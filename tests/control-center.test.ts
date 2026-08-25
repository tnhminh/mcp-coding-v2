import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { JsonLogger } from '../src/infra/json-logger.js';
import { startHttpRuntime, type HttpRuntime } from '../src/runtime/http-runtime.js';

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Unable to reserve port'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

describe('Control Center', () => {
  let runtime: HttpRuntime | undefined;
  let workspace: string | undefined;

  afterEach(async () => {
    if (runtime) await runtime.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    runtime = undefined;
    workspace = undefined;
  });

  test('serves the operational dashboard and real overview APIs', async () => {
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );

    const page = await fetch(`http://127.0.0.1:${port}/control-center`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Control Center');

    const overview = await fetch(`http://127.0.0.1:${port}/api/control-center/overview`);
    expect(overview.status).toBe(200);
    const data = await overview.json() as { counts: { projects: number }; modules: Array<{ id: string; state: string }> };
    expect(data.counts.projects).toBe(0);
    expect(data.modules.find((module) => module.id === 'projects')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'permissions')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'policies')?.state).toBe('available');
  });

  test('creates permission sessions and policies through human-facing CMS APIs', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-cc-auth-'));
    const projectRoot = path.join(workspace, 'auth-project');
    await mkdir(projectRoot, { recursive: true });
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );

    const createdProject = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Auth Project', alias: 'auth-project', rootPath: projectRoot }),
    });
    const project = (await createdProject.json() as { project: { id: string } }).project;

    const createdSession = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/permission-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'local-agent', capabilities: ['filesystem.read', 'filesystem.write'], ttlSeconds: 3600 }),
    });
    expect(createdSession.status).toBe(201);
    const session = (await createdSession.json() as { permissionSession: { id: string } }).permissionSession;

    const sessionList = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/permission-sessions`);
    expect((await sessionList.json() as { permissionSessions: unknown[] }).permissionSessions).toHaveLength(1);

    const policyResponse = await fetch(`http://127.0.0.1:${port}/api/policies`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deny-write', projectId: project.id, capability: 'filesystem.write', effect: 'deny', reason: 'freeze' }),
    });
    expect(policyResponse.status).toBe(201);
    const policy = (await policyResponse.json() as { policy: { id: string } }).policy;

    const overview = await fetch(`http://127.0.0.1:${port}/api/control-center/overview`).then((response) => response.json()) as { counts: { permissionSessions: number; policies: number } };
    expect(overview.counts.permissionSessions).toBe(1);
    expect(overview.counts.policies).toBe(1);

    const disabled = await fetch(`http://127.0.0.1:${port}/api/policies/${policy.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect((await disabled.json() as { policy: { enabled: boolean } }).policy.enabled).toBe(false);

    expect((await fetch(`http://127.0.0.1:${port}/api/permission-sessions/${session.id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/policies/${policy.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  test('creates, updates, lists and removes projects through CMS APIs', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-cc-'));
    const projectRoot = path.join(workspace, 'demo-project');
    await mkdir(projectRoot, { recursive: true });
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );

    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo', alias: 'demo', rootPath: projectRoot, defaultBranch: 'main' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { project: { id: string; alias: string } };
    expect(createdBody.project.alias).toBe('demo');

    const updated = await fetch(`http://127.0.0.1:${port}/api/projects/${createdBody.project.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'inactive', name: 'Demo Updated' }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { project: { status: string; name: string } }).project).toMatchObject({ status: 'inactive', name: 'Demo Updated' });

    const invalidAlias = await fetch(`http://127.0.0.1:${port}/api/projects/${createdBody.project.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'bad alias with spaces' }),
    });
    expect(invalidAlias.status).toBe(400);

    const listed = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect((await listed.json() as { projects: unknown[] }).projects).toHaveLength(1);

    const removed = await fetch(`http://127.0.0.1:${port}/api/projects/${createdBody.project.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`).then((response) => response.json()) as { projects: unknown[] }).projects).toHaveLength(0);
  });
});
