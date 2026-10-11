import type { AppLogger } from '../logger.js';
import { commitPosted } from '../posting/post-commit.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, errorCodeOf } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import type { Attempt, Job } from '../shared/job-schema.js';
import { jstDateKey } from '../shared/time.js';
import type { Mode } from '../shared/types.js';
import type { BundleMover } from '../storage/bundles.js';
import type { ControlStore } from '../storage/control-store.js';
import type { DedupeStore } from '../storage/dedupe-store.js';
import type { HistoryStore } from '../storage/history-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { Dispatch, Scheduler } from './scheduler.js';

export interface DryRunPosterDeps {
  mode: Mode;
  store: JobStore;
  bundles: BundleMover;
  dedupe: DedupeStore;
  control: ControlStore;
  scheduler: Scheduler;
  instanceId: string;
  clock: Clock;
  logger: AppLogger;
  /** data/history.json of the dry-run root (Plan 2 decision 12): each POSTED draft is recorded there. */
  history?: Pick<HistoryStore, 'upsert'>;
}

function withAttempt(job: Job, attemptId: string, patch: Partial<Attempt>): Attempt[] {
  return job.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch } : a));
}

/**
 * Stands in for the real poster in dry_run mode (A32): walks a dispatched job through POSTING / VERIFYING to POSTED,
 * records it exactly like a real post, and never touches SALON BOARD or the network.
 */
export class DryRunPoster {
  readonly #d: DryRunPosterDeps;

  constructor(d: DryRunPosterDeps) {
    if (d.mode !== 'dry_run') {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'posting', d.clock, {
          message: 'dry-run用の擬似投稿は、dry_runモードでしか使えません。本番モードでは本物の投稿処理を使ってください。',
          details: { mode: d.mode },
        }),
      );
    }
    this.#d = d;
  }

  /**
   * Posts the job of `dispatch` (READY, slot reserved by the scheduler) and returns the POSTED job. If the very first save
   * fails, the job is still READY and the reservation is given back (Scheduler.release); a later failure leaves the job
   * with its intent recorded, so its slot stays reserved and keeps counting (R31; startup marks the job VERIFY_REQUIRED).
   * The error is rethrown. Once the job is POSTED the post has happened (R28): the slot is completed as done first, then
   * the dedupe record, history and the submit time (the intent time) are saved; a failure of any of these is only logged.
   */
  async post(dispatch: Dispatch): Promise<Job> {
    const { control, clock, logger } = this.#d;
    const { slot } = dispatch;
    if (dispatch.job.status !== 'READY') {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'posting', clock, {
          message: `投稿できる状態（READY）ではないjobは擬似投稿できません: ${dispatch.job.id}（${dispatch.job.status}）`,
          details: { job_id: dispatch.job.id, status: dispatch.job.status },
        }),
      );
    }
    const slotDate = jstDateKey(new Date(slot.scheduled_at));
    const { job, attempt } = await this.#walkToPosted(dispatch, slotDate);

    await commitPosted(this.#d, job, { date: slotDate, slotId: slot.slot_id });
    try {
      await control.recordSubmit(new Date(attempt.submit_intent_at!));
    } catch (err) {
      logger.warn('SUBMIT_TIME_NOT_SAVED', `擬似投稿は済みましたが、送信時刻を記録できませんでした（次の送信までの間隔の判定に使われません）: ${job.id}`, {
        job_id: job.id,
        post_type: job.post_type,
        slot_id: slot.slot_id,
        error_code: errorCodeOf(err),
      });
    }
    logger.info('JOB_POSTED', `dry-runのため、SALON BOARDには送信せず擬似的に投稿済みにしました: ${job.id}`, {
      job_id: job.id,
      stage: 'posted',
      post_type: job.post_type,
      audience_category: job.audience_category,
      attempt_id: attempt.id,
      slot_id: slot.slot_id,
      dry_run: true,
    });
    return job;
  }

  /**
   * READY → POSTING → VERIFYING → POSTED. The job and its new attempt share the submission state: intent_recorded from
   * POSTING on, confirmed once POSTED. If the first save fails the reservation is given back; the error is rethrown.
   */
  async #walkToPosted(dispatch: Dispatch, slotDate: string): Promise<{ job: Job; attempt: Attempt }> {
    const { store, bundles, instanceId, clock } = this.#d;
    let leftReady = false;
    try {
      const startedAt = clock.now().toISOString();
      const attempt: Attempt = {
        id: newId('att'),
        command_id: newId('cmd'),
        assigned_instance_id: instanceId,
        claimed_at: startedAt,
        submit_intent_at: startedAt, // the pseudo intent
        submitted_at: null,
        completed_at: null,
        submission_state: 'intent_recorded',
        error: null,
        evidence_refs: [],
        route: null,
        permission_id: null,
        client_id: null,
        flags: null,
      };
      let job = await store.update(dispatch.job.id, dispatch.job.revision, (j) => ({
        ...j,
        status: 'POSTING',
        stage: 'posting',
        submission_state: 'intent_recorded',
        attempt_count: j.attempt_count + 1,
        attempts: [...j.attempts, attempt],
      }));
      leftReady = true;
      const submittedAt = clock.now().toISOString(); // the pseudo submission
      job = await store.update(job.id, job.revision, (j) => ({
        ...j,
        status: 'VERIFYING',
        stage: 'verifying',
        attempts: withAttempt(j, attempt.id, { submitted_at: submittedAt }),
      }));

      const at = clock.now().toISOString();
      job = await bundles.transition(job.id, job.revision, (j) => ({
        ...j,
        status: 'POSTED',
        stage: 'posted',
        submission_state: 'confirmed',
        posted_at: at,
        verified_at: at,
        posted_at_source: 'dry_run',
        attempts: withAttempt(j, attempt.id, { submission_state: 'confirmed', completed_at: at }),
      }));
      return { job, attempt: job.attempts.find((a) => a.id === attempt.id) ?? attempt };
    } catch (err) {
      if (!leftReady) await this.#releaseSlot(slotDate, dispatch);
      throw err;
    }
  }

  // The job never left READY, so nothing was sent: the reservation is given back as startup recovery would (R21).
  async #releaseSlot(date: string, dispatch: Dispatch): Promise<void> {
    const { slot, job } = dispatch;
    try {
      await this.#d.scheduler.release(date, slot.slot_id, job.id, 'interrupted');
    } catch (err) {
      // The error that stopped the post is the one the caller needs; the next start gives the reservation back (R21).
      this.#d.logger.error('SLOT_RELEASE_NOT_SAVED', `擬似投稿を始められなかった枠を空きに戻せませんでした（次回の起動時に戻します）: ${slot.slot_id}`, {
        job_id: job.id,
        slot_id: slot.slot_id,
        error_code: errorCodeOf(err),
      });
    }
  }
}
