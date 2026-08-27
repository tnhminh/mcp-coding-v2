import { z } from 'zod';
import type { AiJobService } from './ai-job-service.js';
import type { AuditUsageService } from './audit-usage-service.js';
import type { AppConfig } from './config.js';
import type { PreviewService } from './preview-service.js';
import type { TunnelIntegrationService } from './tunnel-integration-service.js';
import type { WindowsAutoStartService } from './windows-autostart-service.js';
import { AppError } from './errors.js';
import { HealthService } from './health-service.js';
import { mcpToolCatalog } from './mcp-tool-catalog.js';
import { allCapabilities, capabilitySchema } from '../domain/authorization/capability.js';
import type { PermissionSessionRepository } from '../domain/authorization/permission-session-repository.js';
import { createPermissionSession, isPermissionSessionActive, type PermissionSession } from '../domain/authorization/permission-session.js';
import type { PolicyRepository } from '../domain/authorization/policy-repository.js';
import { createAuthorizationPolicy, policyEffectSchema, type AuthorizationPolicy } from '../domain/authorization/policy.js';
import { createProject, touchProject, type Project } from '../domain/projects/project.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';
import { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  alias: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  rootPath: z.string().trim().min(1).max(4096),
  defaultBranch: z.string().trim().min(1).max(2048).nullable().optional(),
  remoteRepository: z.string().trim().min(1).max(2048).nullable().optional(),
}).strict();

const updateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  alias: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
  rootPath: z.string().trim().min(1).max(4096).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  defaultBranch: z.string().trim().min(1).max(2048).nullable().optional(),
  remoteRepository: z.string().trim().min(1).max(2048).nullable().optional(),
}).strict();

const permissionSessionInputSchema = z.object({
  principalId: z.string().trim().min(1).max(160),
  capabilities: z.array(capabilitySchema).min(1),
  ttlSeconds: z.number().int().min(60).max(86_400).default(3600),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

const policyInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  projectId: z.string().uuid().nullable().optional(),
  capability: capabilitySchema,
  effect: policyEffectSchema,
  enabled: z.boolean().default(true),
  reason: z.string().trim().max(500).nullable().optional(),
}).strict();

const updatePolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  projectId: z.string().uuid().nullable().optional(),
  capability: capabilitySchema.optional(),
  effect: policyEffectSchema.optional(),
  enabled: z.boolean().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
}).strict();

const createAiJobInputSchema = z.object({
  objective: z.string().trim().min(1).max(2000),
  maxIterations: z.number().int().min(1).max(20).default(5),
  permissionSessionId: z.string().uuid().optional(),
}).strict();

const previewStartInputSchema = z.object({
  profileId: z.string().trim().min(1).max(120),
  permissionSessionId: z.string().uuid().optional(),
}).strict();

const browserActionInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal('click_text'), text: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().max(2000) }).strict(),
  z.object({ type: z.literal('press'), selector: z.string().min(1).max(500), key: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(5000) }).strict(),
]);

const previewReviewInputSchema = z.object({
  path: z.string().min(1).max(2048).default('/'),
  actions: z.array(browserActionInputSchema).max(20).default([]),
  permissionSessionId: z.string().uuid().optional(),
}).strict();

const tunnelSetupInputSchema = z.object({
  tunnelId: z.string().trim().regex(/^tunnel_[A-Za-z0-9_-]{8,}$/u),
  runtimeApiKey: z.string().trim().min(8).max(4096).optional(),
  autoConnect: z.boolean().default(true),
}).strict();

const tunnelAutoConnectInputSchema = z.object({ enabled: z.boolean() }).strict();

const llmUsageInputSchema = z.object({
  source: z.string().trim().min(1).max(80).optional(),
  actorType: z.string().trim().min(1).max(80).optional(),
  actorId: z.string().trim().min(1).max(200).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(160),
  operation: z.string().trim().min(1).max(160).optional(),
  inputTokens: z.number().int().min(0).max(10_000_000_000),
  outputTokens: z.number().int().min(0).max(10_000_000_000),
  cachedInputTokens: z.number().int().min(0).max(10_000_000_000).optional(),
  reasoningTokens: z.number().int().min(0).max(10_000_000_000).optional(),
  estimatedCostUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  tokenVisibility: z.enum(['actual', 'estimated']).default('actual'),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

function validationError(error: z.ZodError): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message: error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '),
    httpStatus: 400,
    expose: true,
    cause: error,
  });
}

export class ControlCenterService {
  private readonly health = new HealthService();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: PermissionSessionRepository,
    private readonly policies: PolicyRepository,
    private readonly aiJobs: AiJobService,
    private readonly previews: PreviewService,
    private readonly tunnel: TunnelIntegrationService,
    private readonly autoStart: WindowsAutoStartService,
    private readonly auditUsage: AuditUsageService,
    private readonly config: AppConfig,
  ) {}

  async overview(): Promise<Record<string, unknown>> {
    const projects = await this.projects.list();
    const sessions = (await Promise.all(projects.map((project) => this.sessions.listByProject(project.id)))).flat();
    return {
      health: this.health.snapshot(),
      counts: {
        projects: projects.length,
        activeProjects: projects.filter((project) => project.status === 'active').length,
        tools: mcpToolCatalog.length,
        permissionSessions: sessions.filter((session) => isPermissionSessionActive(session)).length,
        policies: (await this.policies.list()).length,
      },
      runtime: {
        transport: 'Streamable HTTP + stdio',
        protocol: 'MCP 2026-07-28',
        endpoint: '/mcp',
        host: this.config.host,
        port: this.config.port,
      },
      modules: this.modules(),
    };
  }

  modules(): Array<{ id: string; label: string; state: 'available' | 'in_development' | 'planned' }> {
    return [
      { id: 'projects', label: 'Projects', state: 'available' },
      { id: 'mcp', label: 'MCP / Tools', state: 'available' },
      { id: 'permissions', label: 'Permissions', state: 'available' },
      { id: 'policies', label: 'Policies', state: 'available' },
      { id: 'filesystem', label: 'Filesystem', state: 'available' },
      { id: 'commands', label: 'Tasks / Commands', state: 'available' },
      { id: 'brain', label: 'Project Brain', state: 'available' },
      { id: 'jobs', label: 'AI Jobs', state: 'available' },
      { id: 'workflows', label: 'Workflow Runs', state: 'available' },
      { id: 'tunnel', label: 'Secure MCP Tunnel', state: 'available' },
      { id: 'audit', label: 'Audit Log', state: 'available' },
      { id: 'usage', label: 'Usage', state: 'available' },
      { id: 'git', label: 'Git / GitHub', state: 'planned' },
      { id: 'browser', label: 'Browser / Preview', state: 'available' },
      { id: 'remote', label: 'Remote / Deploy', state: 'planned' },
    ];
  }

  tools(): Array<Record<string, unknown>> {
    return mcpToolCatalog.map((tool) => ({ ...tool, state: 'available' }));
  }

  settings(): Record<string, unknown> {
    return {
      effective: {
        MCP_HOST: this.config.host,
        MCP_PORT: this.config.port,
        LOG_LEVEL: this.config.logLevel,
        MCP_DATABASE_PATH: this.config.databasePath,
      },
      authorization: {
        capabilities: allCapabilities,
        maxPermissionSessionTtlSeconds: 86_400,
        model: 'session grant required; enabled deny policies override grants',
      },
      note: 'Runtime settings are environment-backed. Changes require restart.',
    };
  }

  listProjects(): Promise<Project[]> { return this.projects.list(); }

  async createProject(input: unknown): Promise<Project> {
    const parsed = createProjectInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const existingAlias = await this.projects.findByAlias(parsed.data.alias);
    if (existingAlias) throw new AppError({ code: 'CONFLICT', message: 'Project alias already exists.', httpStatus: 409, expose: true });
    const others = await this.projects.list();
    await ProjectPathResolver.create(parsed.data.rootPath, { otherProjectRoots: others.map((project) => project.rootPath) });
    let project: Project;
    try {
      project = createProject({
        name: parsed.data.name,
        alias: parsed.data.alias,
        rootPath: parsed.data.rootPath,
        ...(parsed.data.defaultBranch === undefined ? {} : { defaultBranch: parsed.data.defaultBranch }),
        ...(parsed.data.remoteRepository === undefined ? {} : { remoteRepository: parsed.data.remoteRepository }),
      });
    } catch (error) {
      if (error instanceof z.ZodError) throw validationError(error);
      throw error;
    }
    await this.projects.save(project);
    return project;
  }

  async updateProject(id: string, input: unknown): Promise<Project> {
    const parsed = updateProjectInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const current = await this.projects.findById(id);
    if (!current) throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    if (parsed.data.alias && parsed.data.alias.toLowerCase() !== current.alias.toLowerCase()) {
      const aliasOwner = await this.projects.findByAlias(parsed.data.alias);
      if (aliasOwner && aliasOwner.id !== id) throw new AppError({ code: 'CONFLICT', message: 'Project alias already exists.', httpStatus: 409, expose: true });
    }
    const nextRoot = parsed.data.rootPath ?? current.rootPath;
    if (nextRoot !== current.rootPath) {
      const others = (await this.projects.list()).filter((project) => project.id !== id);
      await ProjectPathResolver.create(nextRoot, { otherProjectRoots: others.map((project) => project.rootPath) });
    }
    const next = touchProject({
      ...current,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.alias === undefined ? {} : { alias: parsed.data.alias }),
      ...(parsed.data.rootPath === undefined ? {} : { rootPath: parsed.data.rootPath }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      ...(parsed.data.defaultBranch === undefined ? {} : { defaultBranch: parsed.data.defaultBranch }),
      ...(parsed.data.remoteRepository === undefined ? {} : { remoteRepository: parsed.data.remoteRepository }),
    });
    await this.projects.save(next);
    return next;
  }

  async removeProject(id: string): Promise<void> {
    if (!await this.projects.remove(id)) throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
  }

  listPermissionSessions(projectId: string): Promise<PermissionSession[]> {
    return this.sessions.listByProject(projectId);
  }

  async createPermissionSession(projectId: string, input: unknown): Promise<PermissionSession> {
    const project = await this.projects.findById(projectId);
    if (!project) throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    if (project.status !== 'active') throw new AppError({ code: 'AUTHORIZATION_DENIED', message: 'Permission sessions can only be issued for active projects.', httpStatus: 403, expose: true });
    const parsed = permissionSessionInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const session = createPermissionSession({
      projectId,
      principalId: parsed.data.principalId,
      capabilities: parsed.data.capabilities,
      ttlSeconds: parsed.data.ttlSeconds,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
    await this.sessions.save(session);
    return session;
  }

  async revokePermissionSession(id: string): Promise<void> {
    if (!await this.sessions.revoke(id, new Date().toISOString())) {
      const existing = await this.sessions.findById(id);
      if (!existing) throw new AppError({ code: 'NOT_FOUND', message: 'Permission session was not found.', httpStatus: 404, expose: true });
    }
  }

  listPolicies(): Promise<AuthorizationPolicy[]> { return this.policies.list(); }

  async createPolicy(input: unknown): Promise<AuthorizationPolicy> {
    const parsed = policyInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    if (parsed.data.projectId && !await this.projects.findById(parsed.data.projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Policy project was not found.', httpStatus: 404, expose: true });
    }
    const policy = createAuthorizationPolicy({
      name: parsed.data.name,
      capability: parsed.data.capability,
      effect: parsed.data.effect,
      enabled: parsed.data.enabled,
      ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    });
    await this.policies.save(policy);
    return policy;
  }

  async updatePolicy(id: string, input: unknown): Promise<AuthorizationPolicy> {
    const parsed = updatePolicyInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const current = await this.policies.findById(id);
    if (!current) throw new AppError({ code: 'NOT_FOUND', message: 'Policy was not found.', httpStatus: 404, expose: true });
    if (parsed.data.projectId && !await this.projects.findById(parsed.data.projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Policy project was not found.', httpStatus: 404, expose: true });
    }
    const next: AuthorizationPolicy = {
      ...current,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
      ...(parsed.data.capability === undefined ? {} : { capability: parsed.data.capability }),
      ...(parsed.data.effect === undefined ? {} : { effect: parsed.data.effect }),
      ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      updatedAt: new Date().toISOString(),
    };
    await this.policies.save(next);
    return next;
  }

  async removePolicy(id: string): Promise<void> {
    if (!await this.policies.remove(id)) throw new AppError({ code: 'NOT_FOUND', message: 'Policy was not found.', httpStatus: 404, expose: true });
  }

  async listAiJobs(projectId: string): Promise<Awaited<ReturnType<AiJobService['list']>>> {
    if (!await this.projects.findById(projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    return this.aiJobs.list({ projectId });
  }

  async createAiJob(projectId: string, input: unknown): Promise<Awaited<ReturnType<AiJobService['create']>>> {
    if (!await this.projects.findById(projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    const parsed = createAiJobInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.aiJobs.create({
      projectId,
      objective: parsed.data.objective,
      maxIterations: parsed.data.maxIterations,
      ...(parsed.data.permissionSessionId === undefined ? {} : { permissionSessionId: parsed.data.permissionSessionId }),
    });
  }

  aiJobStatus(id: string): ReturnType<AiJobService['status']> {
    return this.aiJobs.status({ jobId: id });
  }

  cancelAiJob(id: string): ReturnType<AiJobService['cancel']> {
    return this.aiJobs.cancel({ jobId: id });
  }

  async previewProfiles(projectId: string): Promise<Awaited<ReturnType<PreviewService['profiles']>>> {
    if (!await this.projects.findById(projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    return this.previews.profiles({ projectId });
  }

  async listPreviews(projectId: string): Promise<Awaited<ReturnType<PreviewService['list']>>> {
    if (!await this.projects.findById(projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    return this.previews.list({ projectId });
  }

  async startPreview(projectId: string, input: unknown): Promise<Awaited<ReturnType<PreviewService['start']>>> {
    if (!await this.projects.findById(projectId)) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    const parsed = previewStartInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.previews.start({
      projectId,
      profileId: parsed.data.profileId,
      ...(parsed.data.permissionSessionId === undefined ? {} : { permissionSessionId: parsed.data.permissionSessionId }),
    });
  }

  previewStatus(id: string): ReturnType<PreviewService['status']> {
    return this.previews.status({ previewId: id });
  }

  stopPreview(id: string): ReturnType<PreviewService['stop']> {
    return this.previews.stop({ previewId: id });
  }

  async reviewPreview(id: string, input: unknown): Promise<Awaited<ReturnType<PreviewService['review']>>> {
    const parsed = previewReviewInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.previews.review({
      previewId: id,
      path: parsed.data.path,
      actions: parsed.data.actions,
      ...(parsed.data.permissionSessionId === undefined ? {} : { permissionSessionId: parsed.data.permissionSessionId }),
    });
  }

  tunnelStatus(): ReturnType<TunnelIntegrationService['status']> {
    return this.tunnel.status();
  }

  async tunnelSetupStatus(): Promise<{ setup: Awaited<ReturnType<TunnelIntegrationService['setupSnapshot']>>; tunnel: Awaited<ReturnType<TunnelIntegrationService['status']>> }> {
    return { setup: await this.tunnel.setupSnapshot(), tunnel: await this.tunnel.status() };
  }

  async tunnelConfigure(input: unknown): Promise<Awaited<ReturnType<TunnelIntegrationService['configureSetup']>>> {
    const parsed = tunnelSetupInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.tunnel.configureSetup({
      tunnelId: parsed.data.tunnelId,
      ...(parsed.data.runtimeApiKey === undefined ? {} : { runtimeApiKey: parsed.data.runtimeApiKey }),
      autoConnect: parsed.data.autoConnect,
    });
  }

  async tunnelSetAutoConnect(input: unknown): Promise<Awaited<ReturnType<TunnelIntegrationService['setAutoConnect']>>> {
    const parsed = tunnelAutoConnectInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.tunnel.setAutoConnect(parsed.data.enabled);
  }

  tunnelClearStoredRuntimeApiKey(): ReturnType<TunnelIntegrationService['clearStoredRuntimeApiKey']> {
    return this.tunnel.clearStoredRuntimeApiKey();
  }

  tunnelAutoStartStatus(): ReturnType<WindowsAutoStartService['status']> {
    return this.autoStart.status();
  }

  async tunnelSetWindowsAutoStart(input: unknown): Promise<Awaited<ReturnType<WindowsAutoStartService['status']>>> {
    const parsed = tunnelAutoConnectInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data.enabled ? this.autoStart.enable() : this.autoStart.disable();
  }

  tunnelDoctor(): ReturnType<TunnelIntegrationService['doctor']> {
    return this.tunnel.doctor();
  }

  tunnelConnect(): ReturnType<TunnelIntegrationService['connect']> {
    return this.tunnel.connect();
  }

  tunnelDisconnect(): ReturnType<TunnelIntegrationService['disconnect']> {
    return this.tunnel.disconnect();
  }

  auditEvents(input: { limit?: number; projectId?: string; status?: 'success' | 'failure'; category?: string; query?: string }) {
    return this.auditUsage.listAudit(input);
  }

  usageDashboard(input: { days?: number; projectId?: string }) {
    return this.auditUsage.usageDashboard(input);
  }

  recordLlmUsage(input: unknown) {
    const parsed = llmUsageInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return this.auditUsage.recordLlmUsage({
      provider: parsed.data.provider,
      model: parsed.data.model,
      inputTokens: parsed.data.inputTokens,
      outputTokens: parsed.data.outputTokens,
      tokenVisibility: parsed.data.tokenVisibility,
      ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
      ...(parsed.data.actorType === undefined ? {} : { actorType: parsed.data.actorType }),
      ...(parsed.data.actorId === undefined ? {} : { actorId: parsed.data.actorId }),
      ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
      ...(parsed.data.operation === undefined ? {} : { operation: parsed.data.operation }),
      ...(parsed.data.cachedInputTokens === undefined ? {} : { cachedInputTokens: parsed.data.cachedInputTokens }),
      ...(parsed.data.reasoningTokens === undefined ? {} : { reasoningTokens: parsed.data.reasoningTokens }),
      ...(parsed.data.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: parsed.data.estimatedCostUsd }),
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    });
  }
}
