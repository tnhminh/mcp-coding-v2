import { createServer as createNetServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AuditUsageService } from '../src/app/audit-usage-service.js';
import { JsonLogger } from '../src/infra/json-logger.js';
import { openSqliteDatabase } from '../src/infra/sqlite/database.js';
import { startHttpRuntime, type HttpRuntime } from '../src/runtime/http-runtime.js';

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Unable to reserve test port'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

describe('audit and usage accounting', () => {
  let runtime: HttpRuntime | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    client = undefined;
    runtime = undefined;
  });

  test('persists audit events and separates known LLM tokens from unavailable MCP token visibility', () => {
    const handle = openSqliteDatabase(':memory:');
    try {
      const service = new AuditUsageService(handle.database);
      service.recordAudit({
        category: 'mcp_tool',
        action: 'read_file',
        actorType: 'mcp_client',
        projectId: 'project-history-id',
        status: 'success',
        durationMs: 12,
        metadata: { permissionSessionSupplied: true, payloadBytes: 123 },
      });
      service.recordToolUsage({ tool: 'read_file', projectId: 'project-history-id', durationMs: 12, payloadBytes: 123 });
      service.recordLlmUsage({
        source: 'ai_job_provider',
        actorType: 'local_user',
        actorId: 'demo-user',
        projectId: 'project-history-id',
        provider: 'openai',
        model: 'demo-model',
        operation: 'generation',
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 20,
        reasoningTokens: 10,
        estimatedCostUsd: 0.0012,
        tokenVisibility: 'actual',
      });

      const audit = service.listAudit({ projectId: 'project-history-id', query: 'read_file' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'read_file', status: 'success', durationMs: 12 });

      const dashboard = service.usageDashboard({ days: 30, projectId: 'project-history-id' }) as {
        totals: Record<string, number>;
        byModel: Array<Record<string, unknown>>;
        recent: Array<{ tokenVisibility: string; totalTokens: number | null }>;
        tokenVisibility: { chatgptMcp: string; explanation: string };
      };
      expect(dashboard.totals).toMatchObject({
        requests: 2,
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cached_input_tokens: 20,
        reasoning_tokens: 10,
        actual_token_requests: 1,
        unavailable_token_requests: 1,
        mcp_tool_calls: 1,
        llm_requests: 1,
      });
      expect(dashboard.byModel).toEqual([
        expect.objectContaining({ provider: 'openai', model: 'demo-model', requests: 1, total_tokens: 140 }),
      ]);
      expect(dashboard.recent.map((event) => event.tokenVisibility)).toEqual(expect.arrayContaining(['actual', 'unavailable']));
      expect(dashboard.tokenVisibility.chatgptMcp).toBe('unavailable');
      expect(dashboard.tokenVisibility.explanation).toContain('does not expose');
    } finally {
      handle.close();
    }
  });

  test('records real MCP tool calls automatically without storing tool arguments', async () => {
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );
    client = new Client(
      { name: 'audit-usage-integration', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)), { timeout: 8_000 });

    const health = await client.callTool({ name: 'system_health', arguments: {} });
    expect(health.isError).not.toBe(true);

    const auditResponse = await fetch(`http://127.0.0.1:${port}/api/audit?category=mcp_tool&q=system_health`);
    expect(auditResponse.status).toBe(200);
    const auditBody = await auditResponse.json() as { auditEvents: Array<{ action: string; status: string; metadata: Record<string, unknown> }> };
    expect(auditBody.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'system_health', status: 'success' }),
    ]));
    const event = auditBody.auditEvents.find((candidate) => candidate.action === 'system_health');
    expect(event?.metadata).toEqual(expect.objectContaining({ permissionSessionSupplied: false }));
    expect(JSON.stringify(event)).not.toContain('permission_session_id');

    const usageResponse = await fetch(`http://127.0.0.1:${port}/api/usage?days=30`);
    const usage = (await usageResponse.json() as { usage: { totals: Record<string, number>; tokenVisibility: { chatgptMcp: string } } }).usage;
    expect(usage.totals.mcp_tool_calls).toBeGreaterThanOrEqual(1);
    expect(usage.totals.unavailable_token_requests).toBeGreaterThanOrEqual(1);
    expect(usage.totals.total_tokens).toBe(0);
    expect(usage.tokenVisibility.chatgptMcp).toBe('unavailable');
  });

  test('Control Center LLM ingestion counts provider tokens while audit excludes request body content', async () => {
    const port = await reservePort();
    runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      new JsonLogger('error', () => undefined),
    );
    const marker = 'SENSITIVE-METADATA-MARKER-DO-NOT-AUDIT';
    const response = await fetch(`http://127.0.0.1:${port}/api/usage/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'provider-model',
        inputTokens: 123,
        outputTokens: 45,
        cachedInputTokens: 23,
        reasoningTokens: 5,
        estimatedCostUsd: 0.002,
        tokenVisibility: 'actual',
        metadata: { marker },
      }),
    });
    expect(response.status).toBe(201);

    const usage = (await fetch(`http://127.0.0.1:${port}/api/usage?days=30`).then((value) => value.json()) as {
      usage: { totals: Record<string, number>; byModel: Array<Record<string, unknown>> };
    }).usage;
    expect(usage.totals).toMatchObject({ input_tokens: 123, output_tokens: 45, total_tokens: 168, llm_requests: 1 });
    expect(usage.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai', model: 'provider-model', total_tokens: 168 })]));

    const auditText = await fetch(`http://127.0.0.1:${port}/api/audit?category=control_center_api&q=usage`).then((value) => value.text());
    expect(auditText).toContain('POST /api/usage/llm');
    expect(auditText).not.toContain(marker);
    expect(auditText).not.toContain('provider-model');
  });
});
