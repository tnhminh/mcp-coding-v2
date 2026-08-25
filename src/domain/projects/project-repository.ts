import type { Project } from './project.js';

/**
 * Async by contract even for the local synchronous SQLite adapter so a future
 * PostgreSQL implementation can be swapped without changing application services.
 */
export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(id: string): Promise<Project | null>;
  findByAlias(alias: string): Promise<Project | null>;
  list(): Promise<Project[]>;
  remove(id: string): Promise<boolean>;
}
