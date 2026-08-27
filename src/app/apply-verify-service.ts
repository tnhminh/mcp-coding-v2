import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { SecureFilesystemService, type BatchPatchChange, type TextFileResult, type WriteResult } from './secure-filesystem-service.js';
import { TaskRunnerService, type TaskKind, type TaskRunResult } from './task-runner-service.js';

export type ApplyVerifyChange =
  | {
      op: 'replace';
      path: string;
      search: string;
      replacement: string;
      expectedSha256: string;
      expectedCount?: number;
    }
  | {
      op: 'write';
      path: string;
      content: string;
      expectedSha256?: string | null;
    };

interface Snapshot {
  path: string;
  original: TextFileResult | null;
}

export interface VerificationComparison {
  task: TaskKind;
  baselineSuccess: boolean | null;
  afterSuccess: boolean | null;
  acceptedBaselineFailure: boolean;
  regression: boolean;
}

export interface ApplyVerifyResult {
  verified: boolean;
  verificationStatus: 'passed' | 'baseline_accepted' | 'deferred' | 'failed';
  verificationDeferred: boolean;
  applied: WriteResult[];
  baseline: TaskRunResult[];
  verification: TaskRunResult[];
  comparisons: VerificationComparison[];
  acceptedBaselineFailures: TaskKind[];
  verificationError: { code: string; message: string } | null;
  rolledBack: boolean;
  rollbackErrors: Array<{ path: string; message: string }>;
}

function countMatches(content: string, search: string): number {
  if (!search) return 0;
  return content.split(search).length - 1;
}

function errorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.expose ? error.message : 'Verification failed.' };
  return { code: 'INTERNAL_ERROR', message: 'Verification failed.' };
}

function normalizedEvidence(result: TaskRunResult): string {
  return (result.stdout + '\n' + result.stderr)
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function isEquivalentBaselineFailure(before: TaskRunResult | undefined, after: TaskRunResult | undefined): boolean {
  if (!before || !after || before.success || after.success) return false;
  // Only source failures may be accepted as pre-existing regressions. Toolchain,
  // configuration, timeout and cancellation failures are never considered verification.
  if (before.failureKind !== 'source_failure' || after.failureKind !== 'source_failure') return false;
  return before.exitCode === after.exitCode && normalizedEvidence(before) === normalizedEvidence(after);
}

export class ApplyVerifyService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly filesystem: SecureFilesystemService,
    private readonly tasks: TaskRunnerService,
  ) {}

  async applyAndVerify(request: {
    projectId: string;
    permissionSessionId?: string;
    changes: readonly ApplyVerifyChange[];
    tasks: readonly TaskKind[];
    rollbackOnFailure?: boolean;
  }): Promise<ApplyVerifyResult> {
    if (request.changes.length < 1 || request.changes.length > 20) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Apply+Verify requires 1 to 20 changes.', httpStatus: 400, expose: true });
    }
    if (request.tasks.length > 6) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Apply+Verify accepts at most 6 verification tasks.', httpStatus: 400, expose: true });
    }
    if (new Set(request.tasks).size !== request.tasks.length) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Verification tasks must be unique.', httpStatus: 400, expose: true });
    }
    const groupedChanges = this.groupChanges(request.changes);
    for (const [changePath, changes] of groupedChanges) {
      if (changes.length > 1 && changes.some((change) => change.op !== 'replace')) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: `Apply+Verify may target '${changePath}' multiple times only with exact replace patches that share the same original SHA-256.`,
          httpStatus: 400,
          expose: true,
        });
      }
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
    if (request.tasks.length > 0) await this.tasks.assertTaskProfilesAvailable({ ...base, tasks: request.tasks });

    const snapshots = await this.snapshotAndValidate(base, request.changes);
    let applied: WriteResult[];
    try {
      applied = await this.applyChanges(base, request.changes);
    } catch (error) {
      await this.rollback(base, snapshots);
      throw error;
    }

    if (request.tasks.length === 0) {
      return {
        verified: false,
        verificationStatus: 'deferred',
        verificationDeferred: true,
        applied,
        baseline: [],
        verification: [],
        comparisons: [],
        acceptedBaselineFailures: [],
        verificationError: null,
        rolledBack: false,
        rollbackErrors: [],
      };
    }

    const afterRun = await this.runTasks(base, request.tasks);
    const verification = afterRun.results;
    const verificationError = afterRun.error;
    const allPassed = verificationError === null &&
      verification.length === request.tasks.length &&
      verification.every((result) => result.success);

    if (allPassed) {
      return {
        verified: true,
        verificationStatus: 'passed',
        verificationDeferred: false,
        applied,
        baseline: [],
        verification,
        comparisons: request.tasks.map((task) => ({
          task,
          baselineSuccess: null,
          afterSuccess: verification.find((result) => result.task === task)?.success ?? null,
          acceptedBaselineFailure: false,
          regression: false,
        })),
        acceptedBaselineFailures: [],
        verificationError: null,
        rolledBack: false,
        rollbackErrors: [],
      };
    }

    if (request.rollbackOnFailure === false) {
      return {
        verified: false,
        verificationStatus: 'failed',
        verificationDeferred: false,
        applied,
        baseline: [],
        verification,
        comparisons: [],
        acceptedBaselineFailures: [],
        verificationError,
        rolledBack: false,
        rollbackErrors: [],
      };
    }

    // Restore the original tree before establishing the baseline. This avoids paying
    // the cost of running every verifier twice on the common all-green path.
    const rollbackErrors = await this.rollback(base, snapshots);
    if (rollbackErrors.length > 0 || verificationError !== null) {
      return {
        verified: false,
        verificationStatus: 'failed',
        verificationDeferred: false,
        applied,
        baseline: [],
        verification,
        comparisons: [],
        acceptedBaselineFailures: [],
        verificationError,
        rolledBack: rollbackErrors.length === 0,
        rollbackErrors,
      };
    }

    const baselineRun = await this.runTasks(base, request.tasks);
    const baseline = baselineRun.results;
    if (baselineRun.error !== null) {
      return {
        verified: false,
        verificationStatus: 'failed',
        verificationDeferred: false,
        applied,
        baseline,
        verification,
        comparisons: [],
        acceptedBaselineFailures: [],
        verificationError: baselineRun.error,
        rolledBack: true,
        rollbackErrors: [],
      };
    }

    const comparisons: VerificationComparison[] = request.tasks.map((task) => {
      const before = baseline.find((result) => result.task === task);
      const after = verification.find((result) => result.task === task);
      const acceptedBaselineFailure = isEquivalentBaselineFailure(before, after);
      return {
        task,
        baselineSuccess: before?.success ?? null,
        afterSuccess: after?.success ?? null,
        acceptedBaselineFailure,
        regression: after === undefined || (!after.success && !acceptedBaselineFailure),
      };
    });
    const acceptedBaselineFailures = comparisons.filter((item) => item.acceptedBaselineFailure).map((item) => item.task);
    const noNewRegressions = comparisons.length === request.tasks.length && comparisons.every((item) => !item.regression);

    if (!noNewRegressions) {
      return {
        verified: false,
        verificationStatus: 'failed',
        verificationDeferred: false,
        applied,
        baseline,
        verification,
        comparisons,
        acceptedBaselineFailures,
        verificationError: null,
        rolledBack: true,
        rollbackErrors: [],
      };
    }

    // The failure is proven to be pre-existing. Reapply the SHA-guarded change set
    // to the restored tree and keep the explicit baseline evidence in the result.
    applied = await this.applyChanges(base, request.changes);
    return {
      verified: false,
      verificationStatus: 'baseline_accepted',
      verificationDeferred: false,
      applied,
      baseline,
      verification,
      comparisons,
      acceptedBaselineFailures,
      verificationError: null,
      rolledBack: false,
      rollbackErrors: [],
    };
  }

  private async snapshotAndValidate(
    base: { projectId: string; permissionSessionId: string },
    changes: readonly ApplyVerifyChange[],
  ): Promise<Snapshot[]> {
    const snapshots: Snapshot[] = [];
    for (const [changePath, grouped] of this.groupChanges(changes)) {
      let original: TextFileResult | null;
      try {
        original = await this.filesystem.readTextFile({ ...base, path: changePath });
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') original = null;
        else throw error;
      }
      snapshots.push({ path: changePath, original });

      if (grouped.every((change) => change.op === 'replace')) {
        if (!original) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Replace target does not exist.', httpStatus: 404, expose: true });
        let workingContent = original.content;
        for (const change of grouped) {
          if (original.sha256 !== change.expectedSha256.toLowerCase()) {
            throw new AppError({ code: 'SHA_MISMATCH', message: 'All patches for one file must reference its same current SHA-256.', httpStatus: 409, expose: true });
          }
          const expectedCount = Math.min(Math.max(change.expectedCount ?? 1, 1), 100);
          const matches = countMatches(workingContent, change.search);
          if (!change.search || matches !== expectedCount) {
            throw new AppError({ code: 'PATCH_FAILED', message: `Patch expected ${expectedCount} match(es) but found ${matches}.`, httpStatus: 409, expose: true });
          }
          workingContent = workingContent.split(change.search).join(change.replacement);
        }
        continue;
      }

      const change = grouped[0];
      if (!change || change.op !== 'write') {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'Mixed write/replace operations for one path are not supported.', httpStatus: 400, expose: true });
      }
      if (original && (!change.expectedSha256 || original.sha256 !== change.expectedSha256.toLowerCase())) {
        throw new AppError({ code: 'SHA_MISMATCH', message: 'Existing write target requires its current SHA-256.', httpStatus: 409, expose: true });
      }
      if (!original && change.expectedSha256) {
        throw new AppError({ code: 'SHA_MISMATCH', message: 'Expected SHA-256 was supplied but target does not exist.', httpStatus: 409, expose: true });
      }
      await this.filesystem.diffTextFile({ ...base, path: change.path, proposedContent: change.content });
    }
    return snapshots;
  }

  private async applyChanges(
    base: { projectId: string; permissionSessionId: string },
    changes: readonly ApplyVerifyChange[],
  ): Promise<WriteResult[]> {
    const applied: WriteResult[] = [];
    for (const [, grouped] of this.groupChanges(changes)) {
      if (grouped.every((change) => change.op === 'replace')) {
        const batch = await this.filesystem.applyBatchPatch({
          ...base,
          changes: grouped.map((change) => ({
            path: change.path,
            search: change.search,
            replacement: change.replacement,
            expectedSha256: change.expectedSha256,
            ...(change.expectedCount === undefined ? {} : { expectedCount: change.expectedCount }),
          } satisfies BatchPatchChange)),
        });
        applied.push(...batch.applied);
        continue;
      }

      const change = grouped[0];
      if (!change || change.op !== 'write') {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'Mixed write/replace operations for one path are not supported.', httpStatus: 400, expose: true });
      }
      applied.push(await this.filesystem.writeTextFile({
        ...base,
        path: change.path,
        content: change.content,
        ...(change.expectedSha256 === undefined ? {} : { expectedSha256: change.expectedSha256 }),
      }));
    }
    return applied;
  }

  private groupChanges(changes: readonly ApplyVerifyChange[]): Map<string, ApplyVerifyChange[]> {
    const grouped = new Map<string, ApplyVerifyChange[]>();
    for (const change of changes) {
      const existing = grouped.get(change.path) ?? [];
      existing.push(change);
      grouped.set(change.path, existing);
    }
    return grouped;
  }

  private async runTasks(
    base: { projectId: string; permissionSessionId: string },
    tasks: readonly TaskKind[],
  ): Promise<{ results: TaskRunResult[]; error: { code: string; message: string } | null }> {
    const results: TaskRunResult[] = [];
    for (const task of tasks) {
      try {
        results.push(await this.tasks.runTask({ ...base, task }));
      } catch (error) {
        return { results, error: errorSummary(error) };
      }
    }
    return { results, error: null };
  }

  private async rollback(
    base: { projectId: string; permissionSessionId: string },
    snapshots: readonly Snapshot[],
  ): Promise<Array<{ path: string; message: string }>> {
    const errors: Array<{ path: string; message: string }> = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        let current: TextFileResult | null;
        try {
          current = await this.filesystem.readTextFile({ ...base, path: snapshot.path });
        } catch (error) {
          if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') current = null;
          else throw error;
        }
        if (snapshot.original) {
          await this.filesystem.writeTextFile({
            ...base,
            path: snapshot.path,
            content: snapshot.original.content,
            ...(current ? { expectedSha256: current.sha256 } : {}),
          });
        } else if (current) {
          await this.filesystem.deleteFile({ ...base, path: snapshot.path, expectedSha256: current.sha256 });
        }
      } catch (error) {
        errors.push({ path: snapshot.path, message: error instanceof AppError && error.expose ? error.message : 'Rollback failed.' });
      }
    }
    return errors;
  }
}
