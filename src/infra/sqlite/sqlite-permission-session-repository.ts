import type Database from 'better-sqlite3';
import { z } from 'zod';
import { capabilitySchema } from '../../domain/authorization/capability.js';
import type { PermissionSessionRepository } from '../../domain/authorization/permission-session-repository.js';
import type { PermissionSession } from '../../domain/authorization/permission-session.js';

interface SessionRow {
  id: string;
  project_id: string;
  principal_id: string;
  capabilities_json: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  note: string | null;
}

function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('SQLite permission-session operation failed'));
  }
}

function mapRow(row: SessionRow): PermissionSession {
  return {
    id: row.id,
    projectId: row.project_id,
    principalId: row.principal_id,
    capabilities: z.array(capabilitySchema).parse(JSON.parse(row.capabilities_json) as unknown),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

export class SqlitePermissionSessionRepository implements PermissionSessionRepository {
  private readonly upsert;
  private readonly byId;
  private readonly byProject;
  private readonly revokeStatement;

  constructor(private readonly database: Database.Database) {
    this.upsert = database.prepare(`
      INSERT INTO permission_sessions (id, project_id, principal_id, capabilities_json, created_at, expires_at, revoked_at, note)
      VALUES (@id, @project_id, @principal_id, @capabilities_json, @created_at, @expires_at, @revoked_at, @note)
      ON CONFLICT(id) DO UPDATE SET
        capabilities_json = excluded.capabilities_json,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        note = excluded.note
    `);
    this.byId = database.prepare('SELECT * FROM permission_sessions WHERE id = ?');
    this.byProject = database.prepare('SELECT * FROM permission_sessions WHERE project_id = ? ORDER BY created_at DESC');
    this.revokeStatement = database.prepare('UPDATE permission_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  }

  save(session: PermissionSession): Promise<void> {
    return asPromise(() => {
      this.upsert.run({
        id: session.id,
        project_id: session.projectId,
        principal_id: session.principalId,
        capabilities_json: JSON.stringify(session.capabilities),
        created_at: session.createdAt,
        expires_at: session.expiresAt,
        revoked_at: session.revokedAt,
        note: session.note,
      });
    });
  }

  findById(id: string): Promise<PermissionSession | null> {
    return asPromise(() => {
      const row = this.byId.get(id) as SessionRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  listByProject(projectId: string): Promise<PermissionSession[]> {
    return asPromise(() => (this.byProject.all(projectId) as SessionRow[]).map(mapRow));
  }

  revoke(id: string, revokedAt: string): Promise<boolean> {
    return asPromise(() => this.revokeStatement.run(revokedAt, id).changes === 1);
  }
}
