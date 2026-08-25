import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HealthService } from './health-service.js';
import { toPublicError } from './errors.js';
import type { SecureFilesystemService } from './secure-filesystem-service.js';

export interface McpToolServices {
  filesystem: SecureFilesystemService;
}

const authShape = {
  project_id: z.string().uuid(),
  permission_session_id: z.string().uuid(),
};
const pathSchema = z.string().min(1).max(4096);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

function authorized(input: { project_id: string; permission_session_id: string }) {
  return { projectId: input.project_id, permissionSessionId: input.permission_session_id };
}

function ok<T extends object>(output: T) {
  const structuredContent = { ...output } as Record<string, unknown>;
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent };
}

function failed(error: unknown) {
  const publicError = toPublicError(error).body.error;
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(publicError) }] };
}

export function createMcpServer(services?: McpToolServices): McpServer {
  const health = new HealthService();
  const server = new McpServer(
    { name: 'mcp-coding-v2', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'system_health',
    {
      title: 'System health',
      description: 'Return a minimal non-sensitive health snapshot for the MCP control plane.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ service: z.string(), version: z.string(), status: z.literal('ok'), timestamp: z.string() }),
      annotations: { readOnlyHint: true },
    },
    () => ok(health.snapshot()),
  );

  if (!services) return server;
  const fs = services.filesystem;

  server.registerTool('read_file', {
    title: 'Read project file', description: 'Read one authorized project text file with SHA-256 metadata.',
    inputSchema: z.object({ ...authShape, path: pathSchema }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await fs.readTextFile({ ...authorized(input), path: input.path })); } catch (error) { return failed(error); } });

  server.registerTool('stat_path', {
    title: 'Stat project path', description: 'Stat one authorized project path.',
    inputSchema: z.object({ ...authShape, path: pathSchema }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await fs.statPath({ ...authorized(input), path: input.path })); } catch (error) { return failed(error); } });

  server.registerTool('list_files', {
    title: 'List project files', description: 'List bounded project entries without following symlinks.',
    inputSchema: z.object({ ...authShape, path: z.string().max(4096).default('.'), depth: z.number().int().min(0).max(4).default(2), max_entries: z.number().int().min(1).max(500).default(200) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ entries: await fs.listFiles({ ...authorized(input), path: input.path, depth: input.depth, maxEntries: input.max_entries }) }); } catch (error) { return failed(error); } });

  server.registerTool('search_text', {
    title: 'Search project text', description: 'Literal case-insensitive bounded text search inside a project.',
    inputSchema: z.object({ ...authShape, query: z.string().min(1).max(500), path: z.string().max(4096).default('.'), max_results: z.number().int().min(1).max(100).default(50) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ matches: await fs.searchText({ ...authorized(input), query: input.query, path: input.path, maxResults: input.max_results }) }); } catch (error) { return failed(error); } });

  server.registerTool('write_file', {
    title: 'Write project file', description: 'Atomically create or replace text. Existing targets require their current SHA-256.',
    inputSchema: z.object({ ...authShape, path: pathSchema, content: z.string().max(1024 * 1024 + 1), expected_sha256: shaSchema.nullable().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.writeTextFile({ ...authorized(input), path: input.path, content: input.content, ...(input.expected_sha256 === undefined ? {} : { expectedSha256: input.expected_sha256 }) })); } catch (error) { return failed(error); } });

  server.registerTool('append_file', {
    title: 'Append project file', description: 'Atomically append text. Existing targets require their current SHA-256.',
    inputSchema: z.object({ ...authShape, path: pathSchema, content: z.string().max(1024 * 1024 + 1), expected_sha256: shaSchema.nullable().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.appendTextFile({ ...authorized(input), path: input.path, content: input.content, ...(input.expected_sha256 === undefined ? {} : { expectedSha256: input.expected_sha256 }) })); } catch (error) { return failed(error); } });

  server.registerTool('diff_file', {
    title: 'Preview file diff', description: 'Preview a bounded unified-style diff against proposed text content.',
    inputSchema: z.object({ ...authShape, path: pathSchema, proposed_content: z.string().max(1024 * 1024 + 1) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await fs.diffTextFile({ ...authorized(input), path: input.path, proposedContent: input.proposed_content })); } catch (error) { return failed(error); } });

  server.registerTool('apply_patch', {
    title: 'Apply exact patch', description: 'Replace exact text guarded by SHA-256 and expected match count.',
    inputSchema: z.object({ ...authShape, path: pathSchema, search: z.string().min(1).max(1024 * 1024), replacement: z.string().max(1024 * 1024), expected_sha256: shaSchema, expected_count: z.number().int().min(1).max(100).default(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.applyPatch({ ...authorized(input), path: input.path, search: input.search, replacement: input.replacement, expectedSha256: input.expected_sha256, expectedCount: input.expected_count })); } catch (error) { return failed(error); } });

  server.registerTool('batch_patch', {
    title: 'Apply batch patch', description: 'Apply 1–20 exact text patches after prevalidation, with best-effort rollback if an operation fails.',
    inputSchema: z.object({
      ...authShape,
      changes: z.array(z.object({ path: pathSchema, search: z.string().min(1).max(1024 * 1024), replacement: z.string().max(1024 * 1024), expected_sha256: shaSchema, expected_count: z.number().int().min(1).max(100).default(1) }).strict()).min(1).max(20),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.applyBatchPatch({ ...authorized(input), changes: input.changes.map((change) => ({ path: change.path, search: change.search, replacement: change.replacement, expectedSha256: change.expected_sha256, expectedCount: change.expected_count })) })); } catch (error) { return failed(error); } });

  server.registerTool('copy_file', {
    title: 'Copy project file', description: 'Copy a bounded text file to a new path inside the same project.',
    inputSchema: z.object({ ...authShape, from: pathSchema, to: pathSchema }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await fs.copyFile({ ...authorized(input), from: input.from, to: input.to })); } catch (error) { return failed(error); } });

  server.registerTool('move_file', {
    title: 'Move project file', description: 'Move a text file inside the same project using a SHA-256 guard.',
    inputSchema: z.object({ ...authShape, from: pathSchema, to: pathSchema, expected_sha256: shaSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.moveFile({ ...authorized(input), from: input.from, to: input.to, expectedSha256: input.expected_sha256 })); } catch (error) { return failed(error); } });

  server.registerTool('delete_file', {
    title: 'Delete project file', description: 'Delete a text file after SHA-256 verification; runtime backup is created when persistent storage is active.',
    inputSchema: z.object({ ...authShape, path: pathSchema, expected_sha256: shaSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => { try { return ok(await fs.deleteFile({ ...authorized(input), path: input.path, expectedSha256: input.expected_sha256 })); } catch (error) { return failed(error); } });

  return server;
}
