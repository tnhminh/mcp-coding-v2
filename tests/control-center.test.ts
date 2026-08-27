import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const pageText = await page.text();
    expect(pageText).toContain('Control Center');
    expect(pageText).toContain('data-panel="tunnel"');
    expect(pageText).toContain('id="panel-tunnel"');
    expect(pageText).toContain('Windows DPAPI');
    expect(pageText).toContain('Save secure setup');
    expect(pageText).toContain('data-panel="audit"');
    expect(pageText).toContain('data-panel="usage"');
    expect(pageText).toContain('data-panel="git"');
    expect(pageText).toContain('data-panel="processes"');
    expect(pageText).toContain('id="panel-git"');
    expect(pageText).toContain('id="panel-processes"');
    expect(pageText).toContain('Managed process control');
    expect(pageText).toContain('Git repository');
    expect(pageText).toContain('90 days');
    expect(pageText).toContain('150 days');
    expect(pageText).toContain('No expiry');
    expect(pageText).toContain('id="panel-audit"');
    expect(pageText).toContain('id="panel-usage"');
    expect(pageText).toContain('Known provider token usage and MCP activity');

    const overview = await fetch(`http://127.0.0.1:${port}/api/control-center/overview`);
    expect(overview.status).toBe(200);
    const data = await overview.json() as { counts: { projects: number }; modules: Array<{ id: string; state: string }> };
    expect(data.counts.projects).toBe(0);
    expect(data.modules.find((module) => module.id === 'projects')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'permissions')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'policies')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'tunnel')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'audit')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'usage')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'git')?.state).toBe('available');
    expect(data.modules.find((module) => module.id === 'processes')?.state).toBe('available');

    const tunnelResponse = await fetch(`http://127.0.0.1:${port}/api/tunnel/status`);
    expect(tunnelResponse.status).toBe(200);
    const tunnelBody = await tunnelResponse.json() as {
      tunnel: {
        configuration: { mcpServerUrl: string; tunnelIdConfigured: boolean; runtimeApiKeyConfigured: boolean };
        localMcp: { reachable: boolean; ready: boolean; httpStatus: number | null };
      };
    };
    expect(tunnelBody.tunnel.configuration.mcpServerUrl).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(tunnelBody.tunnel.localMcp).toMatchObject({ reachable: true, ready: true, httpStatus: 200 });
    expect(typeof tunnelBody.tunnel.configuration.tunnelIdConfigured).toBe('boolean');
    expect(typeof tunnelBody.tunnel.configuration.runtimeApiKeyConfigured).toBe('boolean');
    if (process.env.CONTROL_PLANE_API_KEY) expect(JSON.stringify(tunnelBody)).not.toContain(process.env.CONTROL_PLANE_API_KEY);
  });

  test('persists secure tunnel setup through Control Center without returning plaintext secrets', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-cc-tunnel-setup-'));
    const databasePath = path.join(workspace, 'runtime.sqlite');
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath },
      new JsonLogger('error', () => undefined),
    );

    const initial = await fetch(`http://127.0.0.1:${port}/api/tunnel/setup`).then((response) => response.json()) as { setup: { tunnelIdConfigured: boolean; runtimeApiKeyConfigured: boolean } };
    expect(initial.setup).toMatchObject({ tunnelIdConfigured: false, runtimeApiKeyConfigured: false });

    const secret = 'sk-dummy-control-center-secret-123456789';
    const configuredResponse = await fetch(`http://127.0.0.1:${port}/api/tunnel/setup`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelId: 'tunnel_abcdefgh12345678', runtimeApiKey: secret, autoConnect: false }),
    });
    expect(configuredResponse.status).toBe(process.platform === 'win32' ? 200 : 503);
    if (process.platform !== 'win32') return;

    const configuredText = await configuredResponse.text();
    expect(configuredText).not.toContain(secret);
    const configured = JSON.parse(configuredText) as { setup: { tunnelIdConfigured: boolean; runtimeApiKeyConfigured: boolean; autoConnect: boolean; secretProvider: string } };
    expect(configured.setup).toMatchObject({ tunnelIdConfigured: true, runtimeApiKeyConfigured: true, autoConnect: false, secretProvider: 'windows-dpapi-current-user' });

    const settingsText = await readFile(path.join(workspace, 'tunnel', 'setup.json'), 'utf8');
    const encryptedText = await readFile(path.join(workspace, 'tunnel', 'runtime-api-key.dpapi'), 'utf8');
    expect(settingsText).toContain('tunnel_abcdefgh12345678');
    expect(settingsText).not.toContain(secret);
    expect(encryptedText).not.toContain(secret);

    await runtime.close();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath },
      new JsonLogger('error', () => undefined),
    );
    const restored = await fetch(`http://127.0.0.1:${port}/api/tunnel/setup`).then((response) => response.json()) as { setup: { tunnelIdConfigured: boolean; runtimeApiKeyConfigured: boolean; autoConnect: boolean }; tunnel: { configuration: { tunnelIdConfigured: boolean; runtimeApiKeyConfigured: boolean; autoConnect: boolean } } };
    expect(restored.setup).toMatchObject({ tunnelIdConfigured: true, runtimeApiKeyConfigured: true, autoConnect: false });
    expect(restored.tunnel.configuration).toMatchObject({ tunnelIdConfigured: true, runtimeApiKeyConfigured: true, autoConnect: false });
  }, 20_000);

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
      body: JSON.stringify({ principalId: 'local-agent', capabilities: ['filesystem.read', 'filesystem.write'], ttlSeconds: 0 }),
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

  test('operates persistent AI jobs and workflow state through real Control Center APIs', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-cc-jobs-'));
    const projectRoot = path.join(workspace, 'job-project');
    await mkdir(projectRoot, { recursive: true });
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );

    const projectResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Job Project', alias: 'job-project', rootPath: projectRoot }),
    });
    const project = (await projectResponse.json() as { project: { id: string } }).project;
    const missingAccessResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/access`);
    expect(missingAccessResponse.status).toBe(200);
    const missingAccess = (await missingAccessResponse.json() as { access: { capabilities: Array<{ capability: string; usable: boolean }>; codingEnvelope: { usable: boolean } } }).access;
    expect(missingAccess.codingEnvelope.usable).toBe(false);
    expect(missingAccess.capabilities.find((item) => item.capability === 'filesystem.read')?.usable).toBe(false);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/permission-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'control-center-agent', capabilities: ['filesystem.read', 'filesystem.write', 'command.run'], ttlSeconds: 3600 }),
    });
    expect(sessionResponse.status).toBe(201);
    const grantedAccess = (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/access`).then((response) => response.json()) as { access: { capabilities: Array<{ capability: string; usable: boolean }>; codingEnvelope: { usable: boolean } } }).access;
    expect(grantedAccess.codingEnvelope.usable).toBe(true);
    expect(grantedAccess.capabilities.find((item) => item.capability === 'filesystem.read')?.usable).toBe(true);

    const created = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/ai-jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'Keep this objective persistent for workflow operations.', maxIterations: 4 }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json() as { job: { id: string; status: string; maxIterations: number } }).job;
    expect(job).toMatchObject({ status: 'queued', maxIterations: 4 });

    const listed = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/ai-jobs`);
    const jobs = (await listed.json() as { jobs: Array<{ id: string }> }).jobs;
    expect(jobs.map((candidate) => candidate.id)).toContain(job.id);

    const status = await fetch(`http://127.0.0.1:${port}/api/ai-jobs/${job.id}`);
    expect((await status.json() as { job: { status: string; iteration: number } }).job).toMatchObject({ status: 'queued', iteration: 0 });

    const cancelled = await fetch(`http://127.0.0.1:${port}/api/ai-jobs/${job.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect((await cancelled.json() as { job: { status: string } }).job.status).toBe('cancelled');
  });

  test('operates preview lifecycle and browser QA through Control Center APIs', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-cc-preview-'));
    const projectRoot = path.join(workspace, 'preview-project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><head><title>Control Preview</title></head><body><h1>Preview QA</h1><button>Ready</button></body></html>', 'utf8');
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );

    const projectResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Preview Project', alias: 'preview-project', rootPath: projectRoot }),
    });
    const project = (await projectResponse.json() as { project: { id: string } }).project;
    expect((await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/permission-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'preview-control-agent', capabilities: ['filesystem.read', 'filesystem.write', 'command.run'], ttlSeconds: 3600 }),
    })).status).toBe(201);

    const profilesResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/preview-profiles`);
    const profiles = (await profilesResponse.json() as { previewProfiles: Array<{ id: string }> }).previewProfiles;
    expect(profiles.map((profile) => profile.id)).toContain('static');

    const startedResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/previews`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'static' }),
    });
    expect(startedResponse.status).toBe(201);
    const preview = (await startedResponse.json() as { preview: { id: string; state: string; url: string } }).preview;
    expect(preview.state).toBe('running');
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    const previewsResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/previews`);
    const previews = (await previewsResponse.json() as { previews: Array<{ id: string }> }).previews;
    expect(previews.map((item) => item.id)).toContain(preview.id);

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/previews/${preview.id}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/', actions: [] }),
    });
    expect(reviewResponse.status).toBe(200);
    const review = (await reviewResponse.json() as { review: { title: string; httpStatus: number; screenshotBase64: string; pageErrors: string[] } }).review;
    expect(review).toMatchObject({ title: 'Control Preview', httpStatus: 200, pageErrors: [] });
    expect(review.screenshotBase64.length).toBeGreaterThan(1000);

    const stoppedResponse = await fetch(`http://127.0.0.1:${port}/api/previews/${preview.id}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect((await stoppedResponse.json() as { preview: { state: string } }).preview.state).toBe('stopped');
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/previews/${preview.id}`);
    expect((await statusResponse.json() as { preview: { state: string } }).preview.state).toBe('stopped');
  }, 30_000);
});
