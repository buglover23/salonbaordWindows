import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { POST_TYPE_JA } from '../shared/labels.js';
import { formatJst } from '../shared/time.js';
import type { ControlStore } from '../storage/control-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { DailySlot } from './schedule-store.js';
import { MIN_SLOT_GAP_MINUTES } from './slots.js';

export interface SubmitGapDeps {
  control: Pick<ControlStore, 'get'>;
  /** The latest recorded intent counts too (P3-R10), should last_submit_at be older. */
  jobs: Pick<JobStore, 'summaries'>;
  getSettings: () => Settings;
  logger: AppLogger;
}

const MINUTE_MS = 60_000;
const FUTURE_SUBMIT_TOLERANCE_MS = 60 * MINUTE_MS;

/**
 * The submission gap (R22, P3-R10) of the scheduler and the live poster: submissions (max of last_submit_at and the latest
 * recorded intent) are at least max(min_submit_interval, MIN_SLOT_GAP) apart. The notices
 * that go with it are logged once each (R27); what was already logged is kept in memory only.
 */
export class SubmitGap {
  readonly #d: SubmitGapDeps;
  #warnedFutureSubmit: string | null = null;
  #waitingSlotId: string | null = null;

  constructor(d: SubmitGapDeps) {
    this.#d = d;
  }

  /**
   * When the next submission is allowed, or null if it is allowed now. A last submission up to an hour in the future (clock
   * moved back) still counts as too recent; further ahead it is a clock or `dry-run --at` artifact, warned about once and ignored.
   */
  waitUntil(now: Date): Date | null {
    const intents = this.#d.jobs.summaries((s) => s.last_intent_at !== null).map((s) => Date.parse(s.last_intent_at!));
    const recorded = this.#d.control.get().last_submit_at;
    const lastMs = Math.max(recorded === null ? -Infinity : Date.parse(recorded), ...intents);
    if (lastMs === -Infinity) return null;
    const last = new Date(lastMs).toISOString();
    if (lastMs - now.getTime() > FUTURE_SUBMIT_TOLERANCE_MS) {
      if (this.#warnedFutureSubmit !== last) {
        this.#warnedFutureSubmit = last;
        this.#d.logger.warn(
          'SUBMIT_TIME_IN_FUTURE',
          `前回の送信時刻（${formatJst(new Date(lastMs))} 日本時間）が現在より60分を超えて先になっています。` +
            'PCの時計の変更や dry-run の --at 指定によるものとみなし、送信間隔の判定には使いません。',
          { last_submit_at: last, now: now.toISOString() },
        );
      }
      return null;
    }
    const gapMs = Math.max(this.#d.getSettings().queue.min_submit_interval_seconds * 1000, MIN_SLOT_GAP_MINUTES * MINUTE_MS);
    return now.getTime() - lastMs >= gapMs ? null : new Date(lastMs + gapMs);
  }

  /** SLOT_WAITING for `slot`, once per slot. The caller decides whether the slot can still be used when the wait ends. */
  noteWaiting(slot: DailySlot, waitUntil: Date): void {
    if (this.#waitingSlotId === slot.slot_id) return;
    this.#waitingSlotId = slot.slot_id;
    this.#d.logger.info('SLOT_WAITING', `前回の送信から間隔を空けるため、この${POST_TYPE_JA[slot.post_type]}の枠は ${formatJst(waitUntil)} 頃まで送信を待ちます。`, {
      post_type: slot.post_type,
      slot_id: slot.slot_id,
      scheduled_at: slot.scheduled_at,
      last_submit_at: this.#d.control.get().last_submit_at,
      wait_until: waitUntil.toISOString(),
    });
  }
}
