import { describe, expect, test } from 'vitest';
import { createProject, touchProject } from '../src/domain/projects/project.js';
import { openSqliteDatabase } from '../src/infra/sqlite/database.js';
import { applyMigrations } from '../src/infra/sqlite/migrations.js';
import { SqliteProjectRepository } from '../src/infra/sqlite/sqlite-project-repository.js';

function createRepository() {
  const handle = openSqliteDatabase(':memory:');
  return { handle, repository: new SqliteProjectRepository(handle.database) };
}

describe('project registry persistence', () => {
  test('versioned migration applies exactly once', () => {
    const handle = openSqliteDatabase(':memory:');
    try {
      expect(handle.appliedMigrations).toEqual(['001_projects', '002_authorization', '003_project_brain', '004_ai_jobs', '005_audit_usage']);
      expect(applyMigrations(handle.database)).toEqual([]);
      const rows = handle.database.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toEqual(['001_projects', '002_authorization', '003_project_brain', '004_ai_jobs', '005_audit_usage']);
    } finally {
      handle.close();
    }
  });

  test('round-trips the complete project aggregate', async () => {
    const { handle, repository } = createRepository();
    try {
      const project = createProject(
        {
          name: 'Control Plane',
          alias: 'control-plane',
          rootPath: 'E:\\projects\\control-plane',
          defaultBranch: 'main',
          remoteRepository: 'git@example.test:team/control-plane.git',
          metadata: { owner: 'platform', nested: { tier: 1 } },
        },
        { id: 'project-001', now: new Date('2026-08-25T12:00:00.000Z') },
      );

      await repository.save(project);
      expect(await repository.findById(project.id)).toEqual(project);
      expect(await repository.findByAlias('CONTROL-PLANE')).toEqual(project);
      expect(await repository.list()).toEqual([project]);
    } finally {
      handle.close();
    }
  });

  test('updates mutable aggregate fields without changing creation time', async () => {
    const { handle, repository } = createRepository();
    try {
      const original = createProject(
        { name: 'Project A', alias: 'project-a', rootPath: 'E:\\project-a' },
        { id: 'project-a-id', now: new Date('2026-08-25T12:00:00.000Z') },
      );
      await repository.save(original);

      const updated = touchProject(
        {
          ...original,
          name: 'Project A Renamed',
          status: 'inactive',
          brainStatus: 'ready',
          metadata: { verified: true },
        },
        new Date('2026-08-25T13:00:00.000Z'),
      );
      await repository.save(updated);

      expect(await repository.findById(original.id)).toEqual(updated);
      expect((await repository.findById(original.id))?.createdAt).toBe(original.createdAt);
    } finally {
      handle.close();
    }
  });

  test('enforces case-insensitive alias uniqueness and supports removal', async () => {
    const { handle, repository } = createRepository();
    try {
      await repository.save(
        createProject(
          { name: 'One', alias: 'Project-One', rootPath: 'E:\\one' },
          { id: 'one' },
        ),
      );

      await expect(
        repository.save(
          createProject(
            { name: 'Two', alias: 'project-one', rootPath: 'E:\\two' },
            { id: 'two' },
          ),
        ),
      ).rejects.toThrow();

      expect(await repository.remove('one')).toBe(true);
      expect(await repository.remove('one')).toBe(false);
      expect(await repository.findById('one')).toBeNull();
    } finally {
      handle.close();
    }
  });

  test('rejects non-JSON project metadata at the domain boundary', () => {
    expect(() =>
      createProject({
        name: 'Invalid Metadata',
        alias: 'invalid-metadata',
        rootPath: 'E:\\invalid-metadata',
        metadata: { unsupported: BigInt(1) } as never,
      }),
    ).toThrow();
  });
});
