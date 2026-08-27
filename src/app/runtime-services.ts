import path from 'node:path';
import type Database from 'better-sqlite3';
import { AiJobService } from './ai-job-service.js';
import { AuditUsageService } from './audit-usage-service.js';
import { ApplyVerifyService } from './apply-verify-service.js';
import { AuthorizationService } from './authorization-service.js';
import { CodingCycleService } from './coding-cycle-service.js';
import { CommandRecipeService } from './command-recipe-service.js';
import { ContextImpactService } from './context-impact-service.js';
import { GitService } from './git-service.js';
import { ManagedProcessService } from './managed-process-service.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { ProjectDiscoveryService } from './project-discovery-service.js';
import { PreviewService } from './preview-service.js';
import { ProjectReadinessService } from './project-readiness-service.js';
import { ProjectBrainService } from './project-brain-service.js';
import { SecureFilesystemService } from './secure-filesystem-service.js';
import { SkillDiscoveryService } from './skill-discovery-service.js';
import { TaskRunnerService } from './task-runner-service.js';
import { WorkspaceBootstrapService } from './workspace-bootstrap-service.js';
import { SqliteAiJobRepository } from '../infra/sqlite/sqlite-ai-job-repository.js';
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
  commandRecipes: CommandRecipeService;
  git: GitService;
  processes: ManagedProcessService;
  skills: SkillDiscoveryService;
  workspace: WorkspaceBootstrapService;
  applyVerify: ApplyVerifyService;
  brain: ProjectBrainService;
  contextImpact: ContextImpactService;
  codingCycle: CodingCycleService;
  aiJobs: AiJobService;
  previews: PreviewService;
  readiness: ProjectReadinessService;
  auditUsage: AuditUsageService;
}

export function createRuntimeServices(database: Database.Database, databaseFilename: string): RuntimeServices {
  const projects = new SqliteProjectRepository(database);
  const auditUsage = new AuditUsageService(database);
  const permissionSessions = new SqlitePermissionSessionRepository(database);
  const policies = new SqlitePolicyRepository(database);
  const brainSnapshots = new SqliteBrainSnapshotRepository(database);
  const aiJobRepository = new SqliteAiJobRepository(database);
  const authorization = new AuthorizationService(projects, permissionSessions, policies);
  const paths = new ProjectPathResolverFactory(projects);
  const previews = new PreviewService(authorization, paths);
  const backupRoot = databaseFilename === ':memory:' ? undefined : path.join(path.dirname(databaseFilename), 'backups');
  const filesystem = new SecureFilesystemService(authorization, paths, backupRoot);
  const projectDiscovery = new ProjectDiscoveryService(projects);
  const tasks = new TaskRunnerService(authorization, paths);
  const commandRecipes = new CommandRecipeService(authorization, paths);
  const git = new GitService(authorization, paths);
  const processes = new ManagedProcessService(authorization, paths);
  const skills = new SkillDiscoveryService(authorization, filesystem);
  const readiness = new ProjectReadinessService(authorization, paths, tasks, commandRecipes);
  const workspace = new WorkspaceBootstrapService(projectDiscovery, authorization, tasks, commandRecipes, processes, skills, previews, readiness);
  const applyVerify = new ApplyVerifyService(authorization, filesystem, tasks);
  const brain = new ProjectBrainService(authorization, filesystem, projects, brainSnapshots);
  const contextImpact = new ContextImpactService(brain, filesystem);
  const codingCycle = new CodingCycleService(authorization, applyVerify, brain, contextImpact);
  const aiJobs = new AiJobService(authorization, aiJobRepository, codingCycle, tasks);
  return {
    projects,
    permissionSessions,
    policies,
    authorization,
    paths,
    filesystem,
    projectDiscovery,
    tasks,
    commandRecipes,
    git,
    processes,
    skills,
    workspace,
    applyVerify,
    brain,
    contextImpact,
    codingCycle,
    aiJobs,
    previews,
    readiness,
    auditUsage,
  };
}
