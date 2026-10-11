import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { FsLike, RetryOptions } from './atomic-json.js';

// Kept importable from here for existing callers; the one definition lives in shared/zod-helpers.ts.
export { issueSummary } from '../shared/zod-helpers.js';

/** Optional injection points shared by the stores; tests pass a flaky fs and a no-wait sleep. */
export interface StoreOptions {
  fs?: FsLike;
  retry?: RetryOptions;
}

/**
 * STATE_CORRUPT naming the file. `what` is a Japanese noun such as 'jobファイル'. The file itself is never touched.
 * Raised at startup and while running alike, so the wording does not speak of starting.
 */
export function stateCorrupt(clock: Clock, what: string, path: string, reason: string): AppFailure {
  return new AppFailure(
    appError('STATE_CORRUPT', 'storage', clock, {
      message: `${what}が壊れています。復旧するまで処理を進めません（${path}）。原因: ${reason}。ファイルは変更していません。`,
      details: { path, reason },
    }),
  );
}

/** REVISION_CONFLICT: the job changed since the caller read it. The caller re-reads and decides again; nothing is written. */
export function revisionConflict(clock: Clock, jobId: string, expectedRevision: number, actualRevision: number | null): AppFailure {
  return new AppFailure(
    appError('REVISION_CONFLICT', 'storage', clock, {
      details: { job_id: jobId, expected_revision: expectedRevision, actual_revision: actualRevision },
    }),
  );
}

/** INTERNAL_ERROR for a caller bug (duplicate create, invalid value handed to a store). Nothing is written. */
export function internalFailure(clock: Clock, message: string, details: Record<string, unknown> = {}): AppFailure {
  return new AppFailure(appError('INTERNAL_ERROR', 'storage', clock, { message, details }));
}
