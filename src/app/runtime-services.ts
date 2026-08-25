import path from 'node:path';
import type Database from 'better-sqlite3';
import { AuthorizationService } from './authorization-service.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { SecureFilesystemService } from './secure-filesystem-service.js';
import { SqlitePermissionSessionRepository } from '../infra/sqlite/sqlite-permission-session-repository.js';
import { SqlitePolicyRepository } from '../infra/sqlite/sqlite-policy-repository.js';
import { SqliteProjectRepository } from '../infra/sqlite/sqlite-project-repository.js';

export interface RuntimeServices {
  projects: SqliteProjectRepository;
  permissionSessions: SqlitePermissionSessionRepository;
  policies: SqlitePolicyRepository;
  authorization: AuthorizationService;
  paths: ProjectPathResolverFactory;
  filesystem: SecureFilesystemService;
}

export function createRuntimeServices(database: Database.Database, databaseFilename: string): RuntimeServices {
  const projects = new SqliteProjectRepository(database);
  const permissionSessions = new SqlitePermissionSessionRepository(database);
  const policies = new SqlitePolicyRepository(database);
  const authorization = new AuthorizationService(projects, permissionSessions, policies);
  const paths = new ProjectPathResolverFactory(projects);
  const backupRoot = databaseFilename === ':memory:' ? undefined : path.join(path.dirname(databaseFilename), 'backups');
  return {
    projects,
    permissionSessions,
    policies,
    authorization,
    paths,
    filesystem: new SecureFilesystemService(authorization, paths, backupRoot),
  };
}
