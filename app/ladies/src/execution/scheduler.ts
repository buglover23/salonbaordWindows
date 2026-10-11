import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, errorCodeOf } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { POST_TYPE_JA } from '../shared/labels.js';
import { formatJst, jstDateKey } from '../shared/time.js';
import { POST_TYPES, type AudienceCategory, type PostType } from '../shared/types.js';
import type { ControlStore } from '../storage/control-store.js';
import type { JobStore, JobSummary } from '../storage/job-store.js';
import { SerialQueue } from '../storage/serial-queue.js';
import type { DailyPlan, DailySlot, ScheduleStore } from './schedule-store.js';
import { countsFor, dayScheduleHash, MIN_SLOT_GAP_MINUTES, planRemainingSlots, slotExpiry, type PlanSchedule } from './slots.js';
import { releaseSlot, type SlotOutcome } from './startup-recovery.js';
import { SubmitGap } from './submit-gap.js';

export interface Dispatch {
  slot: DailySlot;
  job: Job;
}

export interface SchedulerDeps {
  clock: Clock;
  schedules: ScheduleStore;
  jobs: JobStore;
  control: ControlStore;
  /** The effective schedule; its day_counts (Ruling P2-R11) replace the configured counts on those weekdays. */
  getSchedule: () => PlanSchedule;
  getSettings: () => Settings;
  getConfigHash: () => string;
  isRouteAvailable: (t: PostType, a: AudienceCategory) => boolean;
  /** True while a job from an earlier day has an unknown result (spec 12.3; Plan 3). */
  hasBlockingUnresolved: (todayKey: string) => boolean;
  /**
   * Plan decision 13: true while a job of this post type is still to be prepared (JobProcessor.willPrepare). A due slot
   * with no READY job of its type then stays open for it until its grace time or window ends, as Plan 1's preparation
   * before every tick would have had it READY. Omitted: never.
   */
  willPrepare?: (type: PostType) => boolean;
  /** Why the photos of this type wait before preparation (JobProcessor.heldReason): a missed slot names it. Omitted: none. */
  heldReason?: (type: PostType) => string | null;
  /** A41 (JobProcessor.isCurrent): false for a READY job not yet checked against the current rules; it is not dispatched. */
  isCurrent?: (s: JobSummary) => boolean;
  /**
   * Plan 3: whether this post type may be dispatched at all: a type stop closes the slot as type_stopped, a computed service
   * quota as quota_reached (no stop is raised, P3-R9). Omitted: always.
   */
  isTypeAvailable?: (t: PostType) => { ok: true } | { ok: false; close: 'type_stopped' | 'quota_reached' };
  /**
   * Plan 3 (P3-R39): the per-job dispatch predicates shared with due retries (upload prepared for the current constraints,
   * provenance, live_single binding, first-post gate, no retry_blocked_reason). false = skipped, the next candidate is used.
   * Omitted: always.
   */
  isJobDispatchable?: (s: JobSummary) => boolean;
  logger: AppLogger;
}

type CloseReason = 'grace_exceeded' | 'window_closed' | 'superseded' | 'quota_reached' | 'service_quota' | 'type_stopped' | 'no_ready_job' | 'held' | 'route_unavailable';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ROLLBACK_WARN_MS = 5 * MINUTE_MS;
/** How many earlier JST days a tick looks back at for slots left open. */
const PAST_DAYS = 7;

// `stored`: the reason written to the slot when it differs from the key (the service quota shares 'quota_reached').
const CLOSE: Record<CloseReason, { state: 'skipped' | 'missed'; level: 'info' | 'warn'; message: (type: string, time: string, why: string) => string; stored?: string }> = {
  grace_exceeded: { state: 'skipped', level: 'warn', message: (t, at) => `${at} の${t}の枠は、予定時刻から猶予時間を過ぎたため見送りました（後からまとめて投稿はしません）。` },
  window_closed: { state: 'skipped', level: 'warn', message: (t, at) => `投稿できる時間帯が終わったため、${at} の${t}の枠は見送りました（時間帯の外では送信しません）。` },
  superseded: { state: 'skipped', level: 'warn', message: (t, at) => `より後の枠が既に予定時刻を迎えているため、${at} の${t}の枠は見送りました（続けて投稿はしません）。` },
  quota_reached: { state: 'skipped', level: 'info', message: (t, at) => `本日の${t}の投稿数が上限に達しているため、${at} の枠は見送りました。` },
  service_quota: {
    state: 'skipped',
    level: 'info',
    stored: 'quota_reached',
    message: (t, at) => `計算上、${t}の投稿数が上限に達するため、${at} の枠は見送りました（上限の期間が変われば自動で再開します）。`,
  },
  type_stopped: { state: 'skipped', level: 'info', message: (t, at) => `${t}の送信を止めているため、${at} の枠は見送りました（理由は status で確認できます）。` },
  no_ready_job: { state: 'missed', level: 'warn', message: (t, at) => `投稿できる${t}が無いため、${at} の枠は欠席にしました。画像を追加してください。` },
  held: { state: 'missed', level: 'warn', stored: 'no_ready_job', message: (t, at, why) => `${t}の写真は準備を保留しているため、${at} の枠は欠席にしました（${why}）。` },
  route_unavailable: { state: 'missed', level: 'warn', message: (t, at) => `${t}の投稿先が使えない状態のため、${at} の枠は欠席にしました。` },
};

/**
 * P3-R2 / spec 12.3 (SchedulerDeps.hasBlockingUnresolved): new posts wait while a result from an earlier JST day is unknown
 * (by its intent or unexpected-navigation time; an unknown time counts as earlier) or 2 or more results are unknown.
 */
export function blockingUnresolved(summaries: readonly JobSummary[], today: string): boolean {
  const unknown = summaries.filter((s) => s.status === 'VERIFY_REQUIRED');
  return unknown.length >= 2 || unknown.some((s) => s.intent_date_jst === null || s.intent_date_jst < today);
}

/** HH:mm (JST) of a slot. */
const slotTime = (iso: string): string => formatJst(new Date(iso)).slice(11);

function byTime(a: { scheduled_at: string }, b: { scheduled_at: string }): number {
  return Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at);
}

// Oldest first; the same created_at falls back to id order (spec 12.3, A48).
function byAge(a: JobSummary, b: JobSummary): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// The other audience than last time when it has a candidate; otherwise (or on the first pick) the oldest job.
function pickJob(candidates: JobSummary[], last: AudienceCategory | null): JobSummary | undefined {
  const sorted = [...candidates].sort(byAge);
  return (last === null ? undefined : sorted.find((s) => s.audience_category !== last)) ?? sorted[0];
}

function patchSlot(slot: DailySlot, patch: Pick<DailySlot, 'state' | 'job_id' | 'audience_category' | 'reason'>, at: string): void {
  Object.assign(slot, patch, { updated_at: at });
}

/**
 * Decides when a READY job is handed to the poster (spec 12.2-12.3). Every slot state change is saved before anything else
 * happens, so a slot is executed at most once even across restarts, sleep and clock changes; past slots are skipped, never
 * caught up. Public calls are serialized among themselves (not on the shared write queue, which the stores use).
 */
export class Scheduler {
  readonly #d: SchedulerDeps;
  readonly #lock = new SerialQueue();
  readonly #gap: SubmitGap;
  /** This process's previous tick: a plan's last_tick_at does not carry over to the next date. */
  #lastTickMs = -Infinity;
  /** Earlier dates already looked at for slots left open (once per date per process). */
  readonly #pastDaysSeen = new Set<string>();
  /** The slot last logged as waiting for a job still being prepared (logged once per slot). */
  #preparingNoted: string | null = null;
  /** Today's plan as the last tick or replan left it; read by neededType() without touching the file. */
  #lastPlan: DailyPlan | null = null;
  /** When this process started: slots already past then are reported quietly (info). */
  readonly #startedMs: number;

  constructor(d: SchedulerDeps) {
    this.#d = d;
    this.#startedMs = d.clock.now().getTime();
    this.#gap = new SubmitGap(d);
  }

  /** At most one dispatch per call; the slot is `reserved` on disk before the job is updated. */
  tick(): Promise<Dispatch | null> {
    return this.#lock.run(() => this.#tick());
  }

  /** Marks a `reserved` slot as finished; any other state is a caller bug (INTERNAL_ERROR). */
  complete(date: string, slotId: string, outcome: 'done' | 'failed'): Promise<void> {
    return this.#lock.run(() => this.#complete(date, slotId, outcome));
  }

  /**
   * Settles the `reserved` slot of `jobId` by P3-R27 (slotReleasable), as startup recovery does (R21): a job that never sent
   * anything gives it back (`open` within its grace time, otherwise `skipped` with `reason`), a waiting retry keeps it only
   * while it fits the slot's window (else `skipped`, retry_carried_over), POSTED → `done`, "not registered" after intent →
   * `failed`. null = refused: the slot is not reserved for that job, or must be kept (an intent or an unknown result).
   */
  release(date: string, slotId: string, jobId: string, reason: string): Promise<SlotOutcome | null> {
    return this.#lock.run(() => releaseSlot(this.#slotDeps(), date, slotId, jobId, reason));
  }

  /**
   * The service quota was found reached for the job holding this slot (claim or intent, P3-R9): the slot is closed as
   * `skipped` quota_reached (never reopened that day, no stop) and the job's slot fields are cleared. false = not reserved for it.
   */
  closeQuota(date: string, slotId: string, jobId: string): Promise<boolean> {
    return this.#lock.run(async () => {
      const { clock, schedules, jobs } = this.#d;
      const plan = await schedules.load(date, clock);
      const slot = plan?.slots.find((s) => s.slot_id === slotId);
      if (!plan || !slot || slot.state !== 'reserved' || slot.job_id !== jobId) return false;
      this.#close(slot, 'service_quota', clock.now().toISOString());
      await schedules.save(plan);
      const job = await jobs.get(jobId);
      if (job !== null && job.schedule_slot_id === slotId) await jobs.update(jobId, job.revision, (j) => ({ ...j, schedule_slot_id: null, scheduled_at: null }));
      return true;
    });
  }

  /** true while `slotId` of `date` is reserved for `jobId` (a waiting retry still holds its slot). Changes nothing. */
  holdFor(date: string, slotId: string, jobId: string): Promise<boolean> {
    return this.#lock.run(async () => {
      const slot = (await this.#d.schedules.load(date, this.#d.clock))?.slots.find((s) => s.slot_id === slotId);
      return slot?.state === 'reserved' && slot.job_id === jobId;
    });
  }

  #slotDeps(): Parameters<typeof releaseSlot>[0] {
    const { jobs: store, schedules, clock, logger } = this.#d;
    const schedule = this.#d.getSchedule();
    return { store, schedules, clock, logger, graceMinutes: schedule.slot_grace_minutes, schedule };
  }

  /**
   * The post type to prepare first (plan decision 13): going through today's open slots in time order, from the latest due
   * one, each slot uses up a READY job of its type; the first slot left without one names the type. null when every open
   * slot has a job, or before the first tick of the day. Reads the plan of the last tick, not the file.
   */
  neededType(): PostType | null {
    const plan = this.#lastPlan;
    const now = this.#d.clock.now();
    if (plan === null || plan.date !== jstDateKey(now)) return null;
    const open = plan.slots.filter((s) => s.state === 'open').sort(byTime);
    const due = open.filter((s) => Date.parse(s.scheduled_at) <= now.getTime());
    const coming = [...due.slice(-1), ...open.slice(due.length)];
    const holding = new Set(plan.slots.filter((s) => s.state === 'reserved').map((s) => s.job_id));
    const ready: Record<PostType, number> = { style: 0, blog: 0 };
    for (const j of this.#d.jobs.summaries((s) => s.status === 'READY' && !holding.has(s.id))) ready[j.post_type] += 1;
    for (const slot of coming) {
      if (ready[slot.post_type] === 0) return slot.post_type;
      ready[slot.post_type] -= 1;
    }
    return null;
  }

  /** Applies the current schedule to today's future open slots only; past and started slots are kept as they are (A07). */
  replanFuture(): Promise<void> {
    return this.#lock.run(() => this.#replan(null));
  }

  /**
   * R24 extended to the effective schedule (config + instructions): replans today's future open slots when today's
   * windows or daily counts differ from those its plan was built for (dayScheduleHash). Restart-safe, since the plan
   * records the hash. Does nothing without a plan for today (the next tick builds it from the current schedule); a plan
   * made before the hash existed just records it. true = replanned.
   */
  replanIfScheduleChanged(): Promise<boolean> {
    return this.#lock.run(async () => {
      const { clock, schedules } = this.#d;
      const today = jstDateKey(clock.now());
      const plan = await schedules.load(today, clock);
      if (plan === null) return false;
      const hash = dayScheduleHash(today, this.#d.getSchedule());
      if (plan.schedule_hash === hash) return false;
      if (plan.schedule_hash === undefined) {
        plan.schedule_hash = hash;
        await schedules.save(plan);
        return false;
      }
      await this.#replan(plan);
      return true;
    });
  }

  async #tick(): Promise<Dispatch | null> {
    const { clock, control, schedules } = this.#d;
    const now = clock.now();
    const at = now.toISOString();
    const today = jstDateKey(now);
    const schedule = this.#d.getSchedule();
    await this.#closePastDays(now, today);
    const plan = await schedules.loadOrCreate(today, schedule, this.#d.getConfigHash(), clock);
    this.#lastPlan = plan;
    this.#noteTick(plan, now);

    const reasons = new Map<DailySlot, CloseReason>();
    for (const slot of plan.slots) {
      const expiry = slot.state === 'open' ? slotExpiry(schedule, slot.scheduled_at, now) : null;
      const isDue = Date.parse(slot.scheduled_at) <= now.getTime(); // a slot outside every window is closed once it is due
      if (expiry === 'grace_exceeded' || (expiry === 'window_closed' && isDue)) reasons.set(slot, expiry);
    }
    // Only the latest due slot may run; earlier ones still within grace are given up so slots never go out back to back (R22).
    const due = plan.slots.filter((s) => s.state === 'open' && !reasons.has(s) && Date.parse(s.scheduled_at) <= now.getTime()).sort(byTime);
    let current = due.pop();
    for (const slot of due) reasons.set(slot, 'superseded');
    // live:single --now: with nothing due, the next open slot of the armed route's type is pulled forward to now (inside
    // the posting window), so the owner's first live post does not wait for its slot. The day's count is unchanged.
    const bound = control.get().live_single;
    if (current === undefined && bound?.now === true && slotExpiry(schedule, at, now) === null) {
      const type = bound.route_key.split('.')[0];
      const next = plan.slots.filter((s) => s.state === 'open' && s.post_type === type && Date.parse(s.scheduled_at) > now.getTime()).sort(byTime)[0];
      if (next !== undefined) {
        next.scheduled_at = at;
        current = next;
      }
    }
    const batch = reasons.size > 1;
    for (const [slot, reason] of reasons) this.#close(slot, reason, at, batch);
    if (batch) this.#logSkipped([...reasons.keys()]);

    if (current !== undefined && !control.get().paused && !this.#d.hasBlockingUnresolved(today)) {
      const dispatch = await this.#fill(plan, current, schedule, now);
      if (dispatch !== null) return dispatch;
    }
    await schedules.save(plan);
    return null;
  }

  // Open slots of the previous PAST_DAYS days can never run any more: they are closed as day_ended. reserved / done / failed
  // slots are kept (startup recovery owns reserved ones). A plan that cannot be read or saved is only warned about and left
  // as it is, since today's slots do not depend on it.
  async #closePastDays(now: Date, today: string): Promise<void> {
    const { clock, schedules, logger } = this.#d;
    this.#pastDaysSeen.delete(today); // the clock went back to it: look at it again once it is past
    for (let back = 1; back <= PAST_DAYS; back++) {
      const date = jstDateKey(new Date(now.getTime() - back * DAY_MS));
      if (this.#pastDaysSeen.has(date)) continue;
      this.#pastDaysSeen.add(date);
      try {
        const plan = await schedules.load(date, clock);
        const open = plan?.slots.filter((s) => s.state === 'open') ?? [];
        if (plan === null || open.length === 0) continue;
        for (const slot of open) patchSlot(slot, { state: 'skipped', job_id: null, audience_category: null, reason: 'day_ended' }, now.toISOString());
        await schedules.save(plan);
        const fields = { date, reason: 'day_ended', slot_ids: open.map((s) => s.slot_id) };
        logger.warn('SLOT_SKIPPED', `${date} の使われなかった枠（${open.length}件）は、その日が終わったため見送りました（後からまとめて投稿はしません）。`, fields);
      } catch (err) {
        const fields = { date, error_code: errorCodeOf(err) };
        logger.warn('PAST_PLAN_NOT_CLOSED', `${date} の計画に残った枠を見送りにできませんでした（ファイルは変更していません。本日の投稿は続けます）。`, fields);
      }
    }
  }

  #noteTick(plan: DailyPlan, now: Date): void {
    const lastMs = Math.max(plan.last_tick_at === null ? -Infinity : Date.parse(plan.last_tick_at), this.#lastTickMs);
    const backMs = lastMs - now.getTime();
    if (backMs >= ROLLBACK_WARN_MS) {
      this.#d.logger.warn(
        'CLOCK_ROLLBACK',
        `PCの時計が前回の確認より約${Math.round(backMs / MINUTE_MS)}分戻りました。実行済みの枠は記録済みのため、同じ枠を二度投稿することはありません。`,
        { previous_tick_at: new Date(lastMs).toISOString(), now: now.toISOString() },
      );
    }
    plan.last_tick_at = now.toISOString();
    this.#lastTickMs = now.getTime();
  }

  /** Dispatches a job into `slot` (plan saved first), or closes / leaves the slot and returns null. */
  async #fill(plan: DailyPlan, slot: DailySlot, schedule: PlanSchedule, now: Date): Promise<Dispatch | null> {
    const type = slot.post_type;
    const at = now.toISOString();
    const used = plan.slots.filter((s) => s.post_type === type && (s.state === 'done' || s.state === 'reserved')).length;
    if (used >= countsFor(plan.date, schedule)[type]) {
      this.#close(slot, 'quota_reached', at);
      return null;
    }
    const available = this.#d.isTypeAvailable?.(type) ?? { ok: true };
    if (!available.ok) {
      this.#close(slot, available.close === 'quota_reached' ? 'service_quota' : 'type_stopped', at);
      return null;
    }
    // A job that already holds a reserved slot is with the poster and must not get a second one.
    const holding = new Set(plan.slots.filter((s) => s.state === 'reserved').map((s) => s.job_id));
    const dispatchable = (s: JobSummary): boolean => !s.has_operation && (this.#d.isJobDispatchable?.(s) ?? true);
    // P3-R11: a due retry that gave up its slot (carried over) goes before READY jobs, oldest next_retry_at first.
    const retries = this.#d.jobs
      .summaries((s) => s.status === 'RETRY_WAIT' && s.post_type === type && s.schedule_slot_id === null && s.next_retry_at !== null && Date.parse(s.next_retry_at) <= now.getTime())
      .filter((s) => this.#d.isRouteAvailable(type, s.audience_category));
    const all = this.#d.jobs.summaries((s) => s.status === 'READY' && s.post_type === type && !holding.has(s.id));
    const ready = all.filter((s) => this.#d.isCurrent?.(s) ?? true);
    const routable = ready.filter((s) => this.#d.isRouteAvailable(type, s.audience_category));
    const retry = retries.filter(dispatchable).sort((a, b) => Date.parse(a.next_retry_at!) - Date.parse(b.next_retry_at!) || byAge(a, b))[0];
    const pick = retry ?? pickJob(routable.filter(dispatchable), plan.last_audience[type]);
    if (pick === undefined) {
      // Only jobs in the middle of a file move or not dispatchable yet (e.g. an upload being prepared): keep the slot open.
      if (routable.length > 0 || retries.length > 0) return null;
      // A job of this type is still being prepared, or rechecked against changed rules (A41): the slot waits for it
      // within grace (decision 13).
      if (ready.length === 0 && (all.length > 0 || this.#d.willPrepare?.(type) === true)) {
        this.#notePreparing(slot);
        return null;
      }
      // Photos waiting before preparation (e.g. verified_menus not registered): say why, not "add photos".
      const held = ready.length === 0 ? (this.#d.heldReason?.(type) ?? null) : null;
      this.#close(slot, ready.length > 0 ? 'route_unavailable' : held === null ? 'no_ready_job' : 'held', at, false, held?.replace(/。$/, ''));
      return null;
    }
    // The submission gap matters only once the slot would really be filled. Waiting is announced only when the slot is still
    // usable at the end of the wait; otherwise grace_exceeded / window_closed will close it and say so (R27).
    const waitUntil = this.#gap.waitUntil(now);
    if (waitUntil !== null) {
      if (slotExpiry(schedule, slot.scheduled_at, waitUntil) === null) this.#gap.noteWaiting(slot, waitUntil);
      return null;
    }
    return this.#reserve(plan, slot, pick.id, at);
  }

  async #reserve(plan: DailyPlan, slot: DailySlot, jobId: string, at: string): Promise<Dispatch | null> {
    const { jobs, schedules, logger } = this.#d;
    const job = await jobs.get(jobId);
    const carriedRetry = job?.status === 'RETRY_WAIT' && job.schedule_slot_id === null;
    if (job === null || (job.status !== 'READY' && !carriedRetry) || job.operation !== null) return null;

    const type = slot.post_type;
    const previousAudience = plan.last_audience[type];
    patchSlot(slot, { state: 'reserved', job_id: job.id, audience_category: job.audience_category, reason: null }, at);
    plan.last_audience[type] = job.audience_category;
    await schedules.save(plan); // the slot is used up on disk before the job learns about it
    try {
      const updated = await jobs.update(job.id, job.revision, (j) => ({ ...j, schedule_slot_id: slot.slot_id, scheduled_at: slot.scheduled_at }));
      const fields = { job_id: job.id, post_type: type, audience_category: job.audience_category, slot_id: slot.slot_id, scheduled_at: slot.scheduled_at };
      logger.info('SLOT_RESERVED', `${POST_TYPE_JA[type]}の枠にjobを割り当てました。`, fields);
      return { slot: { ...slot }, job: updated };
    } catch (err) {
      // Never leave a reserved slot pointing at a job that does not know about it.
      patchSlot(slot, { state: 'open', job_id: null, audience_category: null, reason: null }, at);
      plan.last_audience[type] = previousAudience;
      if (errorCodeOf(err) === 'REVISION_CONFLICT') return null; // saved at the end of the tick
      await schedules.save(plan).catch(() => undefined); // the original error is the one worth reporting
      throw err;
    }
  }

  #notePreparing(slot: DailySlot): void {
    if (this.#preparingNoted === slot.slot_id) return;
    this.#preparingNoted = slot.slot_id;
    const type = POST_TYPE_JA[slot.post_type];
    this.#d.logger.info('SLOT_WAITING_PREPARATION', `${type}の枠の時刻になりました。${type}の投稿を準備中のため、猶予時間内に準備ができればこの枠で投稿します。`, {
      post_type: slot.post_type,
      slot_id: slot.slot_id,
      scheduled_at: slot.scheduled_at,
    });
  }

  /** `quiet`: one of several closed in the same tick (#logSkipped sums them up on the console). */
  #close(slot: DailySlot, reason: CloseReason, at: string, quiet = false, why = ''): void {
    const c = CLOSE[reason];
    const stored = c.stored ?? reason;
    patchSlot(slot, { state: c.state, job_id: null, audience_category: null, reason: stored }, at);
    const fields = { post_type: slot.post_type, slot_id: slot.slot_id, scheduled_at: slot.scheduled_at, reason: stored };
    const early = c.state === 'skipped' && Date.parse(slot.scheduled_at) < this.#startedMs;
    const level = quiet ? 'debug' : early ? 'info' : c.level;
    this.#d.logger[level](c.state === 'missed' ? 'SLOT_MISSED' : 'SLOT_SKIPPED', c.message(POST_TYPE_JA[slot.post_type], slotTime(slot.scheduled_at), why), fields);
  }

  /** One line for several slots skipped in the same tick (e.g. the first start of the day). */
  #logSkipped(slots: DailySlot[]): void {
    const sorted = [...slots].sort(byTime);
    const first = slotTime(sorted[0]!.scheduled_at);
    const last = slotTime(sorted[sorted.length - 1]!.scheduled_at);
    const counts = POST_TYPES.map((t) => [t, sorted.filter((s) => s.post_type === t).length] as const)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${POST_TYPE_JA[t]}${n}件`)
      .join('・');
    const early = sorted.every((s) => Date.parse(s.scheduled_at) < this.#startedMs);
    const message = `${early ? '起動前に時刻を過ぎた' : ''}本日 ${first}〜${last} の枠（${counts}）は、猶予時間を過ぎたなどの理由で見送りました（後からまとめて投稿はしません）。`;
    this.#d.logger[early ? 'info' : 'warn']('SLOTS_SKIPPED', message, { slot_ids: sorted.map((s) => s.slot_id), reasons: [...new Set(sorted.map((s) => s.reason))] });
  }

  async #complete(date: string, slotId: string, outcome: 'done' | 'failed'): Promise<void> {
    const { clock, schedules } = this.#d;
    const plan = await schedules.load(date, clock);
    const slot = plan?.slots.find((s) => s.slot_id === slotId);
    if (!plan || !slot || slot.state !== 'reserved') {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'schedule', clock, {
          message: `予約中ではない枠は完了にできません: ${date} ${slotId}（${slot?.state ?? '枠なし'}）`,
          details: { date, slot_id: slotId, state: slot?.state ?? null, outcome },
        }),
      );
    }
    slot.state = outcome;
    slot.updated_at = clock.now().toISOString();
    await schedules.save(plan);
  }

  /** `loaded`: today's plan, already read under the lock (null: read or create it here). */
  async #replan(loaded: DailyPlan | null): Promise<void> {
    const { clock, schedules, logger } = this.#d;
    const now = clock.now();
    const at = now.toISOString();
    const today = jstDateKey(now);
    const schedule = this.#d.getSchedule();
    const configHash = this.#d.getConfigHash();
    const plan = loaded ?? (await schedules.loadOrCreate(today, schedule, configHash, clock));

    const kept = plan.slots.filter((s) => s.state !== 'open' || Date.parse(s.scheduled_at) <= now.getTime());
    const cancelled = plan.slots.length - kept.length;
    const r = planRemainingSlots(today, schedule, kept, now);
    const fresh = r.fresh.map((s): DailySlot => ({ ...s, state: 'open', job_id: null, audience_category: null, reason: null, updated_at: at }));
    plan.slots = [...kept, ...fresh].sort(byTime);
    plan.config_hash = configHash;
    plan.schedule_hash = dayScheduleHash(today, schedule);
    await schedules.save(plan);
    this.#lastPlan = plan;

    const { requested, planned, windowMinutes } = r;
    const fields = { date: today, kept: r.kept, requested, planned, cancelled, window_minutes: windowMinutes, from: r.fromUtc.toISOString() };
    if (windowMinutes === 0 && requested.style + requested.blog > 0) {
      logger.info(
        'SCHEDULE_REPLANNED',
        `本日はこの後に投稿できる時間帯が無いため（休業日・営業時間・投稿時間の変更、または時間帯の終了）、本日の未使用の枠（${cancelled}件）を取り消しました。` +
          '実行済みの枠はそのままです。',
        fields,
      );
    } else if (planned.style < requested.style || planned.blog < requested.blog) {
      logger.warn(
        'SCHEDULE_REPLANNED',
        `本日の残りの投稿可能時間（${windowMinutes}分）では投稿の間隔を${MIN_SLOT_GAP_MINUTES}分以上空けられないため、残りの枠を` +
          `スタイル${requested.style}→${planned.style}件、ブログ${requested.blog}→${planned.blog}件に減らしました。`,
        fields,
      );
    } else {
      logger.info('SCHEDULE_REPLANNED', `設定・作業指示書の変更を本日の未来の枠に反映しました（スタイル${planned.style}件、ブログ${planned.blog}件）。`, fields);
    }
  }
}
