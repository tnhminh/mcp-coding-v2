import type Database from 'better-sqlite3';
import { capabilitySchema } from '../../domain/authorization/capability.js';
import type { PolicyRepository } from '../../domain/authorization/policy-repository.js';
import { policyEffectSchema, type AuthorizationPolicy } from '../../domain/authorization/policy.js';

interface PolicyRow {
  id: string;
  name: string;
  project_id: string | null;
  capability: string;
  effect: string;
  enabled: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('SQLite policy operation failed'));
  }
}

function mapRow(row: PolicyRow): AuthorizationPolicy {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    capability: capabilitySchema.parse(row.capability),
    effect: policyEffectSchema.parse(row.effect),
    enabled: row.enabled === 1,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlitePolicyRepository implements PolicyRepository {
  private readonly upsert;
  private readonly byId;
  private readonly all;
  private readonly applicable;
  private readonly deleteById;

  constructor(private readonly database: Database.Database) {
    this.upsert = database.prepare(`
      INSERT INTO authorization_policies (id, name, project_id, capability, effect, enabled, reason, created_at, updated_at)
      VALUES (@id, @name, @project_id, @capability, @effect, @enabled, @reason, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        project_id = excluded.project_id,
        capability = excluded.capability,
        effect = excluded.effect,
        enabled = excluded.enabled,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `);
    this.byId = database.prepare('SELECT * FROM authorization_policies WHERE id = ?');
    this.all = database.prepare('SELECT * FROM authorization_policies ORDER BY created_at DESC');
    this.applicable = database.prepare('SELECT * FROM authorization_policies WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at ASC');
    this.deleteById = database.prepare('DELETE FROM authorization_policies WHERE id = ?');
  }

  save(policy: AuthorizationPolicy): Promise<void> {
    return asPromise(() => {
      this.upsert.run({
        id: policy.id,
        name: policy.name,
        project_id: policy.projectId,
        capability: policy.capability,
        effect: policy.effect,
        enabled: policy.enabled ? 1 : 0,
        reason: policy.reason,
        created_at: policy.createdAt,
        updated_at: policy.updatedAt,
      });
    });
  }

  findById(id: string): Promise<AuthorizationPolicy | null> {
    return asPromise(() => {
      const row = this.byId.get(id) as PolicyRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  list(): Promise<AuthorizationPolicy[]> {
    return asPromise(() => (this.all.all() as PolicyRow[]).map(mapRow));
  }

  listApplicable(projectId: string): Promise<AuthorizationPolicy[]> {
    return asPromise(() => (this.applicable.all(projectId) as PolicyRow[]).map(mapRow));
  }

  remove(id: string): Promise<boolean> {
    return asPromise(() => this.deleteById.run(id).changes === 1);
  }
}
