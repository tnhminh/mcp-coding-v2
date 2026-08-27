import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('project readiness preflight', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-readiness-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'vendor', 'fixture-dep'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'fixture-dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }), 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'readiness-fixture',
      version: '1.0.0',
      private: true,
      scripts: { typecheck: 'node -e "process.exit(0)"' },
      devDependencies: { 'fixture-dep': 'file:./vendor/fixture-dep' },
    }), 'utf8');

    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    const project = createProject({ name: 'Readiness', alias: 'readiness', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'readiness-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
    sessionId = session.id;
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('detects missing dependency artifacts and prepare_workspace installs them before baseline verification', async () => {
    const before = await services.readiness.inspect({ projectId, permissionSessionId: sessionId });
    expect(before).toMatchObject({
      dependencyState: 'missing',
      readyForCoding: false,
      readyForVerification: false,
    });
    expect(before.recommendedPreparation).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run_recipe', recipe: 'package.install' }),
    ]));

    const prepared = await services.readiness.prepare({
      projectId,
      permissionSessionId: sessionId,
      baselineTasks: ['typecheck'],
    });
    expect(prepared.actions).toHaveLength(1);
    expect(prepared.actions[0]).toMatchObject({ kind: 'run_recipe', recipe: 'package.install', result: { success: true } });
    expect(prepared.after.dependencyState).toBe('ready');
    expect(prepared.baseline).toEqual([
      expect.objectContaining({ task: 'typecheck', success: true, failureKind: 'none' }),
    ]);
    expect(prepared.baselineReady).toBe(true);
  }, 30_000);

  test('publishes non-Node dependency preparation recipes without forcing unsafe global Python installs', async () => {
    await rm(path.join(root, 'package.json'));
    await writeFile(path.join(root, 'go.mod'), 'module example.com/readiness\n\ngo 1.22\n', 'utf8');
    await writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n', 'utf8');
    await writeFile(path.join(root, 'requirements.txt'), 'example-package==1.0.0\n', 'utf8');
    const snapshot = await services.readiness.inspect({ projectId, permissionSessionId: sessionId });
    expect(snapshot.recommendedPreparation).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run_recipe', recipe: 'go.mod_download', automatic: true }),
      expect.objectContaining({ kind: 'run_recipe', recipe: 'cargo.fetch', automatic: true }),
      expect.objectContaining({ kind: 'run_recipe', recipe: 'python.install_requirements', automatic: false }),
    ]));
  });

  test('detects interactive Next lint configuration before an autonomous coding cycle', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'readiness-fixture',
      version: '1.0.0',
      private: true,
      scripts: { lint: 'next lint' },
    }), 'utf8');
    const snapshot = await services.readiness.inspect({ projectId, permissionSessionId: sessionId });
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'configuration_required', task: 'lint', blocking: false }),
    ]));
    expect(snapshot.readyForCoding).toBe(true);
    expect(snapshot.readyForVerification).toBe(false);
  });
});
