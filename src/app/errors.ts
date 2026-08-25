export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'PATH_INVALID'
  | 'PATH_NOT_FOUND'
  | 'PATH_OUTSIDE_PROJECT'
  | 'PROJECT_ROOT_CONFLICT'
  | 'PERMISSION_REQUIRED'
  | 'PERMISSION_EXPIRED'
  | 'AUTHORIZATION_DENIED'
  | 'POLICY_DENIED'
  | 'COMMAND_FAILED'
  | 'OUTPUT_LIMIT_EXCEEDED';

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  expose?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly expose: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? 500;
    this.expose = options.expose ?? false;
  }
}

export interface PublicErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export function toPublicError(error: unknown): { status: number; body: PublicErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.httpStatus,
      body: {
        error: {
          code: error.code,
          message: error.expose ? error.message : 'An internal error occurred.',
        },
      },
    };
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } },
  };
}
