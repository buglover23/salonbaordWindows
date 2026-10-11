import { z } from 'zod';
import { nextPacificMidnight, pacificDateKey } from '../shared/pacific-time.js';

// Per-model request quota of a provider whose limits count requests per minute and per quota day (the Gemini API:
// RPM and RPD per project and model, the day resetting at midnight US Pacific). Pure state transitions; the usage
// meter stores the entries (data/ai-usage/request-quota.json) through its write queue.

/** Requests per rolling minute and per quota day for one model. */
export interface RequestLimit {
  rpm: number;
  rpd: number;
}

const MINUTE_MS = 60_000;
/**
 * The rolling window `rpm` is counted in: a second longer than the server's minute, so that differences between when
 * a request is counted here and when it reaches the server cannot put rpm + 1 requests into one of its minutes.
 */
export const RPM_WINDOW_MS = MINUTE_MS + 1_000;
/** First rest after a rate-limit answer (without a longer server hint) or a call left without an answer; it doubles with each further one in a row. */
export const RATE_LIMIT_COOL_DOWN_MS = MINUTE_MS;
const MAX_DOUBLINGS = 16;

/**
 * Stops kept in the file: server_daily = the server said the day's quota is used up (until the reset); rate_limited =
 * a rest after rate-limit answers; unavailable = a rest after calls that got no answer. The app's own daily cap is not
 * stored: it is worked out from the day's count and the current limit on every call, so an edited limit applies at once.
 */
export const QUOTA_STOP_REASONS = ['server_daily', 'rate_limited', 'unavailable'] as const;
export type QuotaStopReason = (typeof QUOTA_STOP_REASONS)[number];
/** daily_limit: this app's count reached the cap; server_daily: the server said the day's quota is used up. */
export type DailyStopReason = 'daily_limit' | 'server_daily';
export type RestReason = Exclude<QuotaStopReason, 'server_daily'>;

const count = z.number().int().nonnegative();
const instant = z.iso.datetime();

export const QuotaEntrySchema = z.strictObject({
  /** The quota day (Pacific calendar date) `requests` belongs to. */
  quota_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Requests started on that day, failed ones included (the provider counts them too). */
  requests: count,
  /** Start times of the requests within the last RPM_WINDOW_MS, oldest first. */
  recent: z.array(instant),
  /** Rests in a row (rate-limit answers, calls left without an answer) since the last answered request. */
  rests_in_row: count,
  /** free_tier: the tier the stop was recorded on; it applies only while settings name the same tier. */
  stop: z.strictObject({ until: instant, reason: z.enum(QUOTA_STOP_REASONS), free_tier: z.boolean() }).nullable(),
});
export type QuotaEntry = z.infer<typeof QuotaEntrySchema>;

export const QuotaFileSchema = z.strictObject({
  schema_version: z.literal(1),
  models: z.record(z.string().min(1), QuotaEntrySchema),
});
export type QuotaFile = z.infer<typeof QuotaFileSchema>;

export type QuotaDecision =
  | { kind: 'go'; requests: number; cap: number | null }
  | { kind: 'wait'; until: Date; reason: 'per_minute' | RestReason }
  | { kind: 'stopped'; until: Date; reason: DailyStopReason; requests: number; cap: number | null };

export interface QuotaStop {
  until: Date;
  reason: QuotaStopReason;
  freeTier: boolean;
}

type StoredStop = NonNullable<QuotaEntry['stop']>;

/** The day's cap: `rpd` minus a safety margin of 1 in 20 (requests failed or made elsewhere count at the provider too). */
export function dailyCap(rpd: number): number {
  return rpd - Math.floor(rpd / 20);
}

const toStop = (s: StoredStop): QuotaStop => ({ until: new Date(s.until), reason: s.reason, freeTier: s.free_tier });
const toStored = (s: QuotaStop): StoredStop => ({ until: s.until.toISOString(), reason: s.reason, free_tier: s.freeTier });

/** The stop that applies on `freeTier`: one recorded on the other tier says nothing about this one's quota. */
const applying = (e: QuotaEntry, freeTier: boolean): StoredStop | null => (e.stop !== null && e.stop.free_tier === freeTier ? e.stop : null);

/**
 * The entry as of `now`: a later quota day starts from zero, requests outside the window and a stop that has ended are
 * dropped. A stored day in the future (the clock went back) keeps its count, which errs on the safe side.
 */
function current(entry: QuotaEntry | undefined, now: Date): QuotaEntry {
  const day = pacificDateKey(now);
  const t = now.getTime();
  if (entry === undefined) return { quota_day: day, requests: 0, recent: [], rests_in_row: 0, stop: null };
  const newDay = day > entry.quota_day;
  const stop = entry.stop !== null && Date.parse(entry.stop.until) > t ? entry.stop : null;
  // A start more than a minute ahead is a clock that went back; it is not a reason to wait.
  const recent = entry.recent.filter((iso) => {
    const at = Date.parse(iso);
    return at > t - RPM_WINDOW_MS && at <= t + MINUTE_MS;
  });
  return {
    quota_day: newDay ? day : entry.quota_day,
    requests: newDay ? 0 : entry.requests,
    recent,
    rests_in_row: newDay ? 0 : entry.rests_in_row,
    stop,
  };
}

/**
 * Whether `now` may start a request on this model, and the entry that results (`changed`: it must be saved). A request
 * that may go is counted right away, before it is sent, so a crash never loses it. Checked in this order, against the
 * limit and tier of this call (settings edited since the last call apply at once):
 * - the server's daily stop recorded on this tier → stopped until it ends;
 * - the day's count at dailyCap(rpd) → stopped until the next Pacific midnight (worked out, not stored);
 * - a rest recorded on this tier → wait until it ends;
 * - rpm requests within RPM_WINDOW_MS → wait until the oldest of them has left it.
 * Without a limit (null) requests are only counted; the server's stops and rests still apply.
 */
export function admit(
  entry: QuotaEntry | undefined,
  limit: RequestLimit | null,
  now: Date,
  freeTier: boolean,
): { decision: QuotaDecision; entry: QuotaEntry; changed: boolean } {
  const e = current(entry, now);
  const cap = limit === null ? null : dailyCap(limit.rpd);
  const stop = applying(e, freeTier);
  if (stop?.reason === 'server_daily') {
    return { decision: { kind: 'stopped', until: new Date(stop.until), reason: 'server_daily', requests: e.requests, cap }, entry: e, changed: false };
  }
  if (cap !== null && e.requests >= cap) {
    return { decision: { kind: 'stopped', until: nextPacificMidnight(now), reason: 'daily_limit', requests: e.requests, cap }, entry: e, changed: false };
  }
  if (stop !== null) return { decision: { kind: 'wait', until: new Date(stop.until), reason: stop.reason as RestReason }, entry: e, changed: false };
  if (limit !== null && e.recent.length >= limit.rpm) {
    const oldest = e.recent[e.recent.length - limit.rpm] as string;
    return { decision: { kind: 'wait', until: new Date(Date.parse(oldest) + RPM_WINDOW_MS), reason: 'per_minute' }, entry: e, changed: false };
  }
  const next = { ...e, requests: e.requests + 1, recent: [...e.recent, now.toISOString()] };
  return { decision: { kind: 'go', requests: next.requests, cap }, entry: next, changed: true };
}

/**
 * Counts one more rest in a row and records the stop `make` returns. The server's daily stop on this tier is kept as
 * it is, and an active rest on this tier is never shortened; no stop outlasts the next Pacific midnight.
 */
function noteRest(e: QuotaEntry, now: Date, freeTier: boolean, make: (inRow: number, reset: Date) => QuotaStop): { entry: QuotaEntry; stop: QuotaStop } {
  const inRow = e.rests_in_row + 1;
  const active = applying(e, freeTier);
  let stop: QuotaStop;
  if (active?.reason === 'server_daily') {
    stop = toStop(active);
  } else {
    const reset = nextPacificMidnight(now);
    const made = make(inRow, reset);
    const until = Math.min(Math.max(made.until.getTime(), active === null ? 0 : Date.parse(active.until)), reset.getTime());
    stop = { ...made, until: new Date(until) };
  }
  return { entry: { ...e, rests_in_row: inRow, stop: toStored(stop) }, stop };
}

const restMs = (inRow: number): number => RATE_LIMIT_COOL_DOWN_MS * 2 ** Math.min(inRow - 1, MAX_DOUBLINGS);

/**
 * Records a rate-limit answer. The server's daily quota stops the model until the next Pacific midnight; otherwise it
 * rests for the longer of the server's retry delay and 1 minute × 2^(rests in a row − 1).
 */
export function noteRateLimited(
  entry: QuotaEntry | undefined,
  now: Date,
  info: { daily: boolean; retryAfterMs?: number | undefined; freeTier: boolean },
): { entry: QuotaEntry; stop: QuotaStop } {
  return noteRest(current(entry, now), now, info.freeTier, (inRow, reset) =>
    info.daily
      ? { until: reset, reason: 'server_daily', freeTier: info.freeTier }
      : { until: new Date(now.getTime() + Math.max(info.retryAfterMs ?? 0, restMs(inRow))), reason: 'rate_limited', freeTier: info.freeTier },
  );
}

/** Records a call whose attempts all ended without an answer (timeouts, 5xx, network): the model rests like after a rate-limit answer. */
export function noteUnavailable(entry: QuotaEntry | undefined, now: Date, freeTier: boolean): { entry: QuotaEntry; stop: QuotaStop } {
  return noteRest(current(entry, now), now, freeTier, (inRow) => ({ until: new Date(now.getTime() + restMs(inRow)), reason: 'unavailable', freeTier }));
}

/** An answered request ends a run of rests. */
export function noteAnswered(entry: QuotaEntry | undefined, now: Date): { entry: QuotaEntry | undefined; changed: boolean } {
  if (entry === undefined || entry.rests_in_row === 0) return { entry, changed: false };
  return { entry: { ...current(entry, now), rests_in_row: 0 }, changed: true };
}

/** The entry's state for status: the day's count (0 once the day is over) and a stop that has not ended, with its tier. */
export function quotaState(entry: QuotaEntry | undefined, now: Date): { requests: number; stop: QuotaStop | null } {
  const e = current(entry, now);
  return { requests: e.requests, stop: e.stop === null ? null : toStop(e.stop) };
}
