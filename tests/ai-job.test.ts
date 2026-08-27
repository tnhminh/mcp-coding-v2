import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createRuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';
import { SqliteAiJobRepository } from '../src/infra/sqlite/sqlite-ai-job-repository.js';

describe('persistent AI coding jobs', () => {
  const cleanups: string[] = [];
  let openHandle: SqliteDatabaseHandle | null = null;

  afterEach(async () => {
    openHandle?.close();
    openHandle = null;
    await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function fixture() {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mcp-ai-job-'));
    cleanups.push(workspace);
    const root = path.join(workspace, 'project');
    const databaseFile = path.join(workspace, 'runtime.sqlite');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const answer = 1;\n', 'utf8');
    await writeFile(path.join(root, 'scripts', 'test.mjs'), `
      import { readFileSync } from 'node:fs';
      const source = readFileSync('src/main.ts', 'utf8');
      if (!source.includes('answer = 2')) {
        console.error('expected answer = 2');
        process.exit(1);
      }
      console.log('verified answer = 2');
    `, 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'ai-job-fixture',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node scripts/test.mjs' },
    }), 'utf8');

    openHandle = openSqliteDatabase(databaseFile);
    const services = createRuntimeServices(openHandle.database, databaseFile);
    const project = createProject({ name: 'AI Job Fixture', alias: 'ai-job-fixture', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'agent-job-test',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    return { workspace, root, databaseFile, services, project, session };
  }

  test('persists fail→fix→review→complete evidence and resumes after runtime recreation', async () => {
    const { root, databaseFile, services, project } = await fixture();
    const job = await services.aiJobs.create({
      projectId: project.id,
      objective: 'Change the answer constant to 2 and keep tests green.',
      maxIterations: 3,
    });
    expect(job).toMatchObject({ status: 'queued', iteration: 0, maxIterations: 3 });

    const original = await services.filesystem.readTextFile({ projectId: project.id, path: 'src/main.ts' });
    const failed = await services.aiJobs.cycle({
      jobId: job.id,
      changes: [{
        op: 'replace',
        path: 'src/main.ts',
        search: 'answer = 1',
        replacement: 'answer = 3',
        expectedSha256: original.sha256,
      }],
      tasks: ['test'],
    });
    expect(failed.job).toMatchObject({ status: 'awaiting_fix', iteration: 1 });
    expect(failed.cycle).toMatchObject({ nextAction: 'fix_and_retry' });
    expect(failed.cycle.verification).toMatchObject({ verified: false, verificationStatus: 'baseline_accepted', rolledBack: false });
    expect(await readFile(path.join(root, 'src', 'main.ts'), 'utf8')).toContain('answer = 3');

    const retained = await services.filesystem.readTextFile({ projectId: project.id, path: 'src/main.ts' });
    const verified = await services.aiJobs.cycle({
      jobId: job.id,
      changes: [{
        op: 'replace',
        path: 'src/main.ts',
        search: 'answer = 3',
        replacement: 'answer = 2',
        expectedSha256: retained.sha256,
      }],
      tasks: ['test'],
    });
    expect(verified.job).toMatchObject({ status: 'awaiting_review', iteration: 2 });
    expect(verified.cycle).toMatchObject({ nextAction: 'review' });
    expect(verified.job.evidence).toHaveLength(2);

    const completed = await services.aiJobs.complete({
      jobId: job.id,
      reviewSummary: 'Verification passed and the changed constant matches the objective.',
    });
    expect(completed).toMatchObject({ status: 'completed', iteration: 2 });

    openHandle?.close();
    openHandle = openSqliteDatabase(databaseFile);
    const restarted = createRuntimeServices(openHandle.database, databaseFile);
    const resumed = await restarted.aiJobs.status({ jobId: job.id });
    expect(resumed).toMatchObject({
      status: 'completed',
      iteration: 2,
      reviewSummary: 'Verification passed and the changed constant matches the objective.',
    });
    expect(resumed.evidence).toHaveLength(2);
  }, 30_000);

  test('unavailable verification profile does not fail or advance a persistent job', async () => {
    const { root, services, project } = await fixture();
    const job = await services.aiJobs.create({ projectId: project.id, objective: 'Change the answer safely.' });
    const current = await services.filesystem.readTextFile({ projectId: project.id, path: 'src/main.ts' });

    await expect(services.aiJobs.cycle({
      jobId: job.id,
      changes: [{ op: 'replace', path: 'src/main.ts', search: 'answer = 1', replacement: 'answer = 2', expectedSha256: current.sha256 }],
      tasks: ['build'],
    })).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });

    expect(await services.aiJobs.status({ jobId: job.id })).toMatchObject({ status: 'queued', iteration: 0 });
    expect(await readFile(path.join(root, 'src', 'main.ts'), 'utf8')).toContain('answer = 1');
  });

  test('rejects invalid completion and compare-and-set prevents stale state overwrite', async () => {
    const { services, project } = await fixture();
    const job = await services.aiJobs.create({ projectId: project.id, objective: 'Do a bounded change.' });

    await expect(services.aiJobs.complete({ jobId: job.id, reviewSummary: 'premature' })).rejects.toMatchObject({ code: 'CONFLICT' });

    if (!openHandle) throw new Error('database handle unavailable');
    const repository = new SqliteAiJobRepository(openHandle.database);
    const staleRunning = { ...job, status: 'running' as const, iteration: 1, updatedAt: new Date().toISOString() };
    expect(await repository.saveIfStatus(staleRunning, 'queued')).toBe(true);
    const staleCancelled = { ...job, status: 'cancelled' as const, updatedAt: new Date().toISOString() };
    expect(await repository.saveIfStatus(staleCancelled, 'queued')).toBe(false);
    expect(await repository.findById(job.id)).toMatchObject({ status: 'running', iteration: 1 });
  });

  test('a job never persists permission session identifiers in its serialized row', async () => {
    const { services, project, session } = await fixture();
    const job = await services.aiJobs.create({ projectId: project.id, permissionSessionId: session.id, objective: 'Keep permission ephemeral.' });
    if (!openHandle) throw new Error('database handle unavailable');
    const row = openHandle.database.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(job.id) as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('permission_session_id');
    expect(JSON.stringify(row)).not.toContain(session.id);
  });
});
