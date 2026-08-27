import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { killProcessTree, redactProcessOutput, sanitizedEnvironment } from './safe-process-runner.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

const MAX_PROCESS_LOG_BYTES = 128 * 1024;
const PROCESS_SCRIPT = /^(dev|start|serve|preview|storybook|watch)(?::[A-Za-z0-9._-]+)*$/u;
const packageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
}).passthrough();

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type ManagedProcessState = 'running' | 'stopped' | 'failed';

export interface ManagedProcessProfile {
  id: string;
  source: 'package.json';
  label: string;
  manager: PackageManager;
  script: string;
}

export interface ManagedProcessSession {
  id: string;
  projectId: string;
  profileId: string;
  state: ManagedProcessState;
  pid: number | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

interface InternalProcess {
  session: ManagedProcessSession;
  child: ChildProcess;
  stdoutBuffer: Buffer;
  stderrBuffer: Buffer;
  outputTruncated: boolean;
}

interface PackageMetadata {
  manager: PackageManager;
  scripts: Record<string, string>;
}

function appendBounded(current: Buffer, chunk: Buffer): { buffer: Buffer; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= MAX_PROCESS_LOG_BYTES) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - MAX_PROCESS_LOG_BYTES), truncated: true };
}

function publicSession(process: InternalProcess): ManagedProcessSession {
  return {
    ...process.session,
    stdout: redactProcessOutput(process.stdoutBuffer.toString('utf8')),
    stderr: redactProcessOutput(process.stderrBuffer.toString('utf8')),
    outputTruncated: process.outputTruncated,
  };
}

function managerFrom(value: string | undefined): PackageManager | null {
  const declared = value?.split('@')[0]?.toLowerCase();
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared;
  return null;
}

function windowsShellCommand(manager: PackageManager, script: string): { executable: string; args: string[] } {
  if (!PROCESS_SCRIPT.test(script)) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Unsupported managed process script name.', httpStatus: 400, expose: true });
  const commandShell = process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
  const executable = manager === 'bun' ? 'bun.exe' : manager + '.cmd';
  return { executable: commandShell, args: ['/d', '/s', '/c', executable + ' run ' + script] };
}

function processCommand(manager: PackageManager, script: string): { executable: string; args: string[] } {
  if (!PROCESS_SCRIPT.test(script)) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Unsupported managed process script name.', httpStatus: 400, expose: true });
  if (process.platform === 'win32') return windowsShellCommand(manager, script);
  return { executable: manager, args: ['run', script] };
}

export class ManagedProcessService {
  private readonly processes = new Map<string, InternalProcess>();

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
  ) {}

  async profiles(request: { projectId: string; permissionSessionId?: string }): Promise<ManagedProcessProfile[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const metadata = await this.packageMetadata(resolver);
    if (!metadata) return [];
    return Object.keys(metadata.scripts)
      .filter((script) => PROCESS_SCRIPT.test(script))
      .sort()
      .map((script) => ({
        id: 'package:' + script,
        source: 'package.json' as const,
        label: metadata.manager + ' run ' + script,
        manager: metadata.manager,
        script,
      }));
  }

  async list(request: { projectId: string; permissionSessionId?: string }): Promise<ManagedProcessSession[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    return [...this.processes.values()]
      .filter((item) => item.session.projectId === request.projectId)
      .map((item) => publicSession(item))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  async start(request: {
    projectId: string;
    permissionSessionId?: string;
    profileId: string;
  }): Promise<ManagedProcessSession> {
    const session = await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'command.run'],
    });
    const profiles = await this.profiles({ projectId: request.projectId, permissionSessionId: session.id });
    const profile = profiles.find((candidate) => candidate.id === request.profileId);
    if (!profile) throw new AppError({ code: 'NOT_FOUND', message: 'Managed process profile is not available for this project.', httpStatus: 404, expose: true });
    const duplicate = [...this.processes.values()].find((candidate) =>
      candidate.session.projectId === request.projectId &&
      candidate.session.profileId === profile.id &&
      candidate.session.state === 'running'
    );
    if (duplicate) throw new AppError({ code: 'CONFLICT', message: 'This managed process profile is already running.', httpStatus: 409, expose: true });

    const resolver = await this.paths.forProject(request.projectId);
    const spec = processCommand(profile.manager, profile.script);
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: resolver.canonicalRoot,
        env: sanitizedEnvironment(),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Managed process could not be started.', httpStatus: 500, expose: true, cause: error });
    }

    const id = randomUUID();
    const internal: InternalProcess = {
      session: {
        id,
        projectId: request.projectId,
        profileId: profile.id,
        state: 'running',
        pid: child.pid ?? null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        outputTruncated: false,
      },
      child,
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      outputTruncated: false,
    };
    this.processes.set(id, internal);

    child.stdout?.on('data', (chunk: Buffer) => {
      const appended = appendBounded(internal.stdoutBuffer, chunk);
      internal.stdoutBuffer = appended.buffer;
      internal.outputTruncated ||= appended.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const appended = appendBounded(internal.stderrBuffer, chunk);
      internal.stderrBuffer = appended.buffer;
      internal.outputTruncated ||= appended.truncated;
    });
    child.once('error', (error) => {
      const appended = appendBounded(internal.stderrBuffer, Buffer.from(error.message));
      internal.stderrBuffer = appended.buffer;
      internal.outputTruncated ||= appended.truncated;
      internal.session.state = 'failed';
      internal.session.stoppedAt = new Date().toISOString();
    });
    child.once('close', (code, signal) => {
      internal.session.exitCode = code;
      internal.session.signal = signal;
      if (internal.session.state === 'running') internal.session.state = code === 0 ? 'stopped' : 'failed';
      internal.session.stoppedAt ??= new Date().toISOString();
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    return publicSession(internal);
  }

  async status(request: { projectId: string; processId: string; permissionSessionId?: string }): Promise<ManagedProcessSession> {
    const item = this.requireProcess(request.processId);
    if (item.session.projectId !== request.projectId) throw new AppError({ code: 'NOT_FOUND', message: 'Managed process session was not found for this project.', httpStatus: 404, expose: true });
    await this.authorization.authorize({
      projectId: item.session.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capability: 'filesystem.read',
    });
    return publicSession(item);
  }

  async stop(request: { projectId: string; processId: string; permissionSessionId?: string }): Promise<ManagedProcessSession> {
    const item = this.requireProcess(request.processId);
    if (item.session.projectId !== request.projectId) throw new AppError({ code: 'NOT_FOUND', message: 'Managed process session was not found for this project.', httpStatus: 404, expose: true });
    await this.authorization.resolvePermissionSession({
      projectId: item.session.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'command.run'],
    });
    if (item.child.exitCode === null) await killProcessTree(item.child);
    item.session.state = 'stopped';
    item.session.stoppedAt ??= new Date().toISOString();
    return publicSession(item);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.processes.values()].map(async (item) => {
      if (item.child.exitCode === null) await killProcessTree(item.child).catch(() => undefined);
      if (item.session.state === 'running') item.session.state = 'stopped';
      item.session.stoppedAt ??= new Date().toISOString();
    }));
  }

  private requireProcess(id: string): InternalProcess {
    const processId = z.string().uuid().parse(id);
    const item = this.processes.get(processId);
    if (!item) throw new AppError({ code: 'NOT_FOUND', message: 'Managed process session was not found in this runtime.', httpStatus: 404, expose: true });
    return item;
  }

  private async packageMetadata(resolver: ProjectPathResolver): Promise<PackageMetadata | null> {
    try {
      const resolved = await resolver.resolveExisting('package.json');
      const info = await stat(resolved.absolutePath);
      if (!info.isFile() || info.size > 256 * 1024) return null;
      const parsed = packageJsonSchema.safeParse(JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as unknown);
      if (!parsed.success) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      let manager = managerFrom(parsed.data.packageManager);
      if (!manager) {
        if (await this.exists(resolver, 'pnpm-lock.yaml')) manager = 'pnpm';
        else if (await this.exists(resolver, 'yarn.lock')) manager = 'yarn';
        else if (await this.exists(resolver, 'bun.lock') || await this.exists(resolver, 'bun.lockb')) manager = 'bun';
        else manager = 'npm';
      }
      return { manager, scripts: parsed.data.scripts ?? {} };
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (error instanceof SyntaxError) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json contains invalid JSON.', httpStatus: 400, expose: true, cause: error });
      throw error;
    }
  }

  private async exists(resolver: ProjectPathResolver, relativePath: string): Promise<boolean> {
    try { await resolver.resolveExisting(relativePath); return true; }
    catch (error) { if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false; throw error; }
  }
}
