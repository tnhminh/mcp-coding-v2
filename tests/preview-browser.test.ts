import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { configuredBrowserAllowedOrigins } from '../src/app/preview-service.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('loopback preview and browser QA', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-preview-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'model.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));
    await writeFile(path.join(root, 'index.html'), `<!doctype html>
      <html><head><title>Preview Fixture</title></head><body>
        <h1>Agentic Preview</h1>
        <button id="change" onclick="document.querySelector('h1').textContent='Clicked'; console.log('clicked-ok')">Change</button>
        <script>fetch('https://example.com/should-be-blocked').catch(() => {});</script>
      </body></html>`, 'utf8');
    await writeFile(path.join(root, '.env'), 'SECRET=should-not-be-served\n', 'utf8');
    await writeFile(path.join(root, 'credentials.json'), '{"token":"should-not-be-served"}\n', 'utf8');
    await writeFile(path.join(root, 'scripts', 'dev.mjs'), `
      import http from 'node:http';
      const portIndex = process.argv.indexOf('--port');
      const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : Number(process.env.PORT);
      const server = http.createServer((_req,res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<h1>Dynamic Preview</h1>'); });
      server.listen(port, '127.0.0.1', () => console.log('token=previewsecret'));
    `, 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'preview-fixture', version: '1.0.0', type: 'module',
      scripts: { dev: 'node scripts/dev.mjs' },
      devDependencies: { vite: '0.0.0-fixture' },
    }), 'utf8');

    const project = createProject({ name: 'Preview Fixture', alias: 'preview-fixture', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'preview-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
  });

  afterEach(async () => {
    await services.previews.closeAll();
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('serves static preview safely and browser review returns interactive/screenshot evidence with external egress blocked', async () => {
    const profiles = await services.previews.profiles({ projectId });
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'static', kind: 'static' }),
      expect.objectContaining({ id: 'package:dev', kind: 'dev', framework: 'vite' }),
    ]));

    const preview = await services.previews.start({ projectId, profileId: 'static' });
    expect(preview).toMatchObject({ state: 'running', kind: 'static', framework: 'static' });
    expect(await services.previews.list({ projectId })).toEqual(expect.arrayContaining([expect.objectContaining({ id: preview.id, state: 'running' })]));
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    const response = await fetch(preview.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Agentic Preview');
    expect((await fetch(new URL('.env', preview.url))).status).toBe(403);
    expect((await fetch(new URL('credentials.json', preview.url))).status).toBe(403);
    const modelResponse = await fetch(new URL('model.glb', preview.url));
    expect(modelResponse.status).toBe(200);
    expect(modelResponse.headers.get('content-type')).toContain('model/gltf-binary');

    const review = await services.previews.review({
      previewId: preview.id,
      actions: [{ type: 'click', selector: '#change' }],
    });
    expect(review).toMatchObject({ title: 'Preview Fixture', httpStatus: 200 });
    expect(review.bodyText).toContain('Clicked');
    expect(review.headings).toEqual(expect.arrayContaining([expect.objectContaining({ level: 1, text: 'Clicked' })]));
    expect(review.interactive).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'button', id: 'change' })]));
    expect(review.consoleMessages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'clicked-ok' })]));
    expect(review.blockedRequests.some((url) => url.startsWith('https://example.com/'))).toBe(true);
    expect(review.screenshotBase64.length).toBeGreaterThan(1000);

    const stopped = await services.previews.stop({ previewId: preview.id });
    expect(stopped.state).toBe('stopped');
  }, 30_000);

  test('parses only explicit trusted-local browser network origins', () => {
    expect(configuredBrowserAllowedOrigins('https://api.example.com,ws://127.0.0.1:9000;file:///tmp/x;not-a-url')).toEqual([
      'https://api.example.com',
      'ws://127.0.0.1:9000',
    ]);
  });

  test('recognized dev preview binds loopback, becomes reachable, redacts logs and stops the process tree', async () => {
    const preview = await services.previews.start({ projectId, profileId: 'package:dev' });
    expect(preview).toMatchObject({ state: 'running', kind: 'dev', framework: 'vite' });
    const response = await fetch(preview.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Dynamic Preview');

    const status = await services.previews.status({ previewId: preview.id });
    expect(status.stdout).toContain('token=[REDACTED]');
    expect(status.stdout).not.toContain('previewsecret');

    await services.previews.stop({ previewId: preview.id });
    await expect(fetch(preview.url, { signal: AbortSignal.timeout(1000) })).rejects.toBeDefined();
  }, 30_000);
});
