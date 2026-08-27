import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '001_projects',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        brain_status TEXT NOT NULL CHECK (brain_status IN ('not_indexed', 'indexing', 'ready', 'failed')),
        default_branch TEXT,
        remote_repository TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_projects_status ON projects(status);
      CREATE INDEX idx_projects_brain_status ON projects(brain_status);
    `,
  },
  {
    id: '002_authorization',
    sql: `
      CREATE TABLE permission_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        note TEXT
      );

      CREATE INDEX idx_permission_sessions_project ON permission_sessions(project_id, created_at DESC);
      CREATE INDEX idx_permission_sessions_expiry ON permission_sessions(expires_at);

      CREATE TABLE authorization_policies (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK (capability IN ('filesystem.read', 'filesystem.write', 'command.run', 'git.read', 'git.write')),
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_authorization_policies_project ON authorization_policies(project_id, enabled);
      CREATE INDEX idx_authorization_policies_capability ON authorization_policies(capability, enabled);
    `,
  },
  {
    id: '003_project_brain',
    sql: `
      CREATE TABLE project_brain_snapshots (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        built_at TEXT NOT NULL,
        index_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_project_brain_snapshots_built_at ON project_brain_snapshots(built_at DESC);
    `,
  },
  {
    id: '004_ai_jobs',
    sql: `
      CREATE TABLE ai_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_fix', 'awaiting_review', 'completed', 'stopped', 'failed', 'cancelled')),
        iteration INTEGER NOT NULL CHECK (iteration >= 0 AND iteration <= 20),
        max_iterations INTEGER NOT NULL CHECK (max_iterations >= 1 AND max_iterations <= 20),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        review_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_ai_jobs_project_updated ON ai_jobs(project_id, updated_at DESC);
      CREATE INDEX idx_ai_jobs_status ON ai_jobs(status, updated_at DESC);
    `,
  },
  {
    id: '005_audit_usage',
    sql: `
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        project_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        duration_ms INTEGER,
        error_code TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX idx_audit_events_time ON audit_events(occurred_at DESC);
      CREATE INDEX idx_audit_events_project_time ON audit_events(project_id, occurred_at DESC);
      CREATE INDEX idx_audit_events_action ON audit_events(action, occurred_at DESC);
      CREATE INDEX idx_audit_events_status ON audit_events(status, occurred_at DESC);

      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY NOT NULL,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        project_id TEXT,
        provider TEXT,
        model TEXT,
        operation TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        estimated_cost_usd REAL,
        token_visibility TEXT NOT NULL CHECK (token_visibility IN ('actual', 'estimated', 'unavailable')),
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX idx_usage_events_time ON usage_events(occurred_at DESC);
      CREATE INDEX idx_usage_events_project_time ON usage_events(project_id, occurred_at DESC);
      CREATE INDEX idx_usage_events_model_time ON usage_events(provider, model, occurred_at DESC);
      CREATE INDEX idx_usage_events_visibility ON usage_events(token_visibility, occurred_at DESC);
    `,
  },
];

export function applyMigrations(database: Database.Database): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = database.prepare('SELECT id FROM schema_migrations WHERE id = ?');
  const recordMigration = database.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );
  const applied: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.get(migration.id)) continue;

    const migrate = database.transaction(() => {
      database.exec(migration.sql);
      recordMigration.run(migration.id, new Date().toISOString());
    });
    migrate();
    applied.push(migration.id);
  }

  return applied;
}
