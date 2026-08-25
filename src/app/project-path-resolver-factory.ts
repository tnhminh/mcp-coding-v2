import { AppError } from './errors.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';
import { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

export class ProjectPathResolverFactory {
  constructor(private readonly projects: ProjectRepository) {}

  async forProject(projectId: string): Promise<ProjectPathResolver> {
    const projects = await this.projects.list();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Project was not found.',
        httpStatus: 404,
        expose: true,
      });
    }

    return ProjectPathResolver.create(project.rootPath, {
      otherProjectRoots: projects
        .filter((candidate) => candidate.id !== project.id)
        .map((candidate) => candidate.rootPath),
    });
  }
}
