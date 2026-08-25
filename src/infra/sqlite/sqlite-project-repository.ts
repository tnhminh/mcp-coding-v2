import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ProjectRepository } from '../../domain/projects/project-repository.js';
import {
  brainStatusSchema,
  projectStatusSchema,
  type Project,
  type ProjectMetadata,
} from '../../domain/projects/project.js';

interface ProjectRow {
  id: string;
  name: string;
  alias: string;
  root_path: string;
  status: string;
  brain_status: string;
  default_branch: string | null;
  remote_repository: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

const metadataSchema = z.record(z.string(), z.json());

function decodeMetadata(value: string): ProjectMetadata {
  return metadataSchema.parse(JSON.parse(value) as unknown);
}

function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('SQLite operation failed'));
  }
}

function mapRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    alias: row.alias,
    rootPath: row.root_path,
    status: projectStatusSchema.parse(row.status),
    brainStatus: brainStatusSchema.parse(row.brain_status),
    defaultBranch: row.default_branch,
    remoteRepository: row.remote_repository,
    metadata: decodeMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteProjectRepository implements ProjectRepository {
  private readonly upsert;
  private readonly byId;
  private readonly byAlias;
  private readonly all;
  private readonly deleteById;

  constructor(private readonly database: Database.Database) {
    this.upsert = database.prepare(`
      INSERT INTO projects (
        id, name, alias, root_path, status, brain_status,
        default_branch, remote_repository, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @name, @alias, @root_path, @status, @brain_status,
        @default_branch, @remote_repository, @metadata_json, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        alias = excluded.alias,
        root_path = excluded.root_path,
        status = excluded.status,
        brain_status = excluded.brain_status,
        default_branch = excluded.default_branch,
        remote_repository = excluded.remote_repository,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    this.byId = database.prepare('SELECT * FROM projects WHERE id = ?');
    this.byAlias = database.prepare('SELECT * FROM projects WHERE alias = ? COLLATE NOCASE');
    this.all = database.prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC');
    this.deleteById = database.prepare('DELETE FROM projects WHERE id = ?');
  }

  save(project: Project): Promise<void> {
    return asPromise(() => {
      this.upsert.run({
        id: project.id,
        name: project.name,
        alias: project.alias,
        root_path: project.rootPath,
        status: project.status,
        brain_status: project.brainStatus,
        default_branch: project.defaultBranch,
        remote_repository: project.remoteRepository,
        metadata_json: JSON.stringify(project.metadata),
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      });
    });
  }

  findById(id: string): Promise<Project | null> {
    return asPromise(() => {
      const row = this.byId.get(id) as ProjectRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  findByAlias(alias: string): Promise<Project | null> {
    return asPromise(() => {
      const row = this.byAlias.get(alias) as ProjectRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  list(): Promise<Project[]> {
    return asPromise(() => (this.all.all() as ProjectRow[]).map(mapRow));
  }

  remove(id: string): Promise<boolean> {
    return asPromise(() => this.deleteById.run(id).changes === 1);
  }
}
