import { z } from 'zod';
import type { AppConfig } from './config.js';
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
      { id: 'brain', label: 'Project Brain', state: 'planned' },
      { id: 'git', label: 'Git / GitHub', state: 'planned' },
      { id: 'browser', label: 'Browser / Preview', state: 'planned' },
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
}
