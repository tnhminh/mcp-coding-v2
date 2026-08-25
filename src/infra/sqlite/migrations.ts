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
