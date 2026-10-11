import type { Scheduler } from '../execution/scheduler.js';
import type { ScheduleStore } from '../execution/schedule-store.js';
import { releaseSlot, slotDate } from '../execution/startup-recovery.js';
import type { AppLogger, LogFields } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf } from '../shared/errors.js';
import { comparisonHash } from '../shared/hash.js';
import type { Job } from '../shared/job-schema.js';
import type { RouteKey } from '../shared/protocol/version.js';
import type { ControlStore } from '../storage/control-store.js';
import type { DedupeRecord, DedupeStore } from '../storage/dedupe-store.js';
import { backfillHistory, recordPostedHistory, type HistoryStore } from '../storage/history-store.js';
import type { JobStore } from '../storage/job-store.js';

/** The pause reason after the one armed first live post of a route (plan §11 "live_single done"). */
export const LIVE_SINGLE_DONE_JA = '1件だけの本番投稿が終わったため一時停止しました。SALON BOARD で内容を確認し、問題なければ npm.cmd run resume で通常運転にしてください。';

function textField(draft: unknown, key: string): string | null {
  if (typeof draft !== 'object' || draft === null) return null;
  const value = (draft as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

const hashOfText = (text: string | null): string | null => (text === null ? null : comparisonHash(text));

/** The dedupe.json record of a POSTED job (spec 16.5: hashes only, no text, no image). */
export function dedupeRecordOf(job: Job): DedupeRecord {
  const at = job.verified_at ?? job.posted_at ?? job.updated_at;
  return {
    job_id: job.id,
    salon_id: job.salon_id,
    post_type: job.post_type,
    audience_category: job.audience_category,
    status: 'POSTED',
    posted_at: job.posted_at ?? at,
    verified_at: at,
    image_sha256: job.image.sha256,
    title_hash: hashOfText(textField(job.draft, 'title')),
    body_hash: hashOfText(textField(job.draft, job.post_type === 'style' ? 'stylist_comment' : 'body')),
    remote_post_id: job.remote_post_id,
    cleaned_at: null,
  };
}

export interface PostCommitDeps {
  scheduler: Pick<Scheduler, 'complete'>;
  dedupe: Pick<DedupeStore, 'upsert'>;
  history?: Pick<HistoryStore, 'upsert'>;
  control: ControlStore;
  logger: AppLogger;
}

// After POSTED nothing may undo or fail the post: a failed record is logged and the next one is still attempted (R28).
async function step(logger: AppLogger, event: string, level: 'warn' | 'error', message: string, fields: LogFields, save: () => Promise<unknown>): Promise<void> {
  try {
    await save();
  } catch (err) {
    logger[level](event, message, { ...fields, error_code: errorCodeOf(err) });
  }
}

/**
 * D3 / R28: what follows a POSTED save, in order and each best effort (logged on failure; startup backfills them):
 * the slot `done` → the dedupe record → history.json → the first live post of the route (P3-R47) and, when the job was the
 * armed live_single one, disarming it and pausing in the same control write (P3-R4).
 */
export async function commitPosted(deps: PostCommitDeps, job: Job, slot: { date: string; slotId: string } | null): Promise<void> {
  const { logger } = deps;
  const fields: LogFields = { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, slot_id: slot?.slotId ?? null };
  if (slot !== null) {
    await step(logger, 'SLOT_DONE_NOT_SAVED', 'error', `投稿は済みましたが、枠を完了として記録できませんでした（枠は予約中のまま残り、二度は使われません）: ${slot.slotId}`, fields, () =>
      deps.scheduler.complete(slot.date, slot.slotId, 'done'),
    );
  }
  await step(logger, 'DEDUPE_NOT_SAVED', 'warn', `投稿は済みましたが、重複防止の記録を保存できませんでした（次回の起動で補います）: ${job.id}`, fields, () =>
    deps.dedupe.upsert(dedupeRecordOf(job)),
  );
  if (deps.history !== undefined) await recordPostedHistory(deps.history, job, logger);
  await step(logger, 'LIVE_SINGLE_NOT_SAVED', 'error', `1件だけの本番投稿の記録を保存できませんでした（一時停止はしていない可能性があります）: ${job.id}`, fields, () =>
    deps.control.update((s) => {
      if (s.live_single?.job_id !== job.id) return null;
      const route = `${job.post_type}.${job.audience_category}` as RouteKey;
      const profileHash = job.attempts.at(-1)?.route?.profile_hash ?? null;
      const posted = profileHash === null ? null : { profile_hash: profileHash, job_id: job.id, posted_at: job.posted_at ?? job.updated_at };
      return {
        live_single: null,
        first_posts: posted === null ? s.first_posts : { ...s.first_posts, [route]: posted },
        paused: true,
        pause_reason: LIVE_SINGLE_DONE_JA,
      };
    }),
  );
}

export interface BackfillDeps {
  store: JobStore;
  dedupe: DedupeStore;
  history?: HistoryStore;
  schedules: ScheduleStore;
  clock: Clock;
  logger: AppLogger;
}

/**
 * R28 at startup: whatever a crash between POSTED and its records left out is filled in: the dedupe record, history.json
 * (Plan 2 backfill) and a slot still `reserved` for a POSTED job (→ done). Never throws.
 */
export async function backfillPosted(d: BackfillDeps): Promise<{ dedupe: number; history: number; slots: number }> {
  const counts = { dedupe: 0, history: 0, slots: 0 };
  const slotDeps = { store: d.store, schedules: d.schedules, clock: d.clock, logger: d.logger, graceMinutes: 0 };
  for (const { id } of d.store.summaries((s) => s.status === 'POSTED')) {
    try {
      const job = await d.store.get(id);
      if (job === null || job.status !== 'POSTED') continue;
      if (d.dedupe.get(id) === undefined) {
        await d.dedupe.upsert(dedupeRecordOf(job));
        counts.dedupe++;
      }
      const slotId = job.schedule_slot_id;
      const date = slotId === null ? null : slotDate(slotId);
      if (slotId !== null && date !== null && (await releaseSlot(slotDeps, date, slotId, id, 'posted')) === 'done') counts.slots++;
    } catch (err) {
      d.logger.warn('POSTED_BACKFILL_FAILED', `投稿済みの job の記録を補えませんでした（次回の起動で再度試します）: ${id}`, { job_id: id, error_code: errorCodeOf(err) });
    }
  }
  if (d.history !== undefined) counts.history = await backfillHistory(d.history, d.store, d.dedupe, d.logger);
  return counts;
}
