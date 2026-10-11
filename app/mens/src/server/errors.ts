import { AppFailure, type ErrorCode } from '../shared/errors.js';
import type { ApiErrorCode } from '../shared/protocol/version.js';

/** A refusal with its HTTP status; the message is Japanese and never carries secrets or raw request keys. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CONFLICT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'STALE_COMMAND',
  'REVISION_CONFLICT',
  'POST_RESULT_UNKNOWN',
  'LIMIT_REACHED',
  'AUTOMATION_NOT_PERMITTED',
  'EXTERNAL_REQUIREMENT_UNVERIFIED',
]);
const UNPROCESSABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['VALIDATION_FAILED', 'DUPLICATE_CONTENT']);
const UNAVAILABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['RESOURCE_DISK_LOW', 'RESOURCE_MEMORY_HIGH', 'DISK_FULL']);

export const UNEXPECTED_MESSAGE = '想定外のエラーです。ログを確認してください';

/** §6.2 error mapping; anything unknown is a 500 that says nothing about its cause. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AppFailure) {
    const { code, message, retryable } = err.error;
    if (CONFLICT.has(code)) return new ApiError(409, code, message, retryable);
    if (UNPROCESSABLE.has(code)) return new ApiError(422, code, message, retryable);
    if (UNAVAILABLE.has(code)) return new ApiError(503, code, message, true);
  }
  return new ApiError(500, 'INTERNAL_ERROR', UNEXPECTED_MESSAGE);
}
