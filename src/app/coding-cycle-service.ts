import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ApplyVerifyService, type ApplyVerifyChange, type ApplyVerifyResult } from './apply-verify-service.js';
import { ContextImpactService, type ContextBundle, type ImpactResult } from './context-impact-service.js';
import { ProjectBrainService, type BrainSummary } from './project-brain-service.js';
import type { TaskKind } from './task-runner-service.js';

export type CodingCycleNextAction = 'fix_and_retry' | 'review' | 'stop';

export interface CodingCycleReview {
  brain: BrainSummary;
  context: ContextBundle;
  impacts: ImpactResult[];
  unresolvedSeeds: string[];
}

export interface CodingCycleResult {
  objective: string;
  iteration: number;
  maxIterations: number;
  state: 'fix_required' | 'review_required' | 'verification_deferred' | 'stopped';
  nextAction: CodingCycleNextAction;
  changedPaths: string[];
  verification: ApplyVerifyResult;
  beforeReview: CodingCycleReview;
  afterReview: CodingCycleReview | null;
  agentInstruction: string;
}

function normalized(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function contextBudget(objective: string, seedCount: number): { maxFiles: number; maxChars: number } {
  const terms = objective.trim().split(/\s+/u).filter(Boolean).length;
  const complexity = terms + seedCount * 3;
  if (complexity >= 35) return { maxFiles: 32, maxChars: 96_000 };
  if (complexity >= 18) return { maxFiles: 24, maxChars: 64_000 };
  if (complexity >= 8) return { maxFiles: 16, maxChars: 40_000 };
  return { maxFiles: 12, maxChars: 24_000 };
}

export class CodingCycleService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly applyVerify: ApplyVerifyService,
    private readonly brain: ProjectBrainService,
    private readonly contextImpact: ContextImpactService,
  ) {}

  async runCycle(request: {
    projectId: string;
    permissionSessionId?: string;
    objective: string;
    changes: readonly ApplyVerifyChange[];
    tasks: readonly TaskKind[];
    reviewSeeds?: readonly string[];
    iteration?: number;
    maxIterations?: number;
    rollbackOnFailure?: boolean;
  }): Promise<CodingCycleResult> {
    const objective = request.objective.trim();
    if (!objective) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Coding-cycle objective is required.', httpStatus: 400, expose: true });
    }
    if (objective.length > 2000) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Coding-cycle objective exceeds 2000 characters.', httpStatus: 400, expose: true });
    }
    const iteration = Math.min(Math.max(request.iteration ?? 1, 1), 20);
    const maxIterations = Math.min(Math.max(request.maxIterations ?? 5, 1), 20);
    if (iteration > maxIterations) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Coding-cycle iteration cannot exceed maxIterations.', httpStatus: 400, expose: true });
    }
    if (request.changes.length < 1 || request.changes.length > 20) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Coding cycle requires 1 to 20 changes.', httpStatus: 400, expose: true });
    }

    const requiredCapabilities = request.tasks.length > 0
      ? ['filesystem.read', 'filesystem.write', 'command.run'] as const
      : ['filesystem.read', 'filesystem.write'] as const;
    const resolvedSession = await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: requiredCapabilities,
    });
    const base = { projectId: request.projectId, permissionSessionId: resolvedSession.id };
    const changedPaths = [...new Set(request.changes.map((change) => normalized(change.path)))];
    const reviewSeeds = [...new Set((request.reviewSeeds?.length ? request.reviewSeeds : changedPaths).map((seed) => normalized(seed)))].slice(0, 20);

    await this.brain.build(base);
    const beforeReview = await this.review(base, objective, reviewSeeds);
    const verification = await this.applyVerify.applyAndVerify({
      ...base,
      changes: request.changes,
      tasks: request.tasks,
      rollbackOnFailure: request.rollbackOnFailure ?? true,
    });

    if (verification.verificationDeferred) {
      await this.brain.build(base);
      const afterReview = await this.review(base, objective, reviewSeeds);
      return {
        objective,
        iteration,
        maxIterations,
        state: 'verification_deferred',
        nextAction: 'review',
        changedPaths,
        verification,
        beforeReview,
        afterReview,
        agentInstruction: 'No structured task verifier is available, so the change is intentionally kept with verification deferred. Use the workspace preview/browser strategy or another explicit verifier before declaring DONE; semantic review alone is not sufficient.',
      };
    }

    if (verification.verificationStatus === 'baseline_accepted') {
      await this.brain.build(base);
      const afterReview = await this.review(base, objective, reviewSeeds);
      const reachedLimit = iteration >= maxIterations;
      return {
        objective,
        iteration,
        maxIterations,
        state: reachedLimit ? 'stopped' : 'fix_required',
        nextAction: reachedLimit ? 'stop' : 'fix_and_retry',
        changedPaths,
        verification,
        beforeReview,
        afterReview,
        agentInstruction: reachedLimit
          ? 'The change was kept because verification matched a pre-existing source failure with no new regression, but the verifier is still red and the iteration budget is exhausted. Do not declare DONE.'
          : 'The change was kept because verification matched a pre-existing source failure with no new regression. This is not a verified state: diagnose/fix the baseline failure or use another explicit verifier, then run the next coding cycle. Do not declare DONE while the verifier remains red.',
      };
    }

    if (!verification.verified) {
      const reachedLimit = iteration >= maxIterations;
      return {
        objective,
        iteration,
        maxIterations,
        state: reachedLimit ? 'stopped' : 'fix_required',
        nextAction: reachedLimit ? 'stop' : 'fix_and_retry',
        changedPaths,
        verification,
        beforeReview,
        afterReview: null,
        agentInstruction: reachedLimit
          ? 'Maximum recommended iterations reached. Stop automatic retries and surface verification evidence for human/agent review.'
          : 'Inspect verification stdout/stderr/error plus the pre-change context and impact evidence, produce a corrected change set, then call coding_cycle again with iteration + 1.',
      };
    }

    await this.brain.build(base);
    const afterReview = await this.review(base, objective, reviewSeeds);
    return {
      objective,
      iteration,
      maxIterations,
      state: 'review_required',
      nextAction: 'review',
      changedPaths,
      verification,
      beforeReview,
      afterReview,
      agentInstruction: 'Review the verified changed files against the objective using afterReview context/impact evidence. If the semantic review is clean, declare DONE; if not, prepare a corrective change set and call coding_cycle again with iteration + 1.',
    };
  }

  private async review(
    base: { projectId: string; permissionSessionId: string },
    objective: string,
    seeds: readonly string[],
  ): Promise<CodingCycleReview> {
    const budget = contextBudget(objective, seeds.length);
    const [brain, context] = await Promise.all([
      this.brain.status(base),
      this.contextImpact.contextBundle({ ...base, query: objective, maxFiles: budget.maxFiles, maxChars: budget.maxChars }),
    ]);
    const impacts: ImpactResult[] = [];
    const unresolvedSeeds: string[] = [];
    for (const seed of seeds) {
      try {
        impacts.push(await this.contextImpact.impactAnalysis({ ...base, seed, maxResults: 50 }));
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') {
          unresolvedSeeds.push(seed);
          continue;
        }
        throw error;
      }
    }
    return { brain, context, impacts, unresolvedSeeds };
  }
}
