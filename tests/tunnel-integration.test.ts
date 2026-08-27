import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TunnelIntegrationService } from '../src/app/tunnel-integration-service.js';
import type { SafeProcessResult } from '../src/app/safe-process-runner.js';

interface CommandCall {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutSeconds: number;
  env?: Readonly<Record<string, string>>;
  captureOutput?: boolean;
}

function result(overrides: Partial<SafeProcessResult> = {}): SafeProcessResult {
  return {
    executable: 'tunnel-client',
    args: [],
    success: true,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    ...overrides,
  };
}

async function fakeBinaryRoot(): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-tunnel-'));
  const versionRoot = path.join(root, '.runtime', 'tools', 'tunnel-client', 'v9.9.9');
  await mkdir(versionRoot, { recursive: true });
  const binary = path.join(versionRoot, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
  await writeFile(binary, 'fixture', 'utf8');
  return { root, binary };
}

describe('OpenAI Secure MCP Tunnel integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('reports configuration_required without exposing missing credentials', async () => {
    const fixture = await fakeBinaryRoot();
    roots.push(fixture.root);
    const calls: CommandCall[] = [];
    const service = new TunnelIntegrationService({
      host: '127.0.0.1',
      port: 7317,
      rootDir: fixture.root,
      env: {},
      fetchFn: () => Promise.resolve(new Response('ok', { status: 200 })),
      commandRunner: (spec) => {
        calls.push(spec);
        if (spec.args[0] === '--version') return Promise.resolve(result({ stdout: '0.0.12+fixture\n' }));
        return Promise.resolve(result({ success: false, exitCode: 1, stderr: 'alias mcp-coding-v2 is not known; run create or connect first' }));
      },
    });

    const status = await service.status();
    expect(status).toMatchObject({
      state: 'configuration_required',
      binary: { installed: true, path: fixture.binary, version: '0.0.12+fixture' },
      configuration: {
        alias: 'mcp-coding-v2',
        mcpServerUrl: 'http://127.0.0.1:7317/mcp',
        tunnelIdConfigured: false,
        runtimeApiKeyConfigured: false,
      },
      localMcp: { reachable: true, ready: true, httpStatus: 200 },
      runtime: { known: false },
    });
    expect(JSON.stringify(status)).not.toContain('CONTROL_PLANE_API_KEY');
    expect(calls.length).toBeGreaterThan(0);
  });

  test('reports an already-running managed runtime as ready even when the current MCP process lacks reconnect credentials', async () => {
    const fixture = await fakeBinaryRoot();
    roots.push(fixture.root);
    const runtimeJson = JSON.stringify({
      alias: 'mcp-coding-v2',
      process_running: true,
      healthy: true,
      ready: true,
      pid: 4242,
      tunnel_id: 'tunnel_abcdefgh12345678',
    });
    const service = new TunnelIntegrationService({
      host: '127.0.0.1',
      port: 7317,
      rootDir: fixture.root,
      env: {},
      fetchFn: () => Promise.resolve(new Response('ok', { status: 200 })),
      commandRunner: (spec) => {
        if (spec.args[0] === '--version') return Promise.resolve(result({ stdout: '0.0.12+fixture\n' }));
        if (spec.args[0] === 'runtimes' && spec.args[1] === 'status') return Promise.resolve(result({ stdout: runtimeJson }));
        return Promise.resolve(result());
      },
    });

    const status = await service.status();
    expect(status).toMatchObject({
      state: 'ready',
      configuration: { tunnelIdConfigured: false, runtimeApiKeyConfigured: false },
      runtime: { known: true, processRunning: true, healthy: true, ready: true, pid: 4242 },
    });
  });

  test('connect keeps the runtime API key out of argv and parses managed runtime health', async () => {
    const fixture = await fakeBinaryRoot();
    roots.push(fixture.root);
    const secret = 'sk-test-runtime-secret-123456';
    const calls: CommandCall[] = [];
    const runtimeJson = JSON.stringify({
      alias: 'mcp-coding-v2',
      process_running: true,
      healthy: true,
      ready: true,
      pid: 4242,
      health_url: 'http://127.0.0.1:19421/healthz',
      ui_url: 'http://127.0.0.1:19421/ui',
      profile_path: 'profiles/mcp-coding-v2.yaml',
      tunnel_id: 'tunnel_abcdefgh12345678',
      control_plane_poll_health: 'ok',
      repair_actions: [],
    });
    const service = new TunnelIntegrationService({
      host: '127.0.0.1',
      port: 7317,
      rootDir: fixture.root,
      env: {
        CONTROL_PLANE_TUNNEL_ID: 'tunnel_abcdefgh12345678',
        CONTROL_PLANE_API_KEY: secret,
      },
      fetchFn: () => Promise.resolve(new Response('ok', { status: 200 })),
      commandRunner: (spec) => {
        calls.push(spec);
        if (spec.args[0] === '--version') return Promise.resolve(result({ stdout: '0.0.12+fixture\n' }));
        if (spec.args[0] === 'runtimes' && spec.args[1] === 'status') return Promise.resolve(result({ stdout: runtimeJson }));
        if (spec.args[0] === 'runtimes' && spec.args[1] === 'connect') return Promise.resolve(result({ stdout: '{"started":true}' }));
        return Promise.resolve(result());
      },
    });

    const status = await service.connect();
    expect(status).toMatchObject({
      state: 'ready',
      configuration: { tunnelIdConfigured: true, runtimeApiKeyConfigured: true },
      runtime: {
        known: true,
        processRunning: true,
        healthy: true,
        ready: true,
        pid: 4242,
      },
    });
    expect(status.runtime.tunnelIdMasked).toContain('…');

    const connectCall = calls.find((call) => call.args[0] === 'runtimes' && call.args[1] === 'connect');
    expect(connectCall).toBeDefined();
    expect(connectCall?.args).toContain('env:CONTROL_PLANE_API_KEY');
    expect(JSON.stringify(connectCall?.args)).not.toContain(secret);
    expect(connectCall?.env?.CONTROL_PLANE_API_KEY).toBe(secret);
    expect(connectCall?.captureOutput).toBe(false);
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).not.toContain('tunnel_abcdefgh12345678');
  });

  test('doctor performs non-recursive preflight without invoking the official self-probing doctor command', async () => {
    const fixture = await fakeBinaryRoot();
    roots.push(fixture.root);
    const secret = 'sk-doctor-secret-123456789';
    const calls: CommandCall[] = [];
    const service = new TunnelIntegrationService({
      host: '127.0.0.1',
      port: 7317,
      rootDir: fixture.root,
      env: {
        CONTROL_PLANE_TUNNEL_ID: 'tunnel_abcdefgh12345678',
        CONTROL_PLANE_API_KEY: secret,
      },
      fetchFn: () => Promise.resolve(new Response('ok', { status: 200 })),
      commandRunner: (spec) => {
        calls.push(spec);
        if (spec.args[0] === '--version') return Promise.resolve(result({ stdout: '0.0.12+fixture\n' }));
        if (spec.args[0] === 'runtimes' && spec.args[1] === 'status') {
          return Promise.resolve(result({ success: false, exitCode: 1, stderr: 'alias mcp-coding-v2 is not known; run create or connect first' }));
        }
        return Promise.resolve(result());
      }
    });

    const doctor = await service.doctor();
    expect(doctor.ok).toBe(true);
    expect(doctor.output).toContain('Tunnel preflight passed.');
    expect(doctor.output).not.toContain(secret);
    const initCall = calls.find((call) => call.args[0] === 'init');
    expect(initCall?.args).toContain('env:CONTROL_PLANE_API_KEY');
    expect(JSON.stringify(initCall?.args)).not.toContain(secret);
    expect(initCall?.env?.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(calls.some((call) => call.args[0] === 'doctor')).toBe(false);
  });
});
