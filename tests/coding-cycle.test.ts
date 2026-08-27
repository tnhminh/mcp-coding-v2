import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('autonomous coding-cycle orchestration', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let permissionSessionId: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-coding-cycle-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, '.mcp'), { recursive: true });
    const databasePath = path.join(workspace, 'runtime.sqlite');
    db = openSqliteDatabase(databasePath);
    services = createRuntimeServices(db.database, databasePath);

    await writeFile(path.join(root, 'src', 'value.ts'), "export const value = 'good';\n", 'utf8');
    await writeFile(path.join(root, 'src', 'consumer.ts'), "import { value } from './value';\nexport const label = value;\n", 'utf8');
    await writeFile(path.join(root, 'scripts', 'verify.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync('src/value.ts','utf8');",
      "if (!value.includes(\"'good'\") && !value.includes(\"'better'\")) { console.error('semantic-check-failed'); process.exit(1); }",
      "console.log('verify-pass');",
    ].join('\n'), 'utf8');
    await writeFile(path.join(root, '.mcp', 'tasks.json'), JSON.stringify({
      version: 1,
      profiles: { test: { executable: 'node', args: ['scripts/verify.mjs'] } },
    }), 'utf8');

    const project = createProject({ name: 'Coding Cycle', alias: 'coding-cycle', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'cycle-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
    permissionSessionId = session.id;
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  function auth() {
    return { projectId, permissionSessionId };
  }

  test('verified implementation returns review evidence and keeps the change', async () => {
    const current = await services.filesystem.readTextFile({ ...auth(), path: 'src/value.ts' });
    const result = await services.codingCycle.runCycle({
      ...auth(),
      objective: 'Change the exported value from good to better without breaking consumers.',
      changes: [{ op: 'replace', path: 'src/value.ts', search: "'good'", replacement: "'better'", expectedSha256: current.sha256 }],
      tasks: ['test'],
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.state).toBe('review_required');
    expect(result.nextAction).toBe('review');
    expect(result.verification.verified).toBe(true);
    expect(result.afterReview).not.toBeNull();
    expect(result.afterReview?.impacts[0]?.affected.map((item) => item.path)).toEqual(expect.arrayContaining(['src/value.ts', 'src/consumer.ts']));
    expect(result.agentInstruction).toContain('DONE');
    expect((await services.filesystem.readTextFile({ ...auth(), path: 'src/value.ts' })).content).toContain("'better'");
  });

  test('failed verification rolls back and returns fix_and_retry evidence', async () => {
    const current = await services.filesystem.readTextFile({ ...auth(), path: 'src/value.ts' });
    const result = await services.codingCycle.runCycle({
      ...auth(),
      objective: 'Change the exported value while keeping verification green.',
      changes: [{ op: 'replace', path: 'src/value.ts', search: "'good'", replacement: "'bad'", expectedSha256: current.sha256 }],
      tasks: ['test'],
      iteration: 1,
      maxIterations: 3,
    });

    expect(result.state).toBe('fix_required');
    expect(result.nextAction).toBe('fix_and_retry');
    expect(result.verification.verified).toBe(false);
    expect(result.verification.rolledBack).toBe(true);
    expect(result.verification.verification[0]).toMatchObject({ task: 'test', success: false });
    expect(result.beforeReview.context.items.length).toBeGreaterThan(0);
    expect((await services.filesystem.readTextFile({ ...auth(), path: 'src/value.ts' })).content).toContain("'good'");
  });

  test('stops automatic retry recommendation at the configured iteration bound', async () => {
    const current = await services.filesystem.readTextFile({ ...auth(), path: 'src/value.ts' });
    const result = await services.codingCycle.runCycle({
      ...auth(),
      objective: 'Attempt a bounded change with no infinite retry loop.',
      changes: [{ op: 'replace', path: 'src/value.ts', search: "'good'", replacement: "'bad'", expectedSha256: current.sha256 }],
      tasks: ['test'],
      iteration: 2,
      maxIterations: 2,
    });

    expect(result.state).toBe('stopped');
    expect(result.nextAction).toBe('stop');
    expect(result.verification.rolledBack).toBe(true);
    expect(result.agentInstruction).toContain('Maximum recommended iterations reached');
  });

  test('workspace bootstrap teaches the connected AI the evidence loop', async () => {
    const bootstrap = await services.workspace.bootstrap(auth());
    const workflow = bootstrap.vibecodeWorkflow as { mode: string; recommendedMaxIterations: number; steps: string[] };
    expect(workflow.mode).toBe('agent-driven evidence loop');
    expect(workflow.recommendedMaxIterations).toBe(5);
    expect(workflow.steps.join(' ')).toContain('coding_cycle');
    expect(workflow.steps.join(' ')).toContain('DONE');
  });
});
