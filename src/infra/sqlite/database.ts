import Database from 'better-sqlite3';
import { applyMigrations } from './migrations.js';

export interface SqliteDatabaseHandle {
  database: Database.Database;
  appliedMigrations: string[];
  close: () => void;
}

export function openSqliteDatabase(filename: string): SqliteDatabaseHandle {
  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') database.pragma('journal_mode = WAL');

  try {
    const appliedMigrations = applyMigrations(database);
    return {
      database,
      appliedMigrations,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
