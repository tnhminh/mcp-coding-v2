import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApplyVerifyService } from './apply-verify-service.js';
import type { ContextImpactService } from './context-impact-service.js';
import { HealthService } from './health-service.js';
import { toPublicError } from './errors.js';
import type { ProjectDiscoveryService } from './project-discovery-service.js';
import type { ProjectBrainService } from './project-brain-service.js';
import type { SecureFilesystemService } from './secure-filesystem-service.js';
import type { SkillDiscoveryService } from './skill-discovery-service.js';
import { taskKindSchema, type TaskRunnerService } from './task-runner-service.js';
import type { WorkspaceBootstrapService } from './workspace-bootstrap-service.js';

export interface McpToolServices {
  filesystem: SecureFilesystemService;
  projectDiscovery: ProjectDiscoveryService;
  tasks: TaskRunnerService;
  skills: SkillDiscoveryService;
  workspace: WorkspaceBootstrapService;
  applyVerify: ApplyVerifyService;
  brain: ProjectBrainService;
  contextImpact: ContextImpactService;
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

  server.registerTool('list_projects', {
    title: 'List local projects', description: 'List registered local project workspaces so the client can select a project ID.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => { try { return ok({ projects: await services.projectDiscovery.listProjects() }); } catch (error) { return failed(error); } });

  server.registerTool('project_info', {
    title: 'Project information', description: 'Return one registered local project workspace by ID.',
    inputSchema: z.object({ project_id: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.projectDiscovery.projectInfo(input.project_id)); } catch (error) { return failed(error); } });

  server.registerTool('workspace_bootstrap', {
    title: 'Bootstrap local workspace', description: 'Return project metadata, tool catalog, task profiles and discovered skills/instructions for an authorized local project.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.workspace.bootstrap(authorized(input))); } catch (error) { return failed(error); } });

  server.registerTool('list_task_profiles', {
    title: 'List project task profiles', description: 'Discover structured test/lint/typecheck/check/build/bench profiles without executing them.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ taskProfiles: await services.tasks.listTaskProfiles(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('run_task', {
    title: 'Run project task', description: 'Run one structured project task with shell disabled, sanitized environment, timeout, output cap and process-tree cleanup.',
    inputSchema: z.object({ ...authShape, task: taskKindSchema, timeout_seconds: z.number().int().min(1).max(600).optional() }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.tasks.runTask({ ...authorized(input), task: input.task, ...(input.timeout_seconds === undefined ? {} : { timeoutSeconds: input.timeout_seconds }) })); } catch (error) { return failed(error); } });

  server.registerTool('list_skills', {
    title: 'List project skills', description: 'Discover AGENTS, SKILL, prompt and editor-rule files inside an authorized local project.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ skills: await services.skills.listSkills(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('read_skill', {
    title: 'Read project skill', description: 'Read one recognized project skill/instruction file.',
    inputSchema: z.object({ ...authShape, path: pathSchema }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.skills.readSkill({ ...authorized(input), path: input.path })); } catch (error) { return failed(error); } });

  server.registerTool('brain_build', {
    title: 'Build Project Brain', description: 'Build or incrementally refresh the bounded project file/language/TS-JS symbol/import/reference/test/config index.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.brain.build(authorized(input))); } catch (error) { return failed(error); } });

  server.registerTool('brain_status', {
    title: 'Project Brain status', description: 'Return current Project Brain state, counts, language distribution and index statistics.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.brain.status(authorized(input))); } catch (error) { return failed(error); } });

  server.registerTool('find_symbol', {
    title: 'Find indexed symbol', description: 'Find TS/JS symbols in the Project Brain using exact-first substring ranking.',
    inputSchema: z.object({ ...authShape, query: z.string().min(1).max(300), max_results: z.number().int().min(1).max(200).default(50) }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ symbols: await services.brain.findSymbols({ ...authorized(input), query: input.query, maxResults: input.max_results }) }); } catch (error) { return failed(error); } });

  server.registerTool('symbol_references', {
    title: 'Find symbol references', description: 'Return indexed TS/JS identifier references for an exact symbol name.',
    inputSchema: z.object({ ...authShape, symbol: z.string().min(1).max(300), max_results: z.number().int().min(1).max(500).default(100) }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ references: await services.brain.references({ ...authorized(input), symbol: input.symbol, maxResults: input.max_results }) }); } catch (error) { return failed(error); } });

  server.registerTool('context_bundle', {
    title: 'Retrieve bounded coding context', description: 'Rank graph and literal-text evidence into a bounded source context bundle for coding/review.',
    inputSchema: z.object({ ...authShape, query: z.string().min(1).max(500), max_files: z.number().int().min(1).max(12).default(8), max_chars: z.number().int().min(2000).max(24000).default(12000) }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.contextImpact.contextBundle({ ...authorized(input), query: input.query, maxFiles: input.max_files, maxChars: input.max_chars })); } catch (error) { return failed(error); } });

  server.registerTool('impact_analysis', {
    title: 'Analyze change impact', description: 'Trace a file or exact symbol to declarations, references, importers, related tests and nearby configs.',
    inputSchema: z.object({ ...authShape, seed: z.string().min(1).max(4096), max_results: z.number().int().min(1).max(200).default(50) }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.contextImpact.impactAnalysis({ ...authorized(input), seed: input.seed, maxResults: input.max_results })); } catch (error) { return failed(error); } });

  const replaceChangeSchema = z.object({
    op: z.literal('replace'), path: pathSchema, search: z.string().min(1).max(1024 * 1024), replacement: z.string().max(1024 * 1024),
    expected_sha256: shaSchema, expected_count: z.number().int().min(1).max(100).default(1),
  }).strict();
  const writeChangeSchema = z.object({
    op: z.literal('write'), path: pathSchema, content: z.string().max(1024 * 1024 + 1), expected_sha256: shaSchema.nullable().optional(),
  }).strict();
  server.registerTool('apply_and_verify', {
    title: 'Apply and verify', description: 'Apply bounded code changes, run structured verification tasks, and roll back automatically when verification fails.',
    inputSchema: z.object({
      ...authShape,
      changes: z.array(z.discriminatedUnion('op', [replaceChangeSchema, writeChangeSchema])).min(1).max(20),
      tasks: z.array(taskKindSchema).min(1).max(6),
      rollback_on_failure: z.boolean().default(true),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return ok(await services.applyVerify.applyAndVerify({
        ...authorized(input),
        changes: input.changes.map((change) => change.op === 'replace'
          ? { op: 'replace' as const, path: change.path, search: change.search, replacement: change.replacement, expectedSha256: change.expected_sha256, expectedCount: change.expected_count }
          : { op: 'write' as const, path: change.path, content: change.content, ...(change.expected_sha256 === undefined ? {} : { expectedSha256: change.expected_sha256 }) }),
        tasks: input.tasks,
        rollbackOnFailure: input.rollback_on_failure,
      }));
    } catch (error) { return failed(error); }
  });

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
