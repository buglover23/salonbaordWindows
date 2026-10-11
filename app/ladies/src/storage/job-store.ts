import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../shared/clock.js';
import { comparisonHash } from '../shared/hash.js';
import { JobSchema, type Job } from '../shared/job-schema.js';
import type { RouteKey } from '../shared/protocol/version.js';
import { jstDateKey } from '../shared/time.js';
import type { AudienceCategory, JobStatus, PostType, SubmissionState } from '../shared/types.js';
import { errnoCode, readJsonFile, storageFailure, unlinkWithRetry, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';
import type { SerialQueue } from './serial-queue.js';
import { internalFailure, issueSummary, revisionConflict, stateCorrupt, type StoreOptions } from './store-errors.js';

/** The small subset of a job kept in memory (spec 16.6: full jobs are read from disk on demand). */
export interface JobSummary {
  id: string;
  status: JobStatus;
  post_type: PostType;
  audience_category: AudienceCategory;
  created_at: string;
  image_sha256: string;
  schedule_slot_id: string | null;
  has_operation: boolean;
  submission_state: SubmissionState;
  /** The rules the READY draft was last checked against (A41). */
  config_hash: string;
  /** Nothing was ever handed to a poster (A41 rechecks only such jobs). */
  never_submitted: boolean;
  updated_at: string;
  /** A FAILED job's error (status lists it); null for any other status. */
  failure: { code: string; message: string } | null;
  // Plan 3 (live poster).
  next_retry_at: string | null;
  /** The latest attempt's intent time, or for a pre-intent unknown result (P3-R40) the time it was recorded. */
  last_intent_at: string | null;
  /** JST date of last_intent_at. */
  intent_date_jst: string | null;
  /** The latest attempt may have reached SALON BOARD and is not settled (intent_recorded or unknown). */
  unresolved_post_intent: boolean;
  reconcile_next_at: string | null;
  last_error_code: string | null;
  draft_title_hash: string | null;
  upload_constraints_hash: string | null;
  /** The draft came from a real AI provider (P3-R41). */
  provenance_real: boolean;
  route_key: RouteKey;
  /** POSTED with a verified time: max(posted_at, verified_at), where the 30-day retention starts (spec 16.5); else null. */
  success_at: string | null;
}

const JSON_SUFFIX = '.json';
// Job ids become file names, so anything that could leave the jobs folder or is not a plain name is refused, and so is a
// Windows device name (con, nul, com1, ...): with or without an extension it opens a device, not a file.
const SAFE_JOB_ID = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/i;

function summarize(job: Job): JobSummary {
  const latest = job.attempts.at(-1);
  const unresolved = latest !== undefined && (latest.submission_state === 'intent_recorded' || latest.submission_state === 'unknown');
  const lastIntentAt = latest?.submit_intent_at ?? (latest?.submission_state === 'unknown' ? latest.completed_at : null);
  const title = (job.draft as { title?: unknown } | null)?.title;
  return {
    id: job.id,
    status: job.status,
    post_type: job.post_type,
    audience_category: job.audience_category,
    created_at: job.created_at,
    image_sha256: job.image.sha256,
    schedule_slot_id: job.schedule_slot_id,
    has_operation: job.operation !== null,
    config_hash: job.config_hash,
    never_submitted: job.submission_state === 'not_started' && job.attempts.every((a) => a.submit_intent_at === null),
    submission_state: job.submission_state,
    updated_at: job.updated_at,
    failure: job.status === 'FAILED' && job.last_error !== null ? { code: job.last_error.code, message: job.last_error.message } : null,
    next_retry_at: job.next_retry_at,
    last_intent_at: lastIntentAt ?? null,
    intent_date_jst: lastIntentAt ? jstDateKey(new Date(lastIntentAt)) : null,
    unresolved_post_intent: unresolved,
    reconcile_next_at: job.reconcile?.next_auto_at ?? null,
    last_error_code: job.last_error?.code ?? null,
    draft_title_hash: typeof title === 'string' ? comparisonHash(title) : null,
    upload_constraints_hash: job.upload?.constraints_hash ?? null,
    provenance_real: job.draft_provenance !== null && job.draft_provenance.provider !== 'mock',
    route_key: `${job.post_type}.${job.audience_category}`,
    success_at:
      job.status === 'POSTED' && job.verified_at !== null
        ? new Date(Math.max(Date.parse(job.verified_at), Date.parse(job.posted_at ?? job.verified_at))).toISOString()
        : null,
  };
}

/**
 * Job JSON files (`<jobsDir>/<id>.json`) are the source of truth; this class only adds a revision check on top
 * and an in-memory index of summaries. Every write goes through the shared SerialQueue (spec 11.4-1).
 * Reads (`get`) bypass the queue on purpose: writes replace the file atomically, and a task running inside the
 * queue must never wait on the queue again.
 */
export class JobStore {
  readonly #paths: DataPaths;
  readonly #queue: SerialQueue;
  readonly #clock: Clock;
  readonly #opts: StoreOptions;
  readonly #index = new Map<string, JobSummary>();

  private constructor(paths: DataPaths, queue: SerialQueue, clock: Clock, opts: StoreOptions) {
    this.#paths = paths;
    this.#queue = queue;
    this.#clock = clock;
    this.#opts = opts;
  }

  /** Reads every `*.json` in the jobs folder one at a time. Any unreadable job → STATE_CORRUPT and nothing is modified. */
  static async open(paths: DataPaths, queue: SerialQueue, clock: Clock, opts: StoreOptions = {}): Promise<JobStore> {
    const store = new JobStore(paths, queue, clock, opts);
    for (const name of await store.#listJobFiles()) {
      const id = name.slice(0, -JSON_SUFFIX.length);
      const path = join(paths.jobsDir, name);
      if (!SAFE_JOB_ID.test(id)) {
        throw stateCorrupt(clock, 'jobファイル', path, 'ファイル名がjob IDとして使えません');
      }
      const job = await store.#readJob(path, id);
      if (job !== null) store.#index.set(id, summarize(job));
    }
    return store;
  }

  /** Writes a new job file. An existing file with the same id is a caller bug, never overwritten. */
  create(job: Job): Promise<Job> {
    return this.#queue.run(async () => {
      const next = this.#validate(job, job.id);
      const path = this.#pathFor(next.id);
      if (path === null) {
        throw internalFailure(this.#clock, `jobのIDがファイル名として使えません: ${next.id}`, { job_id: next.id });
      }
      const existing = await readJsonFile(path, z.unknown(), this.#opts.fs, this.#opts.retry);
      if (existing.kind !== 'missing') {
        throw internalFailure(this.#clock, '同じIDのjobが既に存在します', { job_id: next.id, path });
      }
      await writeJsonAtomic(path, next, this.#opts.fs, this.#opts.retry);
      this.#index.set(next.id, summarize(next));
      return next;
    });
  }

  /** The job as stored on disk, or null if there is no such job. A damaged file → STATE_CORRUPT. */
  async get(id: string): Promise<Job | null> {
    const path = this.#pathFor(id);
    if (path === null) return null;
    return this.#readJob(path, id);
  }

  /**
   * Compare-and-swap on `revision`: `mutate` gets a copy of the job as it is on disk right now. The stored result has
   * `revision + 1` and a fresh `updated_at`, and must pass JobSchema; otherwise nothing is written.
   */
  update(id: string, expectedRevision: number, mutate: (job: Job) => Job): Promise<Job> {
    return this.#queue.run(async () => {
      const path = this.#pathFor(id);
      const current = path === null ? null : await this.#readJob(path, id);
      if (path === null || current === null) {
        throw internalFailure(this.#clock, `更新するjobが見つかりません: ${id}`, { job_id: id, reason: 'job_not_found' });
      }
      if (current.revision !== expectedRevision) throw revisionConflict(this.#clock, id, expectedRevision, current.revision);
      const mutated = mutate(structuredClone(current));
      const next = this.#validate({ ...mutated, revision: current.revision + 1, updated_at: this.#clock.now().toISOString() }, id);
      await writeJsonAtomic(path, next, this.#opts.fs, this.#opts.retry);
      this.#index.set(id, summarize(next));
      return next;
    });
  }

  /** Removes the job file (CAS on `expectedRevision`); only the retention cleanup calls it, as its last step (spec 16.5-6). */
  delete(id: string, expectedRevision: number): Promise<void> {
    return this.#queue.run(async () => {
      const path = this.#pathFor(id);
      const current = path === null ? null : await this.#readJob(path, id);
      if (path === null || current === null) {
        throw internalFailure(this.#clock, `削除するjobが見つかりません: ${id}`, { job_id: id, reason: 'job_not_found' });
      }
      if (current.revision !== expectedRevision) throw revisionConflict(this.#clock, id, expectedRevision, current.revision);
      await unlinkWithRetry(path, this.#opts.fs, this.#opts.retry);
      this.#index.delete(id);
    });
  }

  /** Copies of the summaries (oldest first as loaded/created), optionally filtered. */
  summaries(filter?: (s: JobSummary) => boolean): JobSummary[] {
    const out: JobSummary[] = [];
    for (const summary of this.#index.values()) {
      const copy = { ...summary };
      if (filter === undefined || filter(copy)) out.push(copy);
    }
    return out;
  }

  /** The first job (in index order) with this post type and image hash. */
  findByImage(post_type: PostType, sha256: string): JobSummary | undefined {
    for (const summary of this.#index.values()) {
      if (summary.post_type === post_type && summary.image_sha256 === sha256) return { ...summary };
    }
    return undefined;
  }

  #pathFor(id: string): string | null {
    return SAFE_JOB_ID.test(id) ? join(this.#paths.jobsDir, `${id}${JSON_SUFFIX}`) : null;
  }

  async #listJobFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.#paths.jobsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(JSON_SUFFIX))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return [];
      throw storageFailure(err, 'jobフォルダの読込', this.#paths.jobsDir);
    }
  }

  /** null = no such file. A file that is unreadable, fails JobSchema, or holds a different id is STATE_CORRUPT. */
  async #readJob(path: string, expectedId: string): Promise<Job | null> {
    const result = await readJsonFile(path, JobSchema, this.#opts.fs, this.#opts.retry);
    if (result.kind === 'missing') return null;
    if (result.kind === 'corrupt') throw stateCorrupt(this.#clock, 'jobファイル', path, result.reason);
    if (result.value.id !== expectedId) {
      throw stateCorrupt(this.#clock, 'jobファイル', path, `ファイル名と中のid（${result.value.id}）が一致しません`);
    }
    return result.value;
  }

  /** Parses `candidate` with JobSchema and checks it still belongs to `id`; a violation is a caller bug and writes nothing. */
  #validate(candidate: Job, id: string): Job {
    const parsed = JobSchema.safeParse(candidate);
    if (!parsed.success) {
      throw internalFailure(this.#clock, `jobの内容が不正なため保存しませんでした: ${id}`, {
        job_id: id,
        issues: issueSummary(parsed.error),
      });
    }
    if (parsed.data.id !== id) {
      throw internalFailure(this.#clock, `jobのIDは変更できないため保存しませんでした: ${id}`, { job_id: id, new_id: parsed.data.id });
    }
    return parsed.data;
  }
}
