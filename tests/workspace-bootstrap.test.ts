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
    await mkdir(path.join(root, '.github', 'instructions'), { recursive: true });
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await mkdir(path.join(root, '.codex', 'skills', 'refactor'), { recursive: true });
    await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), '# Project instructions\nFollow the local verification loop.\n', 'utf8');
    await writeFile(path.join(root, '.agents', 'skills', 'testing', 'SKILL.md'), '# Testing skill\nRun focused tests first.\n', 'utf8');
    await writeFile(path.join(root, '.claude', 'skills', 'review', 'SKILL.md'), '# Review skill\nReview before done.\n', 'utf8');
    await writeFile(path.join(root, '.github', 'prompts', 'plan.prompt.md'), '# Plan prompt\nPlan carefully.\n', 'utf8');
    await writeFile(path.join(root, '.github', 'instructions', 'typescript.instructions.md'), '# TypeScript instructions\nUse strict types.\n', 'utf8');
    await writeFile(path.join(root, '.cursor', 'rules', 'ui.mdc'), '# UI rule\nKeep controls accessible.\n', 'utf8');
    await writeFile(path.join(root, '.codex', 'skills', 'refactor', 'SKILL.md'), '# Refactor skill\nRefactor safely.\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), '# Claude instructions\nRespect project rules.\n', 'utf8');
    await writeFile(path.join(root, '.clinerules'), '# Cline rules\nReview diffs.\n', 'utf8');
    await writeFile(path.join(root, 'src', 'AGENTS.md'), '# Source instructions\nApplies under src.\n', 'utf8');
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
    expect(skills.map((skill) => skill.source)).toEqual(expect.arrayContaining(['agents', 'claude', 'codex', 'github', 'cursor', 'cline']));
    const nestedAgents = skills.find((skill) => skill.path.replace(/\\/gu, '/') === 'src/AGENTS.md');
    expect(nestedAgents).toMatchObject({ kind: 'agents', scopePath: 'src' });
    const testingSkill = skills.find((skill) => skill.path.replace(/\\/gu, '/').endsWith('.agents/skills/testing/SKILL.md'));
    expect(testingSkill).toBeDefined();
    const read = await services.skills.readSkill({ projectId, permissionSessionId: sessionId, path: testingSkill?.path ?? '' });
    expect(read.content).toContain('Run focused tests first');
    const guidance = await services.skills.guidanceBundle({ projectId, permissionSessionId: sessionId });
    expect(guidance.items.map((item) => item.path.replace(/\\/gu, '/'))).toEqual(expect.arrayContaining(['AGENTS.md', 'src/AGENTS.md', 'CLAUDE.md', '.clinerules', '.codex/skills/refactor/SKILL.md']));
    expect(guidance.rules.join(' ')).toContain('Nested AGENTS.md');
    await expect(services.skills.readSkill({ projectId, permissionSessionId: sessionId, path: 'package.json' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('static project auto-discovers built-in integrity check plus preview/browser verification', async () => {
    const staticRoot = path.join(workspace, 'static-project');
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><html><body><h1>Static</h1></body></html>', 'utf8');
    const staticProject = createProject({ name: 'Static Project', alias: 'static-project', rootPath: staticRoot });
    await services.projects.save(staticProject);
    const staticSession = createPermissionSession({
      projectId: staticProject.id,
      principalId: 'static-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(staticSession);

    const boot = await services.workspace.bootstrap({ projectId: staticProject.id, permissionSessionId: staticSession.id });
    expect(boot.taskProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'check', source: 'builtin-static', discovery: 'builtin' }),
    ]));
    expect(boot.previewProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'static', kind: 'static' })]));
    expect(boot.verificationStrategy).toMatchObject({
      version: 2,
      mode: 'tasks_then_preview',
      availableTaskIds: ['check'],
      recommendedTaskIds: ['check'],
      fastTaskIds: ['check'],
      releaseTaskIds: ['check'],
      availablePreviewIds: ['static'],
      canUseTaskVerification: true,
      canUsePreviewBrowserVerification: true,
    });
    const strategy = boot.verificationStrategy as { rules: string[] };
    expect(strategy.rules.join(' ')).toContain('built-in check');
    const workflow = boot.vibecodeWorkflow as { steps: string[] };
    expect(workflow.steps.join(' ')).toContain('coding_cycle');
    expect(workflow.steps.join(' ')).toContain('preview_start');
    expect(workflow.steps.join(' ')).toContain('browser_review');
  });

  test('workspace bootstrap returns project, complete tool catalog, task profiles and skills', async () => {
    const boot = await services.workspace.bootstrap({ projectId, permissionSessionId: sessionId });
    expect(boot.project).toMatchObject({ id: projectId, rootPath: root });
    const tools = boot.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_projects', 'project_access_status', 'workspace_bootstrap', 'run_task', 'list_command_recipes', 'run_command_recipe', 'read_file', 'read_files', 'apply_patch', 'list_skills', 'project_guidance']));
    const taskProfiles = boot.taskProfiles as Array<{ id: string }>;
    expect(taskProfiles.map((profile) => profile.id)).toEqual(expect.arrayContaining(['test', 'build']));
    const commandRecipes = boot.commandRecipes as Array<{ id: string; available: boolean; allowedScripts?: string[] }>;
    expect(commandRecipes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'package.install', available: true })]));
    expect(commandRecipes.find((recipe) => recipe.id === 'package.script')?.allowedScripts).toEqual(['build', 'test']);
    expect((boot.skills as unknown[]).length).toBeGreaterThanOrEqual(10);
    expect(boot.projectScripts).toEqual({ manager: 'npm', available: ['build', 'test'] });
    const capabilityManifest = boot.capabilityManifest as {
      version: number;
      codingEnvelopeUsable: boolean;
      availableCapabilities: string[];
      unavailableCapabilities: string[];
    };
    expect(capabilityManifest.version).toBe(1);
    expect(capabilityManifest.codingEnvelopeUsable).toBe(false);
    expect(capabilityManifest.availableCapabilities).toContain('filesystem.read');
    expect(capabilityManifest.availableCapabilities).toContain('command.run');
    expect(capabilityManifest.unavailableCapabilities).toContain('filesystem.write');
    expect((boot.access as { codingEnvelope: { state: string } }).codingEnvelope.state).toBe('missing');
  });
});
