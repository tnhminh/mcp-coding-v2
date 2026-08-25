import { z } from 'zod';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { HealthService } from './health-service.js';
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
    private readonly config: AppConfig,
  ) {}

  async overview(): Promise<Record<string, unknown>> {
    const projects = await this.projects.list();
    return {
      health: this.health.snapshot(),
      counts: {
        projects: projects.length,
        activeProjects: projects.filter((project) => project.status === 'active').length,
        tools: 1,
        permissionSessions: 0,
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
      { id: 'permissions', label: 'Permissions', state: 'in_development' },
      { id: 'policies', label: 'Policies', state: 'planned' },
      { id: 'filesystem', label: 'Filesystem', state: 'planned' },
      { id: 'brain', label: 'Project Brain', state: 'planned' },
      { id: 'git', label: 'Git / GitHub', state: 'planned' },
      { id: 'browser', label: 'Browser / Preview', state: 'planned' },
      { id: 'remote', label: 'Remote / Deploy', state: 'planned' },
    ];
  }

  tools(): Array<Record<string, unknown>> {
    return [{
      name: 'system_health',
      title: 'System health',
      mode: 'read-only',
      state: 'available',
      description: 'Minimal non-sensitive MCP control-plane health snapshot.',
    }];
  }

  settings(): Record<string, unknown> {
    return {
      effective: {
        MCP_HOST: this.config.host,
        MCP_PORT: this.config.port,
        LOG_LEVEL: this.config.logLevel,
        MCP_DATABASE_PATH: this.config.databasePath,
      },
      note: 'Runtime settings are environment-backed. Changes require restart; editable persisted settings will be added with the policy/config subsystem.',
    };
  }

  listProjects(): Promise<Project[]> {
    return this.projects.list();
  }

  async createProject(input: unknown): Promise<Project> {
    const parsed = createProjectInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);

    const existingAlias = await this.projects.findByAlias(parsed.data.alias);
    if (existingAlias) {
      throw new AppError({ code: 'CONFLICT', message: 'Project alias already exists.', httpStatus: 409, expose: true });
    }

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
    if (!current) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }

    if (parsed.data.alias && parsed.data.alias.toLowerCase() !== current.alias.toLowerCase()) {
      const aliasOwner = await this.projects.findByAlias(parsed.data.alias);
      if (aliasOwner && aliasOwner.id !== id) {
        throw new AppError({ code: 'CONFLICT', message: 'Project alias already exists.', httpStatus: 409, expose: true });
      }
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
    const removed = await this.projects.remove(id);
    if (!removed) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
  }
}
