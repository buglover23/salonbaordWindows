import { join } from 'node:path';
import { z } from 'zod';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, writeJsonAtomic } from '../storage/atomic-json.js';
import type { DataPaths } from '../storage/paths.js';
import type { SerialQueue } from '../storage/serial-queue.js';
import { issueSummary } from '../storage/store-errors.js';
import { buildDailySlots, dayScheduleHash, type PlanSchedule } from './slots.js';

export const SLOT_STATES = ['open', 'reserved', 'done', 'failed', 'missed', 'skipped'] as const;
export type SlotState = (typeof SLOT_STATES)[number];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const audience = z.enum(AUDIENCE_CATEGORIES).nullable();

const DailySlotSchema = z.strictObject({
  slot_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
  scheduled_at: isoUtc,
  state: z.enum(SLOT_STATES),
  job_id: z.string().min(1).nullable(),
  audience_category: audience,
  reason: z.string().nullable(),
  updated_at: isoUtc,
});
export type DailySlot = z.infer<typeof DailySlotSchema>;

const DailyPlanSchema = z.strictObject({
  schema_version: z.literal(1),
  date: z.string().regex(DATE_KEY),
  config_hash: z.string(),
  /** dayScheduleHash of the schedule the slots were last (re)built for; absent in plans made before Plan 2. */
  schedule_hash: z.string().optional(),
  created_at: isoUtc,
  last_tick_at: isoUtc.nullable(),
  last_audience: z.strictObject({ style: audience, blog: audience }),
  slots: z.array(DailySlotSchema),
});
export type DailyPlan = z.infer<typeof DailyPlanSchema>;

function scheduleFailure(code: 'STATE_CORRUPT' | 'INTERNAL_ERROR', clock: Clock, message: string, details: Record<string, unknown>): AppFailure {
  return new AppFailure(appError(code, 'schedule', clock, { message, details }));
}

/**
 * One JSON file per JST date (`<schedulesDir>/<YYYY-MM-DD>.json`) holding that day's slots and their states (spec 12.3).
 * An existing file is always reused as is, so a restart never adds slots. Writes go through the shared SerialQueue.
 */
export class ScheduleStore {
  readonly #paths: DataPaths;
  readonly #queue: SerialQueue;
  readonly #clock: Clock;

  /** `clock` stamps the errors this store raises (the scheduler's clock, so `dry-run --at` errors carry its time). */
  constructor(paths: DataPaths, queue: SerialQueue, clock: Clock = systemClock) {
    this.#paths = paths;
    this.#queue = queue;
    this.#clock = clock;
  }

  /** The stored plan, or null if there is none for that date. A damaged file → STATE_CORRUPT and the file is left untouched. */
  async load(dateKey: string, clock: Clock = this.#clock): Promise<DailyPlan | null> {
    const path = this.#pathFor(dateKey, clock);
    const result = await readJsonFile(path, DailyPlanSchema);
    if (result.kind === 'missing') return null;
    if (result.kind === 'ok' && result.value.date === dateKey) return result.value;
    const reason = result.kind === 'corrupt' ? result.reason : `日付（${result.value.date}）がファイル名と一致しません`;
    throw scheduleFailure(
      'STATE_CORRUPT',
      clock,
      `日次計画ファイルが壊れているため、投稿を止めています: ${path}（${reason}）。ファイルは変更していません。`,
      { path, reason },
    );
  }

  /**
   * The plan for `dateKey`; if there is none yet, builds every slot of that day from `schedule` and stores it.
   * CONFIG_INVALID from the slot builder propagates and nothing is written.
   */
  loadOrCreate(dateKey: string, schedule: PlanSchedule, configHash: string, clock: Clock): Promise<DailyPlan> {
    return this.#queue.run(async () => {
      const existing = await this.load(dateKey, clock);
      if (existing !== null) return existing;
      const now = clock.now().toISOString();
      const plan: DailyPlan = {
        schema_version: 1,
        date: dateKey,
        config_hash: configHash,
        schedule_hash: dayScheduleHash(dateKey, schedule),
        created_at: now,
        last_tick_at: null,
        last_audience: { style: null, blog: null },
        slots: buildDailySlots(dateKey, schedule).map((s) => ({
          ...s,
          state: 'open',
          job_id: null,
          audience_category: null,
          reason: null,
          updated_at: now,
        })),
      };
      await this.#write(plan);
      return plan;
    });
  }

  /** Replaces the plan file for `plan.date`. A plan that fails the schema is a caller bug: INTERNAL_ERROR, nothing written. */
  save(plan: DailyPlan): Promise<void> {
    return this.#queue.run(() => this.#write(plan));
  }

  async #write(plan: DailyPlan): Promise<void> {
    const parsed = DailyPlanSchema.safeParse(plan);
    if (!parsed.success) {
      throw scheduleFailure('INTERNAL_ERROR', this.#clock, '日次計画の内容が不正なため保存しませんでした', {
        date: plan.date,
        issues: issueSummary(parsed.error),
      });
    }
    await writeJsonAtomic(this.#pathFor(parsed.data.date, this.#clock), parsed.data);
  }

  #pathFor(dateKey: string, clock: Clock): string {
    if (!DATE_KEY.test(dateKey)) {
      throw scheduleFailure('INTERNAL_ERROR', clock, `日次計画の日付が不正です: ${dateKey}`, { date: dateKey });
    }
    return join(this.#paths.schedulesDir, `${dateKey}.json`);
  }
}
