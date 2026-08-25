import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthorizationService } from '../src/app/authorization-service.js';
import { ProjectPathResolverFactory } from '../src/app/project-path-resolver-factory.js';
import { TaskRunnerService } from '../src/app/task-runner-service.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';
import { SqlitePermissionSessionRepository } from '../src/infra/sqlite/sqlite-permission-session-repository.js';
import { SqlitePolicyRepository } from '../src/infra/sqlite/sqlite-policy-repository.js';
import { SqliteProjectRepository } from '../src/infra/sqlite/sqlite-project-repository.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('structured task runner', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let projectId: string;
  let sessionId: string;
  let runner: TaskRunnerService;
  let originalSecret: string | undefined;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-task-runner-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, '.mcp'), { recursive: true });
    await mkdir(path.join(root, 'scripts'), { recursive: true });

    const projects = new SqliteProjectRepository(db.database);
    const sessions = new SqlitePermissionSessionRepository(db.database);
    const policies = new SqlitePolicyRepository(db.database);
    const authorization = new AuthorizationService(projects, sessions, policies);
    const paths = new ProjectPathResolverFactory(projects);
    const project = createProject({ name: 'Runner Project', alias: 'runner-project', rootPath: root });
    await projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'test-agent',
      capabilities: ['filesystem.read', 'command.run'],
      ttlSeconds: 3600,
    });
    await sessions.save(session);
    projectId = project.id;
    sessionId = session.id;
    runner = new TaskRunnerService(authorization, paths, { maxOutputBytes: 4096 });
    originalSecret = process.env.MCP_RUNNER_SECRET;
  });

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.MCP_RUNNER_SECRET;
    else process.env.MCP_RUNNER_SECRET = originalSecret;
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('discovers allow-listed package scripts and lets explicit structured config override a profile', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest', lint: 'eslint .' } }), 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({ version: 1, profiles: { test: { executable: 'node', args: ['scripts/test.mjs'], timeoutSeconds: 15 } } }), 'utf8');
    const profiles = await runner.listTaskProfiles({ projectId, permissionSessionId: sessionId });
    expect(profiles.find((profile) => profile.id === 'test')).toMatchObject({ source: '.mcp/tasks.json', executable: 'node', args: ['scripts/test.mjs'] });
    expect(profiles.find((profile) => profile.id === 'lint')).toMatchObject({ source: 'package.json', executable: 'pnpm', args: ['run', 'lint'] });
    expect(profiles.map((profile) => profile.id)).not.toContain('build');
  });

  test('runs without shell interpolation, drops arbitrary parent env and redacts secret-shaped output', async () => {
    process.env.MCP_RUNNER_SECRET = 'must-not-leak';
    await writeFile(path.join(root, 'scripts', 'test.mjs'), [
      "console.log('argv=' + JSON.stringify(process.argv.slice(2)));",
      "console.log('env=' + String(process.env.MCP_RUNNER_SECRET));",
      "console.log('token=supersecretvalue');",
    ].join('\n'), 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({
      version: 1,
      profiles: { test: { executable: 'node', args: ['scripts/test.mjs', '&&', 'whoami', ';', 'echo injected'] } },
    }), 'utf8');

    const result = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'test' });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('"&&","whoami",";","echo injected"');
    expect(result.stdout).toContain('env=undefined');
    expect(result.stdout).toContain('token=[REDACTED]');
    expect(result.stdout).not.toContain('supersecretvalue');
    expect(result.stdout).not.toContain('must-not-leak');
  });

  test('enforces output cap and terminates the task', async () => {
    await writeFile(path.join(root, 'scripts', 'output.mjs'), "process.stdout.write('x'.repeat(20000)); setInterval(() => {}, 1000);", 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({ version: 1, profiles: { check: { executable: 'node', args: ['scripts/output.mjs'] } } }), 'utf8');
    const result = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'check' });
    expect(result.success).toBe(false);
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4096);
  });

  test('timeout kills the spawned process tree', async () => {
    const marker = path.join(root, 'orphan-marker.txt');
    await writeFile(path.join(root, 'scripts', 'child.mjs'), "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('orphan-marker.txt','orphan'), 1500); setInterval(() => {}, 1000);", 'utf8');
    await writeFile(path.join(root, 'scripts', 'parent.mjs'), "import { spawn } from 'node:child_process'; spawn(process.execPath,['scripts/child.mjs'],{stdio:'ignore'}); setInterval(() => {}, 1000);", 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({ version: 1, profiles: { bench: { executable: 'node', args: ['scripts/parent.mjs'], timeoutSeconds: 1 } } }), 'utf8');

    const result = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'bench' });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    await sleep(2200);
    await expect(access(marker)).rejects.toBeDefined();
  }, 10_000);
});
