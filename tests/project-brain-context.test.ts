import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('Project Brain + context + impact', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let permissionSessionId: string;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-brain-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'src', 'math.ts'), [
      'export function add(a: number, b: number) { return a + b; }',
      'export const PI = 3.14;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(root, 'src', 'service.ts'), [
      "import { add } from './math';",
      'export function compute() { return add(1, 2); }',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(root, 'tests', 'service.test.ts'), [
      "import { compute } from '../src/service';",
      "test('compute', () => { expect(compute()).toBe(3); });",
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }), 'utf8');
    await writeFile(path.join(root, 'README.md'), '# Fixture\n', 'utf8');

    services = createRuntimeServices(db.database, ':memory:');
    const project = createProject({ name: 'Brain Fixture', alias: 'brain-fixture', rootPath: root });
    projectId = project.id;
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId,
      principalId: 'brain-test-agent',
      capabilities: ['filesystem.read', 'filesystem.write'],
      ttlSeconds: 3600,
    });
    permissionSessionId = session.id;
    await services.permissionSessions.save(session);
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  function auth() {
    return { projectId, permissionSessionId };
  }

  test('builds TS/JS graph with files, symbols, resolved imports, tests and configs', async () => {
    const summary = await services.brain.build(auth());
    expect(summary.state).toBe('ready');
    expect(summary.counts.files).toBeGreaterThanOrEqual(6);
    expect(summary.counts.symbols).toBeGreaterThanOrEqual(3);
    expect(summary.counts.tests).toBe(1);
    expect(summary.counts.configs).toBeGreaterThanOrEqual(2);
    expect(summary.analysisCoverage.structural).toContain('typescript');
    expect(summary.analysisCoverage.lexicalOnly).toContain('json');

    const index = await services.brain.index(auth());
    expect(index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'add', kind: 'function', path: 'src/math.ts', exported: true }),
      expect.objectContaining({ name: 'compute', kind: 'function', path: 'src/service.ts', exported: true }),
    ]));
    expect(index.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/service.ts', specifier: './math', resolvedPath: 'src/math.ts' }),
      expect.objectContaining({ fromPath: 'tests/service.test.ts', specifier: '../src/service', resolvedPath: 'src/service.ts' }),
    ]));
    await writeFile(path.join(root, 'src', 'alias-consumer.ts'), "import { add } from '@/math';\nexport const aliased = add(5, 6);\n", 'utf8');
    await services.brain.build(auth());
    const aliasIndex = await services.brain.index(auth());
    expect(aliasIndex.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPath: 'src/alias-consumer.ts', specifier: '@/math', resolvedPath: 'src/math.ts' }),
    ]));
    expect(index.tests).toContain('tests/service.test.ts');
    expect(index.configs).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
    expect((await services.projects.findById(projectId))?.brainStatus).toBe('ready');
  });

  test('incremental refresh reuses unchanged TS/JS parse results and reparses changed files', async () => {
    const first = await services.brain.build(auth());
    expect(first.stats?.parsedTsJsFiles).toBeGreaterThanOrEqual(3);

    const second = await services.brain.build(auth());
    expect(second.stats?.reusedTsJsFiles).toBeGreaterThanOrEqual(3);

    await writeFile(path.join(root, 'src', 'service.ts'), [
      "import { add } from './math';",
      'export function compute() { return add(2, 3); }',
      '',
    ].join('\n'), 'utf8');
    const third = await services.brain.build(auth());
    expect(third.stats?.parsedTsJsFiles).toBeGreaterThanOrEqual(1);
    expect(third.stats?.reusedTsJsFiles).toBeGreaterThanOrEqual(2);
  });

  test('finds symbols/references and builds bounded ranked context', async () => {
    await services.brain.build(auth());
    const symbols = await services.brain.findSymbols({ ...auth(), query: 'add' });
    expect(symbols[0]).toMatchObject({ name: 'add', path: 'src/math.ts' });

    const references = await services.brain.references({ ...auth(), symbol: 'add' });
    expect(references.map((reference) => reference.path)).toContain('src/service.ts');

    const context = await services.contextImpact.contextBundle({ ...auth(), query: 'add', maxFiles: 4, maxChars: 6000 });
    expect(context.totalChars).toBeLessThanOrEqual(6000);
    expect(context.items.map((item) => item.path)).toEqual(expect.arrayContaining(['src/math.ts', 'src/service.ts']));
    expect(context.items.find((item) => item.path === 'src/math.ts')?.reasons.join(' ')).toContain('symbol');

    const stopwordHeavy = await services.contextImpact.contextBundle({
      ...auth(),
      query: 'please fix the bug in user compute permission service',
      maxFiles: 12,
      maxChars: 24_000,
    });
    expect(stopwordHeavy.items.map((item) => item.path)).toContain('src/service.ts');
  });

  test('refreshes stale Brain content before context queries', async () => {
    await services.brain.build(auth());
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await writeFile(path.join(root, 'src', 'service.ts'), [
      "import { add } from './math';",
      'export function renamedCompute() { return add(4, 5); }',
      '',
    ].join('\n'), 'utf8');
    const symbols = await services.brain.findSymbols({ ...auth(), query: 'renamedCompute' });
    expect(symbols[0]).toMatchObject({ name: 'renamedCompute', path: 'src/service.ts' });
  });

  test('impact analysis follows declaration to importer and related test', async () => {
    await services.brain.build(auth());
    const impact = await services.contextImpact.impactAnalysis({ ...auth(), seed: 'add' });
    expect(impact.declarations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'add', path: 'src/math.ts' })]));
    expect(impact.affected.map((item) => item.path)).toEqual(expect.arrayContaining(['src/math.ts', 'src/service.ts']));
    expect(impact.relatedTests.map((item) => item.path)).toContain('tests/service.test.ts');
    expect(impact.relatedConfigs).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
  });

  test('loads persisted Brain snapshot after runtime service recreation without rebuilding', async () => {
    const built = await services.brain.build(auth());
    expect(built.state).toBe('ready');
    const restarted = createRuntimeServices(db.database, ':memory:');
    const status = await restarted.brain.status(auth());
    expect(status.state).toBe('ready');
    expect(status.builtAt).toBe(built.builtAt);
    expect(status.counts).toEqual(built.counts);
    const symbols = await restarted.brain.findSymbols({ ...auth(), query: 'add' });
    expect(symbols[0]).toMatchObject({ name: 'add', path: 'src/math.ts' });
  });

  test('invalid persisted Brain snapshot fails closed to not_indexed', async () => {
    await services.brain.build(auth());
    db.database.prepare('UPDATE project_brain_snapshots SET index_json = ? WHERE project_id = ?').run('{invalid', projectId);
    const restarted = createRuntimeServices(db.database, ':memory:');
    const status = await restarted.brain.status(auth());
    expect(status.state).toBe('not_indexed');
    expect(status.counts.files).toBe(0);
    expect((await restarted.projects.findById(projectId))?.brainStatus).toBe('not_indexed');
    const row = db.database.prepare('SELECT project_id FROM project_brain_snapshots WHERE project_id = ?').get(projectId);
    expect(row).toBeUndefined();
  });
});
