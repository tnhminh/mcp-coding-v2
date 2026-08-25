import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const children = new Set<ChildProcess>();
let workspace: string | undefined;

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

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('MCP HTTP server did not become ready');
}

async function jsonApi<T>(port: number, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body as T;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}

afterEach(async () => {
  for (const child of [...children]) await stopChild(child);
  children.clear();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe('MCP filesystem vibecode contract', () => {
  test('CMS grant enables MCP read/write and a deny policy blocks the next write', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-vibecode-contract-'));
    const projectRoot = path.join(workspace, 'project');
    const databasePath = path.join(workspace, 'runtime.sqlite');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'main.ts'), 'export const answer = 42;\n', 'utf8');

    const port = await reservePort();
    const child = spawn(process.execPath, [tsxCli, 'src/entrypoints/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_DATABASE_PATH: databasePath, LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child); child.once('exit', () => children.delete(child));
    await waitForHealth(port);

    const projectBody = await jsonApi<{ project: { id: string } }>(port, '/api/projects', {
      method: 'POST', body: JSON.stringify({ name: 'Vibecode', alias: 'vibecode', rootPath: projectRoot }),
    });
    const projectId = projectBody.project.id;
    const sessionBody = await jsonApi<{ permissionSession: { id: string } }>(port, `/api/projects/${projectId}/permission-sessions`, {
      method: 'POST', body: JSON.stringify({ principalId: 'contract-agent', capabilities: ['filesystem.read', 'filesystem.write'], ttlSeconds: 3600 }),
    });
    const permissionSessionId = sessionBody.permissionSession.id;

    const client = new Client(
      { name: 'mcp-filesystem-contract', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)), { timeout: 8_000 });
      const read = await client.callTool({ name: 'read_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/main.ts' } });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ path: path.join('src', 'main.ts') });
      const structured = read.structuredContent as Record<string, unknown> | undefined;
      const readContent: unknown = structured?.content;
      expect(typeof readContent).toBe('string');
      if (typeof readContent === 'string') expect(readContent).toContain('answer = 42');

      const write = await client.callTool({ name: 'write_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/generated.ts', content: 'export const generated = true;\n' } });
      expect(write.isError).not.toBe(true);
      expect(write.structuredContent).toMatchObject({ path: path.join('src', 'generated.ts'), created: true });

      await jsonApi<unknown>(port, '/api/policies', {
        method: 'POST', body: JSON.stringify({ name: 'freeze-writes', projectId, capability: 'filesystem.write', effect: 'deny' }),
      });
      const denied = await client.callTool({ name: 'write_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/denied.ts', content: 'nope\n' } });
      expect(denied.isError).toBe(true);
      const errorBlock = denied.content.find((block) => block.type === 'text');
      expect(errorBlock?.type).toBe('text');
      if (errorBlock?.type === 'text') expect(errorBlock.text).toContain('POLICY_DENIED');
    } finally {
      await client.close().catch(() => undefined);
      await stopChild(child);
    }
  }, 20_000);
});
