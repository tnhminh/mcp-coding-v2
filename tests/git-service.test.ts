import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { runSafeProcess } from '../src/app/safe-process-runner.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('native Git runtime', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let sessionId: string;

  async function git(args: string[]): Promise<void> {
    const result = await runSafeProcess({ executable: 'git', args, cwd: root, timeoutSeconds: 30 });
    if (!result.success) throw new Error(result.stderr || result.stdout || 'git fixture failed');
  }

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-git-'));
    root = path.join(workspace, 'repo');
    await mkdir(root, { recursive: true });
    await git(['init']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
    await git(['add', 'README.md']);
    await git(['commit', '-m', 'initial']);

    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    const project = createProject({ name: 'Git Fixture', alias: 'git-fixture', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'git-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run', 'git.read', 'git.write'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
    sessionId = session.id;
  });

  afterEach(async () => {
    await services?.processes.closeAll().catch(() => undefined);
    db?.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('supports structured local status, diff, stage, commit and branch operations without touching remotes', async () => {
    const initial = await services.git.status({ projectId, permissionSessionId: sessionId });
    expect(initial.clean).toBe(true);
    expect(initial.branch).toBeTruthy();

    await writeFile(path.join(root, 'README.md'), '# changed\n', 'utf8');
    const dirty = await services.git.status({ projectId, permissionSessionId: sessionId });
    expect(dirty.clean).toBe(false);
    expect((await services.git.diff({ projectId, permissionSessionId: sessionId })).diff).toContain('+# changed');

    await services.git.stage({ projectId, permissionSessionId: sessionId, paths: ['README.md'] });
    const stagedDiff = await services.git.diff({ projectId, permissionSessionId: sessionId, staged: true });
    expect(stagedDiff.diff).toContain('+# changed');

    const committed = await services.git.commit({ projectId, permissionSessionId: sessionId, message: 'update fixture' });
    expect(committed.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(committed.status.clean).toBe(true);
    expect((await services.git.log({ projectId, permissionSessionId: sessionId, limit: 2 })).commits[0]?.subject).toBe('update fixture');

    const originalBranch = committed.status.branch ?? 'master';
    const created = await services.git.createBranch({ projectId, permissionSessionId: sessionId, name: 'agent/checkpoint' });
    expect(created.status.branch).toBe('agent/checkpoint');
    expect((await services.git.branches({ projectId, permissionSessionId: sessionId })).branches.map((branch) => branch.name)).toContain(originalBranch);
    const switched = await services.git.switchBranch({ projectId, permissionSessionId: sessionId, name: originalBranch });
    expect(switched.status.branch).toBe(originalBranch);
  }, 30_000);

  test('restores project paths only with the stronger destructive capability envelope', async () => {
    await writeFile(path.join(root, 'README.md'), '# destructive change\n', 'utf8');
    const restored = await services.git.restorePaths({ projectId, permissionSessionId: sessionId, paths: ['README.md'] });
    expect(restored.status.clean).toBe(true);
  });

  test('refuses a registered project nested inside a larger repository root', async () => {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const project = createProject({ name: 'Nested', alias: 'nested-git', rootPath: nested });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'nested-agent',
      capabilities: ['git.read'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    await expect(services.git.status({ projectId: project.id, permissionSessionId: session.id })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });
});
