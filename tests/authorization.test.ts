import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthorizationService } from '../src/app/authorization-service.js';
import { AppError } from '../src/app/errors.js';
import { createPermissionSession, MAX_PERMISSION_SESSION_TTL_SECONDS, NO_EXPIRY_PERMISSION_SESSION_TTL_SECONDS, NO_EXPIRY_TIMESTAMP } from '../src/domain/authorization/permission-session.js';
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

  test('supports 150-day and explicit no-expiry sessions while preserving revoke semantics', async () => {
    const project = await addProject('long-lived');
    const now = new Date('2026-08-27T08:00:00.000Z');

    const finite = createPermissionSession({
      projectId: project.id,
      principalId: 'long-lived-agent',
      capabilities: ['filesystem.read'],
      ttlSeconds: MAX_PERMISSION_SESSION_TTL_SECONDS,
    }, { now });
    expect(Date.parse(finite.expiresAt) - now.getTime()).toBe(MAX_PERMISSION_SESSION_TTL_SECONDS * 1000);

    const noExpiry = createPermissionSession({
      projectId: project.id,
      principalId: 'trusted-local-agent',
      capabilities: ['filesystem.read'],
      ttlSeconds: NO_EXPIRY_PERMISSION_SESSION_TTL_SECONDS,
    }, { now });
    expect(noExpiry.expiresAt).toBe(NO_EXPIRY_TIMESTAMP);
    await sessions.save(noExpiry);
    await expect(authorization.authorize({
      projectId: project.id,
      permissionSessionId: noExpiry.id,
      capability: 'filesystem.read',
      now: new Date('2099-01-01T00:00:00.000Z'),
    })).resolves.toMatchObject({ id: noExpiry.id });

    expect(await sessions.revoke(noExpiry.id, now.toISOString())).toBe(true);
    await expect(authorization.authorize({
      projectId: project.id,
      permissionSessionId: noExpiry.id,
      capability: 'filesystem.read',
      now,
    })).rejects.toMatchObject({ code: 'PERMISSION_EXPIRED' });
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

  test('auto-resolves the newest equivalent active session when permission_session_id is omitted', async () => {
    const project = await addProject('auto');
    const older = createPermissionSession({
      projectId: project.id,
      principalId: 'local-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    }, { now: new Date('2026-08-26T08:00:00.000Z') });
    const newer = createPermissionSession({
      projectId: project.id,
      principalId: 'local-agent',
      capabilities: ['command.run', 'filesystem.write', 'filesystem.read'],
      ttlSeconds: 3600,
    }, { now: new Date('2026-08-26T08:01:00.000Z') });
    await sessions.save(older);
    await sessions.save(newer);

    await expect(authorization.resolvePermissionSession({
      projectId: project.id,
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      now: new Date('2026-08-26T08:02:00.000Z'),
    })).resolves.toMatchObject({ id: newer.id });
  });

  test('omitted permission_session_id fails closed when distinct active authorization envelopes exist', async () => {
    const project = await addProject('ambiguous');
    const first = createPermissionSession({ projectId: project.id, principalId: 'agent-a', capabilities: ['filesystem.read'], ttlSeconds: 3600 });
    const second = createPermissionSession({ projectId: project.id, principalId: 'agent-b', capabilities: ['filesystem.read'], ttlSeconds: 3600 });
    await sessions.save(first);
    await sessions.save(second);

    let caught: unknown;
    try {
      await authorization.authorize({ projectId: project.id, capability: 'filesystem.read' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    if (!(caught instanceof AppError)) throw new Error('Expected AppError');
    expect(caught.code).toBe('PERMISSION_REQUIRED');
    expect(caught.message).toContain('Multiple distinct active permission sessions');
  });

  test('access introspection reports usable, missing, ambiguous and policy-denied capabilities without exposing session ids', async () => {
    const project = await addProject('inspect');
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await sessions.save(session);

    const snapshot = await authorization.inspectAccess({ projectId: project.id, permissionSessionId: session.id });
    expect(snapshot.codingEnvelope).toMatchObject({ usable: true, state: 'granted' });
    expect(snapshot.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'filesystem.read', usable: true, state: 'granted' }),
      expect.objectContaining({ capability: 'git.read', usable: false, state: 'missing' }),
    ]));
    expect(JSON.stringify(snapshot)).not.toContain(session.id);

    await policies.save(createAuthorizationPolicy({ name: 'freeze-commands', projectId: project.id, capability: 'command.run', effect: 'deny' }));
    const denied = await authorization.inspectAccess({ projectId: project.id, permissionSessionId: session.id });
    expect(denied.codingEnvelope).toMatchObject({ usable: false, state: 'policy_denied' });
    expect(denied.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'command.run', usable: false, state: 'policy_denied' }),
    ]));
  });

  test('inactive projects fail closed even with a valid session', async () => {
    const project = await addProject('alpha');
    await projects.save({ ...project, status: 'inactive', updatedAt: new Date().toISOString() });
    const session = createPermissionSession({ projectId: project.id, principalId: 'agent', capabilities: ['filesystem.read'], ttlSeconds: 3600 });
    await sessions.save(session);
    await expect(authorization.authorize({ projectId: project.id, permissionSessionId: session.id, capability: 'filesystem.read' })).rejects.toBeInstanceOf(AppError);
  });
});
