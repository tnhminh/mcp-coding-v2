import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthorizationService } from '../src/app/authorization-service.js';
import { AppError } from '../src/app/errors.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createAuthorizationPolicy } from '../src/domain/authorization/policy.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';
import { SqlitePermissionSessionRepository } from '../src/infra/sqlite/sqlite-permission-session-repository.js';
import { SqlitePolicyRepository } from '../src/infra/sqlite/sqlite-policy-repository.js';
import { SqliteProjectRepository } from '../src/infra/sqlite/sqlite-project-repository.js';

describe('authorization foundation', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let projects: SqliteProjectRepository;
  let sessions: SqlitePermissionSessionRepository;
  let policies: SqlitePolicyRepository;
  let authorization: AuthorizationService;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-auth-'));
    projects = new SqliteProjectRepository(db.database);
    sessions = new SqlitePermissionSessionRepository(db.database);
    policies = new SqlitePolicyRepository(db.database);
    authorization = new AuthorizationService(projects, sessions, policies);
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function addProject(alias: string): Promise<ReturnType<typeof createProject>> {
    const rootPath = path.join(workspace, alias);
    await mkdir(rootPath, { recursive: true });
    const project = createProject({ name: alias, alias, rootPath });
    await projects.save(project);
    return project;
  }

  test('persists bounded permission sessions and authorizes only granted capability for the same project', async () => {
    const project = await addProject('alpha');
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'local-agent',
      capabilities: ['filesystem.read', 'filesystem.read', 'command.run'],
      ttlSeconds: 3600,
    });
    await sessions.save(session);

    expect((await sessions.findById(session.id))?.capabilities).toEqual(['filesystem.read', 'command.run']);
    await expect(authorization.authorize({ projectId: project.id, permissionSessionId: session.id, capability: 'filesystem.read' })).resolves.toMatchObject({ id: session.id });
    await expect(authorization.authorize({ projectId: project.id, permissionSessionId: session.id, capability: 'filesystem.write' })).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  });

  test('rejects wrong-project, expired and revoked sessions', async () => {
    const alpha = await addProject('alpha');
    const beta = await addProject('beta');
    const now = new Date('2026-08-25T10:00:00.000Z');
    const session = createPermissionSession({
      projectId: alpha.id,
      principalId: 'local-agent',
      capabilities: ['filesystem.read'],
      ttlSeconds: 60,
    }, { now });
    await sessions.save(session);

    await expect(authorization.authorize({ projectId: beta.id, permissionSessionId: session.id, capability: 'filesystem.read', now })).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await expect(authorization.authorize({ projectId: alpha.id, permissionSessionId: session.id, capability: 'filesystem.read', now: new Date(now.getTime() + 61_000) })).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED' });

    const active = createPermissionSession({ projectId: alpha.id, principalId: 'local-agent', capabilities: ['filesystem.read'], ttlSeconds: 3600 }, { now });
    await sessions.save(active);
    expect(await sessions.revoke(active.id, now.toISOString())).toBe(true);
    await expect(authorization.authorize({ projectId: alpha.id, permissionSessionId: active.id, capability: 'filesystem.read', now })).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED' });
  });

  test('global and project deny policies override a valid session grant', async () => {
    const alpha = await addProject('alpha');
    const beta = await addProject('beta');
    const sessionA = createPermissionSession({ projectId: alpha.id, principalId: 'agent', capabilities: ['command.run'], ttlSeconds: 3600 });
    const sessionB = createPermissionSession({ projectId: beta.id, principalId: 'agent', capabilities: ['command.run'], ttlSeconds: 3600 });
    await sessions.save(sessionA);
    await sessions.save(sessionB);

    const projectDeny = createAuthorizationPolicy({ name: 'freeze-alpha-commands', projectId: alpha.id, capability: 'command.run', effect: 'deny', reason: 'maintenance' });
    await policies.save(projectDeny);
    await expect(authorization.authorize({ projectId: alpha.id, permissionSessionId: sessionA.id, capability: 'command.run' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(authorization.authorize({ projectId: beta.id, permissionSessionId: sessionB.id, capability: 'command.run' })).resolves.toBeDefined();

    const globalDeny = createAuthorizationPolicy({ name: 'freeze-all-commands', capability: 'command.run', effect: 'deny' });
    await policies.save(globalDeny);
    await expect(authorization.authorize({ projectId: beta.id, permissionSessionId: sessionB.id, capability: 'command.run' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('inactive projects fail closed even with a valid session', async () => {
    const project = await addProject('alpha');
    await projects.save({ ...project, status: 'inactive', updatedAt: new Date().toISOString() });
    const session = createPermissionSession({ projectId: project.id, principalId: 'agent', capabilities: ['filesystem.read'], ttlSeconds: 3600 });
    await sessions.save(session);
    await expect(authorization.authorize({ projectId: project.id, permissionSessionId: session.id, capability: 'filesystem.read' })).rejects.toBeInstanceOf(AppError);
  });
});
