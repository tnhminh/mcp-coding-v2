import { AppError } from './errors.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';
import type { Project } from '../domain/projects/project.js';

export interface ProjectSummary {
  id: string;
  name: string;
  alias: string;
  rootPath: string;
  status: Project['status'];
  brainStatus: Project['brainStatus'];
  defaultBranch: string | null;
  remoteRepository: string | null;
}

function summarize(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    alias: project.alias,
    rootPath: project.rootPath,
    status: project.status,
    brainStatus: project.brainStatus,
    defaultBranch: project.defaultBranch,
    remoteRepository: project.remoteRepository,
  };
}

export class ProjectDiscoveryService {
  constructor(private readonly projects: ProjectRepository) {}

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.projects.list()).map(summarize);
  }

  async projectInfo(projectId: string): Promise<ProjectSummary> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    }
    return summarize(project);
  }
}
