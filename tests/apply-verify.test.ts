import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('apply + verify orchestration', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-apply-verify-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    const databasePath = path.join(workspace, 'runtime.sqlite');
    db = openSqliteDatabase(databasePath);
    services = createRuntimeServices(db.database, databasePath);

    await writeFile(path.join(root, 'src', 'value.txt'), 'good\n', 'utf8');
    await writeFile(path.join(root, 'scripts', 'verify.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync('src/value.txt','utf8');",
      "if (value !== 'good\\n') { console.error('value-invalid=' + JSON.stringify(value)); process.exit(1); }",
      "console.log('verify-pass');",
    ].join('\n'), 'utf8');
    await mkdir(path.join(root, '.mcp'), { recursive: true });
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({
      version: 1,
      profiles: { test: { executable: 'node', args: ['scripts/verify.mjs'] } },
    }), 'utf8');

    const project = createProject({ name: 'Apply Verify', alias: 'apply-verify', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'apply-agent',
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

  test('keeps applied changes when all requested verification tasks pass', async () => {
    const current = await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' });
    const result = await services.applyVerify.applyAndVerify({
      projectId,
      permissionSessionId: sessionId,
      changes: [{ op: 'replace', path: 'src/value.txt', search: 'good', replacement: 'good', expectedSha256: current.sha256 }],
      tasks: ['test'],
    });
    expect(result.verified).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.verification).toHaveLength(1);
    expect(result.verification[0]).toMatchObject({ task: 'test', success: true });
    expect((await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' })).content).toBe('good\n');
  });

  test('rolls an existing file back when verification fails', async () => {
    const current = await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' });
    const result = await services.applyVerify.applyAndVerify({
      projectId,
      permissionSessionId: sessionId,
      changes: [{ op: 'replace', path: 'src/value.txt', search: 'good', replacement: 'bad', expectedSha256: current.sha256 }],
      tasks: ['test'],
    });
    expect(result.verified).toBe(false);
    expect(result.verification[0]).toMatchObject({ task: 'test', success: false });
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackErrors).toEqual([]);
    expect((await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' })).content).toBe('good\n');
  });

  test('removes a newly created file during rollback after verification failure', async () => {
    const current = await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' });
    const result = await services.applyVerify.applyAndVerify({
      projectId,
      permissionSessionId: sessionId,
      changes: [
        { op: 'replace', path: 'src/value.txt', search: 'good', replacement: 'bad', expectedSha256: current.sha256 },
        { op: 'write', path: 'src/generated.txt', content: 'temporary\n' },
      ],
      tasks: ['test'],
    });
    expect(result.verified).toBe(false);
    expect(result.rolledBack).toBe(true);
    await expect(services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/generated.txt' })).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
    expect((await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' })).content).toBe('good\n');
  });

  test('can intentionally keep a failed change when rollback is disabled', async () => {
    const current = await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' });
    const result = await services.applyVerify.applyAndVerify({
      projectId,
      permissionSessionId: sessionId,
      changes: [{ op: 'replace', path: 'src/value.txt', search: 'good', replacement: 'bad', expectedSha256: current.sha256 }],
      tasks: ['test'],
      rollbackOnFailure: false,
    });
    expect(result.verified).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect((await services.filesystem.readTextFile({ projectId, permissionSessionId: sessionId, path: 'src/value.txt' })).content).toBe('bad\n');
  });
});
