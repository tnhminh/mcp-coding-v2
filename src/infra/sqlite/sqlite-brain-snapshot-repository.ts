import type Database from 'better-sqlite3';
import type { BrainSnapshot, BrainSnapshotRepository } from '../../app/brain-snapshot-repository.js';

interface BrainSnapshotRow {
  project_id: string;
  built_at: string;
  index_json: string;
  updated_at: string;
}

function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('SQLite operation failed'));
  }
}

function mapRow(row: BrainSnapshotRow): BrainSnapshot {
  return {
    projectId: row.project_id,
    builtAt: row.built_at,
    indexJson: row.index_json,
    updatedAt: row.updated_at,
  };
}

export class SqliteBrainSnapshotRepository implements BrainSnapshotRepository {
  private readonly upsert;
  private readonly byProject;
  private readonly deleteByProject;

  constructor(database: Database.Database) {
    this.upsert = database.prepare(`
      INSERT INTO project_brain_snapshots (project_id, built_at, index_json, updated_at)
      VALUES (@project_id, @built_at, @index_json, @updated_at)
      ON CONFLICT(project_id) DO UPDATE SET
        built_at = excluded.built_at,
        index_json = excluded.index_json,
        updated_at = excluded.updated_at
    `);
    this.byProject = database.prepare('SELECT * FROM project_brain_snapshots WHERE project_id = ?');
    this.deleteByProject = database.prepare('DELETE FROM project_brain_snapshots WHERE project_id = ?');
  }

  save(snapshot: BrainSnapshot): Promise<void> {
    return asPromise(() => {
      this.upsert.run({
        project_id: snapshot.projectId,
        built_at: snapshot.builtAt,
        index_json: snapshot.indexJson,
        updated_at: snapshot.updatedAt,
      });
    });
  }

  findByProjectId(projectId: string): Promise<BrainSnapshot | null> {
    return asPromise(() => {
      const row = this.byProject.get(projectId) as BrainSnapshotRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  remove(projectId: string): Promise<boolean> {
    return asPromise(() => this.deleteByProject.run(projectId).changes === 1);
  }
}
