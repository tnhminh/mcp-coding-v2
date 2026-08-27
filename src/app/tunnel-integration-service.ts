import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { redactProcessOutput, runSafeProcess, type SafeProcessResult } from './safe-process-runner.js';
import type { TunnelSetupSnapshot, TunnelSetupStore } from './tunnel-setup-store.js';

const DEFAULT_ALIAS = 'mcp-coding-v2';
const DEFAULT_PROFILE_DIR = '.runtime/tunnel-client/profiles';
const TUNNEL_ID_PATTERN = /^tunnel_[A-Za-z0-9_-]{8,}$/u;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MAX_DIAGNOSTIC_CHARS = 16_000;

export interface TunnelRuntimeSnapshot {
  known: boolean;
  processRunning: boolean | null;
  healthy: boolean | null;
  ready: boolean | null;
  pid: number | null;
  healthUrl: string | null;
  uiUrl: string | null;
  profilePath: string | null;
  tunnelIdMasked: string | null;
  controlPlanePollHealth: string | boolean | null;
  repairActions: string[];
}

export interface TunnelStatus {
  state: 'client_missing' | 'local_mcp_unavailable' | 'configuration_required' | 'stopped' | 'starting' | 'ready';
  binary: {
    installed: boolean;
    path: string | null;
    version: string | null;
  };
  configuration: {
    alias: string;
    profileDir: string;
    mcpServerUrl: string;
    tunnelIdConfigured: boolean;
    runtimeApiKeyConfigured: boolean;
    autoConnect: boolean;
  };
  localMcp: {
    reachable: boolean;
    ready: boolean;
    httpStatus: number | null;
  };
  runtime: TunnelRuntimeSnapshot;
}

export interface TunnelDoctorResult {
  ok: boolean;
  output: string;
  status: TunnelStatus;
}

interface TunnelIntegrationOptions {
  host: string;
  port: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  setupStore?: TunnelSetupStore;
  fetchFn?: typeof fetch;
  commandRunner?: (spec: {
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutSeconds: number;
    env?: Readonly<Record<string, string>>;
    captureOutput?: boolean;
  }) => Promise<SafeProcessResult>;
}

function loopbackUrl(host: string, port: number, pathname: string): string {
  const normalizedHost = host === '::1' ? '[::1]' : host;
  return `http://${normalizedHost}:${port}${pathname}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findNestedValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  if (isRecord(value)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    }
    for (const child of Object.values(value)) {
      const found = findNestedValue(child, keys, depth + 1);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNestedValue(child, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function booleanValue(value: unknown, keys: readonly string[]): boolean | null {
  const found = findNestedValue(value, keys);
  return typeof found === 'boolean' ? found : null;
}

function stringValue(value: unknown, keys: readonly string[]): string | null {
  const found = findNestedValue(value, keys);
  return typeof found === 'string' && found.length > 0 ? found : null;
}

function numberValue(value: unknown, keys: readonly string[]): number | null {
  const found = findNestedValue(value, keys);
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

function stringArrayValue(value: unknown, keys: readonly string[]): string[] {
  const found = findNestedValue(value, keys);
  if (!Array.isArray(found)) return [];
  return found.filter((item): item is string => typeof item === 'string').slice(0, 20);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function maskTunnelId(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 14) return 'tunnel_…';
  return `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function compareVersionDirectories(a: string, b: string): number {
  const parse = (value: string): number[] => value.replace(/^v/u, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return b.localeCompare(a);
}

function redactTunnelOutput(value: string): string {
  return redactProcessOutput(value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_OPENAI_KEY]')
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

export class TunnelIntegrationService {
  private readonly rootDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly commandRunner: NonNullable<TunnelIntegrationOptions['commandRunner']>;
  private readonly setupStore: TunnelSetupStore | null;
  private readonly alias: string;
  private readonly profileDir: string;
  private readonly mcpServerUrl: string;
  private readonly healthUrl: string;

  constructor(private readonly options: TunnelIntegrationOptions) {
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? fetch;
    this.commandRunner = options.commandRunner ?? (async (spec) => runSafeProcess(spec));
    this.setupStore = options.setupStore ?? null;
    const requestedAlias = this.env.MCP_TUNNEL_ALIAS?.trim() || DEFAULT_ALIAS;
    this.alias = ALIAS_PATTERN.test(requestedAlias) ? requestedAlias : DEFAULT_ALIAS;
    this.profileDir = path.resolve(this.rootDir, this.env.MCP_TUNNEL_PROFILE_DIR?.trim() || DEFAULT_PROFILE_DIR);
    this.mcpServerUrl = this.env.MCP_TUNNEL_TARGET_URL?.trim() || loopbackUrl(options.host, options.port, '/mcp');
    this.healthUrl = loopbackUrl(options.host, options.port, '/health/ready');
  }

  autoConnectEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((this.env.MCP_TUNNEL_AUTO_CONNECT ?? '').trim().toLowerCase());
  }

  async setupSnapshot(): Promise<TunnelSetupSnapshot | null> {
    return this.setupStore ? this.setupStore.snapshot() : null;
  }

  async configureSetup(input: { tunnelId: string; runtimeApiKey?: string; autoConnect?: boolean }): Promise<{ setup: TunnelSetupSnapshot; tunnel: TunnelStatus }> {
    if (!this.setupStore) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Persistent tunnel setup storage is unavailable.', httpStatus: 503, expose: true });
    const setup = await this.setupStore.configure(input);
    this.env.CONTROL_PLANE_TUNNEL_ID = input.tunnelId;
    if (input.runtimeApiKey !== undefined) this.env.CONTROL_PLANE_API_KEY = input.runtimeApiKey;
    this.env.MCP_TUNNEL_AUTO_CONNECT = setup.autoConnect ? '1' : '0';
    return { setup, tunnel: await this.status() };
  }

  async setAutoConnect(enabled: boolean): Promise<{ setup: TunnelSetupSnapshot; tunnel: TunnelStatus }> {
    if (!this.setupStore) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Persistent tunnel setup storage is unavailable.', httpStatus: 503, expose: true });
    const setup = await this.setupStore.setAutoConnect(enabled);
    this.env.MCP_TUNNEL_AUTO_CONNECT = enabled ? '1' : '0';
    return { setup, tunnel: await this.status() };
  }

  async clearStoredRuntimeApiKey(): Promise<{ setup: TunnelSetupSnapshot; tunnel: TunnelStatus }> {
    if (!this.setupStore) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Persistent tunnel setup storage is unavailable.', httpStatus: 503, expose: true });
    const setup = await this.setupStore.clearRuntimeApiKey();
    delete this.env.CONTROL_PLANE_API_KEY;
    return { setup, tunnel: await this.status() };
  }

  async status(): Promise<TunnelStatus> {
    const [binaryPath, localMcp] = await Promise.all([this.resolveBinary(), this.localMcpStatus()]);
    const version = binaryPath ? await this.binaryVersion(binaryPath) : null;
    const runtime = binaryPath ? await this.runtimeStatus(binaryPath) : this.emptyRuntime();
    const tunnelIdConfigured = this.validTunnelId() !== null;
    const runtimeApiKeyConfigured = Boolean(this.env.CONTROL_PLANE_API_KEY?.trim());
    let state: TunnelStatus['state'];
    if (!binaryPath) state = 'client_missing';
    else if (!localMcp.ready) state = 'local_mcp_unavailable';
    else if (runtime.processRunning && runtime.ready) state = 'ready';
    else if (runtime.processRunning) state = 'starting';
    else if (!tunnelIdConfigured || !runtimeApiKeyConfigured) state = 'configuration_required';
    else state = 'stopped';

    return {
      state,
      binary: { installed: binaryPath !== null, path: binaryPath, version },
      configuration: {
        alias: this.alias,
        profileDir: this.profileDir,
        mcpServerUrl: this.mcpServerUrl,
        tunnelIdConfigured,
        runtimeApiKeyConfigured,
        autoConnect: this.autoConnectEnabled(),
      },
      localMcp,
      runtime,
    };
  }

  async doctor(): Promise<TunnelDoctorResult> {
    const binaryPath = await this.requireBinary();
    this.requireCredentials();
    const localMcp = await this.localMcpStatus();
    if (!localMcp.ready) {
      throw new AppError({ code: 'TUNNEL_LOCAL_MCP_UNAVAILABLE', message: 'Local MCP must be ready before tunnel doctor runs.', httpStatus: 409, expose: true });
    }

    // Do not invoke `tunnel-client doctor` synchronously from this HTTP runtime.
    // The official doctor command probes the configured local MCP target and can
    // self-deadlock when the target is the same server handling this request.
    // Prepare/validate the profile here and treat managed runtime status as the
    // in-process source of truth. Operators can still run the official doctor
    // from an external PowerShell session when deep diagnostics are required.
    await this.prepareProfile(binaryPath);
    const status = await this.status();
    const output = [
      'Tunnel preflight passed.',
      `Local MCP ready: ${status.localMcp.ready ? 'yes' : 'no'}.`,
      `Tunnel ID configured: ${status.configuration.tunnelIdConfigured ? 'yes' : 'no'}.`,
      `Runtime API key configured: ${status.configuration.runtimeApiKeyConfigured ? 'yes' : 'no'}.`,
      `Managed runtime: ${status.runtime.known ? (status.runtime.ready ? 'ready' : 'known but not ready') : 'not created'}.`,
      'For deep diagnostics, run tunnel-client doctor from an external terminal, not through this HTTP endpoint.',
    ].join('\n');
    return { ok: true, output, status };
  }

  async connect(): Promise<TunnelStatus> {
    const binaryPath = await this.requireBinary();
    const tunnelId = this.requireCredentials();
    const localMcp = await this.localMcpStatus();
    if (!localMcp.ready) {
      throw new AppError({ code: 'TUNNEL_LOCAL_MCP_UNAVAILABLE', message: 'Local MCP must be ready before tunnel connect runs.', httpStatus: 409, expose: true });
    }

    await mkdir(this.profileDir, { recursive: true });
    const connect = await this.runCli(binaryPath, [
      'runtimes', 'connect',
      '--alias', this.alias,
      '--profile', this.alias,
      '--profile-dir', this.profileDir,
      '--tunnel-id', tunnelId,
      '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY',
      '--mcp-server-url', this.mcpServerUrl,
      '--json',
    ], 90, true, false);
    if (!connect.success) {
      throw new AppError({ code: 'TUNNEL_CONNECT_FAILED', message: redactTunnelOutput(connect.stderr || connect.stdout || 'Tunnel runtime failed to start.'), httpStatus: 502, expose: true });
    }
    const snapshot = await this.status();
    if (!snapshot.runtime.processRunning || !snapshot.runtime.healthy) {
      throw new AppError({ code: 'TUNNEL_NOT_HEALTHY', message: 'Tunnel runtime launched but did not report a healthy managed process.', httpStatus: 502, expose: true });
    }
    return snapshot;
  }

  async disconnect(): Promise<TunnelStatus> {
    const binaryPath = await this.requireBinary();
    const current = await this.runtimeStatus(binaryPath);
    if (!current.known) return this.status();
    const stopped = await this.runCli(binaryPath, ['runtimes', 'stop', this.alias, '--json'], 30, false);
    if (!stopped.success) {
      throw new AppError({ code: 'TUNNEL_STOP_FAILED', message: redactTunnelOutput(stopped.stderr || stopped.stdout || 'Tunnel runtime could not be stopped.'), httpStatus: 502, expose: true });
    }
    return this.status();
  }

  private emptyRuntime(): TunnelRuntimeSnapshot {
    return {
      known: false,
      processRunning: null,
      healthy: null,
      ready: null,
      pid: null,
      healthUrl: null,
      uiUrl: null,
      profilePath: null,
      tunnelIdMasked: null,
      controlPlanePollHealth: null,
      repairActions: [],
    };
  }

  private validTunnelId(): string | null {
    const value = this.env.CONTROL_PLANE_TUNNEL_ID?.trim() ?? '';
    return TUNNEL_ID_PATTERN.test(value) ? value : null;
  }

  private requireCredentials(): string {
    const tunnelId = this.validTunnelId();
    if (!tunnelId) {
      throw new AppError({ code: 'TUNNEL_ID_REQUIRED', message: 'CONTROL_PLANE_TUNNEL_ID is not configured.', httpStatus: 409, expose: true });
    }
    if (!this.env.CONTROL_PLANE_API_KEY?.trim()) {
      throw new AppError({ code: 'TUNNEL_API_KEY_REQUIRED', message: 'CONTROL_PLANE_API_KEY is not configured.', httpStatus: 409, expose: true });
    }
    return tunnelId;
  }

  private async requireBinary(): Promise<string> {
    const binary = await this.resolveBinary();
    if (!binary) {
      throw new AppError({ code: 'TUNNEL_CLIENT_MISSING', message: 'tunnel-client is not installed or selected.', httpStatus: 409, expose: true });
    }
    return binary;
  }

  private async resolveBinary(): Promise<string | null> {
    const selected = this.env.MCP_TUNNEL_CLIENT_BIN?.trim() || this.env.TUNNEL_CLIENT_BIN?.trim();
    if (selected) {
      const candidate = path.resolve(selected);
      if (await this.fileExists(candidate)) return candidate;
    }

    const root = path.join(this.rootDir, '.runtime', 'tools', 'tunnel-client');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareVersionDirectories);
    const executableName = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
    for (const directory of directories) {
      const candidate = path.join(root, directory, executableName);
      if (await this.fileExists(candidate)) return candidate;
      const nested = path.join(root, directory, 'bin', executableName);
      if (await this.fileExists(nested)) return nested;
    }
    return null;
  }

  private async fileExists(candidate: string): Promise<boolean> {
    try {
      await access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private tunnelEnvironment(includeSecret: boolean): Readonly<Record<string, string>> {
    const extra: Record<string, string> = {};
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ENTERPRISE_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
      const value = this.env[key];
      if (value) extra[key] = value;
    }
    if (includeSecret && this.env.CONTROL_PLANE_API_KEY) extra.CONTROL_PLANE_API_KEY = this.env.CONTROL_PLANE_API_KEY;
    return extra;
  }

  private async runCli(binaryPath: string, args: readonly string[], timeoutSeconds: number, includeSecret: boolean, captureOutput = true): Promise<SafeProcessResult> {
    const result = await this.commandRunner({
      executable: binaryPath,
      args,
      cwd: this.rootDir,
      timeoutSeconds,
      env: this.tunnelEnvironment(includeSecret),
      captureOutput,
    });
    return { ...result, stdout: redactTunnelOutput(result.stdout), stderr: redactTunnelOutput(result.stderr) };
  }

  private async binaryVersion(binaryPath: string): Promise<string | null> {
    const result = await this.runCli(binaryPath, ['--version'], 5, false).catch(() => null);
    if (!result?.success) return null;
    return result.stdout.trim().split(/\r?\n/u)[0]?.slice(0, 200) || null;
  }

  private async localMcpStatus(): Promise<TunnelStatus['localMcp']> {
    try {
      const response = await this.fetchFn(this.healthUrl, { signal: AbortSignal.timeout(2_000) });
      return { reachable: true, ready: response.ok, httpStatus: response.status };
    } catch {
      return { reachable: false, ready: false, httpStatus: null };
    }
  }

  private async runtimeStatus(binaryPath: string): Promise<TunnelRuntimeSnapshot> {
    const result = await this.runCli(binaryPath, ['runtimes', 'status', this.alias, '--json'], 10, false).catch(() => null);
    if (!result) return this.emptyRuntime();
    if (!result.success) {
      if (/not known|unknown alias|run create or connect first/iu.test(`${result.stderr}\n${result.stdout}`)) return this.emptyRuntime();
      return this.emptyRuntime();
    }
    const raw = safeJson(result.stdout);
    if (!raw) return this.emptyRuntime();
    const poll = findNestedValue(raw, ['control_plane_poll_health', 'controlPlanePollHealth']);
    const pollHealth = typeof poll === 'boolean' || typeof poll === 'string' ? poll : null;
    return {
      known: true,
      processRunning: booleanValue(raw, ['process_running', 'processRunning']),
      healthy: booleanValue(raw, ['healthy']),
      ready: booleanValue(raw, ['ready']),
      pid: numberValue(raw, ['pid', 'process_id', 'processId']),
      healthUrl: stringValue(raw, ['health_url', 'healthUrl', 'live_health_url', 'liveHealthUrl']),
      uiUrl: stringValue(raw, ['ui_url', 'uiUrl', 'admin_ui_url', 'adminUiUrl']),
      profilePath: stringValue(raw, ['profile_path', 'profilePath']),
      tunnelIdMasked: maskTunnelId(stringValue(raw, ['tunnel_id', 'tunnelId'])),
      controlPlanePollHealth: pollHealth,
      repairActions: stringArrayValue(raw, ['repair_actions', 'repairActions']),
    };
  }

  private async prepareProfile(binaryPath: string): Promise<void> {
    const tunnelId = this.requireCredentials();
    await mkdir(this.profileDir, { recursive: true });
    const prepared = await this.runCli(binaryPath, [
      'init',
      '--sample', 'sample_mcp_remote_no_auth',
      '--profile', this.alias,
      '--profile-dir', this.profileDir,
      '--tunnel-id', tunnelId,
      '--mcp-server-url', this.mcpServerUrl,
      '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY',
      '--health-listen-addr', '127.0.0.1:0',
      '--force',
    ], 15, false);
    if (!prepared.success) {
      throw new AppError({ code: 'TUNNEL_PROFILE_FAILED', message: redactTunnelOutput(prepared.stderr || prepared.stdout || 'Tunnel profile could not be prepared.'), httpStatus: 500, expose: true });
    }
  }
}
