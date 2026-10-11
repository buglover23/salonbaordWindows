import type { AppLogger } from '../logger.js';
import { errorCodeOf } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import type { JobStatus } from '../shared/types.js';
import type { ControlState, ControlStore } from '../storage/control-store.js';
import { LIVE_SINGLE_DONE_JA } from './post-commit.js';

// P3-R4: the one job the owner armed for a route's first live post. POSTED is handled by commitPosted (it also records
// first_posts); every other final state ends the arming here and pauses, in the handler that applied it.

export const LIVE_SINGLE_CHANGED_JA = '内容が変わったため、もう一度 live:single を実行してください。';
const FINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['VERIFY_REQUIRED', 'FAILED', 'BLOCKED', 'RETRY_WAIT']);

/** Why the armed binding no longer holds for `job` (content or image changed since the owner saw it), or null. */
export function bindingChanged(bound: NonNullable<ControlState['live_single']>, job: Pick<Job, 'content_hash' | 'image'>): boolean {
  return bound.content_hash !== job.content_hash || bound.image_sha256 !== job.image.sha256;
}

/**
 * The bound job reached a final state other than POSTED: pause and disarm in one control write. VERIFY_REQUIRED stays
 * armed (paused): its reconcile or the operator's --registered still records the route's first post (P3-R47), and
 * --not-registered (FAILED) disarms. Never throws.
 */
export async function onJobFinal(control: ControlStore, job: Pick<Job, 'id' | 'status'>, logger: AppLogger): Promise<void> {
  if (!FINAL.has(job.status) || control.get().live_single?.job_id !== job.id) return;
  const keep = job.status === 'VERIFY_REQUIRED';
  try {
    await control.update((s) => (s.live_single?.job_id === job.id ? { ...(keep ? {} : { live_single: null }), paused: true, pause_reason: LIVE_SINGLE_DONE_JA } : null));
    logger.info('SYSTEM_PAUSED', LIVE_SINGLE_DONE_JA, { job_id: job.id });
  } catch (err) {
    logger.error('LIVE_SINGLE_NOT_SAVED', `1件だけの本番投稿の終了を記録できませんでした（一時停止していない可能性があります）: ${job.id}`, { job_id: job.id, error_code: errorCodeOf(err) });
  }
}

/** The binding no longer matches: disarm (no pause; nothing was sent) with the owner's message. Never throws. */
export async function disarm(control: ControlStore, jobId: string, logger: AppLogger): Promise<void> {
  try {
    await control.update((s) => (s.live_single?.job_id === jobId ? { live_single: null } : null));
    logger.warn('LIVE_SINGLE_DISARMED', LIVE_SINGLE_CHANGED_JA, { job_id: jobId });
  } catch (err) {
    logger.error('LIVE_SINGLE_NOT_SAVED', `1件だけの本番投稿の取り消しを記録できませんでした: ${jobId}`, { job_id: jobId, error_code: errorCodeOf(err) });
  }
}
