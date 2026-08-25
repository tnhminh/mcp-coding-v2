import { AppError } from './errors.js';
import { SecureFilesystemService, type TextFileResult, type WriteResult } from './secure-filesystem-service.js';
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

export interface ApplyVerifyResult {
  verified: boolean;
  applied: WriteResult[];
  verification: TaskRunResult[];
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

export class ApplyVerifyService {
  constructor(
    private readonly filesystem: SecureFilesystemService,
    private readonly tasks: TaskRunnerService,
  ) {}

  async applyAndVerify(request: {
    projectId: string;
    permissionSessionId: string;
    changes: readonly ApplyVerifyChange[];
    tasks: readonly TaskKind[];
    rollbackOnFailure?: boolean;
  }): Promise<ApplyVerifyResult> {
    if (request.changes.length < 1 || request.changes.length > 20) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Apply+Verify requires 1 to 20 changes.', httpStatus: 400, expose: true });
    }
    if (request.tasks.length < 1 || request.tasks.length > 6) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Apply+Verify requires 1 to 6 verification tasks.', httpStatus: 400, expose: true });
    }
    if (new Set(request.tasks).size !== request.tasks.length) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Verification tasks must be unique.', httpStatus: 400, expose: true });
    }
    const paths = request.changes.map((change) => change.path);
    if (new Set(paths).size !== paths.length) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Apply+Verify cannot target the same path more than once.', httpStatus: 400, expose: true });
    }

    const base = { projectId: request.projectId, permissionSessionId: request.permissionSessionId };
    const snapshots: Snapshot[] = [];
    for (const change of request.changes) {
      let original: TextFileResult | null;
      try {
        original = await this.filesystem.readTextFile({ ...base, path: change.path });
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') original = null;
        else throw error;
      }
      snapshots.push({ path: change.path, original });

      if (change.op === 'replace') {
        if (!original) throw new AppError({ code: 'PATH_NOT_FOUND', message: 'Replace target does not exist.', httpStatus: 404, expose: true });
        if (original.sha256 !== change.expectedSha256.toLowerCase()) {
          throw new AppError({ code: 'SHA_MISMATCH', message: 'File changed since it was read.', httpStatus: 409, expose: true });
        }
        const expectedCount = Math.min(Math.max(change.expectedCount ?? 1, 1), 100);
        const matches = countMatches(original.content, change.search);
        if (!change.search || matches !== expectedCount) {
          throw new AppError({ code: 'PATCH_FAILED', message: `Patch expected ${expectedCount} match(es) but found ${matches}.`, httpStatus: 409, expose: true });
        }
      } else {
        if (original && (!change.expectedSha256 || original.sha256 !== change.expectedSha256.toLowerCase())) {
          throw new AppError({ code: 'SHA_MISMATCH', message: 'Existing write target requires its current SHA-256.', httpStatus: 409, expose: true });
        }
        if (!original && change.expectedSha256) {
          throw new AppError({ code: 'SHA_MISMATCH', message: 'Expected SHA-256 was supplied but target does not exist.', httpStatus: 409, expose: true });
        }
        await this.filesystem.diffTextFile({ ...base, path: change.path, proposedContent: change.content });
      }
    }

    const applied: WriteResult[] = [];
    try {
      for (const change of request.changes) {
        if (change.op === 'replace') {
          applied.push(await this.filesystem.applyPatch({
            ...base,
            path: change.path,
            search: change.search,
            replacement: change.replacement,
            expectedSha256: change.expectedSha256,
            ...(change.expectedCount === undefined ? {} : { expectedCount: change.expectedCount }),
          }));
        } else {
          applied.push(await this.filesystem.writeTextFile({
            ...base,
            path: change.path,
            content: change.content,
            ...(change.expectedSha256 === undefined ? {} : { expectedSha256: change.expectedSha256 }),
          }));
        }
      }
    } catch (error) {
      await this.rollback(base, snapshots);
      throw error;
    }

    const verification: TaskRunResult[] = [];
    let verificationError: { code: string; message: string } | null = null;
    for (const task of request.tasks) {
      try {
        const result = await this.tasks.runTask({ ...base, task });
        verification.push(result);
        if (!result.success) break;
      } catch (error) {
        verificationError = errorSummary(error);
        break;
      }
    }
    const verified = verificationError === null && verification.length === request.tasks.length && verification.every((result) => result.success);
    if (verified || request.rollbackOnFailure === false) {
      return { verified, applied, verification, verificationError, rolledBack: false, rollbackErrors: [] };
    }

    const rollbackErrors = await this.rollback(base, snapshots);
    return { verified: false, applied, verification, verificationError, rolledBack: rollbackErrors.length === 0, rollbackErrors };
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
