import { z } from 'zod';
import { systemClock, type Clock } from '../shared/clock.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type PostType } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';
import type { SerialQueue } from './serial-queue.js';
import { internalFailure, issueSummary, stateCorrupt, type StoreOptions } from './store-errors.js';

/** Spec 16.5: a small record per posted job. No body text, images or authenticated URLs are ever stored here. */
export const DedupeRecordSchema = z.strictObject({
  job_id: z.string().min(1),
  salon_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
  audience_category: z.enum(AUDIENCE_CATEGORIES),
  status: z.literal('POSTED'),
  posted_at: isoUtc,
  verified_at: isoUtc,
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title_hash: z.string().min(1).nullable(),
  body_hash: z.string().min(1).nullable(),
  remote_post_id: z.string().nullable(),
  cleaned_at: isoUtc.nullable(),
});
export type DedupeRecord = z.infer<typeof DedupeRecordSchema>;

const DedupeFileSchema = z
  .strictObject({
    schema_version: z.literal(1),
    records: z.array(DedupeRecordSchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.records.forEach((r, i) => {
      if (seen.has(r.job_id)) ctx.addIssue({ code: 'custom', path: ['records', i, 'job_id'], message: `job_id「${r.job_id}」が重複しています` });
      seen.add(r.job_id);
    });
  });

const imageKey = (post_type: PostType, sha256: string): string => `${post_type}:${sha256}`;

function isClock(value: Clock | StoreOptions | undefined): value is Clock {
  return typeof (value as Partial<Clock> | undefined)?.now === 'function';
}

/**
 * data/dedupe.json: one record per posted job (replaced by job_id), plus in-memory sets for the exact-match checks.
 * The whole file is rewritten atomically through the shared SerialQueue; memory changes only after the write succeeded.
 */
export class DedupeStore {
  readonly #path: string;
  readonly #queue: SerialQueue;
  readonly #clock: Clock;
  readonly #opts: StoreOptions;
  #records = new Map<string, DedupeRecord>();
  #images = new Set<string>();
  #titleHashes = new Set<string>();
  #bodyHashes = new Set<string>();

  private constructor(path: string, queue: SerialQueue, clock: Clock, opts: StoreOptions) {
    this.#path = path;
    this.#queue = queue;
    this.#clock = clock;
    this.#opts = opts;
  }

  /**
   * A missing file starts empty (and is not created until the first upsert); a damaged one → STATE_CORRUPT, untouched.
   * `clock` (default systemClock) only stamps the errors; `load(paths, queue, opts)` without a clock still works.
   */
  static async load(paths: DataPaths, queue: SerialQueue, opts?: StoreOptions): Promise<DedupeStore>;
  static async load(paths: DataPaths, queue: SerialQueue, clock?: Clock, opts?: StoreOptions): Promise<DedupeStore>;
  static async load(paths: DataPaths, queue: SerialQueue, clockOrOpts?: Clock | StoreOptions, maybeOpts: StoreOptions = {}): Promise<DedupeStore> {
    const clock = isClock(clockOrOpts) ? clockOrOpts : systemClock;
    const opts = isClock(clockOrOpts) || clockOrOpts === undefined ? maybeOpts : clockOrOpts;
    const store = new DedupeStore(paths.dedupeFile, queue, clock, opts);
    const result = await readJsonFile(paths.dedupeFile, DedupeFileSchema, opts.fs, opts.retry);
    if (result.kind === 'corrupt') throw stateCorrupt(clock, 'dedupe.json', paths.dedupeFile, result.reason);
    if (result.kind === 'ok') store.#adopt(new Map(result.value.records.map((r) => [r.job_id, r])));
    return store;
  }

  /** Inserts the record, or replaces the one with the same job_id (position kept). */
  upsert(record: DedupeRecord): Promise<void> {
    return this.#queue.run(async () => {
      const parsed = DedupeRecordSchema.safeParse(record);
      if (!parsed.success) {
        throw internalFailure(this.#clock, '重複防止記録の内容が不正なため保存しませんでした', {
          job_id: typeof record?.job_id === 'string' ? record.job_id : null,
          issues: issueSummary(parsed.error),
        });
      }
      const next = new Map(this.#records);
      next.set(parsed.data.job_id, parsed.data);
      await writeJsonAtomic(this.#path, { schema_version: 1, records: [...next.values()] }, this.#opts.fs, this.#opts.retry);
      this.#adopt(next);
    });
  }

  get(jobId: string): DedupeRecord | undefined {
    const record = this.#records.get(jobId);
    return record === undefined ? undefined : { ...record };
  }

  /** Copies of every record, in file order (the history cache takes the hashes of posts whose job is gone). */
  records(): DedupeRecord[] {
    return [...this.#records.values()].map((r) => ({ ...r }));
  }

  /** Same post type and same image bytes (SHA-256), regardless of audience. */
  hasImage(post_type: PostType, sha256: string): boolean {
    return this.#images.has(imageKey(post_type, sha256));
  }

  /**
   * The first record (file order) with this post type and image hash, so a duplicate can name the job it duplicates.
   * With `salon_id`, only that salon's records count (spec 6.1: the intake key is hash, post type and salon).
   */
  findByImage(post_type: PostType, sha256: string, salon_id?: string): DedupeRecord | undefined {
    if (!this.hasImage(post_type, sha256)) return undefined;
    for (const r of this.#records.values()) {
      if (r.post_type === post_type && r.image_sha256 === sha256 && (salon_id === undefined || r.salon_id === salon_id)) return { ...r };
    }
    return undefined;
  }

  hasTitleHash(h: string): boolean {
    return this.#titleHashes.has(h);
  }

  hasBodyHash(h: string): boolean {
    return this.#bodyHashes.has(h);
  }

  /** Replaces the records and rebuilds the lookup sets from them, so a replaced record leaves no stale hash behind. */
  #adopt(records: Map<string, DedupeRecord>): void {
    const images = new Set<string>();
    const titleHashes = new Set<string>();
    const bodyHashes = new Set<string>();
    for (const r of records.values()) {
      images.add(imageKey(r.post_type, r.image_sha256));
      if (r.title_hash !== null) titleHashes.add(r.title_hash);
      if (r.body_hash !== null) bodyHashes.add(r.body_hash);
    }
    this.#records = records;
    this.#images = images;
    this.#titleHashes = titleHashes;
    this.#bodyHashes = bodyHashes;
  }
}
