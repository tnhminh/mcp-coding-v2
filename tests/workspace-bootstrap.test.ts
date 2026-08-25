import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('local workspace and skill discovery', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-workspace-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, '.agents', 'skills', 'testing'), { recursive: true });
    await mkdir(path.join(root, '.claude', 'skills', 'review'), { recursive: true });
    await mkdir(path.join(root, '.github', 'prompts'), { recursive: true });
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), '# Project instructions\nFollow the local verification loop.\n', 'utf8');
    await writeFile(path.join(root, '.agents', 'skills', 'testing', 'SKILL.md'), '# Testing skill\nRun focused tests first.\n', 'utf8');
    await writeFile(path.join(root, '.claude', 'skills', 'review', 'SKILL.md'), '# Review skill\nReview before done.\n', 'utf8');
    await writeFile(path.join(root, '.github', 'prompts', 'plan.prompt.md'), '# Plan prompt\nPlan carefully.\n', 'utf8');
    await writeFile(path.join(root, '.cursor', 'rules', 'ui.mdc'), '# UI rule\nKeep controls accessible.\n', 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }), 'utf8');

    const project = createProject({ name: 'Workspace', alias: 'workspace', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'workspace-agent',
      capabilities: ['filesystem.read', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
    sessionId = session.id;
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('lists registered local project roots without requiring a pre-known project id', async () => {
    const projects = await services.projectDiscovery.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: projectId, alias: 'workspace', rootPath: root, status: 'active' });
  });

  test('discovers and reads recognized project skills/instructions only', async () => {
    const skills = await services.skills.listSkills({ projectId, permissionSessionId: sessionId });
    expect(skills.map((skill) => skill.kind)).toEqual(expect.arrayContaining(['agents', 'skill', 'prompt', 'rule']));
    const testingSkill = skills.find((skill) => skill.path.replace(/\\/gu, '/').endsWith('.agents/skills/testing/SKILL.md'));
    expect(testingSkill).toBeDefined();
    const read = await services.skills.readSkill({ projectId, permissionSessionId: sessionId, path: testingSkill?.path ?? '' });
    expect(read.content).toContain('Run focused tests first');
    await expect(services.skills.readSkill({ projectId, permissionSessionId: sessionId, path: 'package.json' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('workspace bootstrap returns project, complete tool catalog, task profiles and skills', async () => {
    const boot = await services.workspace.bootstrap({ projectId, permissionSessionId: sessionId });
    expect(boot.project).toMatchObject({ id: projectId, rootPath: root });
    const tools = boot.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_projects', 'workspace_bootstrap', 'run_task', 'read_file', 'apply_patch', 'list_skills']));
    const taskProfiles = boot.taskProfiles as Array<{ id: string }>;
    expect(taskProfiles.map((profile) => profile.id)).toEqual(expect.arrayContaining(['test', 'build']));
    expect((boot.skills as unknown[]).length).toBeGreaterThanOrEqual(5);
  });
});
