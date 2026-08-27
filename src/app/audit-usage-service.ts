import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const auditStatusSchema = z.enum(['success', 'failure']);
const tokenVisibilitySchema = z.enum(['actual', 'estimated', 'unavailable']);

export interface AuditEvent {
  id: string;
  occurredAt: string;
  category: string;
  action: string;
  actorType: string;
  actorId: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  status: 'success' | 'failure';
  durationMs: number | null;
  errorCode: string | null;
  metadata: Record<string, unknown>;
}

export interface UsageEvent {
  id: string;
  occurredAt: string;
  source: string;
  actorType: string;
  actorId: string | null;
  projectId: string | null;
  provider: string | null;
  model: string | null;
  operation: string;
  requestCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  tokenVisibility: 'actual' | 'estimated' | 'unavailable';
  metadata: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  category: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  project_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  status: string;
  duration_ms: number | null;
  error_code: string | null;
  metadata_json: string;
}

interface UsageRow {
  id: string;
  occurred_at: string;
  source: string;
  actor_type: string;
  actor_id: string | null;
  project_id: string | null;
  provider: string | null;
  model: string | null;
  operation: string;
  request_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  token_visibility: string;
  metadata_json: string;
}

function boundedMetadata(value: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(value ?? {});
  return Buffer.byteLength(json, 'utf8') <= 32 * 1024 ? json : JSON.stringify({ truncated: true });
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch {
    return { invalid: true };
  }
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    category: row.category,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    projectId: row.project_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    status: auditStatusSchema.parse(row.status),
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    metadata: parseMetadata(row.metadata_json),
  };
}

function mapUsage(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    source: row.source,
    actorType: row.actor_type,
    actorId: row.actor_id,
    projectId: row.project_id,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    tokenVisibility: tokenVisibilitySchema.parse(row.token_visibility),
    metadata: parseMetadata(row.metadata_json),
  };
}

export class AuditUsageService {
  private readonly insertAudit;
  private readonly insertUsage;

  constructor(private readonly database: Database.Database) {
    this.insertAudit = database.prepare(`
      INSERT INTO audit_events (
        id, occurred_at, category, action, actor_type, actor_id, project_id,
        resource_type, resource_id, status, duration_ms, error_code, metadata_json
      ) VALUES (
        @id, @occurred_at, @category, @action, @actor_type, @actor_id, @project_id,
        @resource_type, @resource_id, @status, @duration_ms, @error_code, @metadata_json
      )
    `);
    this.insertUsage = database.prepare(`
      INSERT INTO usage_events (
        id, occurred_at, source, actor_type, actor_id, project_id, provider, model,
        operation, request_count, input_tokens, output_tokens, cached_input_tokens,
        reasoning_tokens, total_tokens, estimated_cost_usd, token_visibility, metadata_json
      ) VALUES (
        @id, @occurred_at, @source, @actor_type, @actor_id, @project_id, @provider, @model,
        @operation, @request_count, @input_tokens, @output_tokens, @cached_input_tokens,
        @reasoning_tokens, @total_tokens, @estimated_cost_usd, @token_visibility, @metadata_json
      )
    `);
  }

  recordAudit(input: {
    category: string;
    action: string;
    actorType: string;
    actorId?: string | null;
    projectId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    status: 'success' | 'failure';
    durationMs?: number | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    this.insertAudit.run({
      id: randomUUID(),
      occurred_at: new Date().toISOString(),
      category: input.category.slice(0, 80),
      action: input.action.slice(0, 160),
      actor_type: input.actorType.slice(0, 80),
      actor_id: input.actorId?.slice(0, 200) ?? null,
      project_id: input.projectId ?? null,
      resource_type: input.resourceType?.slice(0, 80) ?? null,
      resource_id: input.resourceId?.slice(0, 200) ?? null,
      status: input.status,
      duration_ms: input.durationMs ?? null,
      error_code: input.errorCode?.slice(0, 120) ?? null,
      metadata_json: boundedMetadata(input.metadata),
    });
  }

  recordToolUsage(input: {
    tool: string;
    actorId?: string | null;
    projectId?: string | null;
    durationMs?: number | null;
    payloadBytes?: number | null;
  }): void {
    this.insertUsage.run({
      id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source: 'mcp_tool',
      actor_type: 'mcp_client',
      actor_id: input.actorId ?? null,
      project_id: input.projectId ?? null,
      provider: null,
      model: null,
      operation: input.tool.slice(0, 160),
      request_count: 1,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      estimated_cost_usd: null,
      token_visibility: 'unavailable',
      metadata_json: boundedMetadata({ durationMs: input.durationMs ?? null, payloadBytes: input.payloadBytes ?? null, note: 'ChatGPT model token counts are not exposed to the MCP tool server.' }),
    });
  }

  recordLlmUsage(input: {
    source?: string;
    actorType?: string;
    actorId?: string | null;
    projectId?: string | null;
    provider: string;
    model: string;
    operation?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    estimatedCostUsd?: number | null;
    tokenVisibility?: 'actual' | 'estimated';
    metadata?: Record<string, unknown>;
  }): UsageEvent {
    const inputTokens = z.number().int().min(0).max(10_000_000_000).parse(input.inputTokens);
    const outputTokens = z.number().int().min(0).max(10_000_000_000).parse(input.outputTokens);
    const cachedInputTokens = z.number().int().min(0).max(inputTokens).default(0).parse(input.cachedInputTokens);
    const reasoningTokens = z.number().int().min(0).max(outputTokens).default(0).parse(input.reasoningTokens);
    const event: UsageEvent = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      source: (input.source ?? 'provider').slice(0, 80),
      actorType: (input.actorType ?? 'local_user').slice(0, 80),
      actorId: input.actorId?.slice(0, 200) ?? null,
      projectId: input.projectId ?? null,
      provider: input.provider.slice(0, 120),
      model: input.model.slice(0, 160),
      operation: (input.operation ?? 'generation').slice(0, 160),
      requestCount: 1,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      tokenVisibility: input.tokenVisibility ?? 'actual',
      metadata: input.metadata ?? {},
    };
    this.insertUsage.run({
      id: event.id,
      occurred_at: event.occurredAt,
      source: event.source,
      actor_type: event.actorType,
      actor_id: event.actorId,
      project_id: event.projectId,
      provider: event.provider,
      model: event.model,
      operation: event.operation,
      request_count: event.requestCount,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cached_input_tokens: event.cachedInputTokens,
      reasoning_tokens: event.reasoningTokens,
      total_tokens: event.totalTokens,
      estimated_cost_usd: event.estimatedCostUsd,
      token_visibility: event.tokenVisibility,
      metadata_json: boundedMetadata(event.metadata),
    });
    return event;
  }

  listAudit(input: { limit?: number; projectId?: string; status?: 'success' | 'failure'; category?: string; query?: string }): AuditEvent[] {
    const limit = z.number().int().min(1).max(500).default(100).parse(input.limit);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (input.projectId) { clauses.push('project_id = @project_id'); params.project_id = input.projectId; }
    if (input.status) { clauses.push('status = @status'); params.status = input.status; }
    if (input.category) { clauses.push('category = @category'); params.category = input.category; }
    if (input.query) {
      clauses.push('(action LIKE @query OR actor_id LIKE @query OR resource_id LIKE @query OR error_code LIKE @query)');
      params.query = `%${input.query.slice(0, 200)}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (this.database.prepare(`SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT @limit`).all(params) as AuditRow[]).map(mapAudit);
  }

  usageDashboard(input: { days?: number; projectId?: string }): Record<string, unknown> {
    const days = z.number().int().min(1).max(365).default(30).parse(input.days);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const projectClause = input.projectId ? ' AND project_id = @project_id' : '';
    const params: Record<string, unknown> = { since, ...(input.projectId ? { project_id: input.projectId } : {}) };
    const totals = this.database.prepare(`
      SELECT
        COALESCE(SUM(request_count), 0) AS requests,
        COALESCE(SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN input_tokens ELSE 0 END), 0) AS input_tokens,
        COALESCE(SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN output_tokens ELSE 0 END), 0) AS output_tokens,
        COALESCE(SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN total_tokens ELSE 0 END), 0) AS total_tokens,
        COALESCE(SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
        COALESCE(SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN reasoning_tokens ELSE 0 END), 0) AS reasoning_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
        COALESCE(SUM(CASE WHEN token_visibility = 'actual' THEN request_count ELSE 0 END), 0) AS actual_token_requests,
        COALESCE(SUM(CASE WHEN token_visibility = 'unavailable' THEN request_count ELSE 0 END), 0) AS unavailable_token_requests,
        COALESCE(SUM(CASE WHEN source = 'mcp_tool' THEN request_count ELSE 0 END), 0) AS mcp_tool_calls,
        COALESCE(SUM(CASE WHEN provider IS NOT NULL THEN request_count ELSE 0 END), 0) AS llm_requests
      FROM usage_events WHERE occurred_at >= @since${projectClause}
    `).get(params) as Record<string, number>;
    const byModel = this.database.prepare(`
      SELECT COALESCE(provider, 'n/a') AS provider, COALESCE(model, 'n/a') AS model,
             SUM(request_count) AS requests,
             SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN total_tokens ELSE 0 END) AS total_tokens,
             SUM(estimated_cost_usd) AS estimated_cost_usd
      FROM usage_events WHERE occurred_at >= @since${projectClause} AND provider IS NOT NULL
      GROUP BY provider, model ORDER BY total_tokens DESC, requests DESC LIMIT 30
    `).all(params) as Array<Record<string, unknown>>;
    const daily = this.database.prepare(`
      SELECT substr(occurred_at, 1, 10) AS day,
             SUM(request_count) AS requests,
             SUM(CASE WHEN token_visibility IN ('actual','estimated') THEN total_tokens ELSE 0 END) AS total_tokens,
             SUM(CASE WHEN source = 'mcp_tool' THEN request_count ELSE 0 END) AS tool_calls
      FROM usage_events WHERE occurred_at >= @since${projectClause}
      GROUP BY day ORDER BY day ASC
    `).all(params) as Array<Record<string, unknown>>;
    const recent = (this.database.prepare(`SELECT * FROM usage_events WHERE occurred_at >= @since${projectClause} ORDER BY occurred_at DESC LIMIT 100`).all(params) as UsageRow[]).map(mapUsage);
    return {
      windowDays: days,
      since,
      totals,
      byModel,
      daily,
      recent,
      tokenVisibility: {
        chatgptMcp: 'unavailable',
        explanation: 'The MCP server receives tool calls, but OpenAI does not expose the surrounding ChatGPT model token usage to the MCP server. Actual token totals appear when an LLM/provider adapter reports usage metadata into this ledger.',
      },
    };
  }
}
