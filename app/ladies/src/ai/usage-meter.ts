import { join } from 'node:path';
import { z } from 'zod';
import type { ModelPricing, Settings } from '../config/schemas.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { nextPacificMidnight, pacificDateKey } from '../shared/pacific-time.js';
import { jstDateKey } from '../shared/time.js';
import { readJsonFile, writeJsonAtomic } from '../storage/atomic-json.js';
import type { SerialQueue } from '../storage/serial-queue.js';
import { internalFailure, stateCorrupt, type StoreOptions } from '../storage/store-errors.js';
import type { AiUsage } from './provider.js';
import {
  QuotaFileSchema,
  admit,
  noteAnswered,
  noteRateLimited,
  noteUnavailable,
  quotaState,
  type QuotaDecision,
  type QuotaEntry,
  type QuotaFile,
  type QuotaStop,
  type RequestLimit,
} from './request-quota.js';

/** Per-model request counts and stops (Gemini free tier), next to the monthly files. */
export const REQUEST_QUOTA_FILE = 'request-quota.json';

export interface QuotaSummary {
  /** The quota day (Pacific calendar date) the counts belong to. */
  quota_day: string;
  /** When that day's counts reset (00:00 Pacific). */
  reset_at: Date;
  /** Every model with a record, by name; a stop applies only on the tier it was recorded on (stop.freeTier). */
  models: { model: string; requests: number; stop: QuotaStop | null }[];
}

const count = z.number().int().nonnegative();

const DayUsageSchema = z.strictObject({
  requests: count,
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  est_usd: z.number().nonnegative(),
});
export type DayUsage = z.infer<typeof DayUsageSchema>;

const MonthFileSchema = z.strictObject({
  schema_version: z.literal(1),
  /** JST calendar days of this file's month. */
  days: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), DayUsageSchema),
});
type MonthFile = z.infer<typeof MonthFileSchema>;

/** Tokens of one model inside a single request (a refusal fallback bills each model that ran at its own rates). */
export interface MeteredUsage {
  model: string;
  usage: AiUsage;
}

export type BudgetReason = 'monthly_usd' | 'daily_usd' | 'daily_requests';

export interface UsageSummary {
  /** JST date and month the figures belong to. */
  date: string;
  month: string;
  today: DayUsage;
  month_total: DayUsage;
  limits: { daily_request_limit: number; daily_usd: number; monthly_usd: number };
  /** Why the next AI call would be refused, or null. */
  blocked: { reason: BudgetReason; message: string } | null;
}

export interface UsageMeterOptions {
  /** data/ai-usage (shared by both modes: the spend is real money either way). */
  dir: string;
  /** The shared write queue (spec 11.4-1). */
  queue: SerialQueue;
  /** Read on every check, so a raised budget applies without a restart. */
  getSettings: () => Settings;
  clock?: Clock;
  store?: StoreOptions;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
/** A model the price list does not name is estimated at this many times the list's highest rates (fail closed). */
export const UNPRICED_MODEL_MULTIPLIER = 2;
const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

const zeroDay = (): DayUsage => ({ requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, est_usd: 0 });
// Micro-dollar precision keeps sums of many small requests free of float noise in the file.
const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;
const usdText = (usd: number): string => (usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));

/** USD per million tokens, by model id. */
export type PriceList = Settings['ai']['anthropic']['pricing'];

/** A provider that charges per token (the mock never records). */
export type MeteredProvider = 'anthropic' | 'gemini';

/**
 * The price list of the provider that made the request (not of ai.provider, which can be edited while a provider is
 * running); null when it does not charge (the Gemini free tier).
 */
export function providerPricing(ai: Settings['ai'], provider: MeteredProvider): PriceList | null {
  if (provider === 'gemini') return ai.gemini.free_tier ? null : ai.gemini.pricing;
  return ai.anthropic.pricing;
}

/**
 * Field by field, the highest rates in the price list times UNPRICED_MODEL_MULTIPLIER (used for a model the list does not
 * name).
 */
function highestRates(pricing: PriceList): ModelPricing | undefined {
  const entries = Object.values(pricing);
  if (entries.length === 0) return undefined;
  return {
    input_per_mtok: Math.max(...entries.map((p) => p.input_per_mtok)) * UNPRICED_MODEL_MULTIPLIER,
    output_per_mtok: Math.max(...entries.map((p) => p.output_per_mtok)) * UNPRICED_MODEL_MULTIPLIER,
    cache_read_per_mtok: Math.max(...entries.map((p) => p.cache_read_per_mtok)) * UNPRICED_MODEL_MULTIPLIER,
    verified_at: '',
  };
}

/**
 * Estimated USD of `usage` on `model`: per-MTok rates from the provider's price list, cache writes at 1.25 × input. A
 * model the list does not name (e.g. a refusal-fallback model added after the list was written) is priced at twice the
 * list's highest rates, so the estimate errs high. An empty list estimates 0; the providers never call a model without a
 * price (or, free tier, a limit).
 */
export function estimateUsd(pricing: PriceList, model: string, usage: AiUsage): number {
  const p = Object.hasOwn(pricing, model) ? pricing[model] : highestRates(pricing);
  if (p === undefined) return 0;
  return (
    (usage.input_tokens * p.input_per_mtok +
      usage.output_tokens * p.output_per_mtok +
      usage.cache_read_input_tokens * p.cache_read_per_mtok +
      usage.cache_creation_input_tokens * p.input_per_mtok * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

function sumDays(days: Iterable<DayUsage>): DayUsage {
  const total = zeroDay();
  for (const d of days) {
    total.requests += d.requests;
    for (const k of TOKENS) total[k] += d[k];
    total.est_usd += d.est_usd;
  }
  total.est_usd = roundUsd(total.est_usd);
  return total;
}

/**
 * data/ai-usage/YYYY-MM.json (JST months and days): every AI request, failed ones included, and its tokens and estimated
 * USD (Plan 2 decision 3); and data/ai-usage/request-quota.json: per-model request counts of the quota day and the
 * stops that follow from them (request-quota.ts). Writes go through the shared SerialQueue. Files are read on first use
 * and then kept in memory; this process is the only writer (app lock).
 */
export class UsageMeter {
  readonly #o: UsageMeterOptions;
  readonly #clock: Clock;
  readonly #months = new Map<string, MonthFile>();
  #quotaFile: QuotaFile | undefined;

  private constructor(o: UsageMeterOptions) {
    this.#o = o;
    this.#clock = o.clock ?? systemClock;
  }

  /** Reads the current month and the quota file right away, so a damaged record stops the start (STATE_CORRUPT) instead of the first AI call. */
  static async load(o: UsageMeterOptions): Promise<UsageMeter> {
    const meter = new UsageMeter(o);
    const now = meter.#clock.now();
    await o.queue.run(async () => {
      await meter.#month(jstDateKey(now).slice(0, 7));
      await meter.#quota();
    });
    return meter;
  }

  /**
   * Whether a request to `model` may start now under `limit` (null = count only) on the tier `freeTier`; a request that
   * may go is counted and saved before it is sent. The caller waits ('wait') or stops ('stopped') as told.
   */
  reserveRequest(model: string, limit: RequestLimit | null, now: Date, freeTier: boolean): Promise<QuotaDecision> {
    return this.#o.queue.run(async () => {
      const file = await this.#quota();
      const r = admit(file.models[model], limit, now, freeTier);
      if (r.changed) await this.#saveQuota(model, r.entry);
      return r.decision;
    });
  }

  /** Records a rate-limit answer from the provider for `model` and returns the stop that now applies to it. */
  recordRateLimit(model: string, now: Date, info: { daily: boolean; retryAfterMs?: number | undefined; freeTier: boolean }): Promise<QuotaStop> {
    return this.#o.queue.run(async () => {
      const file = await this.#quota();
      const r = noteRateLimited(file.models[model], now, info);
      await this.#saveQuota(model, r.entry);
      return r.stop;
    });
  }

  /** Records a call to `model` whose attempts all ended without an answer and returns the rest that now applies to it. */
  recordUnavailable(model: string, now: Date, freeTier: boolean): Promise<QuotaStop> {
    return this.#o.queue.run(async () => {
      const file = await this.#quota();
      const r = noteUnavailable(file.models[model], now, freeTier);
      await this.#saveQuota(model, r.entry);
      return r.stop;
    });
  }

  /** An answered request from `model`: ends its run of rests (written only when there was one). */
  clearRateLimit(model: string, now: Date): Promise<void> {
    return this.#o.queue.run(async () => {
      const file = await this.#quota();
      const r = noteAnswered(file.models[model], now);
      if (r.changed && r.entry !== undefined) await this.#saveQuota(model, r.entry);
    });
  }

  /** The quota day, its reset and each recorded model's count and stop (for status). */
  quotaSummary(now: Date): Promise<QuotaSummary> {
    return this.#o.queue.run(async () => {
      const file = await this.#quota();
      const models = Object.keys(file.models)
        .sort()
        .map((model) => ({ model, ...quotaState(file.models[model], now) }));
      return { quota_day: pacificDateKey(now), reset_at: nextPacificMidnight(now), models };
    });
  }

  /** AI_BUDGET_EXCEEDED (not retryable) when the month's or today's estimate or today's request count has reached its limit. */
  assertCanCall(now: Date): Promise<void> {
    return this.#o.queue.run(async () => {
      const blocked = this.#blocked(await this.#figures(now));
      if (blocked === null) return;
      throw new AppFailure(appError('AI_BUDGET_EXCEEDED', 'ai', this.#clock, { message: blocked.message, retryable: false, details: blocked.details }));
    });
  }

  /**
   * Counts one request of `provider` on the JST day of `now`: `usage` priced at `model`, plus `extra` hops priced at
   * their own models, from that provider's price list. The in-memory figures change before the write, so even when
   * saving fails (FILE_IO_ERROR / DISK_FULL) the spend still counts for this process.
   */
  record(now: Date, model: string, usage: AiUsage, extra: readonly MeteredUsage[], provider: MeteredProvider): Promise<void> {
    return this.#record(now, model, usage, extra, () => providerPricing(this.#o.getSettings().ai, provider));
  }

  /**
   * Like record(), priced with `pricing` (a stage's own list, e.g. from .env); null = no charge known, so only the
   * request and its tokens count (the daily request limit still applies). `feeUsd`: charges beyond the tokens (web search calls).
   */
  recordPriced(now: Date, model: string, usage: AiUsage, extra: readonly MeteredUsage[], pricing: PriceList | null, feeUsd = 0): Promise<void> {
    return this.#record(now, model, usage, extra, () => pricing, feeUsd);
  }

  #record(now: Date, model: string, usage: AiUsage, extra: readonly MeteredUsage[], pricingNow: () => PriceList | null, feeUsd = 0): Promise<void> {
    return this.#o.queue.run(async () => {
      const parts: MeteredUsage[] = [{ model, usage }, ...extra];
      for (const part of parts) {
        if (!TOKENS.every((k) => Number.isSafeInteger(part.usage[k]) && part.usage[k] >= 0)) {
          throw internalFailure(this.#clock, 'AIの使用量に不正な値が渡されたため記録しませんでした', { model: part.model });
        }
      }
      const date = jstDateKey(now);
      const monthKey = date.slice(0, 7);
      const month = await this.#month(monthKey);
      const day = { ...(month.days[date] ?? zeroDay()) };
      day.requests += 1;
      const pricing = pricingNow();
      let usd = day.est_usd + feeUsd;
      for (const part of parts) {
        for (const k of TOKENS) day[k] += part.usage[k];
        if (pricing !== null) usd += estimateUsd(pricing, part.model, part.usage);
      }
      day.est_usd = roundUsd(usd);
      const days = Object.fromEntries(Object.entries({ ...month.days, [date]: day }).sort(([a], [b]) => (a < b ? -1 : 1)));
      const next: MonthFile = { schema_version: 1, days };
      this.#months.set(monthKey, next);
      await writeJsonAtomic(this.#path(monthKey), next, this.#o.store?.fs, this.#o.store?.retry);
    });
  }

  /** Today's and this month's figures with the limits, and why a call would be refused now (for status). */
  summary(now: Date): Promise<UsageSummary> {
    return this.#o.queue.run(async () => {
      const f = await this.#figures(now);
      const blocked = this.#blocked(f);
      const ai = this.#o.getSettings().ai;
      return {
        date: f.date,
        month: f.month,
        today: f.today,
        month_total: f.monthTotal,
        limits: { daily_request_limit: ai.daily_request_limit, daily_usd: ai.budget.daily_usd, monthly_usd: ai.budget.monthly_usd },
        blocked: blocked === null ? null : { reason: blocked.details.reason, message: blocked.message },
      };
    });
  }

  async #figures(now: Date): Promise<{ date: string; month: string; today: DayUsage; monthTotal: DayUsage }> {
    const date = jstDateKey(now);
    const month = date.slice(0, 7);
    const file = await this.#month(month);
    return { date, month, today: { ...(file.days[date] ?? zeroDay()) }, monthTotal: sumDays(Object.values(file.days)) };
  }

  // The month comes first: waiting for tomorrow does not help when the month's budget is spent.
  #blocked(f: { date: string; month: string; today: DayUsage; monthTotal: DayUsage }): {
    message: string;
    details: { reason: BudgetReason } & Record<string, unknown>;
  } | null {
    const ai = this.#o.getSettings().ai;
    const { daily_usd, monthly_usd } = ai.budget;
    if (f.monthTotal.est_usd >= monthly_usd) {
      return {
        message: `今月（${f.month}）のAI利用額の見積もり（${usdText(f.monthTotal.est_usd)}ドル）が1か月の予算（${usdText(monthly_usd)}ドル）に達したため、AIの処理を止めています。来月（日本時間）になるか、settings.json の ai.budget.monthly_usd を増やすと再開します。`,
        details: { reason: 'monthly_usd', month: f.month, est_usd: f.monthTotal.est_usd, limit: monthly_usd },
      };
    }
    if (f.today.est_usd >= daily_usd) {
      return {
        message: `本日（${f.date}）のAI利用額の見積もり（${usdText(f.today.est_usd)}ドル）が1日の予算（${usdText(daily_usd)}ドル）に達したため、AIの処理を止めています。明日（日本時間0時）になるか、settings.json の ai.budget.daily_usd を増やすと再開します。`,
        details: { reason: 'daily_usd', date: f.date, est_usd: f.today.est_usd, limit: daily_usd },
      };
    }
    if (f.today.requests >= ai.daily_request_limit) {
      return {
        message: `本日（${f.date}）のAIの利用回数が上限（${ai.daily_request_limit}回）に達したため、AIの処理を止めています。明日（日本時間0時）になるか、settings.json の ai.daily_request_limit を増やすと再開します。`,
        details: { reason: 'daily_requests', date: f.date, requests: f.today.requests, limit: ai.daily_request_limit },
      };
    }
    return null;
  }

  #path(month: string): string {
    return join(this.#o.dir, `${month}.json`);
  }

  async #quota(): Promise<QuotaFile> {
    if (this.#quotaFile !== undefined) return this.#quotaFile;
    const path = join(this.#o.dir, REQUEST_QUOTA_FILE);
    const result = await readJsonFile(path, QuotaFileSchema, this.#o.store?.fs, this.#o.store?.retry);
    if (result.kind === 'corrupt') throw stateCorrupt(this.#clock, 'AIの回数制限の記録', path, result.reason);
    this.#quotaFile = result.kind === 'ok' ? result.value : { schema_version: 1, models: {} };
    return this.#quotaFile;
  }

  // In memory first, like record(): a failed write still leaves the count in force for this process.
  async #saveQuota(model: string, entry: QuotaEntry): Promise<void> {
    const file = await this.#quota();
    const models = Object.fromEntries(Object.entries({ ...file.models, [model]: entry }).sort(([a], [b]) => (a < b ? -1 : 1)));
    this.#quotaFile = { schema_version: 1, models };
    await writeJsonAtomic(join(this.#o.dir, REQUEST_QUOTA_FILE), this.#quotaFile, this.#o.store?.fs, this.#o.store?.retry);
  }

  async #month(month: string): Promise<MonthFile> {
    const cached = this.#months.get(month);
    if (cached !== undefined) return cached;
    const path = this.#path(month);
    const result = await readJsonFile(path, MonthFileSchema, this.#o.store?.fs, this.#o.store?.retry);
    if (result.kind === 'corrupt') throw stateCorrupt(this.#clock, 'AI利用量の記録', path, result.reason);
    let file: MonthFile = { schema_version: 1, days: {} };
    if (result.kind === 'ok') {
      const stray = Object.keys(result.value.days).find((d) => !d.startsWith(`${month}-`));
      if (stray !== undefined) throw stateCorrupt(this.#clock, 'AI利用量の記録', path, `${month} 以外の日付（${stray}）が含まれています`);
      file = result.value;
    }
    this.#months.set(month, file);
    return file;
  }
}
