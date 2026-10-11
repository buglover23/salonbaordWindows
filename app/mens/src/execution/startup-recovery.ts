import type { ScheduleConfig } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { endPreIntent, markUnknown, slotReleasable } from '../posting/attempts.js';
import type { IntentLedger } from '../posting/intent-ledger.js';
import type { StopRegistry } from '../posting/stops.js';
import { RECONCILE_DELAYS_MS, RECONCILE_MAX_AUTO } from '../posting/timing.js';
import type { Clock } from '../shared/clock.js';
import { appError, errorCodeOf, errorText } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { POST_TYPE_JA } from '../shared/labels.js';
import { jstDateKey } from '../shared/time.js';
import type { JobStatus, Mode } from '../shared/types.js';
import type { BundleMover } from '../storage/bundles.js';
import type { ControlStore } from '../storage/control-store.js';
import type { DedupeStore } from '../storage/dedupe-store.js';
import { writeFailureFile } from '../storage/failure-file.js';
import type { JobStore } from '../storage/job-store.js';
import type { DataPaths } from '../storage/paths.js';
import type { DailyPlan, DailySlot, ScheduleStore } from './schedule-store.js';
import { windowEndFor } from './slots.js';

// Startup steps that run after BundleMover.recoverAll and before JobProcessor.resumeInterrupted (rulings R23, R21, Plan 3).

export interface StartupRecoveryDeps {
  store: JobStore;
  bundles: BundleMover;
  schedules: ScheduleStore;
  paths: DataPaths;
  clock: Clock;
  logger: AppLogger;
  /** schedule.slot_grace_minutes */
  graceMinutes: number;
  /** The run's mode. In dry-run nothing ever reached SALON BOARD, so R23 does not ask to check it there. Default: live wording. */
  mode?: Mode;
  /** The schedule whose windows decide whether a waiting retry still fits its slot (P3-R27); without it such a slot is carried over. */
  schedule?: ScheduleConfig;
}

type SlotDeps = Pick<StartupRecoveryDeps, 'store' | 'schedules' | 'clock' | 'logger' | 'graceMinutes' | 'schedule'>;

const SLOT_DATE = /^(\d{4}-\d{2}-\d{2})-/;
const DRY_RUN_INTERRUPTED = 'dry-run の擬似投稿が途中で止まりました（SALON BOARD には送信していません）';
const SETTLED: ReadonlySet<JobStatus> = new Set(['POSTED', 'POSTING', 'VERIFYING', 'VERIFY_REQUIRED']);

/** The JST date of the plan a slot id belongs to (`<YYYY-MM-DD>-<type>-<nn>`). */
export function slotDate(slotId: string): string | null {
  return SLOT_DATE.exec(slotId)?.[1] ?? null;
}

/** Loads each date's plan once; null for a date without a plan. */
function planCache(d: Pick<StartupRecoveryDeps, 'schedules' | 'clock'>): (date: string) => Promise<DailyPlan | null> {
  const plans = new Map<string, Promise<DailyPlan | null>>();
  return (date) => {
    let p = plans.get(date);
    if (p === undefined) {
      p = d.schedules.load(date, d.clock);
      plans.set(date, p);
    }
    return p;
  };
}

/** R21: a given-back slot of `date` is used again while it is within its grace time on its own day, otherwise skipped. */
export function releasedSlotState(date: string, scheduledAt: string, now: Date, graceMinutes: number): 'open' | 'skipped' {
  return date >= jstDateKey(now) && now.getTime() <= Date.parse(scheduledAt) + graceMinutes * 60_000 ? 'open' : 'skipped';
}

export type SlotOutcome = 'open' | 'skipped' | 'done' | 'failed';

/**
 * Applies P3-R27 (slotReleasable) to a slot reserved for `job`, in memory: released (open within grace, else skipped with
 * `reason`), carried over (skipped, retry_carried_over), done, or failed (not_registered). null = kept as it is.
 * Never touches a slot whose job has a recorded intent or an unknown result.
 */
function settle(d: SlotDeps, date: string, slot: DailySlot, job: Job, reason: string, now: Date): SlotOutcome | null {
  const windowEnd = d.schedule === undefined ? null : windowEndFor(d.schedule, new Date(slot.scheduled_at));
  const verdict = slotReleasable(job, windowEnd, now);
  const at = now.toISOString();
  if (verdict === 'keep') return null;
  if (verdict === 'done' || verdict === 'failed') {
    Object.assign(slot, { state: verdict, reason: verdict === 'failed' ? 'not_registered' : slot.reason, updated_at: at });
    return verdict;
  }
  const state = verdict === 'release' ? releasedSlotState(date, slot.scheduled_at, now, d.graceMinutes) : 'skipped';
  const why = verdict === 'carry_over' ? 'retry_carried_over' : reason;
  Object.assign(slot, { state, job_id: null, audience_category: null, reason: state === 'open' ? null : why, updated_at: at });
  return state;
}

function logSettled(d: SlotDeps, slot: DailySlot, jobId: string, outcome: SlotOutcome, reason: string | null): void {
  const t = POST_TYPE_JA[slot.post_type];
  const fields = { job_id: jobId, post_type: slot.post_type, slot_id: slot.slot_id, scheduled_at: slot.scheduled_at, reason };
  if (outcome === 'open') d.logger.info('SLOT_RELEASED', `送信する前に止まったため、この${t}の枠を空きに戻しました（まだ何も送信していません）。`, fields);
  else if (outcome === 'skipped' && reason === 'retry_carried_over') {
    d.logger.info('SLOT_SKIPPED', `再試行がこの${t}の枠の時間帯に収まらないため、枠を手放し、次の枠で優先して投稿します。`, fields);
  } else if (outcome === 'skipped') d.logger.warn('SLOT_SKIPPED', `送信する前に止まり、猶予時間も過ぎていたため、この${t}の枠は見送りました（まだ何も送信していません）。`, fields);
  else if (outcome === 'done') d.logger.info('SLOT_DONE', `投稿済みの job の${t}の枠を完了にしました。`, fields);
  else d.logger.info('SLOT_FAILED', `未登録と確定した投稿の${t}の枠を「失敗」にしました（本日の投稿数には数えません）。`, fields);
}

async function clearJobSlot(d: SlotDeps, job: Job, slotId: string): Promise<void> {
  if (job.schedule_slot_id === slotId) await d.store.update(job.id, job.revision, (j) => ({ ...j, schedule_slot_id: null, scheduled_at: null }));
}

/**
 * R21 / P3-R27 while running: settles the `reserved` slot `slotId` of `date` when it is still reserved for `jobId` (see
 * slotReleasable). The slot is saved first; a released or failed slot then clears the job's slot fields with a revision
 * check. null = the slot is kept or not reserved for that job, and nothing was changed. Callers serialize this with their
 * other plan writes.
 */
export async function releaseSlot(d: SlotDeps, date: string, slotId: string, jobId: string, reason: string): Promise<SlotOutcome | null> {
  const plan = await d.schedules.load(date, d.clock);
  const slot = plan?.slots.find((s) => s.slot_id === slotId);
  if (!plan || !slot || slot.state !== 'reserved' || slot.job_id !== jobId) return null;
  const job = await d.store.get(jobId);
  if (job === null) return null;
  const outcome = settle(d, date, slot, job, reason, d.clock.now());
  if (outcome === null) return null;
  await d.schedules.save(plan);
  logSettled(d, slot, jobId, outcome, slot.reason ?? reason);
  if (outcome !== 'done') await clearJobSlot(d, job, slotId);
  return outcome;
}

/**
 * R23 (spec 11.4-6, 13.3-6) with Plan 3's split by intent:
 * - a POSTING job whose latest attempt has no intent was never sent: the attempt ends `definitely_not_submitted`
 *   (EXTENSION_DISCONNECTED, interrupted), the job is READY again and its slot is released (P3-R27);
 * - with an intent (or VERIFYING) it may have reached SALON BOARD, so it is never posted again automatically: VERIFY_REQUIRED
 *   with its bundle in images/failed/, an automatic reconcile armed, and its slot stays `reserved` (reason
 *   post_result_unknown), still counting toward the day (R31).
 * A job still in the middle of a file move is left for the next start. Returns the ids changed.
 */
export async function markInterruptedPostsUnknown(d: StartupRecoveryDeps): Promise<string[]> {
  const { store, bundles, clock, logger, paths } = d;
  const dryRun = d.mode === 'dry_run';
  const changed: string[] = [];
  const loadPlan = planCache(d);
  for (const summary of store.summaries((s) => s.status === 'POSTING' || s.status === 'VERIFYING')) {
    if (summary.has_operation) {
      logger.warn('VERIFY_REQUIRED_DEFERRED', `画像の移動が途中のため、投稿途中で止まったjobの確認待ちへの切替を次回の起動に回しました: ${summary.id}`, {
        job_id: summary.id,
        post_type: summary.post_type,
        audience_category: summary.audience_category,
      });
      continue;
    }
    try {
      const job = await store.get(summary.id);
      if (job === null || job.operation !== null || (job.status !== 'POSTING' && job.status !== 'VERIFYING')) continue;
      const latest = job.attempts.at(-1);
      const now = clock.now();
      if (job.status === 'POSTING' && latest !== undefined && latest.submit_intent_at === null && latest.submission_state === 'not_started') {
        await abandonInterrupted(d, job, latest.id, now);
        changed.push(job.id);
        continue;
      }
      const error = appError('POST_RESULT_UNKNOWN', job.stage, clock, {
        submission_state: 'unknown',
        details: { previous_status: job.status, reason: 'interrupted' },
        // Stored in the job and failure.json: in dry-run there is nothing to check on SALON BOARD.
        ...(dryRun ? { message: `${DRY_RUN_INTERRUPTED}。自動では擬似投稿し直しません。` } : {}),
      });
      // A job saved without a matching attempt (written before Plan 3) still becomes VERIFY_REQUIRED, never READY.
      const mutate = (j: Job): Job =>
        latest !== undefined && (latest.submit_intent_at !== null || job.status === 'VERIFYING')
          ? markUnknown(j, latest.id, error, now, 'intent')
          : { ...j, status: 'VERIFY_REQUIRED', stage: 'verify_required', submission_state: 'unknown', last_error: error };
      let updated: Job;
      try {
        updated = await bundles.transition(job.id, job.revision, mutate);
      } catch (err) {
        // The bundle folder is gone: there is nothing to move, but the result is still unknown (cf. R17).
        if (errorCodeOf(err) !== 'IMAGE_NOT_FOUND') throw err;
        updated = await store.update(job.id, job.revision, mutate);
      }
      changed.push(updated.id);
      // From here on the job is saved as VERIFY_REQUIRED: nothing below may report it as left for the next start.
      logger.error(
        'VERIFY_REQUIRED',
        dryRun
          ? `${DRY_RUN_INTERRUPTED}。このjobは結果不明（確認待ち）として残し、自動では擬似投稿し直しません: ${updated.id}`
          : `投稿の途中で停止したため、登録できたか確認できません。自動では投稿し直しません。SALON BOARD の画面で登録の有無を確認してください: ${updated.id}`,
        {
          job_id: updated.id,
          stage: updated.stage,
          post_type: updated.post_type,
          audience_category: updated.audience_category,
          error_code: 'POST_RESULT_UNKNOWN',
          previous_status: job.status,
          slot_id: updated.schedule_slot_id,
        },
      );
      try {
        await markSlotUnknown(d, loadPlan, updated);
      } catch (err) {
        logger.error(
          'VERIFY_REQUIRED_SLOT_NOT_SAVED',
          `結果不明にしたjobの枠に結果不明の印を付けられませんでした。枠は予約中のまま残し、本日の投稿数に数え続けます（jobは確認待ちとして保存済みです）: ${updated.schedule_slot_id}（${errorText(err)}）`,
          { job_id: updated.id, slot_id: updated.schedule_slot_id, error_code: errorCodeOf(err) },
        );
      }
      try {
        await writeFailureFile(paths, updated, clock);
      } catch (err) {
        logger.error('FAILURE_FILE_FAILED', `failure.json を書けませんでした（jobは確認待ちとして保存済みです）: ${errorText(err)}`, {
          job_id: updated.id,
          error_code: errorCodeOf(err),
        });
      }
    } catch (err) {
      // The job was not saved: it is still POSTING/VERIFYING, never dispatched, and the next start tries again.
      logger.error('VERIFY_REQUIRED_NOT_SAVED', `投稿途中で止まったjobを確認待ちにできませんでした（次回の起動で再度試します）: ${summary.id}（${errorText(err)}）`, {
        job_id: summary.id,
        error_code: errorCodeOf(err),
      });
    }
  }
  return changed;
}

/** A pre-intent attempt cut short by the stop: nothing was sent, so the job is READY again and its slot is released. */
async function abandonInterrupted(d: StartupRecoveryDeps, job: Job, attemptId: string, now: Date): Promise<void> {
  const error = appError('EXTENSION_DISCONNECTED', job.stage, d.clock, {
    message: '送信の許可の前に停止したため、この試行は送信していません。もう一度投稿の対象にします。',
    submission_state: 'definitely_not_submitted',
    details: { reason: 'interrupted' },
  });
  const updated = await d.store.update(job.id, job.revision, (j) => endPreIntent(j, attemptId, error, { status: 'READY', releaseSlot: true }, now));
  d.logger.info('ATTEMPT_ABANDONED', `送信の許可の前に停止した投稿を、送信していないものとして投稿待ちに戻しました: ${job.id}`, {
    job_id: job.id,
    attempt_id: attemptId,
    post_type: job.post_type,
    audience_category: job.audience_category,
    stage: job.stage,
    retry_count: job.retry_count,
    reason: 'interrupted',
  });
  const slotId = updated.schedule_slot_id;
  const date = slotId === null ? null : slotDate(slotId);
  if (slotId === null || date === null) return;
  try {
    await releaseSlot(d, date, slotId, job.id, 'interrupted');
  } catch (err) {
    // The job is READY and never dispatched twice: the next R21 pass gives the slot back.
    d.logger.warn('SLOT_RELEASE_NOT_SAVED', `送信前に止まった投稿の枠を空きに戻せませんでした（次回の起動時に戻します）: ${slotId}`, { job_id: job.id, slot_id: slotId, error_code: errorCodeOf(err) });
  }
}

/** The slot of an unknown result stays reserved (R31) with reason post_result_unknown. On a failed save the cached plan is put back. */
async function markSlotUnknown(d: StartupRecoveryDeps, loadPlan: (date: string) => Promise<DailyPlan | null>, job: Job): Promise<void> {
  const slotId = job.schedule_slot_id;
  const date = slotId === null ? null : slotDate(slotId);
  if (slotId === null || date === null) return;
  const plan = await loadPlan(date);
  const slot = plan?.slots.find((s) => s.slot_id === slotId);
  if (plan === null || slot === undefined || slot.state !== 'reserved' || slot.job_id !== job.id || slot.reason === 'post_result_unknown') return;
  const before = { reason: slot.reason, updated_at: slot.updated_at };
  Object.assign(slot, { reason: 'post_result_unknown', updated_at: d.clock.now().toISOString() });
  try {
    await d.schedules.save(plan);
  } catch (err) {
    Object.assign(slot, before);
    throw err;
  }
}

export interface ReleaseReport {
  /** Slot ids put back to `open`. */
  reopened: string[];
  /** Slot ids closed as `skipped` (interrupted, or retry_carried_over). */
  skipped: string[];
}

/**
 * R21 with P3-R27: a process stopped between reserving a slot and settling it leaves the slot `reserved`. Every reserved slot
 * of today and of the dates the jobs point at is settled by slotReleasable: a job that never sent anything gives it back
 * (`open` within grace on its own day, else `skipped` interrupted), a waiting retry keeps it only while it still fits the
 * slot's window (else it is carried over, P3-R11), a POSTED job's slot is `done`. A slot whose job has a recorded intent or an unknown result is never touched.
 * Jobs still pointing at a slot that is no longer reserved for them get their slot fields cleared.
 */
export async function releaseInterruptedReservations(d: StartupRecoveryDeps): Promise<ReleaseReport> {
  const { store, schedules, clock } = d;
  const report: ReleaseReport = { reopened: [], skipped: [] };
  const now = clock.now();
  const loadPlan = planCache(d);

  const dates = new Set<string>([jstDateKey(now)]);
  for (const s of store.summaries((x) => x.schedule_slot_id !== null)) {
    const date = slotDate(s.schedule_slot_id!);
    if (date !== null) dates.add(date);
  }

  for (const date of [...dates].sort()) {
    const plan = await loadPlan(date);
    if (plan === null) continue;
    const settled: [DailySlot, string, SlotOutcome][] = [];
    for (const slot of plan.slots) {
      if (slot.state !== 'reserved' || slot.job_id === null) continue;
      const job = await store.get(slot.job_id);
      if (job === null) continue;
      const outcome = settle(d, date, slot, job, 'interrupted', now);
      if (outcome === null) continue;
      settled.push([slot, job.id, outcome]);
      if (outcome === 'open') report.reopened.push(slot.slot_id);
      if (outcome === 'skipped') report.skipped.push(slot.slot_id);
    }
    if (settled.length === 0) continue;
    await schedules.save(plan);
    for (const [slot, jobId, outcome] of settled) logSettled(d, slot, jobId, outcome, slot.reason ?? 'interrupted');
  }

  // Jobs that still point at a slot which is no longer reserved for them (including the ones released above).
  for (const s of store.summaries((x) => x.schedule_slot_id !== null && !SETTLED.has(x.status))) {
    const slotId = s.schedule_slot_id!;
    const date = slotDate(slotId);
    const plan = date === null ? null : await loadPlan(date);
    const slot = plan?.slots.find((x) => x.slot_id === slotId);
    if (slot !== undefined && slot.state === 'reserved' && slot.job_id === s.id) continue;
    const job = await store.get(s.id);
    if (job === null || SETTLED.has(job.status)) continue;
    await clearJobSlot(d, job, slotId);
  }
  return report;
}

/**
 * After a restart no reconcile command is in flight: VERIFY_REQUIRED jobs get their automatic reconcile due again
 * (now + 2 min) while fewer than three automatic tries were made. Returns how many jobs were changed.
 */
export async function rearmReconcile(d: Pick<StartupRecoveryDeps, 'store' | 'clock' | 'logger'>): Promise<number> {
  const now = d.clock.now();
  const next = new Date(now.getTime() + RECONCILE_DELAYS_MS[0]).toISOString();
  let n = 0;
  for (const s of d.store.summaries((x) => x.status === 'VERIFY_REQUIRED')) {
    try {
      const job = await d.store.get(s.id);
      const attemptId = job?.attempts.at(-1)?.id;
      if (job === null || job.status !== 'VERIFY_REQUIRED' || attemptId === undefined) continue;
      const r = job.reconcile ?? { attempt_id: attemptId, auto_count: 0, next_auto_at: null, last_at: null, last_outcome: null, operator_needed: false, in_flight_command_id: null };
      const due = r.next_auto_at === null && r.auto_count < RECONCILE_MAX_AUTO ? next : r.next_auto_at;
      if (job.reconcile !== null && r.in_flight_command_id === null && due === r.next_auto_at) continue;
      await d.store.update(job.id, job.revision, (j) => ({ ...j, reconcile: { ...r, next_auto_at: due, in_flight_command_id: null } }));
      n++;
    } catch (err) {
      d.logger.warn('RECONCILE_NOT_REARMED', `確認待ちのjobの自動照合を予約できませんでした（次回の起動で再度試します）: ${s.id}（${errorText(err)}）`, {
        job_id: s.id,
        error_code: errorCodeOf(err),
      });
    }
  }
  return n;
}

export interface UnrecordedSendDeps {
  mode: Mode;
  ledger: IntentLedger;
  store: JobStore;
  dedupe: Pick<DedupeStore, 'get'>;
  control: ControlStore;
  stops: StopRegistry;
  clock: Clock;
  logger: AppLogger;
}

const LEDGER_DAYS = 400;
const SUBMIT_TOLERANCE_MS = 1000;

/**
 * P3-R38 (live only; spec 11.4-7): the saved data may be older than what was sent, e.g. data/ restored from a backup while
 * the ledger (outside data/) kept the newer intents. Raises the salon stop POST_RESULT_UNKNOWN (unrecorded_send_suspected)
 * when an intent line is explained by nothing (no void line, no attempt with that id and an intent, no dedupe record of the
 * job), or when control.last_submit_at is more than 1 s after every recorded intent. true = the stop was raised.
 */
export async function suspectUnrecordedSend(d: UnrecordedSendDeps): Promise<boolean> {
  if (d.mode !== 'live') return false;
  const now = d.clock.now();
  const lines = await d.ledger.readSince(new Date(now.getTime() - LEDGER_DAYS * 24 * 60 * 60 * 1000));
  const voided = new Set(lines.filter((l) => l.kind === 'void').map((l) => l.attempt_id));

  const attemptIntents = new Map<string, number>();
  for (const s of d.store.summaries()) {
    const job = await d.store.get(s.id);
    for (const a of job?.attempts ?? []) {
      if (a.submit_intent_at !== null) attemptIntents.set(a.id, Date.parse(a.submit_intent_at));
    }
  }
  const recorded: number[] = [...attemptIntents.values()];
  const unexplained = lines.filter((l) => {
    if (l.kind !== 'intent') return false;
    const ok = voided.has(l.attempt_id) || attemptIntents.has(l.attempt_id) || d.dedupe.get(l.job_id) !== undefined;
    if (ok) recorded.push(Date.parse(l.at));
    return !ok;
  });

  const last = d.control.get().last_submit_at;
  const newerSubmit = last !== null && Date.parse(last) > Math.max(-Infinity, ...recorded) + SUBMIT_TOLERANCE_MS;
  if (unexplained.length === 0 && !newerSubmit) return false;
  d.logger.error('UNRECORDED_SEND_SUSPECTED', '保存データに無い送信の記録があります。SALON BOARD の画面で照合するまで新規の送信を止めます。', {
    unexplained_intents: unexplained.map((l) => ({ job_id: l.job_id, attempt_id: l.attempt_id, at: l.at })),
    last_submit_at: last,
    newer_submit: newerSubmit,
  });
  await d.stops.raise('POST_RESULT_UNKNOWN', {}, { detail: 'unrecorded_send_suspected', jobId: unexplained[0]?.job_id ?? null });
  return true;
}
