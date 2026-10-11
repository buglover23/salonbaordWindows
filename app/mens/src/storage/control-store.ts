import { z } from 'zod';
import type { Clock } from '../shared/clock.js';
import { ERROR_CODES } from '../shared/errors.js';
import { PreflightResultSchema } from '../shared/protocol/results.js';
import { ROUTE_KEYS } from '../shared/protocol/version.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';
import type { SerialQueue } from './serial-queue.js';
import { internalFailure, issueSummary, stateCorrupt, type StoreOptions } from './store-errors.js';

/** The extension paired with this tool (Plan 3 D1-1); its key is derived from .env, never stored. */
export const PairedClientSchema = z.strictObject({ client_id: z.string(), extension_id: z.string(), paired_at: isoUtc, fingerprint: z.string() });
export type PairedClient = z.infer<typeof PairedClientSchema>;
const PairingFileSchema = z.strictObject({ schema_version: z.literal(1), paired_client: PairedClientSchema.nullable() });
/** A stop of new posting (salon, post type or route) until it is cleared (Plan 3; P1-R25: kept here, not in runtime-status). */
export const StopSchema = z.strictObject({
  id: z.string().min(1),
  scope: z.enum(['salon', 'type', 'route']),
  post_type: z.enum(POST_TYPES).nullable(),
  audience_category: z.enum(AUDIENCE_CATEGORIES).nullable(),
  code: z.enum(ERROR_CODES),
  /** A fixed token, e.g. 'unrecorded_send_suspected'. */
  detail: z.string().nullable(),
  message: z.string(),
  remedy: z.string(),
  job_id: z.string().nullable(),
  raised_at: isoUtc,
  route_config_hash: z.string().nullable(),
  period: z.enum(['daily', 'monthly', 'total', 'unknown']).nullable(),
  /** 'YYYY-MM-DD' or 'YYYY-MM' (JST) after which the stop clears by itself; null = cleared by the operator. */
  period_key: z.string().nullable(),
});
export type Stop = z.infer<typeof StopSchema>;

const routeKey = z.enum(ROUTE_KEYS);

export const ControlStateSchema = z.strictObject({
  schema_version: z.literal(1),
  paused: z.boolean(),
  pause_reason: z.string().nullable(),
  last_submit_at: isoUtc.nullable(),
  updated_at: isoUtc,
  // Plan 3 (live poster). Defaults keep files written before Plan 3 valid.
  stops: z.array(StopSchema).default([]),
  /** The one job the owner armed for the first live post of a route (P3-R4). */
  live_single: z
    // now: live:single --now pulls the next slot of the route's type forward to the next scheduler tick.
    .strictObject({ route_key: routeKey, job_id: z.string(), content_hash: z.string(), image_sha256: z.string(), armed_at: isoUtc, now: z.boolean().optional() })
    .nullable()
    .default(null),
  /** The first live post per route, bound to the profile it was verified with (P3-R47). */
  first_posts: z
    .record(routeKey, z.strictObject({ profile_hash: z.string(), job_id: z.string(), posted_at: isoUtc }).nullable())
    .default({ 'style.mens': null, 'style.ladies': null, 'blog.mens': null, 'blog.ladies': null }),
  pending_preflight: z
    .strictObject({
      preflight_id: z.string(),
      route_keys: z.array(routeKey),
      requested_at: isoUtc,
      purpose: z.enum(['resume', 'owner']),
      command_id: z.string().nullable(),
      result: PreflightResultSchema.nullable(),
    })
    .nullable()
    .default(null),
  /** The current extension client (no secret: the key is derived from the master secret, D1). data/pairing.json (shared
   * by both modes) is the record; the copy in control.json counts only while no pairing.json exists (older files). */
  paired_client: PairedClientSchema.nullable().default(null),
  probe: z.strictObject({ armed_at: isoUtc, expires_at: isoUtc }).nullable().default(null),
});
export type ControlState = z.infer<typeof ControlStateSchema>;

/**
 * data/control.json: the operator's pause switch, the time of the last submission and the live poster's control state.
 * A missing file means the defaults and is not created until the first change. Writes go through the shared SerialQueue,
 * and the in-memory state changes only after the write succeeded.
 */
export class ControlStore {
  readonly #path: string;
  readonly #pairingPath: string;
  readonly #queue: SerialQueue;
  readonly #clock: Clock;
  readonly #opts: StoreOptions;
  #state: ControlState;

  private constructor(paths: DataPaths, queue: SerialQueue, clock: Clock, opts: StoreOptions, state: ControlState) {
    this.#path = paths.controlFile;
    this.#pairingPath = paths.pairingFile;
    this.#queue = queue;
    this.#clock = clock;
    this.#opts = opts;
    this.#state = state;
  }

  /** A damaged file → STATE_CORRUPT and the file is left as it is. */
  static async load(paths: DataPaths, queue: SerialQueue, clock: Clock, opts: StoreOptions = {}): Promise<ControlStore> {
    const result = await readJsonFile(paths.controlFile, ControlStateSchema, opts.fs, opts.retry);
    if (result.kind === 'corrupt') throw stateCorrupt(clock, 'control.json', paths.controlFile, result.reason);
    const state: ControlState =
      result.kind === 'ok'
        ? result.value
        : ControlStateSchema.parse({ schema_version: 1, paused: false, pause_reason: null, last_submit_at: null, updated_at: clock.now().toISOString() });
    const pairing = await readJsonFile(paths.pairingFile, PairingFileSchema, opts.fs, opts.retry);
    if (pairing.kind === 'corrupt') throw stateCorrupt(clock, 'pairing.json', paths.pairingFile, pairing.reason);
    const paired = pairing.kind === 'ok' ? pairing.value.paired_client : state.paired_client;
    return new ControlStore(paths, queue, clock, opts, { ...state, paired_client: paired });
  }

  get(): ControlState {
    return structuredClone(this.#state);
  }

  /**
   * A non-empty reason pauses (and replaces any earlier reason); null resumes. An empty or whitespace-only reason is a
   * caller bug (INTERNAL_ERROR, nothing written). Setting what is already set writes nothing.
   */
  setPaused(reason: string | null): Promise<void> {
    return this.update((s) => {
      if (reason !== null && reason.trim() === '') {
        throw internalFailure(this.#clock, '一時停止の理由が空です（再開するときは null を渡してください）');
      }
      const paused = reason !== null;
      return s.paused === paused && s.pause_reason === reason ? null : { paused, pause_reason: reason };
    });
  }

  /** Stores the time of the latest submission exactly as given. */
  recordSubmit(at: Date): Promise<void> {
    return this.update(() => {
      if (Number.isNaN(at.getTime())) {
        throw internalFailure(this.#clock, '最終送信時刻に不正な日時が渡されました');
      }
      return { last_submit_at: at.toISOString() };
    });
  }

  /** Replaces (null: forgets) the paired extension; the previous one is revoked by that alone (STALE_CLIENT). */
  setPairedClient(client: PairedClient | null): Promise<void> {
    return this.#queue.run(async () => {
      const paired_client = client === null ? null : PairedClientSchema.parse(client);
      await writeJsonAtomic(this.#pairingPath, { schema_version: 1, paired_client }, this.#opts.fs, this.#opts.retry);
      this.#state = { ...this.#state, paired_client };
    });
  }

  /**
   * `compute` sees a copy of the current state inside the queue and returns the fields to change (null: no change).
   * The result must pass ControlStateSchema, else INTERNAL_ERROR and nothing is written.
   */
  update(compute: (current: ControlState) => Partial<ControlState> | null): Promise<void> {
    return this.#queue.run(async () => {
      const patch = compute(structuredClone(this.#state));
      if (patch === null) return;
      if ('paired_client' in patch) throw internalFailure(this.#clock, '拡張機能の接続は setPairedClient で保存します');
      const parsed = ControlStateSchema.safeParse({ ...this.#state, ...patch, updated_at: this.#clock.now().toISOString() });
      if (!parsed.success) {
        throw internalFailure(this.#clock, '制御状態の内容が不正なため保存しませんでした', { issues: issueSummary(parsed.error) });
      }
      await writeJsonAtomic(this.#path, parsed.data, this.#opts.fs, this.#opts.retry);
      this.#state = parsed.data;
    });
  }
}
