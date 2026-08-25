import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const children = new Set<ChildProcess>();

function createModernClient(): Client {
  return new Client(
    { name: 'mcp-coding-v2-contract-tests', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
}

async function assertToolContract(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
    'system_health', 'list_projects', 'project_info', 'workspace_bootstrap', 'list_task_profiles', 'run_task', 'list_skills', 'read_skill', 'apply_and_verify',
    'read_file', 'stat_path', 'list_files', 'search_text', 'write_file', 'append_file', 'diff_file', 'apply_patch', 'batch_patch', 'copy_file', 'move_file', 'delete_file',
  ]));

  const result = await client.callTool({ name: 'system_health', arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    service: 'mcp-coding-v2',
    version: '0.1.0',
    status: 'ok',
  });

  await expect(client.callTool({ name: 'does_not_exist', arguments: {} })).rejects.toMatchObject({
    name: 'ProtocolError',
    code: -32602,
  });

  const invalidArgs = await client.callTool({
    name: 'system_health',
    arguments: { unexpected: true },
  });
  expect(invalidArgs.isError).toBe(true);
  const validationText = invalidArgs.content.find((block) => block.type === 'text');
  expect(validationText?.type).toBe('text');
  if (validationText?.type === 'text') {
    expect(validationText.text).toContain('Input validation error');
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve test port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`HTTP MCP server did not become ready on port ${port}`);
}

function track(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

describe('MCP 2026-07-28 protocol contracts', () => {
  test('stdio negotiates modern MCP and supports tools/list + tools/call', async () => {
    const client = createModernClient();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, 'src/entrypoints/stdio.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    });

    try {
      await client.connect(transport, { timeout: 8_000 });
      await assertToolContract(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 15_000);

  test('Streamable HTTP negotiates modern MCP and supports tools/list + tools/call', async () => {
    const port = await reservePort();
    const child = track(
      spawn(process.execPath, [tsxCli, 'src/entrypoints/http.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, MCP_HOST: '127.0.0.1', MCP_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );

    await waitForHealth(port);
    const client = createModernClient();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    try {
      await client.connect(transport, { timeout: 8_000 });
      await assertToolContract(client);
    } finally {
      await client.close().catch(() => undefined);
      child.kill();
    }
  }, 20_000);
});
