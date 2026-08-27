import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { runSafeProcess } from './safe-process-runner.js';
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
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).strict();

const taskConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.partialRecord(taskKindSchema, configuredProfileSchema).default({}),
}).strict();

const DEFAULT_TIMEOUT_SECONDS: Record<TaskKind, number> = {
  test: 900,
  lint: 300,
  typecheck: 300,
  check: 900,
  build: 1200,
  bench: 900,
};
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATIC_HTML_BYTES = 1024 * 1024;
const SAFE_SCRIPT_NAME = /^[a-z0-9:_-]{1,120}$/iu;
const STATIC_ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.cjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.map', '.webmanifest', '.glb', '.gltf', '.bin', '.wasm',
  '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.pdf',
]);

export type TaskProfileSource = 'package.json' | '.mcp/tasks.json' | 'cargo' | 'go' | 'python' | 'maven' | 'gradle' | 'dotnet' | 'builtin-static';
export type TaskProfileDiscovery = 'explicit' | 'alias' | 'ecosystem' | 'builtin';

export interface TaskProfile {
  id: TaskKind;
  source: TaskProfileSource;
  discovery: TaskProfileDiscovery;
  executable: string;
  args: string[];
  timeoutSeconds: number;
  script?: string;
  description?: string;
}

export type TaskFailureKind = 'none' | 'source_failure' | 'dependency_missing' | 'configuration_required' | 'tool_missing' | 'timeout' | 'cancelled';

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
  failureKind: TaskFailureKind;
}

export interface TaskRunnerOptions {
  maxOutputBytes?: number;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_SCRIPT_ALIASES: Record<TaskKind, readonly string[]> = {
  test: ['test', 'test:unit', 'test:ci', 'test:integration', 'test:e2e', 'test:all', 'test:backend', 'test:frontend'],
  lint: ['lint', 'lint:check', 'lint:ci', 'lint:all'],
  typecheck: ['typecheck', 'type-check', 'check:types', 'types:check', 'typecheck:app', 'typecheck:all'],
  check: ['check', 'verify', 'validate', 'check:all', 'verify:ci', 'verify:all', 'validate:ci'],
  build: ['build', 'compile', 'bundle', 'build:prod', 'build:production', 'build:ci', 'build:all'],
  bench: ['bench', 'benchmark', 'bench:ci'],
};

function platformExecutable(executable: string): string {
  if (process.platform !== 'win32') return executable;
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(executable)) return `${executable}.cmd`;
  if (executable === 'mvnw') return 'mvnw.cmd';
  if (executable === 'gradlew') return 'gradlew.bat';
  return executable;
}

function windowsShellCommand(tokens: readonly string[]): { executable: string; args: string[] } {
  if (tokens.some((token) => !/^[a-z0-9@._:+*/=\\-]+$/iu.test(token))) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'Generated verification command contains unsupported Windows shell characters.', httpStatus: 400, expose: true });
  }
  const commandShell = process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
  return { executable: commandShell, args: ['/d', '/s', '/c', tokens.join(' ')] };
}

function spawnSpec(profile: TaskProfile): { executable: string; args: string[] } {
  if (profile.source === 'builtin-static') {
    throw new AppError({ code: 'INTERNAL_ERROR', message: 'Built-in static verification does not spawn a process.' });
  }
  if (process.platform !== 'win32') return { executable: profile.executable, args: [...profile.args] };

  if (profile.source === 'package.json' && ['npm', 'pnpm', 'yarn'].includes(profile.executable)) {
    const script = profile.script ?? profile.args[1] ?? '';
    if (profile.args.length !== 2 || profile.args[0] !== 'run' || profile.args[1] !== script || !SAFE_SCRIPT_NAME.test(script)) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Package task profile is not in the expected fixed form.', httpStatus: 400, expose: true });
    }
    return windowsShellCommand([`${profile.executable}.cmd`, 'run', script]);
  }

  if (profile.source === 'maven' && ['mvn', 'mvnw'].includes(profile.executable)) {
    return windowsShellCommand([profile.executable === 'mvnw' ? 'mvnw.cmd' : 'mvn.cmd', ...profile.args]);
  }
  if (profile.source === 'gradle' && ['gradle', 'gradlew'].includes(profile.executable)) {
    return windowsShellCommand([profile.executable === 'gradlew' ? 'gradlew.bat' : 'gradle.bat', ...profile.args]);
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

function declaredPackageManager(packageManager: string | undefined): PackageManager | null {
  const declared = packageManager?.split('@')[0]?.toLowerCase();
  return declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm' ? declared : null;
}

function classifyTaskFailure(result: {
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}, profile: TaskProfile): TaskFailureKind {
  if (result.success) return 'none';
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'timeout';
  const text = `${result.stdout}\n${result.stderr}`;
  if (/how would you like to configure eslint|requires one-time configuration|interactive configuration/iu.test(text)) {
    return 'configuration_required';
  }
  if (/(?:is not recognized as an internal or external command|command not found|enoent|cannot find module)/iu.test(text)) {
    return profile.source === 'package.json' ? 'dependency_missing' : 'tool_missing';
  }
  return 'source_failure';
}

function profile(
  id: TaskKind,
  source: TaskProfileSource,
  discovery: TaskProfileDiscovery,
  executable: string,
  args: string[],
  options: { script?: string; description?: string } = {},
): TaskProfile {
  return {
    id,
    source,
    discovery,
    executable,
    args,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS[id],
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
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

  async listTaskProfiles(request: { projectId: string; permissionSessionId?: string }): Promise<TaskProfile[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    return this.discoverProfiles(resolver);
  }

  async assertTaskProfilesAvailable(request: {
    projectId: string;
    permissionSessionId?: string;
    tasks: readonly TaskKind[];
  }): Promise<TaskProfile[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const profiles = await this.discoverProfiles(resolver);
    const available = new Set(profiles.map((candidate) => candidate.id));
    const missing = [...new Set(request.tasks)].filter((task) => !available.has(task));
    if (missing.length > 0) {
      const availableText = profiles.length > 0 ? profiles.map((candidate) => candidate.id).join(', ') : 'none';
      throw new AppError({
        code: 'VERIFICATION_UNAVAILABLE',
        message: `Verification task profile(s) ${missing.map((task) => `'${task}'`).join(', ')} are not available for this project. Available task profiles: ${availableText}. Use workspace_bootstrap/list_task_profiles and its recommended verification plan instead of inventing a profile.`,
        httpStatus: 409,
        expose: true,
      });
    }
    return profiles.filter((candidate) => request.tasks.includes(candidate.id));
  }

  async runTask(request: {
    projectId: string;
    permissionSessionId?: string;
    task: TaskKind;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<TaskRunResult> {
    await this.authorization.authorize({ ...request, capability: 'command.run' });
    const resolver = await this.paths.forProject(request.projectId);
    const profiles = await this.discoverProfiles(resolver);
    const selected = profiles.find((candidate) => candidate.id === request.task);
    if (!selected) {
      const availableText = profiles.length > 0 ? profiles.map((candidate) => candidate.id).join(', ') : 'none';
      throw new AppError({
        code: 'VERIFICATION_UNAVAILABLE',
        message: `Task profile '${request.task}' is not available for this project. Available task profiles: ${availableText}. Use workspace_bootstrap/list_task_profiles and its recommended verification plan instead of inventing a profile.`,
        httpStatus: 409,
        expose: true,
      });
    }
    const timeoutSeconds = Math.min(Math.max(request.timeoutSeconds ?? selected.timeoutSeconds, 1), 3600);
    if (selected.source === 'builtin-static') return this.executeStaticCheck(selected, resolver);
    return this.execute(selected, resolver.canonicalRoot, timeoutSeconds, request.signal);
  }

  private async discoverProfiles(resolver: ProjectPathResolver): Promise<TaskProfile[]> {
    const profiles = new Map<TaskKind, TaskProfile>();
    const packageJson = await this.readJsonFile(resolver, 'package.json', 256 * 1024);
    if (packageJson !== null) {
      const parsed = packageJsonSchema.safeParse(packageJson);
      if (!parsed.success) {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json task metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      }
      const manager = await this.packageManager(resolver, parsed.data.packageManager);
      const scripts = parsed.data.scripts ?? {};
      for (const task of taskKindSchema.options) {
        const selectedScript = PACKAGE_SCRIPT_ALIASES[task].find((candidate) => SAFE_SCRIPT_NAME.test(candidate) && Boolean(scripts[candidate]));
        if (!selectedScript) continue;
        profiles.set(task, profile(
          task,
          'package.json',
          selectedScript === task ? 'explicit' : 'alias',
          manager,
          ['run', selectedScript],
          { script: selectedScript, description: selectedScript === task ? `Declared package script '${selectedScript}'.` : `Mapped package script alias '${selectedScript}' to '${task}'.` },
        ));
      }
    }

    if (await this.exists(resolver, 'Cargo.toml')) {
      const cargo: Partial<Record<TaskKind, string[]>> = {
        test: ['test'], lint: ['clippy', '--all-targets'], typecheck: ['check'], check: ['check'], build: ['build'], bench: ['bench'],
      };
      for (const task of taskKindSchema.options) {
        const args = cargo[task];
        if (!profiles.has(task) && args) profiles.set(task, profile(task, 'cargo', 'ecosystem', 'cargo', args, { description: 'Rust Cargo convention.' }));
      }
    }

    if (await this.exists(resolver, 'go.mod')) {
      const go: Partial<Record<TaskKind, string[]>> = {
        test: ['test', './...'], lint: ['vet', './...'], typecheck: ['test', './...'], check: ['vet', './...'], build: ['build', './...'],
      };
      for (const task of taskKindSchema.options) {
        const args = go[task];
        if (!profiles.has(task) && args) profiles.set(task, profile(task, 'go', 'ecosystem', 'go', args, { description: 'Go module convention.' }));
      }
    }

    await this.discoverPythonProfiles(resolver, profiles);
    await this.discoverJavaProfiles(resolver, profiles);
    await this.discoverDotnetProfiles(resolver, profiles);

    if (profiles.size === 0 && await this.exists(resolver, 'index.html')) {
      profiles.set('check', profile('check', 'builtin-static', 'builtin', 'builtin:static-check', [], {
        description: 'Built-in static integrity check for root index.html and local asset references.',
      }));
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
          discovery: 'explicit',
          executable: configured.executable,
          args: [...configured.args],
          timeoutSeconds: configured.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS[task],
          description: 'Explicit project MCP task profile.',
        });
      }
    }

    return taskKindSchema.options.flatMap((task) => {
      const selected = profiles.get(task);
      return selected ? [selected] : [];
    });
  }

  private async discoverPythonProfiles(resolver: ProjectPathResolver, profiles: Map<TaskKind, TaskProfile>): Promise<void> {
    const hasPythonMarker = await this.exists(resolver, 'pyproject.toml') || await this.exists(resolver, 'requirements.txt') || await this.hasRootExtension(resolver, ['.py']);
    if (!hasPythonMarker) return;
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const hasTests = await this.exists(resolver, 'tests') || await this.exists(resolver, 'pytest.ini') || await this.exists(resolver, 'conftest.py');
    if (!profiles.has('test') && hasTests) profiles.set('test', profile('test', 'python', 'ecosystem', python, ['-m', 'pytest'], { description: 'Python test convention detected from tests/pytest markers.' }));
    const hasRuff = await this.exists(resolver, 'ruff.toml') || await this.exists(resolver, '.ruff.toml');
    if (!profiles.has('lint') && hasRuff) profiles.set('lint', profile('lint', 'python', 'ecosystem', python, ['-m', 'ruff', 'check', '.'], { description: 'Ruff configuration detected.' }));
    const hasMypy = await this.exists(resolver, 'mypy.ini') || await this.exists(resolver, '.mypy.ini');
    if (!profiles.has('typecheck') && hasMypy) profiles.set('typecheck', profile('typecheck', 'python', 'ecosystem', python, ['-m', 'mypy', '.'], { description: 'Mypy configuration detected.' }));
  }

  private async discoverJavaProfiles(resolver: ProjectPathResolver, profiles: Map<TaskKind, TaskProfile>): Promise<void> {
    if (await this.exists(resolver, 'pom.xml')) {
      const executable = await this.exists(resolver, 'mvnw') || await this.exists(resolver, 'mvnw.cmd') ? 'mvnw' : 'mvn';
      if (!profiles.has('test')) profiles.set('test', profile('test', 'maven', 'ecosystem', executable, ['test'], { description: 'Maven project convention.' }));
      if (!profiles.has('check')) profiles.set('check', profile('check', 'maven', 'ecosystem', executable, ['verify', '-DskipTests=false'], { description: 'Maven verify lifecycle.' }));
      if (!profiles.has('build')) profiles.set('build', profile('build', 'maven', 'ecosystem', executable, ['package', '-DskipTests'], { description: 'Maven package lifecycle without duplicate tests.' }));
      return;
    }
    const hasGradle = await this.exists(resolver, 'build.gradle') || await this.exists(resolver, 'build.gradle.kts');
    if (!hasGradle) return;
    const executable = await this.exists(resolver, 'gradlew') || await this.exists(resolver, 'gradlew.bat') ? 'gradlew' : 'gradle';
    if (!profiles.has('test')) profiles.set('test', profile('test', 'gradle', 'ecosystem', executable, ['test'], { description: 'Gradle test task convention.' }));
    if (!profiles.has('check')) profiles.set('check', profile('check', 'gradle', 'ecosystem', executable, ['check'], { description: 'Gradle check task convention.' }));
    if (!profiles.has('build')) profiles.set('build', profile('build', 'gradle', 'ecosystem', executable, ['build', '-x', 'test'], { description: 'Gradle build convention without duplicate test task.' }));
  }

  private async discoverDotnetProfiles(resolver: ProjectPathResolver, profiles: Map<TaskKind, TaskProfile>): Promise<void> {
    const hasDotnet = await this.hasRootExtension(resolver, ['.sln', '.csproj']);
    if (!hasDotnet) return;
    const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    if (!profiles.has('test')) profiles.set('test', profile('test', 'dotnet', 'ecosystem', executable, ['test', '--no-restore'], { description: '.NET test convention.' }));
    if (!profiles.has('build')) profiles.set('build', profile('build', 'dotnet', 'ecosystem', executable, ['build', '--no-restore'], { description: '.NET build convention.' }));
  }

  private async packageManager(resolver: ProjectPathResolver, packageManager: string | undefined): Promise<PackageManager> {
    const declared = declaredPackageManager(packageManager);
    if (declared) return declared;
    if (await this.exists(resolver, 'pnpm-lock.yaml')) return 'pnpm';
    if (await this.exists(resolver, 'yarn.lock')) return 'yarn';
    if (await this.exists(resolver, 'bun.lock') || await this.exists(resolver, 'bun.lockb')) return 'bun';
    return 'npm';
  }

  private async executeStaticCheck(selected: TaskProfile, resolver: ProjectPathResolver): Promise<TaskRunResult> {
    const started = Date.now();
    const result = await this.staticIntegrityCheck(resolver);
    return {
      task: selected.id,
      source: selected.source,
      executable: selected.executable,
      args: [],
      success: result.missing.length === 0,
      exitCode: result.missing.length === 0 ? 0 : 1,
      signal: null,
      stdout: `Static integrity check: index.html readable; checked ${result.checked} local asset reference(s).${result.missing.length === 0 ? ' All referenced local assets exist.' : ''}\n`,
      stderr: result.missing.length === 0 ? '' : `Missing local asset reference(s): ${result.missing.join(', ')}\n`,
      durationMs: Date.now() - started,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      failureKind: result.missing.length === 0 ? 'none' : 'source_failure',
    };
  }

  private async staticIntegrityCheck(resolver: ProjectPathResolver): Promise<{ checked: number; missing: string[] }> {
    const resolved = await resolver.resolveExisting('index.html');
    const info = await stat(resolved.absolutePath);
    if (!info.isFile()) throw new AppError({ code: 'PATH_INVALID', message: 'Static verification requires index.html to be a regular file.', httpStatus: 400, expose: true });
    if (info.size > MAX_STATIC_HTML_BYTES) throw new AppError({ code: 'FILE_TOO_LARGE', message: 'index.html exceeds the built-in static verification limit.', httpStatus: 413, expose: true });
    const html = await readFile(resolved.absolutePath, 'utf8');
    if (html.includes('\0')) throw new AppError({ code: 'VALIDATION_ERROR', message: 'index.html contains binary/NUL content.', httpStatus: 400, expose: true });
    const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean)
      .filter((value) => !/^(?:[a-z]+:|\/\/|#)/iu.test(value))
      .map((value) => value.split(/[?#]/u)[0] ?? '')
      .filter((value) => STATIC_ASSET_EXTENSIONS.has(path.extname(value).toLowerCase()))
      .slice(0, 200);
    const unique = [...new Set(references)];
    const missing: string[] = [];
    for (const reference of unique) {
      const normalized = reference.replace(/^\/+/, '');
      try { await resolver.resolveExisting(normalized); }
      catch (error) {
        if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') missing.push(reference);
        else throw error;
      }
    }
    return { checked: unique.length, missing };
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

  private async hasRootExtension(resolver: ProjectPathResolver, extensions: readonly string[]): Promise<boolean> {
    const entries = await readdir(resolver.canonicalRoot, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()));
  }

  private async execute(selected: TaskProfile, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<TaskRunResult> {
    const spec = spawnSpec(selected);
    const result = await runSafeProcess({
      executable: spec.executable,
      args: spec.args,
      cwd,
      timeoutSeconds,
      maxOutputBytes: this.maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      task: selected.id,
      source: selected.source,
      executable: selected.executable,
      args: [...selected.args],
      success: result.success,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputTruncated: result.outputTruncated,
      failureKind: classifyTaskFailure(result, selected),
    };
  }
}
