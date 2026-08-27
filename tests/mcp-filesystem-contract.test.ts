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
    await mkdir(path.join(projectRoot, '.agents', 'skills', 'verify'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'main.ts'), 'export const answer = 42;\n', 'utf8');
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Local agent instructions\nRun verification after edits.\n', 'utf8');
    await writeFile(path.join(projectRoot, '.agents', 'skills', 'verify', 'SKILL.md'), '# Verify skill\nUse the project test task.\n', 'utf8');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture-pass')\"" } }), 'utf8');

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
      method: 'POST', body: JSON.stringify({ principalId: 'contract-agent', capabilities: ['filesystem.read', 'filesystem.write', 'command.run'], ttlSeconds: 3600 }),
    });
    const permissionSessionId = sessionBody.permissionSession.id;

    const client = new Client(
      { name: 'mcp-filesystem-contract', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)), { timeout: 8_000 });

      const projectList = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(projectList.isError).not.toBe(true);
      const projects = (projectList.structuredContent as { projects?: Array<{ id: string }> } | undefined)?.projects ?? [];
      expect(projects.some((project) => project.id === projectId)).toBe(true);

      const autoList = await client.callTool({ name: 'list_files', arguments: { project_id: projectId, path: '.', depth: 2 } });
      expect(autoList.isError, JSON.stringify(autoList.content)).not.toBe(true);
      const autoEntries = (autoList.structuredContent as { entries?: Array<{ path: string }> } | undefined)?.entries ?? [];
      expect(autoEntries.map((entry) => entry.path)).toEqual(expect.arrayContaining(['AGENTS.md', 'package.json', 'src']));

      const bootstrap = await client.callTool({ name: 'workspace_bootstrap', arguments: { project_id: projectId } });
      expect(bootstrap.isError, JSON.stringify(bootstrap.content)).not.toBe(true);
      const boot = bootstrap.structuredContent as { taskProfiles?: Array<{ id: string }>; skills?: Array<{ kind: string }> } | undefined;
      expect(boot?.taskProfiles?.map((profile) => profile.id)).toContain('test');
      expect(boot?.skills?.map((skill) => skill.kind)).toEqual(expect.arrayContaining(['agents', 'skill']));

      const task = await client.callTool({ name: 'run_task', arguments: { project_id: projectId, permission_session_id: permissionSessionId, task: 'test' } });
      expect(task.isError, JSON.stringify(task.content)).not.toBe(true);
      expect(task.structuredContent).toMatchObject({ task: 'test', success: true });
      const taskOutput = (task.structuredContent as { stdout?: string } | undefined)?.stdout;
      expect(taskOutput).toContain('fixture-pass');

      const brainBuild = await client.callTool({ name: 'brain_build', arguments: { project_id: projectId, permission_session_id: permissionSessionId } });
      expect(brainBuild.isError, JSON.stringify(brainBuild.content)).not.toBe(true);
      expect(brainBuild.structuredContent).toMatchObject({ state: 'ready' });
      const findSymbol = await client.callTool({ name: 'find_symbol', arguments: { project_id: projectId, permission_session_id: permissionSessionId, query: 'answer' } });
      const brainSymbols = (findSymbol.structuredContent as { symbols?: Array<{ name: string; path: string }> } | undefined)?.symbols ?? [];
      expect(brainSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'answer', path: 'src/main.ts' })]));
      const context = await client.callTool({ name: 'context_bundle', arguments: { project_id: projectId, permission_session_id: permissionSessionId, query: 'answer', max_files: 4, max_chars: 6000 } });
      const contextItems = (context.structuredContent as { items?: Array<{ path: string }> } | undefined)?.items ?? [];
      expect(contextItems.map((item) => item.path)).toContain('src/main.ts');
      const impact = await client.callTool({ name: 'impact_analysis', arguments: { project_id: projectId, permission_session_id: permissionSessionId, seed: 'answer' } });
      expect(impact.isError, JSON.stringify(impact.content)).not.toBe(true);
      const declarations = (impact.structuredContent as { declarations?: Array<{ name: string; path: string }> } | undefined)?.declarations ?? [];
      expect(declarations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'answer', path: 'src/main.ts' })]));

      const read = await client.callTool({ name: 'read_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/main.ts' } });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ path: path.join('src', 'main.ts') });
      const structured = read.structuredContent as Record<string, unknown> | undefined;
      const readContent: unknown = structured?.content;
      const readSha: unknown = structured?.sha256;
      expect(typeof readContent).toBe('string');
      expect(typeof readSha).toBe('string');
      if (typeof readContent === 'string') expect(readContent).toContain('answer = 42');

      if (typeof readSha !== 'string') throw new Error('read_file did not return SHA-256');
      const applyVerify = await client.callTool({
        name: 'apply_and_verify',
        arguments: {
          project_id: projectId,
          permission_session_id: permissionSessionId,
          changes: [{ op: 'replace', path: 'src/main.ts', search: 'answer = 42', replacement: 'answer = 43', expected_sha256: readSha }],
          tasks: ['test'],
        },
      });
      expect(applyVerify.isError, JSON.stringify(applyVerify.content)).not.toBe(true);
      expect(applyVerify.structuredContent).toMatchObject({ verified: true, rolledBack: false });
      const reread = await client.callTool({ name: 'read_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/main.ts' } });
      const rereadStructured = reread.structuredContent as { content?: string; sha256?: string } | undefined;
      expect(rereadStructured?.content).toContain('answer = 43');
      if (!rereadStructured?.sha256) throw new Error('reread did not return SHA-256');

      const cycle = await client.callTool({
        name: 'coding_cycle',
        arguments: {
          project_id: projectId,
          objective: 'Update the answer constant while keeping the project verification green.',
          changes: [{ op: 'replace', path: 'src/main.ts', search: 'answer = 43', replacement: 'answer = 44', expected_sha256: rereadStructured.sha256 }],
          tasks: ['test'],
          iteration: 1,
          max_iterations: 3,
        },
      });
      expect(cycle.isError, JSON.stringify(cycle.content)).not.toBe(true);
      expect(cycle.structuredContent).toMatchObject({ state: 'review_required', nextAction: 'review' });
      const cycleVerification = (cycle.structuredContent as { verification?: { verified?: boolean }; afterReview?: unknown } | undefined)?.verification;
      expect(cycleVerification?.verified).toBe(true);
      const afterCycle = await client.callTool({ name: 'read_file', arguments: { project_id: projectId, permission_session_id: permissionSessionId, path: 'src/main.ts' } });
      expect((afterCycle.structuredContent as { content?: string } | undefined)?.content).toContain('answer = 44');

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
