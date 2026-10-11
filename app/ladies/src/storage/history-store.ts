import { z } from 'zod';
import { ctaSentence, postSentences, type RecentDraftPattern, type RecentPatternQuery, type RecentPatternsSource } from '../ai/context.js';
import { DraftMetaSchema, DraftSchema, primaryTextOf, type Draft } from '../ai/draft-schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf, errorText } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { comparisonHash } from '../shared/hash.js';
import { AUDIENCE_CATEGORIES, MODES, POST_TYPES, type AudienceCategory, type JobStatus, type Mode, type PostType } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, renameWithRetry, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';
import type { SerialQueue } from './serial-queue.js';
import { internalFailure, issueSummary, stateCorrupt, type StoreOptions } from './store-errors.js';

// data/history.json (spec 16.5, Plan 2 decision 12): the full title and text of the last HISTORY_MAX_ENTRIES posted jobs
// for near-duplicate and variety checks, plus only the hashes of older ones for exact-duplicate checks (unless
// dedupe.json, the long-term record, already holds them). A full text also becomes hash-only once its retention period
// is over (fullTextDays) or its job is cleaned up (forgetText). A cache: it can be rebuilt from the POSTED jobs (and
// dedupe.json for the hashes). Each mode has its own file under its data root. A damaged file moved aside
// (history.json.corrupt-<time>) still holds full texts: the Plan 4 cleanup deletes it after the retention period.

/** Spec 16.5: full texts of at most this many posts are kept. */
export const HISTORY_MAX_ENTRIES = 100;

const DAY_MS = 24 * 3_600_000;

/**
 * The full-text period of history.json from settings.retention (spec 16.5): posted_data_days while retention is enabled,
 * otherwise null (only the HISTORY_MAX_ENTRIES cap applies, as nothing else is cleaned up automatically either).
 */
export function historyFullTextDays(retention: { enabled: boolean; posted_data_days: number }): number | null {
  return retention.enabled ? retention.posted_data_days : null;
}

const hash = z.string().regex(/^[0-9a-f]{64}$/);

/** Hash of a title or primary text (as dedupe.json): SHA-256 of the spec 10.3 comparison text. */
export const historyTextHash = comparisonHash;

export const HistoryEntrySchema = z.strictObject({
  job_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
  audience_category: z.enum(AUDIENCE_CATEGORIES),
  title: z.string(),
  /** The stylist comment / body without the hashtags. */
  primary_text: z.string(),
  /** Style posts only. */
  menu_text: z.string().optional(),
  hashtags: z.array(z.string()),
  meta: DraftMetaSchema,
  /** First sentence of the primary text (spec 9.9 rotation). */
  opening: z.string(),
  /** The sentence carrying the call to action. */
  cta: z.string(),
  title_hash: hash,
  body_hash: hash,
  posted_at: isoUtc,
  mode: z.enum(MODES),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** An older post: only its hashes remain (and posts known from dedupe.json only). */
export const HistoryHashSchema = z.strictObject({
  job_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
  title_hash: hash.nullable(),
  body_hash: hash.nullable(),
  posted_at: isoUtc.nullable(),
});
export type HistoryHash = z.infer<typeof HistoryHashSchema>;

const HistoryFileSchema = z
  .strictObject({
    schema_version: z.literal(1),
    entries: z.array(HistoryEntrySchema),
    hashes: z.array(HistoryHashSchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    const check = (list: 'entries' | 'hashes', id: string, i: number): void => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [list, i, 'job_id'], message: `job_id「${id}」が重複しています` });
      seen.add(id);
    };
    file.entries.forEach((e, i) => check('entries', e.job_id, i));
    file.hashes.forEach((h, i) => check('hashes', h.job_id, i));
  });

/** What a poster records when a job is POSTED. */
export interface HistoryInput {
  job_id: string;
  audience_category: AudienceCategory;
  draft: Draft;
  posted_at: string;
}

/** The jobs a rebuild reads (JobStore). */
export interface HistoryJobReader {
  summaries(filter?: (s: { id: string; status: JobStatus; post_type: PostType }) => boolean): readonly { id: string }[];
  get(id: string): Promise<Job | null>;
}

/** dedupe.json records (DedupeStore.records): hashes of posts whose job is gone. */
export interface HistoryDedupeReader {
  records(): readonly { job_id: string; post_type: PostType; title_hash: string | null; body_hash: string | null; posted_at: string }[];
}

export interface HistoryLoadIssue {
  /** Why the file could not be used (Japanese). */
  reason: string;
  /** Where the unusable file was moved (kept for inspection; never deleted). */
  moved_to: string;
}

export interface HistoryRebuildReport {
  /** Full-text entries after the rebuild. */
  entries: number;
  /** Hash-only records after the rebuild. */
  hashes: number;
  /** POSTED jobs whose draft could not be read (left out). */
  skipped: number;
}

export interface HistoryStoreOptions extends StoreOptions {
  /** The mode this file belongs to (stamped on each entry). */
  mode: Mode;
  maxEntries?: number;
  /**
   * Days after posted_at until a full text becomes hash-only (historyFullTextDays). posted_at is never later than
   * verified_at, so the text goes no later than spec 16.5 asks. null / omitted: no period.
   */
  fullTextDays?: number | null;
  /**
   * dedupe.json (DedupeStore), the long-term record of every posted job's hashes (spec 16.5). A hash-only record that
   * dedupe.json holds with the same hashes is not kept here as well, so history.json stays a cache of the recent posts.
   * Exact-duplicate checks over the whole history then rely on dedupe.json: pass the same store to the Validator's
   * duplicate sources. Omitted: every hash-only record is kept.
   */
  dedupe?: HistoryDedupeReader;
  logger?: AppLogger;
}

interface State {
  entries: HistoryEntry[];
  hashes: HistoryHash[];
}

/** The job ids of history.json as last read or written: full-text entries and hash-only records. */
interface OnDisk {
  texts: ReadonlySet<string>;
  hashes: ReadonlySet<string>;
}

const onDiskOf = (s: State): OnDisk => ({ texts: new Set(s.entries.map((e) => e.job_id)), hashes: new Set(s.hashes.map((h) => h.job_id)) });

const byPostedAt = (a: { posted_at: string | null; job_id: string }, b: { posted_at: string | null; job_id: string }): number =>
  (a.posted_at ?? '') < (b.posted_at ?? '') ? -1 : (a.posted_at ?? '') > (b.posted_at ?? '') ? 1 : a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;

const hashOf = (e: HistoryEntry): HistoryHash => ({ job_id: e.job_id, post_type: e.post_type, title_hash: e.title_hash, body_hash: e.body_hash, posted_at: e.posted_at });

/** Whether a full text is still within its period (`cutoff`: epoch ms before which texts expire; null = no period). */
const current = (e: HistoryEntry, cutoff: number | null): boolean => cutoff === null || Date.parse(e.posted_at) >= cutoff;

/**
 * Sorted oldest first; expired full texts and those beyond `max` become hash-only records, and hash-only records
 * `covered` (held by dedupe.json) are dropped.
 */
function capped(state: State, max: number, cutoff: number | null, covered: (h: HistoryHash) => boolean): State {
  const sorted = [...state.entries].sort(byPostedAt);
  const entries = sorted.filter((e) => current(e, cutoff));
  const expired = sorted.filter((e) => !current(e, cutoff));
  const overflow = entries.length > max ? entries.splice(0, entries.length - max) : [];
  const hashes = [...state.hashes, ...expired.map(hashOf), ...overflow.map(hashOf)].filter((h) => !covered(h)).sort(byPostedAt);
  return { entries, hashes };
}

/**
 * The history cache of one mode. Writes go through the shared SerialQueue and replace the file atomically; memory
 * changes only after a write succeeded. Reads are from memory.
 */
export class HistoryStore implements RecentPatternsSource {
  readonly #path: string;
  readonly #queue: SerialQueue;
  readonly #clock: Clock;
  readonly #opts: HistoryStoreOptions;
  readonly #max: number;
  #state: State = { entries: [], hashes: [] };
  /** What the file holds (memory may already have aged texts out of it, e.g. those that expired while the PC was off). */
  #onDisk: OnDisk = { texts: new Set(), hashes: new Set() };
  #loadIssue: HistoryLoadIssue | null = null;

  private constructor(path: string, queue: SerialQueue, clock: Clock, opts: HistoryStoreOptions) {
    this.#path = path;
    this.#queue = queue;
    this.#clock = clock;
    this.#opts = opts;
    this.#max = Math.max(0, opts.maxEntries ?? HISTORY_MAX_ENTRIES);
  }

  /**
   * Reads data/history.json of the mode. A missing file starts empty (created on the first write). A damaged file is a
   * cache, not a record: it is moved aside to history.json.corrupt-<time> (never deleted), the store starts empty and
   * `loadIssue` says so, so the caller can rebuild it from the jobs. If even the move fails → STATE_CORRUPT.
   */
  static async load(paths: DataPaths, queue: SerialQueue, clock: Clock, opts: HistoryStoreOptions): Promise<HistoryStore> {
    const store = new HistoryStore(paths.historyFile, queue, clock, opts);
    const read = await readJsonFile(paths.historyFile, HistoryFileSchema, opts.fs, opts.retry);
    if (read.kind === 'ok') {
      store.#state = store.#capped({ entries: read.value.entries, hashes: read.value.hashes });
      store.#onDisk = onDiskOf(read.value);
    } else if (read.kind === 'corrupt') {
      const movedTo = `${paths.historyFile}.corrupt-${clock.now().toISOString().replace(/[:.]/g, '-')}`;
      await queue.run(async () => {
        try {
          await renameWithRetry(paths.historyFile, movedTo, opts.fs, opts.retry);
        } catch {
          throw stateCorrupt(clock, '投稿履歴（history.json）', paths.historyFile, read.reason);
        }
      });
      store.#loadIssue = { reason: read.reason, moved_to: movedTo };
      opts.logger?.warn(
        'HISTORY_CORRUPT_MOVED',
        `投稿履歴（history.json）が壊れていたため ${movedTo} に移し、空の履歴から始めます（投稿済みのjobから作り直せます）。原因: ${read.reason}`,
        { stage: 'storage', path: paths.historyFile, moved_to: movedTo },
      );
    }
    return store;
  }

  /** Set when load found a damaged file and moved it aside. */
  get loadIssue(): HistoryLoadIssue | null {
    return this.#loadIssue === null ? null : { ...this.#loadIssue };
  }

  /** Entry and hash-only counts. */
  get size(): { entries: number; hashes: number } {
    return { entries: this.#state.entries.length, hashes: this.#state.hashes.length };
  }

  has(jobId: string): boolean {
    return this.#state.entries.some((e) => e.job_id === jobId) || this.#state.hashes.some((h) => h.job_id === jobId);
  }

  /**
   * Records a posted job (replacing an earlier record of the same job): full text, hashes, rotation data. Beyond
   * HISTORY_MAX_ENTRIES the oldest full texts become hash-only records. An invalid input is a caller bug (INTERNAL_ERROR,
   * nothing written).
   */
  upsert(input: HistoryInput): Promise<HistoryEntry> {
    return this.#queue.run(async () => {
      const entry = this.#entryOf(input);
      const next = this.#capped({
        entries: [...this.#state.entries.filter((e) => e.job_id !== entry.job_id), entry],
        hashes: this.#state.hashes.filter((h) => h.job_id !== entry.job_id),
      });
      await this.#write(next);
      return { ...entry };
    });
  }

  /**
   * Turns the full texts whose period is over into hash-only records and rewrites the file when it still holds any of
   * them, including texts that expired while the tool was not running (spec 16.5: handled at the next start; call at
   * startup and with the periodic cleanup). Hash-only records dedupe.json holds are dropped from the file too. Returns
   * how many full texts left the file.
   */
  prune(): Promise<number> {
    return this.#queue.run(async () => {
      const next = this.#capped(this.#state);
      const texts = new Set(next.entries.map((e) => e.job_id));
      const ids = new Set([...texts, ...next.hashes.map((h) => h.job_id)]);
      const dropped = [...this.#onDisk.texts].filter((id) => !texts.has(id)).length;
      if (dropped > 0 || [...this.#onDisk.hashes].some((id) => !ids.has(id))) await this.#write(next);
      return dropped;
    });
  }

  /**
   * Drops the full text of one job and keeps its hashes (spec 16.5: a cleaned-up job leaves only light records), also
   * when memory already aged it out but the file still holds it. False when the file holds no full text of that job
   * (nothing is written).
   */
  forgetText(jobId: string): Promise<boolean> {
    return this.#queue.run(async () => {
      const entry = this.#state.entries.find((e) => e.job_id === jobId);
      if (entry === undefined && !this.#onDisk.texts.has(jobId)) return false;
      await this.#write(
        this.#capped({
          entries: this.#state.entries.filter((e) => e.job_id !== jobId),
          hashes: entry === undefined ? this.#state.hashes : [...this.#state.hashes, hashOf(entry)],
        }),
      );
      return true;
    });
  }

  /** Full-text entries within their period, newest first: of one post type, or of every type with null. */
  recentEntries(postType: PostType | null, n: number): HistoryEntry[] {
    if (n <= 0) return [];
    const cutoff = this.#cutoff();
    return [...this.#state.entries]
      .reverse()
      .filter((e) => current(e, cutoff) && (postType === null || e.post_type === postType))
      .slice(0, n)
      .map((e) => structuredClone(e));
  }

  /** The hashes of every recorded post (full-text entries and older ones), for exact-duplicate checks. */
  hashes(): HistoryHash[] {
    return [...this.#state.entries.map(hashOf), ...this.#state.hashes.map((h) => ({ ...h }))];
  }

  /** RecentPatternsSource: the rotation data of posted texts (spec 9.9), newest first. */
  async recent(q: RecentPatternQuery): Promise<readonly RecentDraftPattern[]> {
    if (q.limit <= 0) return [];
    const cutoff = this.#cutoff();
    return [...this.#state.entries]
      .reverse()
      .filter((e) => current(e, cutoff) && e.post_type === q.post_type && e.job_id !== q.exclude_job_id)
      .slice(0, q.limit)
      .map((e) => ({
        job_id: e.job_id,
        post_type: e.post_type,
        at: e.posted_at,
        title: e.title,
        title_pattern: e.meta.title_pattern,
        content_angle: e.meta.content_angle,
        opening_pattern: e.meta.opening_pattern,
        cta_pattern: e.meta.cta_pattern,
        opening: e.opening,
        cta: e.cta,
      }));
  }

  /**
   * Rebuilds the cache from the POSTED jobs (their stored drafts) and, for posts whose job is gone, dedupe.json hashes.
   * Records already in the cache for jobs that are no longer readable are kept. The jobs are read before the write is
   * queued; the merge with the cache happens inside the queue, so a concurrent upsert is never lost.
   */
  async rebuildFromJobs(jobs: HistoryJobReader, dedupe?: HistoryDedupeReader): Promise<HistoryRebuildReport> {
    const rebuilt: HistoryEntry[] = [];
    let skipped = 0;
    for (const { id } of jobs.summaries((s) => s.status === 'POSTED')) {
      const job = await jobs.get(id);
      if (job === null || job.status !== 'POSTED') continue;
      const draft = DraftSchema.safeParse(job.draft);
      const postedAt = job.posted_at ?? job.verified_at ?? job.updated_at;
      if (!draft.success || draft.data.post_type !== job.post_type) {
        skipped++;
        continue;
      }
      try {
        rebuilt.push(this.#entryOf({ job_id: job.id, audience_category: job.audience_category, draft: draft.data, posted_at: postedAt }));
      } catch {
        skipped++;
      }
    }
    return this.#queue.run(async () => {
      const byId = new Map<string, HistoryEntry>(this.#state.entries.map((e) => [e.job_id, e]));
      for (const e of rebuilt) byId.set(e.job_id, e);
      const hashes = new Map<string, HistoryHash>();
      for (const h of this.#state.hashes) if (!byId.has(h.job_id)) hashes.set(h.job_id, h);
      for (const r of dedupe?.records() ?? []) {
        if (byId.has(r.job_id) || hashes.has(r.job_id)) continue;
        hashes.set(r.job_id, { job_id: r.job_id, post_type: r.post_type, title_hash: r.title_hash, body_hash: r.body_hash, posted_at: r.posted_at });
      }
      const next = this.#capped({ entries: [...byId.values()], hashes: [...hashes.values()] });
      await this.#write(next);
      return { entries: next.entries.length, hashes: next.hashes.length, skipped };
    });
  }

  /** Epoch ms before which a full text has expired, or null without a period. */
  #cutoff(): number | null {
    const days = this.#opts.fullTextDays;
    return days === undefined || days === null ? null : this.#clock.now().getTime() - days * DAY_MS;
  }

  /** capped() with this store's cap, period and the hash-only records dedupe.json already holds (same hashes). */
  #capped(state: State): State {
    const held = this.#opts.dedupe === undefined ? null : new Map(this.#opts.dedupe.records().map((r) => [r.job_id, r]));
    const covered = (h: HistoryHash): boolean => {
      const r = held?.get(h.job_id);
      return r !== undefined && r.post_type === h.post_type && (h.title_hash === null || r.title_hash === h.title_hash) && (h.body_hash === null || r.body_hash === h.body_hash);
    };
    return capped(state, this.#max, this.#cutoff(), covered);
  }

  #entryOf(input: HistoryInput): HistoryEntry {
    const draft = DraftSchema.safeParse(input.draft);
    const primary = draft.success ? primaryTextOf(draft.data) : '';
    const candidate = draft.success
      ? {
          job_id: input.job_id,
          post_type: draft.data.post_type,
          audience_category: input.audience_category,
          title: draft.data.title,
          primary_text: primary,
          ...(draft.data.post_type === 'style' ? { menu_text: draft.data.menu_text } : {}),
          hashtags: [...draft.data.hashtags],
          meta: { ...draft.data.meta },
          opening: postSentences(primary)[0] ?? '',
          cta: ctaSentence(postSentences(primary), draft.data.meta.cta_pattern),
          title_hash: historyTextHash(draft.data.title),
          body_hash: historyTextHash(primary),
          posted_at: input.posted_at,
          mode: this.#opts.mode,
        }
      : null;
    const parsed = HistoryEntrySchema.safeParse(candidate);
    if (!draft.success || !parsed.success) {
      throw internalFailure(this.#clock, '投稿履歴に記録する内容が不正なため保存しませんでした', {
        job_id: typeof input?.job_id === 'string' ? input.job_id : null,
        issues: draft.success ? (parsed.success ? [] : issueSummary(parsed.error)) : issueSummary(draft.error),
      });
    }
    return parsed.data;
  }

  async #write(next: State): Promise<void> {
    await writeJsonAtomic(this.#path, { schema_version: 1, entries: next.entries, hashes: next.hashes }, this.#opts.fs, this.#opts.retry);
    this.#state = next;
    this.#onDisk = onDiskOf(next);
  }
}

/**
 * What every poster calls once a job is POSTED (the dry-run poster now, the live poster in Plan 3): records the posted
 * draft in history.json. A draft that is not a Plan 2 draft (e.g. the Plan 1 mock's) is skipped. Never throws: the post
 * has happened (R28), so a failure is only logged and the next start fills the gap (backfillHistory).
 */
export async function recordPostedHistory(history: Pick<HistoryStore, 'upsert'>, job: Job, logger: AppLogger): Promise<boolean> {
  const fields = { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'posted' };
  const draft = DraftSchema.safeParse(job.draft);
  if (!draft.success || draft.data.post_type !== job.post_type) {
    logger.debug('HISTORY_SKIPPED', `下書きが文章生成の形式ではないため、投稿履歴（history.json）には記録しません: ${job.id}`, fields);
    return false;
  }
  const postedAt = job.posted_at ?? job.verified_at ?? job.updated_at;
  try {
    await history.upsert({ job_id: job.id, audience_category: job.audience_category, draft: draft.data, posted_at: postedAt });
    return true;
  } catch (err) {
    logger.warn('HISTORY_NOT_SAVED', `投稿は済みましたが、投稿履歴（history.json）に記録できませんでした（次の起動で補います）: ${job.id}`, {
      ...fields,
      error_code: errorCodeOf(err),
    });
    return false;
  }
}

/**
 * Startup (spec 11.4-5: history is a rebuildable cache): rebuilds history.json from the POSTED jobs when one of them with
 * a usable draft is missing from it, and moves expired full texts out (prune). Returns how many were added. Never throws.
 */
export async function backfillHistory(history: HistoryStore, jobs: HistoryJobReader, dedupe: HistoryDedupeReader | undefined, logger: AppLogger): Promise<number> {
  try {
    await history.prune();
    let missing = 0;
    for (const { id } of jobs.summaries((s) => s.status === 'POSTED')) {
      if (history.has(id)) continue;
      const job = await jobs.get(id);
      const draft = DraftSchema.safeParse(job?.draft);
      if (job !== null && job.status === 'POSTED' && draft.success && draft.data.post_type === job.post_type) missing++;
    }
    if (missing === 0) return 0;
    const report = await history.rebuildFromJobs(jobs, dedupe);
    logger.info('HISTORY_BACKFILLED', `投稿履歴（history.json）に無かった投稿済みの記録を補いました（${missing}件。全文 ${report.entries}件・hash のみ ${report.hashes}件）。`, {
      added: missing,
      entries: report.entries,
      hashes: report.hashes,
    });
    return missing;
  } catch (err) {
    logger.warn('HISTORY_BACKFILL_FAILED', `投稿履歴（history.json）を投稿済みの記録で補えませんでした（次の起動でもう一度試します）: ${errorText(err)}`, {
      error_code: errorCodeOf(err),
    });
    return 0;
  }
}
