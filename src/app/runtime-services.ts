import path from 'node:path';
import type Database from 'better-sqlite3';
import { ApplyVerifyService } from './apply-verify-service.js';
import { AuthorizationService } from './authorization-service.js';
import { ContextImpactService } from './context-impact-service.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { ProjectDiscoveryService } from './project-discovery-service.js';
import { ProjectBrainService } from './project-brain-service.js';
import { SecureFilesystemService } from './secure-filesystem-service.js';
import { SkillDiscoveryService } from './skill-discovery-service.js';
import { TaskRunnerService } from './task-runner-service.js';
import { WorkspaceBootstrapService } from './workspace-bootstrap-service.js';
import { SqliteBrainSnapshotRepository } from '../infra/sqlite/sqlite-brain-snapshot-repository.js';
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
  projectDiscovery: ProjectDiscoveryService;
  tasks: TaskRunnerService;
  skills: SkillDiscoveryService;
  workspace: WorkspaceBootstrapService;
  applyVerify: ApplyVerifyService;
  brain: ProjectBrainService;
  contextImpact: ContextImpactService;
}

export function createRuntimeServices(database: Database.Database, databaseFilename: string): RuntimeServices {
  const projects = new SqliteProjectRepository(database);
  const permissionSessions = new SqlitePermissionSessionRepository(database);
  const policies = new SqlitePolicyRepository(database);
  const brainSnapshots = new SqliteBrainSnapshotRepository(database);
  const authorization = new AuthorizationService(projects, permissionSessions, policies);
  const paths = new ProjectPathResolverFactory(projects);
  const backupRoot = databaseFilename === ':memory:' ? undefined : path.join(path.dirname(databaseFilename), 'backups');
  const filesystem = new SecureFilesystemService(authorization, paths, backupRoot);
  const projectDiscovery = new ProjectDiscoveryService(projects);
  const tasks = new TaskRunnerService(authorization, paths);
  const skills = new SkillDiscoveryService(authorization, filesystem);
  const workspace = new WorkspaceBootstrapService(projectDiscovery, tasks, skills);
  const applyVerify = new ApplyVerifyService(filesystem, tasks);
  const brain = new ProjectBrainService(authorization, filesystem, projects, brainSnapshots);
  const contextImpact = new ContextImpactService(brain, filesystem);
  return {
    projects,
    permissionSessions,
    policies,
    authorization,
    paths,
    filesystem,
    projectDiscovery,
    tasks,
    skills,
    workspace,
    applyVerify,
    brain,
    contextImpact,
  };
}
