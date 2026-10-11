import { join } from 'node:path';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf, errorText } from '../shared/errors.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, writeJsonAtomic } from './atomic-json.js';
import type { RecoveryHalt } from './bundles.js';
import type { DataPaths } from './paths.js';
import type { SerialQueue } from './serial-queue.js';

// R25: `<modeRoot>/data/runtime-status.json` tells the read-only `status` command, from another window, whether the
// running process has stopped dispatching posts and why. Only the process holding app.lock writes it.

export const HALT_CODES = ['STATE_CORRUPT', 'FILE_IO_ERROR'] as const;
export type HaltCode = (typeof HALT_CODES)[number];

export const RuntimeStatusSchema = z
  .strictObject({
    schema_version: z.literal(1),
    instance_id: z.string().min(1),
    pid: z.number().int().positive(),
    updated_at: isoUtc,
    dispatch_halted: z.boolean(),
    halt_code: z.enum(HALT_CODES).nullable(),
    halted: z.array(z.strictObject({ job_id: z.string().min(1), reason: z.string().min(1) })),
    stopped_at: isoUtc.nullable(),
    /** Plan 2: why the running tool stopped AI work (budget, key, settings); absent in records written before Plan 2. */
    ai_stop: z.strictObject({ code: z.string().min(1), message: z.string(), since: isoUtc }).nullable().optional(),
    /** Plan 3: the paired extension as last seen by the running tool. */
    extension: z
      .strictObject({
        last_seen_at: isoUtc,
        extension_version: z.string(),
        logged_in: z.boolean().nullable(),
        tab_state: z.enum(['none', 'loading', 'ready']),
        fingerprint: z.string(),
      })
      .nullable()
      .default(null),
  })
  .refine((s) => s.dispatch_halted === s.halted.length > 0 && s.dispatch_halted === (s.halt_code !== null), {
    message: 'dispatch_halted・halt_code・halted の内容が一致しません',
  });
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** The single classification of a dispatch halt (R18): only transient file locks → FILE_IO_ERROR, anything else → STATE_CORRUPT. */
export function haltCode(halted: readonly { job_id?: string; reason: string }[]): HaltCode | null {
  if (halted.length === 0) return null;
  return halted.every((h) => h.reason === 'io_error') ? 'FILE_IO_ERROR' : 'STATE_CORRUPT';
}

export function runtimeStatusPath(paths: DataPaths): string {
  return join(paths.modeRoot, 'data', 'runtime-status.json');
}

export type AiStopRecord = NonNullable<RuntimeStatus['ai_stop']>;
export type ExtensionRecord = NonNullable<RuntimeStatus['extension']>;

export class RuntimeStatusWriter {
  readonly #o: { paths: DataPaths; queue: SerialQueue; instanceId: string; clock: Clock; logger: AppLogger };
  #current: RuntimeStatus | null = null;
  #aiStop: AiStopRecord | null = null;
  #extension: ExtensionRecord | null = null;

  constructor(o: { paths: DataPaths; queue: SerialQueue; instanceId: string; clock: Clock; logger: AppLogger }) {
    this.#o = o;
  }

  /** The latest record handed to write() (set before the file is written, so it is there even if the write fails). */
  get current(): RuntimeStatus | null {
    return this.#current === null ? null : structuredClone(this.#current);
  }

  /**
   * Records why AI work is stopped (null: it is not) and rewrites the record when that changed and a record exists
   * (the halt list is kept). Never throws.
   */
  async setAiStop(stop: AiStopRecord | null): Promise<void> {
    const same = JSON.stringify(stop) === JSON.stringify(this.#aiStop);
    this.#aiStop = stop === null ? null : { ...stop };
    const current = this.#current;
    if (same || current === null || current.stopped_at !== null) return;
    await this.write(current.halted.map((h) => ({ job_id: h.job_id, reason: h.reason as RecoveryHalt['reason'] })), false);
  }

  /**
   * Plan 3: the paired extension as last seen (null: not connected). The coordinator calls it on connect, disconnect and
   * login-state change, and at most every 5 minutes otherwise. Rewrites the record while one exists. Never throws.
   */
  async setExtension(ext: ExtensionRecord | null): Promise<void> {
    this.#extension = ext === null ? null : { ...ext };
    const current = this.#current;
    if (current === null || current.stopped_at !== null) return;
    await this.write(current.halted.map((h) => ({ job_id: h.job_id, reason: h.reason as RecoveryHalt['reason'] })), false);
  }

  /** Saves the dispatch state atomically; `stopped` marks the end of this process's run. Never throws: a failure is logged. */
  async write(halted: readonly RecoveryHalt[], stopped: boolean): Promise<void> {
    const { paths, queue, instanceId, clock, logger } = this.#o;
    const now = clock.now().toISOString();
    const record: RuntimeStatus = {
      schema_version: 1,
      instance_id: instanceId,
      pid: process.pid,
      updated_at: now,
      dispatch_halted: halted.length > 0,
      halt_code: haltCode(halted),
      halted: halted.map((h) => ({ job_id: h.job_id, reason: h.reason })),
      stopped_at: stopped ? now : null,
      ai_stop: stopped ? null : this.#aiStop,
      extension: stopped ? null : this.#extension,
    };
    this.#current = record;
    try {
      await queue.run(() => writeJsonAtomic(runtimeStatusPath(paths), RuntimeStatusSchema.parse(record)));
    } catch (err) {
      logger.error('RUNTIME_STATUS_NOT_SAVED', `稼働状態の記録（runtime-status.json）を保存できませんでした: ${errorText(err)}`, {
        error_code: errorCodeOf(err),
      });
    }
  }
}

export type RuntimeStatusRead =
  | { kind: 'ok'; value: RuntimeStatus }
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unreadable'; reason: string };

/** Reads the record without ever writing or creating anything; never throws. */
export async function readRuntimeStatus(paths: DataPaths): Promise<RuntimeStatusRead> {
  try {
    return await readJsonFile(runtimeStatusPath(paths), RuntimeStatusSchema);
  } catch (err) {
    return { kind: 'unreadable', reason: errorText(err) };
  }
}
