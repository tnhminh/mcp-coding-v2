import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/app/errors.js';
import { ProjectPathResolverFactory } from '../src/app/project-path-resolver-factory.js';
import { createProject } from '../src/domain/projects/project.js';
import { ProjectPathResolver } from '../src/infra/filesystem/project-path-resolver.js';
import { openSqliteDatabase } from '../src/infra/sqlite/database.js';
import { SqliteProjectRepository } from '../src/infra/sqlite/sqlite-project-repository.js';

async function expectPathError(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'AppError', code });
}

function expectSyncPathError(action: () => unknown, code: AppError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AppError ${code}`);
}

describe('ProjectPathResolver', () => {
  let workspace: string;
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'mcp-coding-v2-path-'));
    rootA = path.join(workspace, 'project-a');
    rootB = path.join(workspace, 'project-b');
    await mkdir(path.join(rootA, 'src', 'nested'), { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, 'src', 'nested', 'inside.txt'), 'inside', 'utf8');
    await writeFile(path.join(rootB, 'secret.txt'), 'outside', 'utf8');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('canonicalizes the project root and resolves normal in-project paths', async () => {
    const resolver = await ProjectPathResolver.create(rootA);
    expect(resolver.canonicalRoot).toBe(await realpath(rootA));

    expect(resolver.resolveLexical('src/nested/../nested/inside.txt')).toMatchObject({
      relativePath: path.join('src', 'nested', 'inside.txt'),
    });

    const existing = await resolver.resolveExisting('src/nested/inside.txt');
    expect(existing.absolutePath).toBe(await realpath(path.join(rootA, 'src', 'nested', 'inside.txt')));
    expect(existing.relativePath).toBe(path.join('src', 'nested', 'inside.txt'));
  });

  it('rejects lexical traversal, absolute cross-project paths and null bytes', async () => {
    const resolver = await ProjectPathResolver.create(rootA);

    expectSyncPathError(
      () => resolver.resolveLexical(path.join('..', 'project-b', 'secret.txt')),
      'PATH_OUTSIDE_PROJECT',
    );
    expectSyncPathError(() => resolver.resolveLexical(path.join(rootB, 'secret.txt')), 'PATH_OUTSIDE_PROJECT');
    expectSyncPathError(() => resolver.resolveLexical(`src${path.sep}bad\0name`), 'PATH_INVALID');

    expect(resolver.resolveLexical('..safe/file.txt').relativePath).toBe(path.join('..safe', 'file.txt'));
  });

  it('distinguishes missing existing paths and safely resolves a new write target', async () => {
    const resolver = await ProjectPathResolver.create(rootA);

    await expectPathError(resolver.resolveExisting('src/missing.txt'), 'PATH_NOT_FOUND');
    const target = await resolver.resolveForWrite('src/new/deep/file.txt');
    expect(target.absolutePath).toBe(path.join(await realpath(rootA), 'src', 'new', 'deep', 'file.txt'));
    expect(target.relativePath).toBe(path.join('src', 'new', 'deep', 'file.txt'));
  });

  it('blocks junction/symlink escape for existing and not-yet-created targets', async () => {
    const resolver = await ProjectPathResolver.create(rootA);
    const escapeLink = path.join(rootA, 'escape');
    await symlink(rootB, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

    await expectPathError(resolver.resolveExisting(path.join('escape', 'secret.txt')), 'PATH_OUTSIDE_PROJECT');
    await expectPathError(resolver.resolveForWrite(path.join('escape', 'new', 'file.txt')), 'PATH_OUTSIDE_PROJECT');
  });

  it('allows a junction/symlink that resolves elsewhere inside the same project', async () => {
    const resolver = await ProjectPathResolver.create(rootA);
    const realDirectory = path.join(rootA, 'src', 'nested');
    const internalLink = path.join(rootA, 'internal-link');
    await symlink(realDirectory, internalLink, process.platform === 'win32' ? 'junction' : 'dir');

    const existing = await resolver.resolveExisting(path.join('internal-link', 'inside.txt'));
    expect(existing.absolutePath).toBe(await realpath(path.join(realDirectory, 'inside.txt')));

    const writeTarget = await resolver.resolveForWrite(path.join('internal-link', 'future.txt'));
    expect(writeTarget.absolutePath).toBe(path.join(await realpath(realDirectory), 'future.txt'));
  });

  it('keeps sibling registered project roots mutually isolated', async () => {
    const resolverA = await ProjectPathResolver.create(rootA, { otherProjectRoots: [rootB] });
    const resolverB = await ProjectPathResolver.create(rootB, { otherProjectRoots: [rootA] });

    expectSyncPathError(() => resolverA.resolveLexical(path.join(rootB, 'secret.txt')), 'PATH_OUTSIDE_PROJECT');
    expectSyncPathError(
      () => resolverB.resolveLexical(path.join(rootA, 'src', 'nested', 'inside.txt')),
      'PATH_OUTSIDE_PROJECT',
    );
  });

  it('blocks a nested child project from the parent project while keeping the child usable', async () => {
    const parentRoot = path.join(workspace, 'parent-project');
    const childRoot = path.join(parentRoot, 'child-project');
    await mkdir(childRoot, { recursive: true });
    await writeFile(path.join(parentRoot, 'parent.txt'), 'parent', 'utf8');
    await writeFile(path.join(childRoot, 'child.txt'), 'child', 'utf8');

    const parentResolver = await ProjectPathResolver.create(parentRoot, { otherProjectRoots: [childRoot] });
    const childResolver = await ProjectPathResolver.create(childRoot, { otherProjectRoots: [parentRoot] });

    expectSyncPathError(() => parentResolver.resolveLexical('child-project/child.txt'), 'PATH_OUTSIDE_PROJECT');
    await expectPathError(parentResolver.resolveExisting('child-project/child.txt'), 'PATH_OUTSIDE_PROJECT');
    expect((await childResolver.resolveExisting('child.txt')).relativePath).toBe('child.txt');
    expectSyncPathError(() => childResolver.resolveLexical('../parent.txt'), 'PATH_OUTSIDE_PROJECT');
  });

  it('rejects duplicate registered projects that resolve to one canonical root', async () => {
    const aliasRoot = path.join(workspace, 'project-a-alias');
    await symlink(rootA, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expectPathError(
      ProjectPathResolver.create(rootA, { otherProjectRoots: [aliasRoot] }),
      'PROJECT_ROOT_CONFLICT',
    );
  });

  it('uses the registry snapshot so callers cannot omit nested project exclusions', async () => {
    const parentRoot = path.join(workspace, 'factory-parent');
    const childRoot = path.join(parentRoot, 'factory-child');
    await mkdir(childRoot, { recursive: true });
    await writeFile(path.join(childRoot, 'private.txt'), 'child-only', 'utf8');

    const handle = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteProjectRepository(handle.database);
      const parent = createProject({ name: 'Parent', alias: 'parent', rootPath: parentRoot });
      const child = createProject({ name: 'Child', alias: 'child', rootPath: childRoot });
      await repository.save(parent);
      await repository.save(child);

      const factory = new ProjectPathResolverFactory(repository);
      const parentResolver = await factory.forProject(parent.id);
      const childResolver = await factory.forProject(child.id);

      await expectPathError(parentResolver.resolveExisting('factory-child/private.txt'), 'PATH_OUTSIDE_PROJECT');
      expect((await childResolver.resolveExisting('private.txt')).relativePath).toBe('private.txt');
      await expectPathError(factory.forProject('missing-project'), 'NOT_FOUND');
    } finally {
      handle.close();
    }
  });

  it('rejects Windows alternate streams, reserved devices and normalization-ambiguous segments', async () => {
    if (process.platform !== 'win32') return;
    const resolver = await ProjectPathResolver.create(rootA);

    expectSyncPathError(() => resolver.resolveLexical('src/inside.txt:stream'), 'PATH_INVALID');
    expectSyncPathError(() => resolver.resolveLexical('src/CON.txt'), 'PATH_INVALID');
    expectSyncPathError(() => resolver.resolveLexical('src/trailing-dot.'), 'PATH_INVALID');
    expectSyncPathError(() => resolver.resolveLexical('src/trailing-space '), 'PATH_INVALID');
  });
});
