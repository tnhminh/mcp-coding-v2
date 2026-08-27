import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { runSafeProcess, type SafeProcessResult } from './safe-process-runner.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function hasInvalidGitRefCharacter(value: string): boolean {
  const invalid = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
  return [...value].some((character) => invalid.has(character));
}

const branchNameSchema = z.string().trim().min(1).max(240).refine(
  (value) => !value.startsWith('-') && !hasControlCharacter(value) && !hasInvalidGitRefCharacter(value) && !value.includes('..') && !value.endsWith('.') && !value.endsWith('/') && !value.endsWith('.lock') && !value.includes('@{'),
  'Invalid Git branch name.',
);
const commitMessageSchema = z.string().trim().min(1).max(4000).refine(
  (value) => ![...value].some((character) => character.charCodeAt(0) === 0),
  'Commit message contains an invalid character.',
);

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath: string | null;
}

export interface GitRepositoryStatus {
  repository: boolean;
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: GitStatusEntry[];
}

export interface GitCommitSummary {
  hash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export interface GitBranchSummary {
  name: string;
  current: boolean;
  commit: string;
  upstream: string | null;
}

export interface GitMutationResult {
  success: true;
  status: GitRepositoryStatus;
}

export class GitService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
  ) {}

  async status(request: { projectId: string; permissionSessionId?: string }): Promise<GitRepositoryStatus> {
    await this.authorization.authorize({ ...request, capability: 'git.read' });
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const result = await this.git(resolver, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], 20, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git status failed.');
    return this.parseStatus(resolver, result.stdout);
  }

  async diff(request: {
    projectId: string;
    permissionSessionId?: string;
    staged?: boolean;
    paths?: readonly string[];
  }): Promise<{ staged: boolean; diff: string; truncated: boolean }> {
    await this.authorization.authorize({ ...request, capability: 'git.read' });
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3'];
    if (request.staged) args.push('--cached');
    const paths = await this.pathspecs(resolver, request.paths ?? []);
    if (paths.length > 0) args.push('--', ...paths);
    const result = await this.git(resolver, args, 30, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git diff failed.');
    return { staged: request.staged ?? false, diff: result.stdout, truncated: result.outputTruncated };
  }

  async log(request: {
    projectId: string;
    permissionSessionId?: string;
    limit?: number;
  }): Promise<{ commits: GitCommitSummary[] }> {
    await this.authorization.authorize({ ...request, capability: 'git.read' });
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const result = await this.git(resolver, [
      'log',
      '-' + String(limit),
      '--date=iso-strict',
      '--pretty=format:%H%x09%an%x09%ae%x09%ad%x09%s',
    ], 20, MAX_GIT_OUTPUT_BYTES);
    if (!result.success && /does not have any commits yet|your current branch .* does not have any commits/iu.test(result.stderr)) return { commits: [] };
    this.requireSuccess(result, 'Git log failed.');
    return {
      commits: result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
        const [hash = '', authorName = '', authorEmail = '', authoredAt = '', ...subjectParts] = line.split('\t');
        return { hash, authorName, authorEmail, authoredAt, subject: subjectParts.join('\t') };
      }),
    };
  }

  async branches(request: { projectId: string; permissionSessionId?: string }): Promise<{ branches: GitBranchSummary[] }> {
    await this.authorization.authorize({ ...request, capability: 'git.read' });
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const result = await this.git(resolver, [
      'for-each-ref',
      '--format=%(refname:short)%09%(HEAD)%09%(objectname)%09%(upstream:short)',
      'refs/heads',
    ], 20, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git branch listing failed.');
    return {
      branches: result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
        const [name = '', head = '', commit = '', upstream = ''] = line.split('\t');
        return { name, current: head.trim() === '*', commit, upstream: upstream || null };
      }),
    };
  }

  async stage(request: { projectId: string; permissionSessionId?: string; paths: readonly string[] }): Promise<GitMutationResult> {
    const session = await this.writeSession(request);
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const paths = await this.pathspecs(resolver, request.paths, true);
    if (paths.length === 0) throw new AppError({ code: 'VALIDATION_ERROR', message: 'At least one project path is required.', httpStatus: 400, expose: true });
    const result = await this.git(resolver, ['add', '--', ...paths], 60, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git stage failed.');
    return { success: true, status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }) };
  }

  async unstage(request: { projectId: string; permissionSessionId?: string; paths: readonly string[] }): Promise<GitMutationResult> {
    const session = await this.writeSession(request);
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const paths = await this.pathspecs(resolver, request.paths, true);
    if (paths.length === 0) throw new AppError({ code: 'VALIDATION_ERROR', message: 'At least one project path is required.', httpStatus: 400, expose: true });
    const result = await this.git(resolver, ['restore', '--staged', '--', ...paths], 30, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git unstage failed.');
    return { success: true, status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }) };
  }

  async createBranch(request: { projectId: string; permissionSessionId?: string; name: string }): Promise<GitMutationResult> {
    const session = await this.writeSession(request);
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const name = branchNameSchema.parse(request.name);
    await this.validateRef(resolver, name);
    const result = await this.git(resolver, ['switch', '-c', name], 30, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git branch creation failed.');
    return { success: true, status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }) };
  }

  async switchBranch(request: { projectId: string; permissionSessionId?: string; name: string }): Promise<GitMutationResult> {
    const session = await this.writeSession(request);
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const name = branchNameSchema.parse(request.name);
    await this.validateRef(resolver, name);
    const result = await this.git(resolver, ['switch', name], 30, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git branch switch failed.');
    return { success: true, status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }) };
  }

  async commit(request: { projectId: string; permissionSessionId?: string; message: string }): Promise<{ commit: string; status: GitRepositoryStatus }> {
    const session = await this.writeSession(request);
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const message = commitMessageSchema.parse(request.message);
    const result = await this.git(resolver, ['commit', '-m', message], 120, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git commit failed.');
    const hashResult = await this.git(resolver, ['rev-parse', 'HEAD'], 20, 4096);
    this.requireSuccess(hashResult, 'Git commit hash could not be resolved.');
    return {
      commit: hashResult.stdout.trim(),
      status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }),
    };
  }

  async restorePaths(request: { projectId: string; permissionSessionId?: string; paths: readonly string[]; staged?: boolean }): Promise<GitMutationResult> {
    const session = await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.write', 'command.run', 'git.read', 'git.write'],
    });
    const resolver = await this.paths.forProject(request.projectId);
    await this.requireRepository(resolver);
    const paths = await this.pathspecs(resolver, request.paths, true);
    if (paths.length === 0) throw new AppError({ code: 'VALIDATION_ERROR', message: 'At least one project path is required.', httpStatus: 400, expose: true });
    const args = ['restore'];
    if (request.staged) args.push('--staged');
    args.push('--worktree', '--', ...paths);
    const result = await this.git(resolver, args, 30, MAX_GIT_OUTPUT_BYTES);
    this.requireSuccess(result, 'Git restore failed.');
    return { success: true, status: await this.status({ projectId: request.projectId, permissionSessionId: session.id }) };
  }

  private async writeSession(request: { projectId: string; permissionSessionId?: string }) {
    return this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['command.run', 'git.read', 'git.write'],
    });
  }

  private async requireRepository(resolver: ProjectPathResolver): Promise<void> {
    const result = await this.git(resolver, ['rev-parse', '--show-toplevel'], 20, 4096);
    this.requireSuccess(result, 'Project is not a Git repository.');
    const top = result.stdout.trim();
    if (!top) throw new AppError({ code: 'CONFLICT', message: 'Project is not a Git repository.', httpStatus: 409, expose: true });
    const canonicalTop = await realpath(path.resolve(top)).catch(() => path.resolve(top));
    if (this.normalize(canonicalTop) !== this.normalize(resolver.canonicalRoot)) {
      throw new AppError({
        code: 'PATH_OUTSIDE_PROJECT',
        message: 'Git repository root must exactly match the registered project root.',
        httpStatus: 403,
        expose: true,
      });
    }
  }

  private async validateRef(resolver: ProjectPathResolver, name: string): Promise<void> {
    const result = await this.git(resolver, ['check-ref-format', '--branch', name], 10, 4096);
    if (!result.success) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Invalid Git branch name.', httpStatus: 400, expose: true });
  }

  private async pathspecs(resolver: ProjectPathResolver, values: readonly string[], allowMissing = false): Promise<string[]> {
    if (values.length > 50) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Git operations accept at most 50 project paths.', httpStatus: 400, expose: true });
    const output: string[] = [];
    for (const value of [...new Set(values)]) {
      const resolved = allowMissing ? await resolver.resolveForWrite(value) : await resolver.resolveExisting(value);
      if (resolved.relativePath === '.') throw new AppError({ code: 'VALIDATION_ERROR', message: 'Git path operations require file or directory paths, not project root.', httpStatus: 400, expose: true });
      output.push(resolved.relativePath.replace(/\\/gu, '/'));
    }
    return output;
  }

  private async git(resolver: ProjectPathResolver, args: readonly string[], timeoutSeconds: number, maxOutputBytes: number): Promise<SafeProcessResult> {
    return runSafeProcess({
      executable: 'git',
      args: ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args],
      cwd: resolver.canonicalRoot,
      timeoutSeconds,
      maxOutputBytes,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    });
  }

  private requireSuccess(result: SafeProcessResult, message: string): void {
    if (result.success) return;
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new AppError({
      code: 'COMMAND_FAILED',
      message: detail ? message + ' ' + detail : message,
      httpStatus: 409,
      expose: true,
    });
  }

  private parseStatus(resolver: ProjectPathResolver, text: string): GitRepositoryStatus {
    let branch: string | null = null;
    let head: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const entries: GitStatusEntry[] = [];

    for (const line of text.split(/\r?\n/u)) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim() || null;
      else if (line.startsWith('# branch.oid ')) head = line.slice('# branch.oid '.length).trim() || null;
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim() || null;
      else if (line.startsWith('# branch.ab ')) {
        const match = /\+([0-9]+)\s+-([0-9]+)/u.exec(line);
        ahead = Number(match?.[1] ?? 0);
        behind = Number(match?.[2] ?? 0);
      } else if (line.startsWith('? ')) {
        entries.push({ index: '?', worktree: '?', path: line.slice(2), originalPath: null });
      } else if (line.startsWith('1 ')) {
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        entries.push({ index: xy[0] ?? '.', worktree: xy[1] ?? '.', path: parts.slice(8).join(' '), originalPath: null });
      } else if (line.startsWith('2 ')) {
        const tabIndex = line.indexOf('\t');
        const metadata = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
        const pathPart = tabIndex >= 0 ? line.slice(tabIndex + 1) : '';
        const [current = '', original = ''] = pathPart.split('\t');
        const parts = metadata.split(' ');
        const xy = parts[1] ?? '..';
        entries.push({ index: xy[0] ?? '.', worktree: xy[1] ?? '.', path: current, originalPath: original || null });
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        const xy = parts[1] ?? 'UU';
        entries.push({ index: xy[0] ?? 'U', worktree: xy[1] ?? 'U', path: parts.slice(10).join(' '), originalPath: null });
      }
    }

    if (branch === '(detached)') branch = null;
    if (head === '(initial)') head = null;
    return {
      repository: true,
      root: resolver.canonicalRoot,
      branch,
      head,
      upstream,
      ahead,
      behind,
      clean: entries.length === 0,
      entries,
    };
  }

  private normalize(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
