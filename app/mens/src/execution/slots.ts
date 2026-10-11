import type { ScheduleConfig } from '../config/schemas.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError, errorCodeOf } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import type { PostType } from '../shared/types.js';
import { jstDateKey, jstIsoWeekday, jstMinutesOfDay, jstToUtc, parseHHmm } from '../shared/time.js';

export interface PlannedSlot {
  slot_id: string;
  post_type: PostType;
  scheduled_at: string; // UTC ISO 8601
}

/** Smallest allowed gap between slots, in minutes (spec 5.4: refuse to cram slots into too little time). */
export const MIN_SLOT_GAP_MINUTES = 5;

/** A half-open range of minutes since 00:00 JST: [start, end). */
export type TimeWindow = { start: number; end: number };
type IsoWeekday = ReturnType<typeof jstIsoWeekday>;
type WeekdayKey = '1' | '2' | '3' | '4' | '5' | '6' | '7';

/** Ruling P2-R11: per ISO weekday, the daily counts reduced so that they fit that weekday's posting windows. */
export type DayCounts = Partial<Record<WeekdayKey, Record<PostType, number>>>;

/**
 * What the slot functions plan from: schedule.json, or the effective schedule (instructions applied) whose `day_counts`
 * replace the configured counts on the weekdays an instruction's hours or post window leave too little room for them.
 */
export type PlanSchedule = ScheduleConfig & { readonly day_counts?: DayCounts };

const WEEKDAY_JA: Record<IsoWeekday, string> = { 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土', 7: '日' };

function windowsForWeekday(weekday: IsoWeekday, schedule: ScheduleConfig): TimeWindow[] {
  const post: TimeWindow = { start: parseHHmm(schedule.post_start), end: parseHHmm(schedule.post_end) };
  if (schedule.business_hours === null) {
    return post.start < post.end ? [post] : [];
  }

  const clipped: TimeWindow[] = [];
  for (const range of schedule.business_hours[String(weekday) as keyof typeof schedule.business_hours]) {
    const start = Math.max(post.start, parseHHmm(range.start));
    const end = Math.min(post.end, parseHHmm(range.end));
    if (start < end) clipped.push({ start, end });
  }
  clipped.sort((a, b) => a.start - b.start);

  const merged: TimeWindow[] = [];
  for (const w of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/** Posting windows (JST minutes, half-open) for one calendar day; empty on closed dates and inactive weekdays. */
export function effectiveWindows(dateKey: string, schedule: ScheduleConfig): TimeWindow[] {
  const weekday = jstIsoWeekday(dateKey);
  if (schedule.closed_dates.includes(dateKey) || !schedule.active_weekdays.includes(weekday)) return [];
  return windowsForWeekday(weekday, schedule);
}

/** The daily counts for one date: its weekday's reduced counts (Ruling P2-R11), else the configured ones. */
export function countsFor(dateKey: string, schedule: PlanSchedule): Record<PostType, number> {
  const reduced = schedule.day_counts?.[String(jstIsoWeekday(dateKey)) as WeekdayKey];
  return reduced === undefined ? { style: schedule.style_posts_per_day, blog: schedule.blog_posts_per_day } : { style: reduced.style, blog: reduced.blog };
}

/**
 * What shapes one day's slots: that day's posting windows and its daily counts. A day's plan is rebuilt only when this
 * changes (R24, extended to the instruction overlay), so edits that do not touch the day never move its slots.
 */
export function dayScheduleHash(dateKey: string, schedule: PlanSchedule): string {
  const counts = countsFor(dateKey, schedule);
  return sha256Hex(JSON.stringify({ windows: effectiveWindows(dateKey, schedule), style: counts.style, blog: counts.blog }));
}

function totalMinutes(windows: TimeWindow[]): number {
  return windows.reduce((sum, w) => sum + (w.end - w.start), 0);
}

function gapTooSmall(totalWindowMinutes: number, slotCount: number): boolean {
  return totalWindowMinutes / slotCount < MIN_SLOT_GAP_MINUTES;
}

/**
 * Ruling P2-R11: for each active weekday whose posting windows cannot hold the configured counts with the minimum gap
 * (the weekdays validateScheduleCapacity reports), those counts reduced in proportion (R13 fitCounts) to what fits.
 */
export function fittedDayCounts(schedule: ScheduleConfig): DayCounts {
  const requested = { style: schedule.style_posts_per_day, blog: schedule.blog_posts_per_day };
  const total = requested.style + requested.blog;
  const out: DayCounts = {};
  if (total === 0) return out;
  for (const day of [...schedule.active_weekdays].sort((a, b) => a - b)) {
    const windowMinutes = totalMinutes(windowsForWeekday(day as IsoWeekday, schedule));
    if (windowMinutes === 0 || !gapTooSmall(windowMinutes, total)) continue;
    out[String(day) as WeekdayKey] = fitCounts(requested, Math.floor(windowMinutes / MIN_SLOT_GAP_MINUTES));
  }
  return out;
}

// Drops everything before `fromMinute`, keeping only the remainder of each window.
function trimWindows(windows: TimeWindow[], fromMinute: number): TimeWindow[] {
  const out: TimeWindow[] = [];
  for (const w of windows) {
    const start = Math.max(w.start, fromMinute);
    if (start < w.end) out.push({ start, end: w.end });
  }
  return out;
}

// The day's windows from `fromUtc` on: none once that day has passed, untrimmed when `fromUtc` is an earlier day,
// otherwise cut at fromUtc with a start time carrying seconds or milliseconds rounded up to the next whole minute.
function windowsFrom(dateKey: string, schedule: ScheduleConfig, fromUtc: Date | undefined): TimeWindow[] {
  const windows = effectiveWindows(dateKey, schedule);
  if (fromUtc === undefined) return windows;
  const fromDay = jstDateKey(fromUtc);
  if (fromDay > dateKey) return [];
  if (fromDay < dateKey) return windows;
  return trimWindows(windows, jstMinutesOfDay(fromUtc) + (fromUtc.getTime() % 60_000 === 0 ? 0 : 1));
}

/** Total minutes of the day's posting windows left from `fromUtc` on, trimmed exactly as buildDailySlots trims them. */
export function windowMinutesFrom(dateKey: string, schedule: ScheduleConfig, fromUtc?: Date): number {
  return totalMinutes(windowsFrom(dateKey, schedule, fromUtc));
}

/** When the posting window holding `at` ends (R26), or null when `at` lies outside every window of its JST day. */
export function windowEndFor(schedule: ScheduleConfig, at: Date): Date | null {
  const dateKey = jstDateKey(at);
  const minute = jstMinutesOfDay(at);
  const holding = effectiveWindows(dateKey, schedule).find((w) => w.start <= minute && minute < w.end);
  return holding === undefined ? null : jstToUtc(dateKey, holding.end);
}

/**
 * Why a slot scheduled at `scheduledAt` can no longer be filled at `at`: its grace time has passed, or the posting window
 * holding it has ended (R26: nothing is submitted after the window, spec 12.1); null while it still can be.
 */
export function slotExpiry(schedule: ScheduleConfig, scheduledAt: string, at: Date): 'grace_exceeded' | 'window_closed' | null {
  const scheduledMs = Date.parse(scheduledAt);
  if (at.getTime() > scheduledMs + schedule.slot_grace_minutes * 60_000) return 'grace_exceeded';
  const end = windowEndFor(schedule, new Date(scheduledMs));
  return end === null || at.getTime() >= end.getTime() ? 'window_closed' : null;
}

/** R13: splits `capacity` slots in proportion to `requested` (largest remainder, ties → style), never above the request. */
export function fitCounts(requested: Record<PostType, number>, capacity: number): Record<PostType, number> {
  const total = requested.style + requested.blog;
  if (capacity >= total) return { ...requested };
  const out: Record<PostType, number> = {
    style: Math.floor((capacity * requested.style) / total),
    blog: Math.floor((capacity * requested.blog) / total),
  };
  if (out.style + out.blog < capacity) {
    out[(capacity * requested.style) % total >= (capacity * requested.blog) % total ? 'style' : 'blog'] += 1;
  }
  return { style: Math.min(out.style, requested.style), blog: Math.min(out.blog, requested.blog) };
}

export interface RemainingSlots {
  fresh: PlannedSlot[];
  kept: Record<PostType, number>;
  requested: Record<PostType, number>;
  planned: Record<PostType, number>;
  /** Window minutes left from `fromUtc` on. */
  windowMinutes: number;
  fromUtc: Date;
}

function countByType(slots: readonly PlannedSlot[]): Record<PostType, number> {
  const counts = { style: 0, blog: 0 };
  for (const s of slots) counts[s.post_type] += 1;
  return counts;
}

/**
 * A07: new slots for the rest of `dateKey` around the `kept` ones (already started, finished or due): that day's counts
 * (countsFor) minus the kept ones, from `now` but at least MIN_SLOT_GAP after the latest kept slot (R22), numbered after the kept ones.
 * When too little of the day is left they are reduced in proportion instead of failing (R13).
 */
export function planRemainingSlots(dateKey: string, schedule: PlanSchedule, kept: readonly PlannedSlot[], now: Date): RemainingSlots {
  const keptCounts = countByType(kept);
  const day = countsFor(dateKey, schedule);
  const requested = {
    style: Math.max(0, day.style - keptCounts.style),
    blog: Math.max(0, day.blog - keptCounts.blog),
  };
  const latestKept = Math.max(-Infinity, ...kept.map((s) => Date.parse(s.scheduled_at)));
  const fromUtc = new Date(Math.max(now.getTime(), latestKept + MIN_SLOT_GAP_MINUTES * 60_000));
  const opts = { fromUtc, nextSeq: { style: maxSlotSeq(kept, 'style') + 1, blog: maxSlotSeq(kept, 'blog') + 1 } };
  const windowMinutes = windowMinutesFrom(dateKey, schedule, fromUtc);
  let fresh: PlannedSlot[];
  try {
    fresh = buildDailySlots(dateKey, schedule, { ...opts, counts: requested });
  } catch (err) {
    if (errorCodeOf(err) !== 'CONFIG_INVALID') throw err;
    fresh = buildDailySlots(dateKey, schedule, { ...opts, counts: fitCounts(requested, Math.floor(windowMinutes / MIN_SLOT_GAP_MINUTES)) });
  }
  return { fresh, kept: keptCounts, requested, planned: countByType(fresh), windowMinutes, fromUtc };
}

/** The highest sequence number among the `<date>-<type>-<nn>` slot ids of `type` (0 when there is none). */
export function maxSlotSeq(slots: readonly PlannedSlot[], type: PostType): number {
  let max = 0;
  for (const s of slots) {
    if (s.post_type === type) max = Math.max(max, Number(/-(\d+)$/.exec(s.slot_id)?.[1] ?? 0));
  }
  return max;
}

// Maps an offset on the axis formed by joining the windows back to a JST minute.
// An offset at the end of one window belongs to the start of the next (half-open windows).
function axisToMinute(windows: TimeWindow[], offset: number): number {
  let remaining = offset;
  for (const w of windows) {
    const length = w.end - w.start;
    if (remaining < length) return w.start + remaining;
    remaining -= length;
  }
  throw new Error(`軸上の位置が窓の合計を超えています: ${offset}`);
}

// Picks the type that is furthest behind its target share; ties go to style.
function nextType(assigned: Record<PostType, number>, target: Record<PostType, number>): PostType {
  const styleLeft = assigned.style < target.style;
  const blogLeft = assigned.blog < target.blog;
  if (!blogLeft) return 'style';
  if (!styleLeft) return 'blog';
  // assigned.style / target.style <= assigned.blog / target.blog, compared without division
  return assigned.style * target.blog <= assigned.blog * target.style ? 'style' : 'blog';
}

function capacityError(totalWindowMinutes: number, slotCount: number): AppFailure {
  return new AppFailure(
    appError('CONFIG_INVALID', 'schedule', systemClock, {
      message:
        `投稿可能な時間（${totalWindowMinutes}分）に対して投稿数（${slotCount}件）が多すぎます。` +
        `投稿の間隔は最低${MIN_SLOT_GAP_MINUTES}分必要です。投稿数を減らすか、投稿時間を広げてください。`,
      details: { window_minutes: totalWindowMinutes, slot_count: slotCount, min_gap_minutes: MIN_SLOT_GAP_MINUTES },
    }),
  );
}

// Counts and sequence numbers come from the scheduler, not from the operator: a bad value is a programming error.
function assertCounts(name: 'counts' | 'nextSeq', value: Record<PostType, number> | undefined): void {
  if (value === undefined || (isCount(value.style) && isCount(value.blog))) return;
  throw new AppFailure(
    appError('INTERNAL_ERROR', 'schedule', systemClock, {
      message: `投稿枠の計算に渡された ${name} が不正です（0以上の整数が必要です）。`,
      details: { option: name, style: String(value.style), blog: String(value.blog) },
    }),
  );
}

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** The day's slots; without `opts.counts`, that day's counts (countsFor: the reduced ones of Ruling P2-R11 when set). */
export function buildDailySlots(
  dateKey: string,
  schedule: PlanSchedule,
  opts?: {
    fromUtc?: Date;
    counts?: { style: number; blog: number };
    nextSeq?: { style: number; blog: number };
  },
): PlannedSlot[] {
  assertCounts('counts', opts?.counts);
  assertCounts('nextSeq', opts?.nextSeq);
  const windows = windowsFrom(dateKey, schedule, opts?.fromUtc);

  const target: Record<PostType, number> = opts?.counts ?? countsFor(dateKey, schedule);
  const seq: Record<PostType, number> = { ...(opts?.nextSeq ?? { style: 1, blog: 1 }) };
  const total = target.style + target.blog;
  const windowMinutes = totalMinutes(windows);
  if (total === 0 || windowMinutes === 0) return [];
  if (gapTooSmall(windowMinutes, total)) throw capacityError(windowMinutes, total);

  const assigned: Record<PostType, number> = { style: 0, blog: 0 };
  const slots: PlannedSlot[] = [];
  for (let i = 0; i < total; i++) {
    const postType = nextType(assigned, target);
    assigned[postType] += 1;
    const minute = axisToMinute(windows, Math.floor((i * windowMinutes) / total));
    const slotSeq = seq[postType];
    seq[postType] += 1;
    slots.push({
      slot_id: `${dateKey}-${postType}-${String(slotSeq).padStart(2, '0')}`,
      post_type: postType,
      scheduled_at: jstToUtc(dateKey, minute).toISOString(),
    });
  }
  return slots;
}

/**
 * Japanese issues for the active weekdays whose slot gap would fall below the minimum with the configured counts.
 * Weekdays with the same window length share one issue that names them all (e.g. 「火・金曜日: …」).
 */
export function validateScheduleCapacity(schedule: ScheduleConfig): string[] {
  const total = schedule.style_posts_per_day + schedule.blog_posts_per_day;
  if (total === 0) return [];

  const daysByMinutes = new Map<number, IsoWeekday[]>();
  for (const day of [...schedule.active_weekdays].sort((a, b) => a - b)) {
    const weekday = day as IsoWeekday; // the schema guarantees 1..7
    const windowMinutes = totalMinutes(windowsForWeekday(weekday, schedule));
    if (windowMinutes === 0 || !gapTooSmall(windowMinutes, total)) continue;
    daysByMinutes.set(windowMinutes, [...(daysByMinutes.get(windowMinutes) ?? []), weekday]);
  }
  return [...daysByMinutes].map(
    ([windowMinutes, days]) =>
      `${days.map((d) => WEEKDAY_JA[d]).join('・')}曜日: 投稿可能な時間（${windowMinutes}分）に対して投稿数（${total}件）が多く、` +
      `投稿の間隔が約${(windowMinutes / total).toFixed(1)}分になります（最低${MIN_SLOT_GAP_MINUTES}分必要）。` +
      `投稿数を減らすか、投稿時間を広げてください。`,
  );
}
