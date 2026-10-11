import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { errnoCode, storageFailure, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';
import type { StoreOptions } from './store-errors.js';

/**
 * Writes `failure.json` into the job's current bundle folder: a read-only copy of why the job stopped (spec 11.3).
 * `failed_stage` is the job's own stage when it stopped; `error_stage` is the stage recorded in its last error (the
 * step that raised it, e.g. 'storage' for a move), null without one.
 * The job JSON stays the source of truth; nothing ever reads this file back. The folder must already exist, so a
 * stray empty folder can never block a later bundle move. `opts` lets BundleMover route the write through its own fs.
 */
export async function writeFailureFile(paths: DataPaths, job: Job, clock: Clock = systemClock, opts: StoreOptions = {}): Promise<void> {
  const dir = join(paths.modeRoot, ...posix.dirname(job.image.relative_path).split('/'));
  try {
    await stat(dir);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new AppFailure(
        appError('IMAGE_NOT_FOUND', 'storage', clock, {
          message: `画像のフォルダが見つからないため、failure.json を書けませんでした: ${dir}`,
          details: { job_id: job.id, path: dir },
        }),
      );
    }
    throw storageFailure(err, 'フォルダの確認', dir, { clock });
  }
  const error = job.last_error;
  await writeJsonAtomic(join(dir, 'failure.json'), {
    job_id: job.id,
    error_code: error?.code ?? null,
    failed_stage: job.stage,
    error_stage: error?.stage ?? null,
    attempt_count: job.attempt_count,
    retry_count: job.retry_count,
    next_retry_at: job.next_retry_at,
    stop_reason: error?.message ?? null,
    result_unknown: job.submission_state === 'unknown' || job.status === 'VERIFY_REQUIRED',
    written_at: clock.now().toISOString(),
  }, opts.fs, opts.retry);
}
