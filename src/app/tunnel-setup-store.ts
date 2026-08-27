import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

const tunnelSettingsSchema = z.object({
  version: z.literal(1),
  tunnelId: z.string().regex(/^tunnel_[A-Za-z0-9_-]{8,}$/u).nullable(),
  autoConnect: z.boolean(),
  updatedAt: z.string(),
}).strict();

export interface TunnelSetupSettings {
  version: 1;
  tunnelId: string | null;
  autoConnect: boolean;
  updatedAt: string;
}

export interface SecretProtector {
  readonly provider: string;
  readonly available: boolean;
  protect(secret: string): Promise<string>;
  unprotect(payload: string): Promise<string>;
}

async function runPowerShellDpapi(script: string, stdin: string): Promise<string> {
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const maxBytes = 256 * 1024;
    const timer = setTimeout(() => {
      child.kill();
      reject(new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows DPAPI operation timed out.', httpStatus: 503, expose: true }));
    }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxBytes) stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows DPAPI helper could not start.', httpStatus: 503, expose: true, cause: error }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows DPAPI operation failed.', httpStatus: 503, expose: true }));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
    child.stdin?.end(stdin, 'utf8');
  });
}

export class WindowsDpapiProtector implements SecretProtector {
  readonly provider = 'windows-dpapi-current-user';
  readonly available = process.platform === 'win32';

  async protect(secret: string): Promise<string> {
    if (!this.available) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows DPAPI is unavailable on this platform.', httpStatus: 503, expose: true });
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$plain=[Console]::In.ReadToEnd();',
      '$bytes=[Text.Encoding]::UTF8.GetBytes($plain);',
      '$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($protected));',
    ].join('');
    return runPowerShellDpapi(script, secret);
  }

  async unprotect(payload: string): Promise<string> {
    if (!this.available) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows DPAPI is unavailable on this platform.', httpStatus: 503, expose: true });
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$encoded=[Console]::In.ReadToEnd();',
      '$protected=[Convert]::FromBase64String($encoded.Trim());',
      '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));',
    ].join('');
    return runPowerShellDpapi(script, payload);
  }
}

export interface TunnelSetupSnapshot {
  tunnelId: string | null;
  tunnelIdConfigured: boolean;
  runtimeApiKeyConfigured: boolean;
  autoConnect: boolean;
  secretProvider: string;
  secretProviderAvailable: boolean;
  settingsPath: string;
  updatedAt: string | null;
}

export class TunnelSetupStore {
  private readonly settingsPath: string;
  private readonly secretPath: string;

  constructor(
    storageRoot: string,
    private readonly protector: SecretProtector = new WindowsDpapiProtector(),
  ) {
    const root = path.resolve(storageRoot, 'tunnel');
    this.settingsPath = path.join(root, 'setup.json');
    this.secretPath = path.join(root, 'runtime-api-key.dpapi');
  }

  async snapshot(): Promise<TunnelSetupSnapshot> {
    const settings = await this.readSettings();
    return {
      tunnelId: settings.tunnelId,
      tunnelIdConfigured: settings.tunnelId !== null,
      runtimeApiKeyConfigured: await this.exists(this.secretPath),
      autoConnect: settings.autoConnect,
      secretProvider: this.protector.provider,
      secretProviderAvailable: this.protector.available,
      settingsPath: this.settingsPath,
      updatedAt: settings.updatedAt || null,
    };
  }

  async configure(input: { tunnelId: string; runtimeApiKey?: string; autoConnect?: boolean }): Promise<TunnelSetupSnapshot> {
    const tunnelId = z.string().trim().regex(/^tunnel_[A-Za-z0-9_-]{8,}$/u).parse(input.tunnelId);
    const current = await this.readSettings();
    const next: TunnelSetupSettings = {
      version: 1,
      tunnelId,
      autoConnect: input.autoConnect ?? current.autoConnect,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    if (input.runtimeApiKey !== undefined) {
      const secret = z.string().trim().min(8).max(4096).parse(input.runtimeApiKey);
      if (!this.protector.available) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Secure Windows credential storage is unavailable.', httpStatus: 503, expose: true });
      const encrypted = await this.protector.protect(secret);
      await this.atomicWrite(this.secretPath, `${encrypted}\n`);
    }
    await this.atomicWrite(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return this.snapshot();
  }

  async setAutoConnect(enabled: boolean): Promise<TunnelSetupSnapshot> {
    const current = await this.readSettings();
    const next: TunnelSetupSettings = { ...current, autoConnect: enabled, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await this.atomicWrite(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return this.snapshot();
  }

  async runtimeApiKey(): Promise<string | null> {
    if (!await this.exists(this.secretPath)) return null;
    if (!this.protector.available) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Secure Windows credential storage is unavailable.', httpStatus: 503, expose: true });
    const encrypted = (await readFile(this.secretPath, 'utf8')).trim();
    if (!encrypted) return null;
    return this.protector.unprotect(encrypted);
  }

  async clearRuntimeApiKey(): Promise<TunnelSetupSnapshot> {
    await unlink(this.secretPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return this.snapshot();
  }

  private async readSettings(): Promise<TunnelSetupSettings> {
    try {
      const parsed = tunnelSettingsSchema.safeParse(JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown);
      if (!parsed.success) throw new AppError({ code: 'CONFIG_INVALID', message: 'Persisted tunnel setup is invalid.', httpStatus: 500, expose: true, cause: parsed.error });
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, tunnelId: null, autoConnect: false, updatedAt: '' };
      }
      if (error instanceof SyntaxError) throw new AppError({ code: 'CONFIG_INVALID', message: 'Persisted tunnel setup contains invalid JSON.', httpStatus: 500, expose: true, cause: error });
      throw error;
    }
  }

  private async exists(candidate: string): Promise<boolean> {
    try { await access(candidate); return true; } catch { return false; }
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }
}
