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

  test('auto-discovers safe package script aliases and package manager from lockfile', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
      'test:unit': 'vitest run',
      'lint:check': 'eslint .',
      'type-check': 'tsc --noEmit',
      verify: 'node scripts/verify.mjs',
      compile: 'vite build',
      benchmark: 'node scripts/bench.mjs',
      'test:e2e': 'playwright test',
      'build:prod': 'vite build',
    } }), 'utf8');
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

    const profiles = await runner.listTaskProfiles({ projectId, permissionSessionId: sessionId });
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'test', source: 'package.json', discovery: 'alias', executable: 'pnpm', script: 'test:unit', args: ['run', 'test:unit'] }),
      expect.objectContaining({ id: 'lint', discovery: 'alias', script: 'lint:check' }),
      expect.objectContaining({ id: 'typecheck', discovery: 'alias', script: 'type-check' }),
      expect.objectContaining({ id: 'check', discovery: 'alias', script: 'verify' }),
      expect.objectContaining({ id: 'build', discovery: 'alias', script: 'compile' }),
      expect.objectContaining({ id: 'bench', discovery: 'alias', script: 'benchmark' }),
    ]));
  });

  test('auto-discovers and executes built-in static integrity check without pretending it is a build', async () => {
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><script src="app.js"></script></body></html>', 'utf8');
    await writeFile(path.join(root, 'app.css'), 'body{}\n', 'utf8');
    await writeFile(path.join(root, 'app.js'), 'console.log("ok");\n', 'utf8');

    const profiles = await runner.listTaskProfiles({ projectId, permissionSessionId: sessionId });
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'check', source: 'builtin-static', discovery: 'builtin', executable: 'builtin:static-check' }),
    ]));
    expect(profiles.map((candidate) => candidate.id)).not.toContain('build');

    const passed = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'check' });
    expect(passed).toMatchObject({ success: true, source: 'builtin-static', exitCode: 0 });
    expect(passed.stdout).toContain('checked 2 local asset reference(s)');

    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><script src="missing.js"></script></body></html>', 'utf8');
    const failed = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'check' });
    expect(failed).toMatchObject({ success: false, source: 'builtin-static', exitCode: 1 });
    expect(failed.stderr).toContain('missing.js');
  });

  test('does not add legacy static check when package/ecosystem verifiers already exist', async () => {
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body>legacy</body></html>', 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' } }), 'utf8');
    const profiles = await runner.listTaskProfiles({ projectId, permissionSessionId: sessionId });
    expect(profiles.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(['typecheck', 'build']));
    expect(profiles.map((candidate) => candidate.id)).not.toContain('check');
  });

  test('auto-discovers Maven ecosystem verification profiles from pom.xml', async () => {
    await writeFile(path.join(root, 'pom.xml'), '<project></project>\n', 'utf8');
    const profiles = await runner.listTaskProfiles({ projectId, permissionSessionId: sessionId });
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'test', source: 'maven', discovery: 'ecosystem', args: ['test'] }),
      expect.objectContaining({ id: 'check', source: 'maven', args: ['verify', '-DskipTests=false'] }),
      expect.objectContaining({ id: 'build', source: 'maven', args: ['package', '-DskipTests'] }),
    ]));
  });

  test('runs without shell interpolation, keeps safe toolchain env, drops arbitrary parent env and redacts secret-shaped output', async () => {
    process.env.MCP_RUNNER_SECRET = 'must-not-leak';
    process.env.JAVA_HOME = path.join(root, 'fake-jdk');
    process.env.VITE_PUBLIC_TEST_VALUE = 'public-value';
    await writeFile(path.join(root, 'scripts', 'test.mjs'), [
      "console.log('argv=' + JSON.stringify(process.argv.slice(2)));",
      "console.log('env=' + String(process.env.MCP_RUNNER_SECRET));",
      "console.log('java=' + String(process.env.JAVA_HOME));",
      "console.log('vite=' + String(process.env.VITE_PUBLIC_TEST_VALUE));",
      "console.log('ci=' + String(process.env.CI));",
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
    expect(result.stdout).toContain('java=' + path.join(root, 'fake-jdk'));
    expect(result.stdout).toContain('vite=public-value');
    expect(result.stdout).toContain('ci=undefined');
    expect(result.stdout).toContain('token=[REDACTED]');
    expect(result.stdout).not.toContain('supersecretvalue');
    expect(result.stdout).not.toContain('must-not-leak');
  });

  test('classifies toolchain/configuration failures separately from source failures', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'definitely-missing-tool --noEmit' },
    }), 'utf8');
    const missing = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'typecheck' });
    expect(missing.success).toBe(false);
    expect(missing.failureKind).toBe('dependency_missing');

    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({
      version: 1,
      profiles: { lint: { executable: 'node', args: ['scripts/config-required.mjs'] } },
    }), 'utf8');
    await writeFile(path.join(root, 'scripts', 'config-required.mjs'), "console.error('How would you like to configure ESLint?'); process.exit(1);", 'utf8');
    const config = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'lint' });
    expect(config.success).toBe(false);
    expect(config.failureKind).toBe('configuration_required');
  });

  test('caps captured output without killing an otherwise successful task', async () => {
    await writeFile(path.join(root, 'scripts', 'output.mjs'), "process.stdout.write('x'.repeat(20000));", 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({ version: 1, profiles: { check: { executable: 'node', args: ['scripts/output.mjs'] } } }), 'utf8');
    const result = await runner.runTask({ projectId, permissionSessionId: sessionId, task: 'check' });
    expect(result.success).toBe(true);
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
