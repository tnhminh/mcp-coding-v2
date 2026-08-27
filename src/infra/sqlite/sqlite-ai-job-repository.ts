import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AiJobRepository } from '../../app/ai-job-repository.js';
import { aiJobStatusSchema, type AiJob } from '../../domain/jobs/ai-job.js';

interface AiJobRow {
  id: string;
  project_id: string;
  objective: string;
  status: string;
  iteration: number;
  max_iterations: number;
  evidence_json: string;
  review_summary: string | null;
  created_at: string;
  updated_at: string;
}

const evidenceSchema = z.array(z.unknown()).max(20);

function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('SQLite AI job operation failed'));
  }
}

function mapRow(row: AiJobRow): AiJob {
  return {
    id: row.id,
    projectId: row.project_id,
    objective: z.string().min(1).max(2000).parse(row.objective),
    status: aiJobStatusSchema.parse(row.status),
    iteration: z.number().int().min(0).max(20).parse(row.iteration),
    maxIterations: z.number().int().min(1).max(20).parse(row.max_iterations),
    evidence: evidenceSchema.parse(JSON.parse(row.evidence_json) as unknown),
    reviewSummary: z.string().max(4000).nullable().parse(row.review_summary),
    createdAt: z.string().datetime().parse(row.created_at),
    updatedAt: z.string().datetime().parse(row.updated_at),
  };
}

export class SqliteAiJobRepository implements AiJobRepository {
  private readonly upsert;
  private readonly updateIfStatus;
  private readonly byId;
  private readonly byProject;

  constructor(database: Database.Database) {
    this.upsert = database.prepare(`
      INSERT INTO ai_jobs (id, project_id, objective, status, iteration, max_iterations, evidence_json, review_summary, created_at, updated_at)
      VALUES (@id, @project_id, @objective, @status, @iteration, @max_iterations, @evidence_json, @review_summary, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        iteration = excluded.iteration,
        max_iterations = excluded.max_iterations,
        evidence_json = excluded.evidence_json,
        review_summary = excluded.review_summary,
        updated_at = excluded.updated_at
    `);
    this.updateIfStatus = database.prepare(`
      UPDATE ai_jobs SET
        objective = @objective,
        status = @status,
        iteration = @iteration,
        max_iterations = @max_iterations,
        evidence_json = @evidence_json,
        review_summary = @review_summary,
        updated_at = @updated_at
      WHERE id = @id AND status = @expected_status
    `);
    this.byId = database.prepare('SELECT * FROM ai_jobs WHERE id = ?');
    this.byProject = database.prepare('SELECT * FROM ai_jobs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100');
  }

  save(job: AiJob): Promise<void> {
    return asPromise(() => {
      const evidenceJson = JSON.stringify(job.evidence);
      if (Buffer.byteLength(evidenceJson, 'utf8') > 512 * 1024) throw new Error('AI job evidence exceeds 512 KiB persistence limit');
      this.upsert.run({
        id: job.id,
        project_id: job.projectId,
        objective: job.objective,
        status: job.status,
        iteration: job.iteration,
        max_iterations: job.maxIterations,
        evidence_json: evidenceJson,
        review_summary: job.reviewSummary,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });
    });
  }

  saveIfStatus(job: AiJob, expectedStatus: AiJob['status']): Promise<boolean> {
    return asPromise(() => {
      const evidenceJson = JSON.stringify(job.evidence);
      if (Buffer.byteLength(evidenceJson, 'utf8') > 512 * 1024) throw new Error('AI job evidence exceeds 512 KiB persistence limit');
      return this.updateIfStatus.run({
        id: job.id,
        objective: job.objective,
        status: job.status,
        iteration: job.iteration,
        max_iterations: job.maxIterations,
        evidence_json: evidenceJson,
        review_summary: job.reviewSummary,
        updated_at: job.updatedAt,
        expected_status: expectedStatus,
      }).changes === 1;
    });
  }

  findById(id: string): Promise<AiJob | null> {
    return asPromise(() => {
      const row = this.byId.get(id) as AiJobRow | undefined;
      return row ? mapRow(row) : null;
    });
  }

  listByProject(projectId: string): Promise<AiJob[]> {
    return asPromise(() => (this.byProject.all(projectId) as AiJobRow[]).map(mapRow));
  }
}
