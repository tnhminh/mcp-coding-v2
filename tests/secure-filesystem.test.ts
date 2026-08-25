import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthorizationService } from '../src/app/authorization-service.js';
import { ProjectPathResolverFactory } from '../src/app/project-path-resolver-factory.js';
import { SecureFilesystemService } from '../src/app/secure-filesystem-service.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createAuthorizationPolicy } from '../src/domain/authorization/policy.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';
import { SqlitePermissionSessionRepository } from '../src/infra/sqlite/sqlite-permission-session-repository.js';
import { SqlitePolicyRepository } from '../src/infra/sqlite/sqlite-policy-repository.js';
import { SqliteProjectRepository } from '../src/infra/sqlite/sqlite-project-repository.js';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

describe('SecureFilesystemService', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let rootA: string;
  let rootB: string;
  let projectA: ReturnType<typeof createProject>;
  let projectB: ReturnType<typeof createProject>;
  let sessionId: string;
  let filesystem: SecureFilesystemService;
  let policies: SqlitePolicyRepository;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-fs-'));
    rootA = path.join(workspace, 'project-a'); rootB = path.join(workspace, 'project-b');
    await mkdir(path.join(rootA, 'src'), { recursive: true }); await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, 'src', 'app.ts'), 'export const value = 1;\n// needle here\n', 'utf8');
    await writeFile(path.join(rootA, '.env'), 'SECRET=hidden\n', 'utf8');
    await writeFile(path.join(rootA, 'binary.bin'), Buffer.from([1, 0, 2, 3]));
    await writeFile(path.join(rootB, 'secret.txt'), 'outside', 'utf8');
    db = openSqliteDatabase(':memory:');
    const projects = new SqliteProjectRepository(db.database);
    const sessions = new SqlitePermissionSessionRepository(db.database);
    policies = new SqlitePolicyRepository(db.database);
    projectA = createProject({ name: 'A', alias: 'a', rootPath: rootA });
    projectB = createProject({ name: 'B', alias: 'b', rootPath: rootB });
    await projects.save(projectA); await projects.save(projectB);
    const session = createPermissionSession({ projectId: projectA.id, principalId: 'agent', capabilities: ['filesystem.read', 'filesystem.write'], ttlSeconds: 3600 });
    await sessions.save(session); sessionId = session.id;
    filesystem = new SecureFilesystemService(new AuthorizationService(projects, sessions, policies), new ProjectPathResolverFactory(projects), path.join(workspace, 'backups'));
  });

  afterEach(async () => { db.close(); await rm(workspace, { recursive: true, force: true }); });

  const auth = () => ({ projectId: projectA.id, permissionSessionId: sessionId });

  test('reads, stats, lists and searches bounded project text without leaking sensitive files', async () => {
    const read = await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' });
    expect(read.content).toContain('needle'); expect(read.sha256).toBe(hash(read.content));
    expect((await filesystem.statPath({ ...auth(), path: 'src/app.ts' })).type).toBe('file');
    const listed = await filesystem.listFiles({ ...auth(), path: '.', depth: 3 });
    expect(listed.map((entry) => entry.path)).toContain(path.join('src', 'app.ts'));
    expect(listed.map((entry) => entry.path)).not.toContain('.env');
    const matches = await filesystem.searchText({ ...auth(), query: 'needle' });
    expect(matches).toEqual([expect.objectContaining({ path: path.join('src', 'app.ts'), line: 2 })]);
  });

  test('blocks sensitive, binary, traversal, cross-project and junction escape reads', async () => {
    await expect(filesystem.readTextFile({ ...auth(), path: '.env' })).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
    await expect(filesystem.readTextFile({ ...auth(), path: 'binary.bin' })).rejects.toMatchObject({ code: 'BINARY_FILE' });
    await expect(filesystem.readTextFile({ ...auth(), path: path.join('..', 'project-b', 'secret.txt') })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    const link = path.join(rootA, 'escape');
    await symlink(rootB, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(filesystem.readTextFile({ ...auth(), path: path.join('escape', 'secret.txt') })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });

  test('requires write capability and obeys deny policies', async () => {
    const deny = createAuthorizationPolicy({ name: 'freeze-write', projectId: projectA.id, capability: 'filesystem.write', effect: 'deny' });
    await policies.save(deny);
    await expect(filesystem.writeTextFile({ ...auth(), path: 'new.ts', content: 'new' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('creates atomically and requires optimistic SHA-256 for overwrite', async () => {
    const created = await filesystem.writeTextFile({ ...auth(), path: 'src/new.ts', content: 'export const n = 1;\n' });
    expect(created.created).toBe(true);
    const original = await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' });
    await expect(filesystem.writeTextFile({ ...auth(), path: 'src/app.ts', content: 'changed' })).rejects.toMatchObject({ code: 'SHA_MISMATCH' });
    await expect(filesystem.writeTextFile({ ...auth(), path: 'src/app.ts', content: 'changed', expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'SHA_MISMATCH' });
    const written = await filesystem.writeTextFile({ ...auth(), path: 'src/app.ts', content: 'changed', expectedSha256: original.sha256 });
    expect(written.sha256).toBe(hash('changed'));
    expect(await readFile(path.join(rootA, 'src', 'app.ts'), 'utf8')).toBe('changed');
  });

  test('previews diff and applies a validated multi-file batch patch', async () => {
    await writeFile(path.join(rootA, 'src', 'second.ts'), 'export const second = 1;\n', 'utf8');
    const first = await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' });
    const second = await filesystem.readTextFile({ ...auth(), path: 'src/second.ts' });
    const preview = await filesystem.diffTextFile({ ...auth(), path: 'src/app.ts', proposedContent: first.content.replace('value = 1', 'value = 9') });
    expect(preview.changed).toBe(true);
    expect(preview.diff).toContain('-export const value = 1;');
    expect(preview.diff).toContain('+export const value = 9;');
    const batch = await filesystem.applyBatchPatch({ ...auth(), changes: [
      { path: 'src/app.ts', search: 'value = 1', replacement: 'value = 3', expectedSha256: first.sha256 },
      { path: 'src/second.ts', search: 'second = 1', replacement: 'second = 2', expectedSha256: second.sha256 },
    ] });
    expect(batch.applied).toHaveLength(2);
    expect((await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' })).content).toContain('value = 3');
    expect((await filesystem.readTextFile({ ...auth(), path: 'src/second.ts' })).content).toContain('second = 2');
  });

  test('applies exact patch, append, copy, move and backed-up delete with SHA guards', async () => {
    const original = await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' });
    const patched = await filesystem.applyPatch({ ...auth(), path: 'src/app.ts', search: 'value = 1', replacement: 'value = 2', expectedSha256: original.sha256 });
    expect((await filesystem.readTextFile({ ...auth(), path: 'src/app.ts' })).content).toContain('value = 2');
    const appended = await filesystem.appendTextFile({ ...auth(), path: 'src/app.ts', content: '// end\n', expectedSha256: patched.sha256 });
    const copied = await filesystem.copyFile({ ...auth(), from: 'src/app.ts', to: 'src/copied.ts' });
    expect(copied.sha256).toBe(appended.sha256);
    const moved = await filesystem.moveFile({ ...auth(), from: 'src/copied.ts', to: 'src/moved.ts', expectedSha256: copied.sha256 });
    const deleted = await filesystem.deleteFile({ ...auth(), path: 'src/moved.ts', expectedSha256: moved.sha256 });
    expect(deleted.originalPath).toBe(path.join('src', 'moved.ts'));
    expect(await readFile(path.join(workspace, 'backups', projectA.id, `${deleted.backupId}.bak`), 'utf8')).toContain('value = 2');
    await expect(filesystem.readTextFile({ ...auth(), path: 'src/moved.ts' })).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });

  test('rejects unsafe write destinations and oversized/private-key content', async () => {
    await expect(filesystem.writeTextFile({ ...auth(), path: '.git/config', content: 'x' })).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
    await expect(filesystem.writeTextFile({ ...auth(), path: '.env.local', content: 'x' })).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
    await expect(filesystem.writeTextFile({ ...auth(), path: 'key.txt', content: '-----BEGIN PRIVATE KEY-----\nabc' })).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
    await expect(filesystem.writeTextFile({ ...auth(), path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
