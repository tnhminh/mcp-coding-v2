import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AiJobService } from './ai-job-service.js';
import type { AuditUsageService } from './audit-usage-service.js';
import type { AuthorizationService } from './authorization-service.js';
import type { ApplyVerifyService } from './apply-verify-service.js';
import type { CodingCycleService } from './coding-cycle-service.js';
import { commandRecipeIdSchema, type CommandRecipeService } from './command-recipe-service.js';
import type { ContextImpactService } from './context-impact-service.js';
import { mcpToolCatalog } from './mcp-tool-catalog.js';
import type { BrowserReviewResult, PreviewService } from './preview-service.js';
import { HealthService } from './health-service.js';
import { toPublicError } from './errors.js';
import type { ProjectDiscoveryService } from './project-discovery-service.js';
import type { ProjectReadinessService } from './project-readiness-service.js';
import type { ProjectBrainService } from './project-brain-service.js';
import type { SecureFilesystemService } from './secure-filesystem-service.js';
import type { SkillDiscoveryService } from './skill-discovery-service.js';
import { taskKindSchema, type TaskRunnerService } from './task-runner-service.js';
import type { WorkspaceBootstrapService } from './workspace-bootstrap-service.js';

export interface McpToolServices {
  authorization: AuthorizationService;
  filesystem: SecureFilesystemService;
  projectDiscovery: ProjectDiscoveryService;
  readiness: ProjectReadinessService;
  tasks: TaskRunnerService;
  commandRecipes: CommandRecipeService;
  skills: SkillDiscoveryService;
  workspace: WorkspaceBootstrapService;
  applyVerify: ApplyVerifyService;
  brain: ProjectBrainService;
  contextImpact: ContextImpactService;
  codingCycle: CodingCycleService;
  aiJobs: AiJobService;
  previews: PreviewService;
  auditUsage: AuditUsageService;
}

const authShape = {
  project_id: z.string().uuid(),
  permission_session_id: z.string().uuid().optional(),
};
const pathSchema = z.string().min(1).max(4096);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

function authorized(input: { project_id: string; permission_session_id?: string | undefined }) {
  return {
    projectId: input.project_id,
    ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }),
  };
}

function ok<T extends object>(output: T) {
  const structuredContent = { ...output } as Record<string, unknown>;
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent };
}

function failed(error: unknown) {
  const publicError = toPublicError(error).body.error;
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(publicError) }] };
}

function browserOk(result: BrowserReviewResult) {
  const { screenshotBase64, ...summary } = result;
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(summary) },
      { type: 'image' as const, data: screenshotBase64, mimeType: 'image/jpeg' },
    ],
    structuredContent: summary as Record<string, unknown>,
  };
}

type RuntimeRegisteredTool = {
  handler: (args: unknown, context: unknown) => unknown;
  update: (updates: { callback: (args: unknown, context: unknown) => Promise<unknown> }) => void;
};

function projectIdFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = (args as Record<string, unknown>).project_id;
  return typeof value === 'string' ? value : null;
}

function permissionSessionSupplied(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  return typeof (args as Record<string, unknown>).permission_session_id === 'string';
}

function safePayloadBytes(args: unknown): number | null {
  try { return Buffer.byteLength(JSON.stringify(args), 'utf8'); } catch { return null; }
}

function toolResultFailed(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).isError === true);
}

function installToolAudit(server: McpServer, audit: AuditUsageService): void {
  const internals = server as unknown as { _registeredTools?: Record<string, RuntimeRegisteredTool> };
  if (!internals._registeredTools) return;
  for (const [name, tool] of Object.entries(internals._registeredTools)) {
    const original = tool.handler;
    tool.update({ callback: async (args, context) => {
      const started = Date.now();
      const projectId = projectIdFromArgs(args);
      const payloadBytes = safePayloadBytes(args);
      try {
        const result = await original(args, context);
        const failed = toolResultFailed(result);
        const durationMs = Date.now() - started;
        audit.recordAudit({
          category: 'mcp_tool', action: name, actorType: 'mcp_client', projectId,
          status: failed ? 'failure' : 'success', durationMs,
          errorCode: failed ? 'TOOL_ERROR' : null,
          metadata: { permissionSessionSupplied: permissionSessionSupplied(args), payloadBytes },
        });
        audit.recordToolUsage({ tool: name, projectId, durationMs, payloadBytes });
        return result;
      } catch (error) {
        const durationMs = Date.now() - started;
        audit.recordAudit({
          category: 'mcp_tool', action: name, actorType: 'mcp_client', projectId,
          status: 'failure', durationMs, errorCode: 'UNHANDLED_TOOL_ERROR',
          metadata: { permissionSessionSupplied: permissionSessionSupplied(args), payloadBytes },
        });
        audit.recordToolUsage({ tool: name, projectId, durationMs, payloadBytes });
        throw error;
      }
    } });
  }
}

export function createMcpServer(services?: McpToolServices): McpServer {
  const health = new HealthService();
  const server = new McpServer(
    { name: 'mcp-coding-v2', version: '0.1.0' },
    { capabilities: { tools: {}, resources: { listChanged: false } } },
  );

  server.registerResource(
    'tool-catalog',
    'mcp://server/tool-catalog',
    { title: 'MCP Coding Tool Catalog', description: 'Read-only catalog of the local coding MCP tool surface.', mimeType: 'application/json' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(mcpToolCatalog) }] }),
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

  server.registerTool('project_access_status', {
    title: 'Project access status', description: 'Inspect effective project capabilities, policy denials and permission ambiguity without exposing permission-session bearer IDs. Use this before planning when privileged tools may be blocked.',
    inputSchema: z.object({ project_id: z.string().uuid(), permission_session_id: z.string().uuid().optional() }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.authorization.inspectAccess({ projectId: input.project_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }) })); } catch (error) { return failed(error); } });

  server.registerTool('project_readiness', {
    title: 'Inspect project readiness', description: 'Inspect dependency artifacts, lockfile state, non-interactive task configuration and available verification tasks before coding. Use this to distinguish environment/toolchain readiness issues from source-code failures.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.readiness.inspect(authorized(input))); } catch (error) { return failed(error); } });

  server.registerTool('prepare_workspace', {
    title: 'Prepare workspace', description: 'Prepare the project before coding: install missing declared dependencies through the structured package.install recipe, then run baseline verification tasks so pre-existing failures are captured before edits.',
    inputSchema: z.object({
      ...authShape,
      run_baseline: z.boolean().default(true),
      baseline_tasks: z.array(taskKindSchema).max(5).optional(),
    }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => {
    try {
      return ok(await services.readiness.prepare({
        ...authorized(input),
        runBaseline: input.run_baseline,
        ...(input.baseline_tasks === undefined ? {} : { baselineTasks: input.baseline_tasks }),
      }));
    } catch (error) { return failed(error); }
  });

  server.registerTool('workspace_bootstrap', {
    title: 'Bootstrap local workspace', description: 'Return project metadata, effective access/capability manifest, project readiness, all declared safe package scripts, task/preview profiles, skills/instructions and Verification Router V2. Inspect this before planning so the agent knows what is actually available.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.workspace.bootstrap(authorized(input))); } catch (error) { return failed(error); } });

  server.registerTool('list_task_profiles', {
    title: 'List project task profiles', description: 'Auto-discover structured test/lint/typecheck/check/build/bench profiles from safe package-script aliases, ecosystem conventions and built-in static integrity checks, without executing them.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ taskProfiles: await services.tasks.listTaskProfiles(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('run_task', {
    title: 'Run project task', description: 'Run one structured project task with shell disabled, sanitized environment, timeout, output cap and process-tree cleanup.',
    inputSchema: z.object({ ...authShape, task: taskKindSchema, timeout_seconds: z.number().int().min(1).max(600).optional() }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.tasks.runTask({ ...authorized(input), task: input.task, ...(input.timeout_seconds === undefined ? {} : { timeoutSeconds: input.timeout_seconds }) })); } catch (error) { return failed(error); } });

  server.registerTool('list_command_recipes', {
    title: 'List structured command recipes', description: 'Discover dependency/install/codegen recipes plus every existing safe-name package.json script for this project without exposing caller-controlled raw shell.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ commandRecipes: await services.commandRecipes.listRecipes(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('run_command_recipe', {
    title: 'Run structured command recipe', description: 'Run a validated project recipe or one existing safe-name package.json script through the bounded safe process runner; caller-controlled raw shell is not exposed.',
    inputSchema: z.object({
      ...authShape,
      recipe: commandRecipeIdSchema,
      packages: z.array(z.string().min(1).max(160)).max(32).optional(),
      script: z.string().min(1).max(120).optional(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return ok(await services.commandRecipes.runRecipe({
        ...authorized(input),
        recipe: input.recipe,
        ...(input.packages === undefined ? {} : { packages: input.packages }),
        ...(input.script === undefined ? {} : { script: input.script }),
        ...(input.timeout_seconds === undefined ? {} : { timeoutSeconds: input.timeout_seconds }),
      }));
    } catch (error) { return failed(error); }
  });

  server.registerTool('list_skills', {
    title: 'List project skills', description: 'Discover nested AGENTS, SKILL, prompt and rule files across common coding-agent formats including MCP/Agents/Codex/Claude/GitHub/Cursor/Cline/Roo/Windsurf/Continue.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ skills: await services.skills.listSkills(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('read_skill', {
    title: 'Read project skill', description: 'Read one recognized project skill/instruction file.',
    inputSchema: z.object({ ...authShape, path: pathSchema }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.skills.readSkill({ ...authorized(input), path: input.path })); } catch (error) { return failed(error); } });

  server.registerTool('project_guidance', {
    title: 'Load project guidance', description: 'Load a bounded bundle of all recognized coding-agent instructions and skills with source/scope metadata. Use before implementation so project rules are not missed.',
    inputSchema: z.object({ ...authShape, max_bytes: z.number().int().min(1024).max(1024 * 1024).optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try {
      return ok(await services.skills.guidanceBundle({
        ...authorized(input),
        ...(input.max_bytes === undefined ? {} : { maxBytes: input.max_bytes }),
      }));
    } catch (error) { return failed(error); }
  });

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
  server.registerTool('coding_cycle', {
    title: 'Run coding cycle', description: 'Orchestrate one bounded IMPLEMENT → VERIFY → REVIEW step using only task IDs returned by Verification Router V2. Prefer workspace_bootstrap.verificationStrategy.fastTaskIds and add releaseTaskIds before DONE; never invent task IDs.',
    inputSchema: z.object({
      ...authShape,
      objective: z.string().min(1).max(2000),
      changes: z.array(z.discriminatedUnion('op', [replaceChangeSchema, writeChangeSchema])).min(1).max(20),
      tasks: z.array(taskKindSchema).min(1).max(6),
      review_seeds: z.array(z.string().min(1).max(4096)).max(20).optional(),
      iteration: z.number().int().min(1).max(20).default(1),
      max_iterations: z.number().int().min(1).max(20).default(5),
      rollback_on_failure: z.boolean().default(true),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return ok(await services.codingCycle.runCycle({
        ...authorized(input),
        objective: input.objective,
        changes: input.changes.map((change) => change.op === 'replace'
          ? { op: 'replace' as const, path: change.path, search: change.search, replacement: change.replacement, expectedSha256: change.expected_sha256, expectedCount: change.expected_count }
          : { op: 'write' as const, path: change.path, content: change.content, ...(change.expected_sha256 === undefined ? {} : { expectedSha256: change.expected_sha256 }) }),
        tasks: input.tasks,
        ...(input.review_seeds === undefined ? {} : { reviewSeeds: input.review_seeds }),
        iteration: input.iteration,
        maxIterations: input.max_iterations,
        rollbackOnFailure: input.rollback_on_failure,
      }));
    } catch (error) { return failed(error); }
  });

  server.registerTool('agent_job_create', {
    title: 'Create persistent agent job', description: 'Create a persistent project coding objective with bounded iteration budget. Permission sessions are not persisted with the job.',
    inputSchema: z.object({ ...authShape, objective: z.string().min(1).max(2000), max_iterations: z.number().int().min(1).max(20).default(5) }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.aiJobs.create({ ...authorized(input), objective: input.objective, maxIterations: input.max_iterations })); } catch (error) { return failed(error); } });

  server.registerTool('agent_job_list', {
    title: 'List persistent agent jobs', description: 'List recent persistent coding jobs for one authorized project.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ jobs: await services.aiJobs.list(authorized(input)) }); } catch (error) { return failed(error); } });

  const jobAccessSchema = z.object({ job_id: z.string().uuid(), permission_session_id: z.string().uuid().optional() }).strict();
  server.registerTool('agent_job_status', {
    title: 'Read persistent agent job', description: 'Return persisted objective, state, iteration and bounded evidence so an agent can resume after reconnect/restart.',
    inputSchema: jobAccessSchema, annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.aiJobs.status({ jobId: input.job_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }) })); } catch (error) { return failed(error); } });

  server.registerTool('agent_job_cycle', {
    title: 'Run persistent agent job cycle', description: 'Run one persisted IMPLEMENT → VERIFY → REVIEW cycle using only Verification Router V2 task IDs. Prefer the bootstrap fast/release plans; missing profiles return VERIFICATION_UNAVAILABLE before job state or files advance.',
    inputSchema: z.object({
      job_id: z.string().uuid(),
      permission_session_id: z.string().uuid().optional(),
      changes: z.array(z.discriminatedUnion('op', [replaceChangeSchema, writeChangeSchema])).min(1).max(20),
      tasks: z.array(taskKindSchema).min(1).max(6),
      review_seeds: z.array(z.string().min(1).max(4096)).max(20).optional(),
      rollback_on_failure: z.boolean().default(true),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return ok(await services.aiJobs.cycle({
        jobId: input.job_id,
        ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }),
        changes: input.changes.map((change) => change.op === 'replace'
          ? { op: 'replace' as const, path: change.path, search: change.search, replacement: change.replacement, expectedSha256: change.expected_sha256, expectedCount: change.expected_count }
          : { op: 'write' as const, path: change.path, content: change.content, ...(change.expected_sha256 === undefined ? {} : { expectedSha256: change.expected_sha256 }) }),
        tasks: input.tasks,
        ...(input.review_seeds === undefined ? {} : { reviewSeeds: input.review_seeds }),
        rollbackOnFailure: input.rollback_on_failure,
      }));
    } catch (error) { return failed(error); }
  });

  server.registerTool('agent_job_complete', {
    title: 'Complete persistent agent job', description: 'Mark a verified job complete only from awaiting_review after the connected AI supplies its semantic review summary.',
    inputSchema: z.object({ job_id: z.string().uuid(), permission_session_id: z.string().uuid().optional(), review_summary: z.string().min(1).max(4000) }).strict(),
    annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.aiJobs.complete({ jobId: input.job_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }), reviewSummary: input.review_summary })); } catch (error) { return failed(error); } });

  server.registerTool('agent_job_cancel', {
    title: 'Cancel persistent agent job', description: 'Cancel a non-terminal persistent agent job using a compare-and-set state transition.',
    inputSchema: jobAccessSchema, annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.aiJobs.cancel({ jobId: input.job_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }) })); } catch (error) { return failed(error); } });

  server.registerTool('preview_profiles', {
    title: 'List local preview profiles', description: 'Discover loopback-only static or recognized framework dev-preview profiles for an authorized project.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ previewProfiles: await services.previews.profiles(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('preview_list', {
    title: 'List local preview sessions', description: 'List runtime-owned preview sessions for one authorized project, including stopped/failed state and redacted logs.',
    inputSchema: z.object(authShape).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok({ previews: await services.previews.list(authorized(input)) }); } catch (error) { return failed(error); } });

  server.registerTool('preview_start', {
    title: 'Start local project preview', description: 'Start a loopback-only static or recognized dev preview. Unknown generic dev scripts are not launched.',
    inputSchema: z.object({ ...authShape, profile_id: z.string().min(1).max(120) }).strict(), annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.previews.start({ ...authorized(input), profileId: input.profile_id })); } catch (error) { return failed(error); } });

  const previewAccessSchema = z.object({ preview_id: z.string().uuid(), permission_session_id: z.string().uuid().optional() }).strict();
  server.registerTool('preview_status', {
    title: 'Read local preview status', description: 'Read runtime state and redacted bounded logs for one local preview session.',
    inputSchema: previewAccessSchema, annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await services.previews.status({ previewId: input.preview_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }) })); } catch (error) { return failed(error); } });

  server.registerTool('preview_stop', {
    title: 'Stop local project preview', description: 'Stop one loopback preview and its dev-server process tree when applicable.',
    inputSchema: previewAccessSchema, annotations: { readOnlyHint: false },
  }, async (input) => { try { return ok(await services.previews.stop({ previewId: input.preview_id, ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }) })); } catch (error) { return failed(error); } });

  const browserActionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
    z.object({ type: z.literal('click_text'), text: z.string().min(1).max(500) }).strict(),
    z.object({ type: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().max(2000) }).strict(),
    z.object({ type: z.literal('press'), selector: z.string().min(1).max(500), key: z.string().min(1).max(80) }).strict(),
    z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(5000) }).strict(),
  ]);
  server.registerTool('browser_review', {
    title: 'Review local preview in browser', description: 'Open only a server-created preview_id in local Edge/Chrome, block cross-origin HTTP/WebSocket egress, optionally interact, and return DOM/console/network/screenshot evidence.',
    inputSchema: z.object({
      preview_id: z.string().uuid(),
      permission_session_id: z.string().uuid().optional(),
      path: z.string().min(1).max(2048).default('/'),
      actions: z.array(browserActionSchema).max(20).default([]),
    }).strict(), annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return browserOk(await services.previews.review({
        previewId: input.preview_id,
        ...(input.permission_session_id === undefined ? {} : { permissionSessionId: input.permission_session_id }),
        path: input.path,
        actions: input.actions,
      }));
    } catch (error) { return failed(error); }
  });

  server.registerTool('apply_and_verify', {
    title: 'Apply and verify', description: 'Apply bounded code changes and run only verification task IDs returned by workspace_bootstrap/list_task_profiles. Requested task profiles are preflighted before any file mutation; unavailable profiles return VERIFICATION_UNAVAILABLE instead of being treated as code failure.',
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

  server.registerTool('read_files', {
    title: 'Read project files', description: 'Read up to 20 authorized project text files in one bounded call. Each file keeps SHA-256 metadata so the agent can prepare safe patches efficiently.',
    inputSchema: z.object({ ...authShape, paths: z.array(pathSchema).min(1).max(20) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try {
      const files = [];
      for (const requestedPath of [...new Set(input.paths)]) {
        files.push(await fs.readTextFile({ ...authorized(input), path: requestedPath }));
      }
      return ok({ files });
    } catch (error) { return failed(error); }
  });

  server.registerTool('stat_path', {
    title: 'Stat project path', description: 'Stat one authorized project path.',
    inputSchema: z.object({ ...authShape, path: pathSchema }).strict(), annotations: { readOnlyHint: true },
  }, async (input) => { try { return ok(await fs.statPath({ ...authorized(input), path: input.path })); } catch (error) { return failed(error); } });

  server.registerTool('list_files', {
    title: 'List project files', description: 'List bounded project entries without following symlinks.',
    inputSchema: z.object({ ...authShape, path: z.string().max(4096).default('.'), depth: z.number().int().min(0).max(8).default(2), max_entries: z.number().int().min(1).max(500).default(200) }).strict(),
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

  installToolAudit(server, services.auditUsage);
  return server;
}
