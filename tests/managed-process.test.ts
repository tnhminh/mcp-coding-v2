import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('managed process runtime', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-process-'));
    root = path.join(workspace, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'managed-process-fixture',
      private: true,
      scripts: {
        dev: 'node dev.mjs',
        build: 'node -e "process.exit(0)"',
      },
    }), 'utf8');
    await writeFile(path.join(root, 'dev.mjs'), [
      "console.log('managed-process-ready');",
      "setInterval(() => console.log('heartbeat'), 1000);",
    ].join('\n'), 'utf8');

    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    const project = createProject({ name: 'Process Fixture', alias: 'process-fixture', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'process-agent',
      capabilities: ['filesystem.read', 'command.run'],
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

  test('discovers only long-running package profiles and manages start/status/log/stop lifecycle', async () => {
    const profiles = await services.processes.profiles({ projectId, permissionSessionId: sessionId });
    expect(profiles.map((profile) => profile.id)).toEqual(['package:dev']);

    const started = await services.processes.start({ projectId, permissionSessionId: sessionId, profileId: 'package:dev' });
    expect(started).toMatchObject({ projectId, profileId: 'package:dev', state: 'running' });
    expect(started.pid).toBeGreaterThan(0);

    let status = await services.processes.status({ projectId, processId: started.id, permissionSessionId: sessionId });
    const deadline = Date.now() + 3000;
    while (!status.stdout.includes('managed-process-ready') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await services.processes.status({ projectId, processId: started.id, permissionSessionId: sessionId });
    }
    expect(status.state).toBe('running');
    expect(status.stdout).toContain('managed-process-ready');

    const listed = await services.processes.list({ projectId, permissionSessionId: sessionId });
    expect(listed.map((item) => item.id)).toContain(started.id);

    await expect(services.processes.start({ projectId, permissionSessionId: sessionId, profileId: 'package:dev' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const stopped = await services.processes.stop({ projectId, processId: started.id, permissionSessionId: sessionId });
    expect(stopped.state).toBe('stopped');
  }, 20_000);

  test('does not expose arbitrary package scripts as managed process profiles', async () => {
    const profiles = await services.processes.profiles({ projectId, permissionSessionId: sessionId });
    expect(profiles.map((profile) => profile.id)).not.toContain('package:build');
    await expect(services.processes.start({ projectId, permissionSessionId: sessionId, profileId: 'package:build' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
