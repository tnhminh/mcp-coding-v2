import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import type { ProjectPathResolver, ResolvedProjectPath } from '../infra/filesystem/project-path-resolver.js';

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_LARGE_TEXT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RANGE_OUTPUT_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_LIST_DEPTH = 12;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_RESULTS = 100;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.runtime']);
const SENSITIVE_BASENAMES = new Set([
  '.env', '.npmrc', '.yarnrc', '.pypirc', '.netrc',
  'credentials', 'credentials.json', 'service-account.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);

export interface AuthorizedProjectRequest {
  projectId: string;
  permissionSessionId?: string;
}

export interface TextFileResult {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface TextRangeResult {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface PathStatResult {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  bytes: number;
  modifiedAt: string;
}

export interface ListedEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  bytes: number | null;
}

export interface ListFilesResult {
  entries: ListedEntry[];
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchTextResult {
  matches: SearchMatch[];
  inspectedFiles: number;
  truncated: boolean;
}

export interface WriteResult {
  path: string;
  bytes: number;
  sha256: string;
  created: boolean;
}

export interface BackupResult {
  backupId: string;
  originalPath: string;
  sha256: string;
  bytes: number;
}

export interface DiffResult {
  path: string;
  currentSha256: string | null;
  changed: boolean;
  diff: string;
}

export interface BatchPatchChange {
  path: string;
  search: string;
  replacement: string;
  expectedSha256: string;
  expectedCount?: number;
}

export interface BatchPatchResult {
  applied: WriteResult[];
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/u).filter(Boolean).map((segment) => segment.toLowerCase());
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const segments = pathSegments(relativePath);
  if (segments.some((segment) => segment === '.git' || segment === '.ssh')) return true;
  const base = segments.at(-1) ?? '';
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(base));
}

function assertSafeContentPath(relativePath: string): void {
  if (isSensitiveRelativePath(relativePath)) {
    throw new AppError({
      code: 'SENSITIVE_PATH',
      message: 'Sensitive credential/configuration paths are not available to coding tools.',
      httpStatus: 403,
      expose: true,
    });
  }
}

function hasPrivateKeyMaterial(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(content);
}

function assertTextBufferLimit(buffer: Buffer, maxBytes: number, label: string): string {
  if (buffer.length > maxBytes) {
    throw new AppError({ code: 'FILE_TOO_LARGE', message: `Text file exceeds the ${label} coding-tool limit.`, httpStatus: 413, expose: true });
  }
  if (buffer.includes(0)) {
    throw new AppError({ code: 'BINARY_FILE', message: 'Binary files are not exposed as text.', httpStatus: 415, expose: true });
  }
  const content = buffer.toString('utf8');
  if (hasPrivateKeyMaterial(content)) {
    throw new AppError({ code: 'SENSITIVE_PATH', message: 'Private key material is blocked from tool output.', httpStatus: 403, expose: true });
  }
  return content;
}

function assertTextBuffer(buffer: Buffer): string {
  return assertTextBufferLimit(buffer, MAX_TEXT_FILE_BYTES, '1 MiB');
}

function assertTextSizeLimit(content: string, maxBytes: number, label: string): void {
  if (byteLength(content) > maxBytes) {
    throw new AppError({ code: 'FILE_TOO_LARGE', message: `Text content exceeds the ${label} coding-tool limit.`, httpStatus: 413, expose: true });
  }
  if (content.includes('\0')) {
    throw new AppError({ code: 'BINARY_FILE', message: 'NUL bytes are not allowed in text writes.', httpStatus: 415, expose: true });
  }
  if (hasPrivateKeyMaterial(content)) {
    throw new AppError({ code: 'SENSITIVE_PATH', message: 'Private key material cannot be written by coding tools.', httpStatus: 403, expose: true });
  }
}

function assertTextSize(content: string): void {
  assertTextSizeLimit(content, MAX_TEXT_FILE_BYTES, '1 MiB');
}

function entryType(entry: Dirent): ListedEntry['type'] {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function existingTextFileWithLimit(resolver: ProjectPathResolver, requestedPath: string, maxBytes: number, label: string): Promise<{ resolved: ResolvedProjectPath; buffer: Buffer; content: string }> {
  const resolved = await resolver.resolveExisting(requestedPath);
  assertSafeContentPath(resolved.relativePath);
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) throw new AppError({ code: 'PATH_INVALID', message: 'Path must refer to a regular file.', httpStatus: 400, expose: true });
  if (fileStat.size > maxBytes) throw new AppError({ code: 'FILE_TOO_LARGE', message: `Text file exceeds the ${label} coding-tool limit.`, httpStatus: 413, expose: true });
  const buffer = await readFile(resolved.absolutePath);
  return { resolved, buffer, content: assertTextBufferLimit(buffer, maxBytes, label) };
}

async function existingTextFile(resolver: ProjectPathResolver, requestedPath: string): Promise<{ resolved: ResolvedProjectPath; buffer: Buffer; content: string }> {
  const resolved = await resolver.resolveExisting(requestedPath);
  assertSafeContentPath(resolved.relativePath);
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new AppError({ code: 'PATH_INVALID', message: 'Path must refer to a regular file.', httpStatus: 400, expose: true });
  }
  if (fileStat.size > MAX_TEXT_FILE_BYTES) {
    throw new AppError({ code: 'FILE_TOO_LARGE', message: 'Text file exceeds the 1 MiB coding-tool limit.', httpStatus: 413, expose: true });
  }
  const buffer = await readFile(resolved.absolutePath);
  return { resolved, buffer, content: assertTextBuffer(buffer) };
}

export class SecureFilesystemService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
    private readonly backupRoot?: string,
  ) {}

  async readTextFile(request: AuthorizedProjectRequest & { path: string }): Promise<TextFileResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const file = await existingTextFile(resolver, request.path);
    return {
      path: file.resolved.relativePath,
      content: file.content,
      bytes: file.buffer.length,
      sha256: sha256(file.buffer),
    };
  }

  async readTextRange(request: AuthorizedProjectRequest & { path: string; startLine?: number; maxLines?: number; maxBytes?: number }): Promise<TextRangeResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const file = await existingTextFileWithLimit(resolver, request.path, MAX_LARGE_TEXT_FILE_BYTES, '16 MiB');
    const lines = file.content.split(/\r?\n/u);
    const startLine = Math.min(Math.max(request.startLine ?? 1, 1), Math.max(lines.length, 1));
    const maxLines = Math.min(Math.max(request.maxLines ?? 400, 1), 2000);
    const maxBytes = Math.min(Math.max(request.maxBytes ?? 128 * 1024, 1024), MAX_RANGE_OUTPUT_BYTES);
    const selected: string[] = [];
    let bytes = 0;
    let endLine = startLine - 1;
    for (let index = startLine - 1; index < lines.length && selected.length < maxLines; index += 1) {
      const line = lines[index] ?? '';
      const addition = (selected.length > 0 ? '\n' : '') + line;
      const additionBytes = byteLength(addition);
      if (selected.length > 0 && bytes + additionBytes > maxBytes) break;
      if (selected.length === 0 && additionBytes > maxBytes) {
        selected.push(Buffer.from(line, 'utf8').subarray(0, maxBytes).toString('utf8'));
        bytes = byteLength(selected[0] ?? '');
        endLine = index + 1;
        break;
      }
      selected.push(line);
      bytes += additionBytes;
      endLine = index + 1;
    }
    return {
      path: file.resolved.relativePath,
      content: selected.join('\n'),
      bytes,
      sha256: sha256(file.buffer),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
    };
  }

  async replaceTextLines(request: AuthorizedProjectRequest & { path: string; startLine: number; endLine: number; replacement: string; expectedSha256: string }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    assertTextSize(request.replacement);
    const resolver = await this.paths.forProject(request.projectId);
    const current = await existingTextFileWithLimit(resolver, request.path, MAX_LARGE_TEXT_FILE_BYTES, '16 MiB');
    this.assertExpectedSha(current, request.expectedSha256);
    const starts = [0];
    for (let index = 0; index < current.content.length; index += 1) if (current.content[index] === '\n') starts.push(index + 1);
    const totalLines = starts.length;
    if (request.startLine < 1 || request.endLine < request.startLine || request.endLine > totalLines) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: `Line range must be within 1..${totalLines}.`, httpStatus: 400, expose: true });
    }
    const startOffset = starts[request.startLine - 1] ?? 0;
    const endOffset = starts[request.endLine] ?? current.content.length;
    const next = current.content.slice(0, startOffset) + request.replacement + current.content.slice(endOffset);
    assertTextSizeLimit(next, MAX_LARGE_TEXT_FILE_BYTES, '16 MiB');
    return this.writeAuthorized(resolver, request.path, next, current);
  }

  async statPath(request: AuthorizedProjectRequest & { path: string }): Promise<PathStatResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const resolved = await resolver.resolveExisting(request.path);
    assertSafeContentPath(resolved.relativePath);
    const info = await lstat(resolved.absolutePath);
    return {
      path: resolved.relativePath,
      type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  }

  async listFiles(request: AuthorizedProjectRequest & { path?: string; depth?: number; maxEntries?: number }): Promise<ListedEntry[]> {
    return (await this.listFilesDetailed(request)).entries;
  }

  async listFilesDetailed(request: AuthorizedProjectRequest & { path?: string; depth?: number; maxEntries?: number }): Promise<ListFilesResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const root = await resolver.resolveExisting(request.path ?? '.');
    assertSafeContentPath(root.relativePath);
    const rootStat = await stat(root.absolutePath);
    if (!rootStat.isDirectory()) throw new AppError({ code: 'PATH_INVALID', message: 'List path must be a directory.', httpStatus: 400, expose: true });

    const maxDepth = Math.min(Math.max(request.depth ?? 2, 0), MAX_LIST_DEPTH);
    const maxEntries = Math.min(Math.max(request.maxEntries ?? 200, 1), MAX_LIST_ENTRIES);
    const results: ListedEntry[] = [];
    const queue: Array<{ absolute: string; depth: number }> = [{ absolute: root.absolutePath, depth: 0 }];
    let truncated = false;

    while (queue.length > 0 && results.length < maxEntries) {
      const current = queue.shift();
      if (!current) break;
      const entries = await readdir(current.absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        if (results.length >= maxEntries) { truncated = true; break; }
        const entry = entries[entryIndex];
        if (!entry) continue;
        if (SKIP_DIRECTORIES.has(entry.name) && entry.isDirectory()) continue;
        const candidateAbsolute = path.join(current.absolute, entry.name);
        const candidateInput = path.relative(resolver.canonicalRoot, candidateAbsolute);
        let resolved: ResolvedProjectPath;
        try {
          resolved = await resolver.resolveExisting(candidateInput);
        } catch (error) {
          if (entry.isSymbolicLink()) {
            results.push({ path: candidateInput, type: 'symlink', bytes: null });
            continue;
          }
          throw error;
        }
        if (isSensitiveRelativePath(resolved.relativePath)) continue;
        const info = await lstat(resolved.absolutePath);
        results.push({ path: resolved.relativePath, type: entryType(entry), bytes: info.isFile() ? info.size : null });
        if (entry.isDirectory() && current.depth < maxDepth) queue.push({ absolute: resolved.absolutePath, depth: current.depth + 1 });
        if (results.length >= maxEntries && entryIndex < entries.length - 1) truncated = true;
      }
    }
    if (queue.length > 0) truncated = true;
    return { entries: results, truncated };
  }

  async searchText(request: AuthorizedProjectRequest & { query: string; path?: string; maxResults?: number }): Promise<SearchMatch[]> {
    return (await this.searchTextDetailed(request)).matches;
  }

  async searchTextDetailed(request: AuthorizedProjectRequest & { query: string; path?: string; maxResults?: number }): Promise<SearchTextResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const query = request.query.trim();
    if (!query) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Search query is required.', httpStatus: 400, expose: true });
    if (query.length > 500) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Search query is too long.', httpStatus: 400, expose: true });
    const resolver = await this.paths.forProject(request.projectId);
    const root = await resolver.resolveExisting(request.path ?? '.');
    const rootStat = await stat(root.absolutePath);
    if (!rootStat.isDirectory()) throw new AppError({ code: 'PATH_INVALID', message: 'Search path must be a directory.', httpStatus: 400, expose: true });
    const maxResults = Math.min(Math.max(request.maxResults ?? 50, 1), MAX_SEARCH_RESULTS);
    const lowerQuery = query.toLowerCase();
    const matches: SearchMatch[] = [];
    const queue = [root.absolutePath];
    let inspectedFiles = 0;

    while (queue.length > 0 && inspectedFiles < MAX_SEARCH_FILES && matches.length < maxResults) {
      const directory = queue.shift();
      if (!directory) break;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= maxResults || inspectedFiles >= MAX_SEARCH_FILES) break;
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        inspectedFiles += 1;
        const candidate = path.relative(resolver.canonicalRoot, path.join(directory, entry.name));
        let file: { resolved: ResolvedProjectPath; buffer: Buffer; content: string };
        try {
          file = await existingTextFile(resolver, candidate);
        } catch (error) {
          if (error instanceof AppError && ['FILE_TOO_LARGE', 'BINARY_FILE', 'SENSITIVE_PATH', 'PATH_OUTSIDE_PROJECT'].includes(error.code)) continue;
          throw error;
        }
        const lines = file.content.split(/\r?\n/u);
        for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex += 1) {
          const line = lines[lineIndex] ?? '';
          const column = line.toLowerCase().indexOf(lowerQuery);
          if (column >= 0) matches.push({ path: file.resolved.relativePath, line: lineIndex + 1, column: column + 1, preview: line.slice(0, 500) });
        }
      }
    }
    return {
      matches,
      inspectedFiles,
      truncated: queue.length > 0 || inspectedFiles >= MAX_SEARCH_FILES || matches.length >= maxResults,
    };
  }

  async writeTextFile(request: AuthorizedProjectRequest & { path: string; content: string; expectedSha256?: string | null }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    assertTextSize(request.content);
    const resolver = await this.paths.forProject(request.projectId);
    const lexical = resolver.resolveLexical(request.path);
    assertSafeContentPath(lexical.relativePath);
    const current = await this.readCurrentForWrite(resolver, request.path);
    this.assertExpectedSha(current, request.expectedSha256);

    let target = await resolver.resolveForWrite(request.path);
    assertSafeContentPath(target.relativePath);
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    target = await resolver.resolveForWrite(request.path);
    const rechecked = await resolver.resolveForWrite(request.path);
    if (rechecked.absolutePath !== target.absolutePath) throw new AppError({ code: 'PATH_INVALID', message: 'Project path changed during write resolution.', httpStatus: 409, expose: true });

    const tempPath = path.join(path.dirname(target.absolutePath), `.mcp-write-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, request.content, { encoding: 'utf8', flag: 'wx' });
      const finalCheck = await resolver.resolveForWrite(request.path);
      if (finalCheck.absolutePath !== target.absolutePath) throw new AppError({ code: 'PATH_INVALID', message: 'Project path changed before atomic commit.', httpStatus: 409, expose: true });
      await rename(tempPath, target.absolutePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const bytes = byteLength(request.content);
    return { path: target.relativePath, bytes, sha256: sha256(request.content), created: current === null };
  }

  async appendTextFile(request: AuthorizedProjectRequest & { path: string; content: string; expectedSha256?: string | null }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    assertTextSize(request.content);
    const resolver = await this.paths.forProject(request.projectId);
    const current = await this.readCurrentForWrite(resolver, request.path);
    this.assertExpectedSha(current, request.expectedSha256);
    const nextContent = (current?.content ?? '') + request.content;
    assertTextSize(nextContent);
    return this.writeAuthorized(resolver, request.path, nextContent, current);
  }

  async diffTextFile(request: AuthorizedProjectRequest & { path: string; proposedContent: string }): Promise<DiffResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    assertTextSize(request.proposedContent);
    const resolver = await this.paths.forProject(request.projectId);
    const current = await this.readCurrentForWrite(resolver, request.path);
    const currentContent = current?.content ?? '';
    return {
      path: current?.resolved.relativePath ?? resolver.resolveLexical(request.path).relativePath,
      currentSha256: current ? sha256(current.buffer) : null,
      changed: currentContent !== request.proposedContent,
      diff: this.simpleUnifiedDiff(currentContent, request.proposedContent),
    };
  }

  async applyPatch(request: AuthorizedProjectRequest & { path: string; search: string; replacement: string; expectedSha256: string; expectedCount?: number }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    const resolver = await this.paths.forProject(request.projectId);
    return this.applyPatchAuthorized(resolver, request);
  }

  async applyBatchPatch(request: AuthorizedProjectRequest & { changes: readonly BatchPatchChange[] }): Promise<BatchPatchResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    if (request.changes.length < 1 || request.changes.length > 20) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Batch patch requires 1 to 20 changes.', httpStatus: 400, expose: true });
    }
    const resolver = await this.paths.forProject(request.projectId);
    const grouped = new Map<string, BatchPatchChange[]>();
    for (const change of request.changes) {
      const bucket = grouped.get(change.path) ?? [];
      bucket.push(change);
      grouped.set(change.path, bucket);
    }

    const originals = new Map<string, { content: string; sha256: string }>();
    const proposed = new Map<string, string>();
    for (const [patchPath, changes] of grouped) {
      const current = await this.readCurrentForWrite(resolver, patchPath);
      if (!current) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Batch patch target does not exist.', httpStatus: 404, expose: true });
      const originalSha = sha256(current.buffer);
      let next = current.content;
      for (const change of changes) {
        if (change.expectedSha256.toLowerCase() !== originalSha) {
          throw new AppError({ code: 'SHA_MISMATCH', message: 'All patches for one file must reference its same current SHA-256.', httpStatus: 409, expose: true });
        }
        next = this.computePatchedContent(next, change.search, change.replacement, change.expectedCount);
      }
      originals.set(patchPath, { content: current.content, sha256: originalSha });
      proposed.set(patchPath, next);
    }

    const applied: WriteResult[] = [];
    try {
      for (const [patchPath, next] of proposed) {
        const current = await this.readCurrentForWrite(resolver, patchPath);
        if (!current) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Batch patch target disappeared before commit.', httpStatus: 409, expose: true });
        this.assertExpectedSha(current, originals.get(patchPath)?.sha256);
        applied.push(await this.writeAuthorized(resolver, patchPath, next, current));
      }
      return { applied };
    } catch (error) {
      for (const [originalPath, original] of [...originals.entries()].reverse()) {
        try {
          const now = await this.readCurrentForWrite(resolver, originalPath);
          if (now) await this.writeAuthorized(resolver, originalPath, original.content, now);
        } catch {
          // Preserve the original operation error; outer workflow will report rollback limitations.
        }
      }
      throw error;
    }
  }

  async copyFile(request: AuthorizedProjectRequest & { from: string; to: string }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    const resolver = await this.paths.forProject(request.projectId);
    const source = await existingTextFile(resolver, request.from);
    const destinationLexical = resolver.resolveLexical(request.to);
    assertSafeContentPath(destinationLexical.relativePath);
    if (await this.pathExists(resolver, request.to)) throw new AppError({ code: 'CONFLICT', message: 'Copy destination already exists.', httpStatus: 409, expose: true });
    let destination = await resolver.resolveForWrite(request.to);
    await mkdir(path.dirname(destination.absolutePath), { recursive: true });
    destination = await resolver.resolveForWrite(request.to);
    await copyFile(source.resolved.absolutePath, destination.absolutePath, 1);
    return { path: destination.relativePath, bytes: source.buffer.length, sha256: sha256(source.buffer), created: true };
  }

  async moveFile(request: AuthorizedProjectRequest & { from: string; to: string; expectedSha256: string }): Promise<WriteResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    const resolver = await this.paths.forProject(request.projectId);
    const source = await this.readCurrentForWrite(resolver, request.from);
    if (!source) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Move source does not exist.', httpStatus: 404, expose: true });
    this.assertExpectedSha(source, request.expectedSha256);
    if (await this.pathExists(resolver, request.to)) throw new AppError({ code: 'CONFLICT', message: 'Move destination already exists.', httpStatus: 409, expose: true });
    let destination = await resolver.resolveForWrite(request.to);
    assertSafeContentPath(destination.relativePath);
    await mkdir(path.dirname(destination.absolutePath), { recursive: true });
    destination = await resolver.resolveForWrite(request.to);
    await rename(source.resolved.absolutePath, destination.absolutePath);
    return { path: destination.relativePath, bytes: source.buffer.length, sha256: sha256(source.buffer), created: true };
  }

  async deleteFile(request: AuthorizedProjectRequest & { path: string; expectedSha256: string }): Promise<BackupResult> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.write' });
    const resolver = await this.paths.forProject(request.projectId);
    const current = await this.readCurrentForWrite(resolver, request.path);
    if (!current) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Delete target does not exist.', httpStatus: 404, expose: true });
    this.assertExpectedSha(current, request.expectedSha256);
    if (!this.backupRoot) {
      throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Delete requires persistent backup storage.', httpStatus: 503, expose: true });
    }
    const backupId = randomUUID();
    const directory = path.join(this.backupRoot, request.projectId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${backupId}.bak`), current.buffer, { flag: 'wx' });
    const finalCheck = await resolver.resolveExisting(request.path);
    if (finalCheck.absolutePath !== current.resolved.absolutePath) throw new AppError({ code: 'PATH_INVALID', message: 'Project path changed before delete.', httpStatus: 409, expose: true });
    await rm(current.resolved.absolutePath);
    return { backupId, originalPath: current.resolved.relativePath, sha256: sha256(current.buffer), bytes: current.buffer.length };
  }

  private async applyPatchAuthorized(
    resolver: ProjectPathResolver,
    request: { path: string; search: string; replacement: string; expectedSha256: string; expectedCount?: number },
  ): Promise<WriteResult> {
    const current = await this.readCurrentForWrite(resolver, request.path);
    if (!current) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Patch target does not exist.', httpStatus: 404, expose: true });
    this.assertExpectedSha(current, request.expectedSha256);
    const next = this.computePatchedContent(current.content, request.search, request.replacement, request.expectedCount);
    return this.writeAuthorized(resolver, request.path, next, current);
  }

  private computePatchedContent(content: string, search: string, replacement: string, expectedCount?: number): string {
    if (!search) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Patch search text must not be empty.', httpStatus: 400, expose: true });
    const count = Math.min(Math.max(expectedCount ?? 1, 1), 100);
    const matches = content.split(search).length - 1;
    if (matches !== count) throw new AppError({ code: 'PATCH_FAILED', message: `Patch expected ${count} match(es) but found ${matches}.`, httpStatus: 409, expose: true });
    const next = content.split(search).join(replacement);
    assertTextSize(next);
    return next;
  }

  private simpleUnifiedDiff(before: string, after: string): string {
    if (before === after) return '';
    const oldLines = before.split(/\r?\n/u);
    const newLines = after.split(/\r?\n/u);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix += 1;
    const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
    const newChanged = newLines.slice(prefix, newLines.length - suffix);
    const header = `@@ -${prefix + 1},${oldChanged.length} +${prefix + 1},${newChanged.length} @@`;
    return [header, ...oldChanged.map((line) => `-${line}`), ...newChanged.map((line) => `+${line}`)].join('\n');
  }

  private async readCurrentForWrite(resolver: ProjectPathResolver, requestedPath: string): Promise<{ resolved: ResolvedProjectPath; buffer: Buffer; content: string } | null> {
    const lexical = resolver.resolveLexical(requestedPath);
    assertSafeContentPath(lexical.relativePath);
    try {
      return await existingTextFile(resolver, requestedPath);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private assertExpectedSha(current: { buffer: Buffer } | null, expectedSha256: string | null | undefined): void {
    if (!current) {
      if (expectedSha256) throw new AppError({ code: 'SHA_MISMATCH', message: 'Expected SHA-256 was supplied but target does not exist.', httpStatus: 409, expose: true });
      return;
    }
    if (!expectedSha256) throw new AppError({ code: 'SHA_MISMATCH', message: 'Overwriting an existing file requires its current SHA-256.', httpStatus: 409, expose: true });
    if (sha256(current.buffer) !== expectedSha256.toLowerCase()) throw new AppError({ code: 'SHA_MISMATCH', message: 'File changed since it was read.', httpStatus: 409, expose: true });
  }

  private async writeAuthorized(
    resolver: ProjectPathResolver,
    requestedPath: string,
    content: string,
    current: { resolved: ResolvedProjectPath; buffer: Buffer; content: string } | null,
  ): Promise<WriteResult> {
    let target = await resolver.resolveForWrite(requestedPath);
    assertSafeContentPath(target.relativePath);
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    target = await resolver.resolveForWrite(requestedPath);
    const tempPath = path.join(path.dirname(target.absolutePath), `.mcp-write-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
      const finalCheck = await resolver.resolveForWrite(requestedPath);
      if (finalCheck.absolutePath !== target.absolutePath) throw new AppError({ code: 'PATH_INVALID', message: 'Project path changed before atomic commit.', httpStatus: 409, expose: true });
      await rename(tempPath, target.absolutePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { path: target.relativePath, bytes: byteLength(content), sha256: sha256(content), created: current === null };
  }

  private async pathExists(resolver: ProjectPathResolver, requestedPath: string): Promise<boolean> {
    try {
      await resolver.resolveExisting(requestedPath);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false;
      throw error;
    }
  }
}
