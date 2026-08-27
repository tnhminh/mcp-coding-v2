import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRuntimeServices, type RuntimeServices } from '../src/app/runtime-services.js';
import { createPermissionSession } from '../src/domain/authorization/permission-session.js';
import { createProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase, type SqliteDatabaseHandle } from '../src/infra/sqlite/database.js';

describe('structured command recipes', () => {
  let db: SqliteDatabaseHandle;
  let workspace: string;
  let root: string;
  let services: RuntimeServices;
  let projectId: string;
  let fullSessionId: string;

  beforeEach(async () => {
    db = openSqliteDatabase(':memory:');
    services = createRuntimeServices(db.database, ':memory:');
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-command-recipe-'));
    root = path.join(workspace, 'project');
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'recipe-fixture',
      version: '1.0.0',
      scripts: {
        generate: 'node scripts/generate.mjs',
        test: 'node --test',
        dangerous: 'node scripts/generate.mjs',
      },
    }), 'utf8');
    await writeFile(path.join(root, 'scripts', 'generate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('generated.txt','generated'); console.log('token=supersecretvalue');", 'utf8');

    const project = createProject({ name: 'Recipe Fixture', alias: 'recipe-fixture', rootPath: root });
    await services.projects.save(project);
    const session = createPermissionSession({
      projectId: project.id,
      principalId: 'recipe-agent',
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(session);
    projectId = project.id;
    fullSessionId = session.id;
  });

  afterEach(async () => {
    db.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('discovers project-aware dependency recipes and every declared safe-name package script', async () => {
    const recipes = await services.commandRecipes.listRecipes({ projectId });
    expect(recipes.find((recipe) => recipe.id === 'package.install')).toMatchObject({ available: true, manager: 'npm' });
    expect(recipes.find((recipe) => recipe.id === 'package.script')).toMatchObject({ available: true, allowedScripts: ['dangerous', 'generate', 'test'] });
    expect(recipes.find((recipe) => recipe.id === 'go.generate')).toMatchObject({ available: false });
  });

  test('runs an allow-listed project maintenance script through the bounded runner and redacts output', async () => {
    const result = await services.commandRecipes.runRecipe({ projectId, recipe: 'package.script', script: 'generate', timeoutSeconds: 30 });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('token=[REDACTED]');
    expect(result.stdout).not.toContain('supersecretvalue');
    await expect(access(path.join(root, 'generated.txt'))).resolves.toBeUndefined();

    await expect(services.commandRecipes.runRecipe({ projectId, recipe: 'package.script', script: 'dangerous' })).resolves.toMatchObject({ success: true });
    await expect(services.commandRecipes.runRecipe({ projectId, recipe: 'package.script', script: 'missing' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.commandRecipes.runRecipe({ projectId, recipe: 'package.script', script: 'bad&name' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.commandRecipes.runRecipe({ projectId, recipe: 'package.add', packages: ['left-pad&whoami'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.commandRecipes.runRecipe({ projectId, recipe: 'package.remove', packages: ['left-pad@1.3.0'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, 20_000);

  test('mutation recipes require one session granting read, write and command capabilities', async () => {
    const limited = createPermissionSession({
      projectId,
      principalId: 'limited-agent',
      capabilities: ['filesystem.read', 'command.run'],
      ttlSeconds: 3600,
    });
    await services.permissionSessions.save(limited);

    await expect(services.commandRecipes.runRecipe({
      projectId,
      permissionSessionId: limited.id,
      recipe: 'package.script',
      script: 'generate',
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    await expect(services.commandRecipes.runRecipe({
      projectId,
      permissionSessionId: fullSessionId,
      recipe: 'package.script',
      script: 'generate',
    })).resolves.toMatchObject({ success: true });
  }, 20_000);
});
