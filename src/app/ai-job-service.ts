import { z } from 'zod';
import type { AiJobRepository } from './ai-job-repository.js';
import { AuthorizationService } from './authorization-service.js';
import { CodingCycleService, type CodingCycleResult } from './coding-cycle-service.js';
import { AppError } from './errors.js';
import type { ApplyVerifyChange } from './apply-verify-service.js';
import { TaskRunnerService, type TaskKind } from './task-runner-service.js';
import { createAiJob, isAiJobTerminal, transitionAiJob, type AiJob, type AiJobStatus } from '../domain/jobs/ai-job.js';

const MAX_PERSISTED_STREAM_CHARS = 12_000;

function clipped(value: string): string {
  return value.length <= MAX_PERSISTED_STREAM_CHARS ? value : `${value.slice(0, MAX_PERSISTED_STREAM_CHARS)}\n...[persisted evidence truncated]`;
}

function publicFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.expose ? error.message : 'Agent job cycle failed.' };
  return { code: 'INTERNAL_ERROR', message: 'Agent job cycle failed.' };
}

function compactCycleEvidence(cycle: CodingCycleResult): Record<string, unknown> {
  return {
    iteration: cycle.iteration,
    state: cycle.state,
    nextAction: cycle.nextAction,
    changedPaths: cycle.changedPaths,
    verification: {
      verified: cycle.verification.verified,
      rolledBack: cycle.verification.rolledBack,
      rollbackErrors: cycle.verification.rollbackErrors,
      verificationError: cycle.verification.verificationError,
      tasks: cycle.verification.verification.map((item) => ({
        task: item.task,
        success: item.success,
        exitCode: item.exitCode,
        signal: item.signal,
        timedOut: item.timedOut,
        cancelled: item.cancelled,
        outputTruncated: item.outputTruncated,
        stdout: clipped(item.stdout),
        stderr: clipped(item.stderr),
      })),
    },
    beforeReview: {
      brainBuiltAt: cycle.beforeReview.brain.builtAt,
      context: cycle.beforeReview.context.items.map((item) => ({ path: item.path, score: item.score, reasons: item.reasons })),
      impacts: cycle.beforeReview.impacts.map((impact) => ({ seed: impact.seed, affected: impact.affected.slice(0, 20), relatedTests: impact.relatedTests.slice(0, 20), relatedConfigs: impact.relatedConfigs })),
      unresolvedSeeds: cycle.beforeReview.unresolvedSeeds,
    },
    afterReview: cycle.afterReview ? {
      brainBuiltAt: cycle.afterReview.brain.builtAt,
      context: cycle.afterReview.context.items.map((item) => ({ path: item.path, score: item.score, reasons: item.reasons })),
      impacts: cycle.afterReview.impacts.map((impact) => ({ seed: impact.seed, affected: impact.affected.slice(0, 20), relatedTests: impact.relatedTests.slice(0, 20), relatedConfigs: impact.relatedConfigs })),
      unresolvedSeeds: cycle.afterReview.unresolvedSeeds,
    } : null,
    agentInstruction: cycle.agentInstruction,
  };
}

function transitionOrConflict(job: AiJob, status: AiJobStatus): AiJob {
  try {
    return transitionAiJob(job, status);
  } catch (error) {
    throw new AppError({ code: 'CONFLICT', message: error instanceof Error ? error.message : 'Invalid AI job transition.', httpStatus: 409, expose: true, cause: error });
  }
}

export class AiJobService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly jobs: AiJobRepository,
    private readonly codingCycle: CodingCycleService,
    private readonly tasks: TaskRunnerService,
  ) {}

  async create(request: { projectId: string; permissionSessionId?: string; objective: string; maxIterations?: number }): Promise<AiJob> {
    await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
    });
    const job = createAiJob({ projectId: request.projectId, objective: request.objective, ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }) });
    await this.jobs.save(job);
    return job;
  }

  async list(request: { projectId: string; permissionSessionId?: string }): Promise<AiJob[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    return this.jobs.listByProject(request.projectId);
  }

  async status(request: { jobId: string; permissionSessionId?: string }): Promise<AiJob> {
    const job = await this.requireJob(request.jobId);
    await this.authorization.authorize({ projectId: job.projectId, ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }), capability: 'filesystem.read' });
    return job;
  }

  async cycle(request: {
    jobId: string;
    permissionSessionId?: string;
    changes: readonly ApplyVerifyChange[];
    tasks: readonly TaskKind[];
    reviewSeeds?: readonly string[];
    rollbackOnFailure?: boolean;
  }): Promise<{ job: AiJob; cycle: CodingCycleResult }> {
    const job = await this.requireJob(request.jobId);
    if (!['queued', 'awaiting_fix', 'awaiting_review'].includes(job.status)) {
      throw new AppError({ code: 'CONFLICT', message: `AI job cannot run a coding cycle from status '${job.status}'.`, httpStatus: 409, expose: true });
    }
    const session = await this.authorization.resolvePermissionSession({
      projectId: job.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
    });
    await this.tasks.assertTaskProfilesAvailable({ projectId: job.projectId, permissionSessionId: session.id, tasks: request.tasks });
    const nextIteration = job.iteration + 1;
    if (nextIteration > job.maxIterations) {
      throw new AppError({ code: 'CONFLICT', message: 'AI job has exhausted its configured iteration budget.', httpStatus: 409, expose: true });
    }

    const running = { ...transitionOrConflict(job, 'running'), iteration: nextIteration };
    if (!await this.jobs.saveIfStatus(running, job.status)) {
      throw new AppError({ code: 'CONFLICT', message: 'AI job state changed concurrently; reload the job before retrying.', httpStatus: 409, expose: true });
    }

    let cycle: CodingCycleResult;
    try {
      cycle = await this.codingCycle.runCycle({
        projectId: job.projectId,
        permissionSessionId: session.id,
        objective: job.objective,
        changes: request.changes,
        tasks: request.tasks,
        ...(request.reviewSeeds === undefined ? {} : { reviewSeeds: request.reviewSeeds }),
        iteration: nextIteration,
        maxIterations: job.maxIterations,
        rollbackOnFailure: request.rollbackOnFailure ?? true,
      });
    } catch (error) {
      const failed = {
        ...transitionOrConflict(running, 'failed'),
        evidence: [...running.evidence, { iteration: nextIteration, state: 'failed', error: publicFailure(error) }].slice(-20),
      };
      await this.jobs.saveIfStatus(failed, 'running');
      throw error;
    }

    const nextStatus: AiJobStatus = cycle.nextAction === 'fix_and_retry'
      ? 'awaiting_fix'
      : cycle.nextAction === 'review'
        ? 'awaiting_review'
        : 'stopped';
    const next = {
      ...transitionOrConflict(running, nextStatus),
      evidence: [...running.evidence, compactCycleEvidence(cycle)].slice(-20),
    };
    if (!await this.jobs.saveIfStatus(next, 'running')) {
      throw new AppError({ code: 'CONFLICT', message: 'AI job state changed while the coding cycle was running; reload persisted state.', httpStatus: 409, expose: true });
    }
    return { job: next, cycle };
  }

  async complete(request: { jobId: string; permissionSessionId?: string; reviewSummary: string }): Promise<AiJob> {
    const job = await this.requireJob(request.jobId);
    await this.authorization.authorize({ projectId: job.projectId, ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }), capability: 'filesystem.read' });
    if (job.status !== 'awaiting_review') {
      throw new AppError({ code: 'CONFLICT', message: 'AI job can only be completed after a verified cycle is awaiting semantic review.', httpStatus: 409, expose: true });
    }
    const reviewSummary = z.string().trim().min(1).max(4000).parse(request.reviewSummary);
    const completed = { ...transitionOrConflict(job, 'completed'), reviewSummary };
    if (!await this.jobs.saveIfStatus(completed, 'awaiting_review')) {
      throw new AppError({ code: 'CONFLICT', message: 'AI job state changed concurrently; reload before completing.', httpStatus: 409, expose: true });
    }
    return completed;
  }

  async cancel(request: { jobId: string; permissionSessionId?: string }): Promise<AiJob> {
    const job = await this.requireJob(request.jobId);
    await this.authorization.authorize({ projectId: job.projectId, ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }), capability: 'filesystem.read' });
    if (job.status === 'cancelled') return job;
    if (isAiJobTerminal(job.status)) {
      throw new AppError({ code: 'CONFLICT', message: `Terminal AI job '${job.status}' cannot be cancelled.`, httpStatus: 409, expose: true });
    }
    const cancelled = transitionOrConflict(job, 'cancelled');
    if (!await this.jobs.saveIfStatus(cancelled, job.status)) {
      throw new AppError({ code: 'CONFLICT', message: 'AI job state changed concurrently; reload before cancelling.', httpStatus: 409, expose: true });
    }
    return cancelled;
  }

  private async requireJob(jobId: string): Promise<AiJob> {
    const parsedId = z.string().uuid().parse(jobId);
    const job = await this.jobs.findById(parsedId);
    if (!job) throw new AppError({ code: 'NOT_FOUND', message: 'AI job was not found.', httpStatus: 404, expose: true });
    return job;
  }
}
