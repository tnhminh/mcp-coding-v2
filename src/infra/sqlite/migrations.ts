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
