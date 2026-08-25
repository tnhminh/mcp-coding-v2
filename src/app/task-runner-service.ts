import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

export const taskKindSchema = z.enum(['test', 'lint', 'typecheck', 'check', 'build', 'bench']);
export type TaskKind = z.infer<typeof taskKindSchema>;

const packageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
}).passthrough();

const configuredProfileSchema = z.object({
  executable: z.enum(['node', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'python', 'python3', 'pytest', 'uv', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew']),
  args: z.array(z.string().max(4096)).max(64).default([]),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
}).strict();

const taskConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.partialRecord(taskKindSchema, configuredProfileSchema).default({}),
}).strict();

const DEFAULT_TIMEOUT_SECONDS: Record<TaskKind, number> = {
  test: 300,
  lint: 180,
  typecheck: 180,
  check: 360,
  build: 600,
  bench: 300,
};
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
] as const;

export interface TaskProfile {
  id: TaskKind;
  source: 'package.json' | '.mcp/tasks.json' | 'cargo' | 'go';
  executable: string;
  args: string[];
  timeoutSeconds: number;
}

export interface TaskRunResult {
  task: TaskKind;
  source: TaskProfile['source'];
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

export interface TaskRunnerOptions {
  maxOutputBytes?: number;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function redactOutput(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED_AWS_KEY]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*([^\s'"`]+)/giu, '$1=[REDACTED]');
}

function platformExecutable(executable: string): string {
  if (process.platform !== 'win32') return executable;
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(executable)) return `${executable}.cmd`;
  if (executable === 'mvnw') return 'mvnw.cmd';
  if (executable === 'gradlew') return 'gradlew.bat';
  return executable;
}

function spawnSpec(profile: TaskProfile): { executable: string; args: string[] } {
  if (process.platform !== 'win32') return { executable: profile.executable, args: [...profile.args] };

  if (profile.source === 'package.json' && ['npm', 'pnpm', 'yarn'].includes(profile.executable)) {
    if (profile.args.length !== 2 || profile.args[0] !== 'run' || profile.args[1] !== profile.id) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Package task profile is not in the expected fixed form.', httpStatus: 400, expose: true });
    }
    const commandShell = process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    const command = `${profile.executable}.cmd run ${profile.id}`;
    return { executable: commandShell, args: ['/d', '/s', '/c', command] };
  }

  const executable = platformExecutable(profile.executable);
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: 'Windows custom task profiles cannot execute .cmd/.bat shims; use a direct executable or a package.json task.',
      httpStatus: 400,
      expose: true,
    });
  }
  return { executable, args: [...profile.args] };
}

async function killProcessTree(child: ChildProcess): Promise<void> {
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
      try { child.kill('SIGKILL'); } catch { /* process already gone */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* process already gone */ }
  }
}

function managerFromPackage(packageManager: string | undefined): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const declared = packageManager?.split('@')[0]?.toLowerCase();
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  return 'npm';
}

export class TaskRunnerService {
  private readonly maxOutputBytes: number;

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
    options: TaskRunnerOptions = {},
  ) {
    this.maxOutputBytes = Math.min(Math.max(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1024), 1024 * 1024);
  }

  async listTaskProfiles(request: { projectId: string; permissionSessionId: string }): Promise<TaskProfile[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    return this.discoverProfiles(resolver);
  }

  async runTask(request: {
    projectId: string;
    permissionSessionId: string;
    task: TaskKind;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<TaskRunResult> {
    await this.authorization.authorize({ ...request, capability: 'command.run' });
    const resolver = await this.paths.forProject(request.projectId);
    const profiles = await this.discoverProfiles(resolver);
    const profile = profiles.find((candidate) => candidate.id === request.task);
    if (!profile) {
      throw new AppError({ code: 'NOT_FOUND', message: `Task profile '${request.task}' is not available for this project.`, httpStatus: 404, expose: true });
    }
    const timeoutSeconds = Math.min(Math.max(request.timeoutSeconds ?? profile.timeoutSeconds, 1), 600);
    return this.execute(profile, resolver.canonicalRoot, timeoutSeconds, request.signal);
  }

  private async discoverProfiles(resolver: ProjectPathResolver): Promise<TaskProfile[]> {
    const profiles = new Map<TaskKind, TaskProfile>();
    const packageJson = await this.readJsonFile(resolver, 'package.json', 256 * 1024);
    if (packageJson !== null) {
      const parsed = packageJsonSchema.safeParse(packageJson);
      if (!parsed.success) {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json task metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      }
      const manager = managerFromPackage(parsed.data.packageManager);
      for (const task of taskKindSchema.options) {
        if (parsed.data.scripts?.[task]) {
          profiles.set(task, { id: task, source: 'package.json', executable: manager, args: ['run', task], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS[task] });
        }
      }
    }

    if (await this.exists(resolver, 'Cargo.toml')) {
      const cargo: Partial<Record<TaskKind, string[]>> = {
        test: ['test'], lint: ['clippy', '--all-targets'], typecheck: ['check'], check: ['check'], build: ['build'], bench: ['bench'],
      };
      for (const task of taskKindSchema.options) {
        if (!profiles.has(task) && cargo[task]) profiles.set(task, { id: task, source: 'cargo', executable: 'cargo', args: cargo[task] ?? [], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS[task] });
      }
    }

    if (await this.exists(resolver, 'go.mod')) {
      const go: Partial<Record<TaskKind, string[]>> = {
        test: ['test', './...'], lint: ['vet', './...'], typecheck: ['test', './...'], check: ['vet', './...'], build: ['build', './...'],
      };
      for (const task of taskKindSchema.options) {
        if (!profiles.has(task) && go[task]) profiles.set(task, { id: task, source: 'go', executable: 'go', args: go[task] ?? [], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS[task] });
      }
    }

    const custom = await this.readJsonFile(resolver, '.mcp/tasks.json', MAX_CONFIG_BYTES);
    if (custom !== null) {
      const parsed = taskConfigSchema.safeParse(custom);
      if (!parsed.success) {
        throw new AppError({ code: 'VALIDATION_ERROR', message: '.mcp/tasks.json is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      }
      for (const [task, configured] of Object.entries(parsed.data.profiles) as Array<[TaskKind, z.infer<typeof configuredProfileSchema>]>) {
        profiles.set(task, {
          id: task,
          source: '.mcp/tasks.json',
          executable: configured.executable,
          args: [...configured.args],
          timeoutSeconds: configured.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS[task],
        });
      }
    }

    return taskKindSchema.options.flatMap((task) => {
      const profile = profiles.get(task);
      return profile ? [profile] : [];
    });
  }

  private async readJsonFile(resolver: ProjectPathResolver, requestedPath: string, maxBytes: number): Promise<unknown> {
    try {
      const resolved = await resolver.resolveExisting(requestedPath);
      const info = await stat(resolved.absolutePath);
      if (!info.isFile()) return null;
      if (info.size > maxBytes) throw new AppError({ code: 'FILE_TOO_LARGE', message: `${requestedPath} exceeds the task metadata limit.`, httpStatus: 413, expose: true });
      const text = await readFile(resolved.absolutePath, 'utf8');
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (error instanceof SyntaxError) throw new AppError({ code: 'VALIDATION_ERROR', message: `${requestedPath} contains invalid JSON.`, httpStatus: 400, expose: true, cause: error });
      throw error;
    }
  }

  private async exists(resolver: ProjectPathResolver, requestedPath: string): Promise<boolean> {
    try {
      await resolver.resolveExisting(requestedPath);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false;
      throw error;
    }
  }

  private async execute(profile: TaskProfile, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<TaskRunResult> {
    const started = Date.now();
    const spec = spawnSpec(profile);
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd,
        env: sanitizedEnvironment(),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Task executable could not be started.', httpStatus: 500, expose: true, cause: error });
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let killing = false;

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const total = stdout.length + stderr.length;
      const remaining = Math.max(this.maxOutputBytes - total, 0);
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
    if (!child.stdout || !child.stderr) {
      await killProcessTree(child);
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Task output streams are unavailable.', httpStatus: 500, expose: true });
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

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
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal }));
      });
      return {
        task: profile.id,
        source: profile.source,
        executable: profile.executable,
        args: [...profile.args],
        success: !timedOut && !cancelled && !outputTruncated && !killing && outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: redactOutput(stdout.toString('utf8')),
        stderr: redactOutput(stderr.toString('utf8')),
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        outputTruncated,
      };
    } catch (error) {
      if (timedOut || cancelled || outputTruncated) {
        return {
          task: profile.id, source: profile.source, executable: profile.executable, args: [...profile.args],
          success: false, exitCode: null, signal: null,
          stdout: redactOutput(stdout.toString('utf8')), stderr: redactOutput(stderr.toString('utf8')),
          durationMs: Date.now() - started, timedOut, cancelled, outputTruncated,
        };
      }
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Task executable could not be started.', httpStatus: 500, expose: true, cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (killing && child.exitCode === null) await killProcessTree(child);
    }
  }
}
