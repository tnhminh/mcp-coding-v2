import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { AppError } from './errors.js';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
] as const;

export interface SafeProcessSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutSeconds: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  captureOutput?: boolean;
}

export interface SafeProcessResult {
  executable: string;
  args: string[];
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}

export function sanitizedEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

export function redactProcessOutput(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_OPENAI_KEY]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED_AWS_KEY]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*([^\s'"`]+)/giu, '$1=[REDACTED]');
}

export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

export async function runSafeProcess(spec: SafeProcessSpec): Promise<SafeProcessResult> {
  const started = Date.now();
  const timeoutSeconds = Math.min(Math.max(spec.timeoutSeconds, 1), 600);
  const maxOutputBytes = Math.min(Math.max(spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1024), 1024 * 1024);
  const captureOutput = spec.captureOutput ?? true;
  let child: ChildProcess;
  try {
    child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: sanitizedEnvironment(spec.env),
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    throw new AppError({ code: 'COMMAND_FAILED', message: 'Executable could not be started.', httpStatus: 500, expose: true, cause: error });
  }

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputTruncated = false;
  let timedOut = false;
  let cancelled = false;
  let killing = false;

  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    const total = stdout.length + stderr.length;
    const remaining = Math.max(maxOutputBytes - total, 0);
    if (remaining > 0) {
      const accepted = chunk.subarray(0, remaining);
      if (target === 'stdout') stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);
    }
    if (chunk.length > remaining && !outputTruncated) {
      outputTruncated = true;
      killing = true;
      void killProcessTree(child);
    }
  };

  if (captureOutput) {
    if (!child.stdout || !child.stderr) {
      await killProcessTree(child);
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Process output streams are unavailable.', httpStatus: 500, expose: true });
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    killing = true;
    void killProcessTree(child);
  }, timeoutSeconds * 1000);
  timeout.unref();

  const onAbort = (): void => {
    cancelled = true;
    killing = true;
    void killProcessTree(child);
  };
  if (spec.signal?.aborted) onAbort();
  else spec.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal }));
    });
    return {
      executable: spec.executable,
      args: [...spec.args],
      success: !timedOut && !cancelled && !outputTruncated && !killing && outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: redactProcessOutput(stdout.toString('utf8')),
      stderr: redactProcessOutput(stderr.toString('utf8')),
      durationMs: Date.now() - started,
      timedOut,
      cancelled,
      outputTruncated,
    };
  } catch (error) {
    if (timedOut || cancelled || outputTruncated) {
      return {
        executable: spec.executable,
        args: [...spec.args],
        success: false,
        exitCode: null,
        signal: null,
        stdout: redactProcessOutput(stdout.toString('utf8')),
        stderr: redactProcessOutput(stderr.toString('utf8')),
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        outputTruncated,
      };
    }
    throw new AppError({ code: 'COMMAND_FAILED', message: 'Executable could not be started.', httpStatus: 500, expose: true, cause: error });
  } finally {
    clearTimeout(timeout);
    spec.signal?.removeEventListener('abort', onAbort);
    if (killing && child.exitCode === null) await killProcessTree(child);
  }
}
