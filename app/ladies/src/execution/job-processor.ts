import { handledAudiences, type Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, ERROR_MESSAGES_JA, appError, errorCodeOf, type AppError, type ErrorCode } from '../shared/errors.js';
import { INTAKE_STAGE, type Job } from '../shared/job-schema.js';
import { formatJst } from '../shared/time.js';
import type { JobStatus, PostType } from '../shared/types.js';
import type { BundleMover } from '../storage/bundles.js';
import { writeFailureFile } from '../storage/failure-file.js';
import type { JobStore, JobSummary } from '../storage/job-store.js';
import type { DataPaths } from '../storage/paths.js';
import { SerialQueue } from '../storage/serial-queue.js';

/** Job fields a pipeline may set together with READY (what the draft was made and checked with). */
export type ReadyRecord = Partial<Pick<Job, 'content_hash' | 'config_hash' | 'instruction_refs' | 'template_hash' | 'trend_source_refs'>>;

export type ValidationOutcome = { ok: true; record?: ReadyRecord } | { ok: false; error: AppError; regenerate: boolean };

/** Why preparation cannot run now (Japanese message for logs and status). */
export interface PreparationHold {
  code: ErrorCode;
  message: string;
}

/**
 * A READY draft checked again after the rules changed (Plan 2 A41): still fine (`record` is stored, e.g. the new
 * config_hash), to be written again from its analysis, to be prepared again from the start (its analysis cannot be
 * used, spec 11.2), or not checkable now (left as it is and tried again after the next change).
 */
export type RecheckOutcome =
  | { kind: 'current'; record: ReadyRecord }
  | { kind: 'regenerate'; error: AppError }
  | { kind: 'restart'; error: AppError }
  | { kind: 'skip' };

/**
 * Thrown by a pipeline step when the job cannot be worked on now although nothing is wrong with it (a transient AI or
 * file problem, or a stop that applies to every job): the job goes back to the stage it can restart from and waits until
 * `retryAt` instead of failing.
 */
export class PreparationDeferred extends Error {
  readonly error: AppError;
  readonly retryAt: Date;

  constructor(error: AppError, retryAt: Date) {
    super(error.message);
    this.name = 'PreparationDeferred';
    this.error = error;
    this.retryAt = retryAt;
  }
}

/**
 * The boundary Plan 2 fills with the real AI pipeline. Results are stored as they are (JSON) in the job's `analysis` /
 * `draft`. The optional members are used by the real pipeline only; the Plan 1 mock leaves them out.
 */
export interface ContentPipeline {
  analyze(job: Job): Promise<unknown>;
  /**
   * An AppFailure with AI_OUTPUT_INVALID is a draft that failed its checks: it is regenerated (spec 15.1), unless the API
   * refused the request (retryable false with a numeric details.status): that fails the job.
   */
  generate(job: Job): Promise<unknown>;
  validate(job: Job): Promise<ValidationOutcome>;
  /** A stop that applies to every job (AI budget, key or settings, templates missing); null when preparation may run. */
  stopped?(): Promise<PreparationHold | null>;
  /** A job that must wait without being started (e.g. style posts while no verified menu is registered). */
  holdFor?(job: JobSummary): PreparationHold | null;
  /** Identifies the rules READY drafts were checked against; when it changes, READY jobs are checked again (A41). */
  recheckKey?(): string | null;
  recheck?(job: Job): Promise<RecheckOutcome>;
  /** Who wrote the draft generate() just returned for this job (P3-R41); taken once. Omitted or null: not recorded. */
  provenance?(jobId: string): Job['draft_provenance'];
}

export interface JobProcessorDeps {
  store: JobStore;
  bundles: BundleMover;
  pipeline: ContentPipeline;
  getSettings: () => Settings;
  clock: Clock;
  logger: AppLogger;
  /** Needed to write failure.json into the failed bundle (spec 11.3). */
  paths: DataPaths;
  /**
   * Plan decision 13: the post type the coming slots need (Scheduler.neededType); its PENDING jobs are prepared first,
   * each type oldest first. Omitted or null: oldest first.
   */
  preferredType?: () => PostType | null;
  /** Plan 4 (spec 16.6): memory or disk over its limit; no new preparation starts meanwhile. */
  resourceHold?: () => PreparationHold | null;
}

// Spec 16.6: jobs that already hold prepared (or half-prepared) content count against resources.max_prepared_jobs.
const PREPARED: ReadonlySet<JobStatus> = new Set<JobStatus>(['ANALYZING', 'GENERATING', 'VALIDATING', 'READY']);
const INTERRUPTED: ReadonlySet<JobStatus> = new Set<JobStatus>(['ANALYZING', 'GENERATING', 'VALIDATING']);
const MAX_LOGGED_STACK = 1500;
const MAX_LOGGED_CAUSE = 200;

/** Where a job continues inside this process: generation (analysis kept) or validation of the stored draft. */
type ResumeStage = 'GENERATING' | 'VALIDATING';

// Oldest first; the same created_at falls back to id order.
function byAge(a: JobSummary, b: JobSummary): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Safe to store (job JSON, failure.json): an AppFailure's own message, otherwise only the exception's name.
function errorMessageOf(err: unknown): string {
  return err instanceof AppFailure ? err.error.message : err instanceof Error ? err.name : typeof err;
}

// For log fields only, never stored: the exception's name and message, the message cut at MAX_LOGGED_CAUSE characters.
function causeOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${String(err.message).slice(0, MAX_LOGGED_CAUSE)}`;
  try {
    return `${typeof err}: ${String(err).slice(0, MAX_LOGGED_CAUSE)}`;
  } catch {
    return typeof err;
  }
}

const isOutputInvalid = (err: unknown): err is AppFailure => err instanceof AppFailure && err.error.code === 'AI_OUTPUT_INVALID';

/** A READY job that was never handed to a poster: no attempt ever recorded a submit intent (A41). */
const neverSubmitted = (job: Job): boolean => job.submission_state === 'not_started' && job.attempts.every((a) => a.submit_intent_at === null);

/**
 * Drives PENDING jobs to READY through a ContentPipeline (spec 11.2, 10.2). Status changes inside the processing
 * folder are plain job updates; FAILED moves the bundle to images/failed/ and writes failure.json. A failure never
 * stops the processor: whatever cannot be saved is logged and left for the startup recovery.
 * Public calls run one at a time, so a slow pipeline can never be handed the same job twice.
 */
export class JobProcessor {
  readonly #d: JobProcessorDeps;
  readonly #lock = new SerialQueue();
  /**
   * Jobs that continue from GENERATING or VALIDATING (interrupted at startup, or waiting after a transient problem); they
   * already count as prepared, so the preparation cap does not apply.
   */
  readonly #resume = new Map<string, ResumeStage>();
  /** PENDING jobs a pass could not move (e.g. the first save failed); not tried again until the next start. */
  readonly #parked = new Set<string>();
  /** Jobs deferred by the pipeline: not tried again before this time (epoch ms). */
  readonly #waitUntil = new Map<string, number>();
  /** The hold last logged per job (logged once until it changes). */
  readonly #heldLogged = new Map<string, string>();
  /** The stop seen by the last processNext (willPrepare reads it). */
  #stop: PreparationHold | null = null;
  #stopLogged: string | null = null;
  /** Recheck failures already warned about (job | key | code): a failure tried again is logged once (A41). */
  readonly #recheckWarned = new Set<string>();

  constructor(d: JobProcessorDeps) {
    this.#d = d;
  }

  /**
   * Startup (after BundleMover.recoverAll): puts jobs interrupted mid-preparation back on a safe stage and returns how
   * many it handled. ANALYZING restarts at PENDING; GENERATING / VALIDATING continue from GENERATING when the analysis
   * was saved (it is reused), otherwise restart at PENDING. Jobs with an unfinished file move are left alone.
   */
  resumeInterrupted(): Promise<number> {
    return this.#lock.run(() => this.#resumeInterrupted());
  }

  /**
   * Prepares the oldest PENDING job (of the preferred type first, decision 13) unless enough jobs are prepared already.
   * true = a job advanced (it left PENDING, to READY, FAILED or a stage in between); false = nothing advanced. A picked job
   * that cannot be worked on is parked and the next one is tried within the same call. Nothing is started while the
   * pipeline reports a stop; held and waiting jobs are skipped.
   */
  processNext(): Promise<boolean> {
    return this.#lock.run(() => this.#processNext());
  }

  /**
   * P3-R29: the live poster sent a READY job back to GENERATING (rules drift, provenance); it is generated again from its
   * analysis at the next processNext. Lock-free (a Map write), so the coordinator never waits on this processor.
   */
  notifyRegeneration(id: string): void {
    this.#resume.set(id, 'GENERATING');
    this.#waitUntil.delete(id);
  }

  /** The stop the last processNext saw (null: none). */
  get stop(): PreparationHold | null {
    return this.#stop === null ? null : { ...this.#stop };
  }

  /**
   * Whether a job of `type` is among the next to be prepared, as Plan 1's preparation before every tick would have made
   * it READY: a job continuing from GENERATING / VALIDATING, or a PENDING one (not parked, held or waiting) within the room
   * left under max_prepared_jobs, in the order processNext takes them. The scheduler keeps a due slot of that type open
   * for it within grace (decision 13). Never while preparation is stopped. Reads only.
   */
  willPrepare(type: PostType): boolean {
    if (this.#stop !== null) return false;
    const { store } = this.#d;
    const now = this.#d.clock.now().getTime();
    if (store.summaries((s) => this.#resume.has(s.id) && s.post_type === type && this.#available(s, now)).length > 0) return true;
    const room = this.#d.getSettings().resources.max_prepared_jobs - store.summaries((s) => PREPARED.has(s.status)).length;
    return room > 0 && this.#queue(now).slice(0, room).some((s) => s.post_type === type);
  }

  /** Why the PENDING jobs of `type` are not prepared (preparation stopped, or a pipeline hold), or null. Reads only. */
  heldReason(type: PostType): string | null {
    const pending = this.#d.store.summaries((s) => s.status === 'PENDING' && s.post_type === type);
    if (pending.length === 0) return null;
    if (this.#stop !== null) return this.#stop.message;
    return pending.map((s) => this.#d.pipeline.holdFor?.(s) ?? null).find((h) => h !== null)?.message ?? null;
  }

  /**
   * A41: false for a READY job last checked against rules older than the current ones (the recheck is still to come, or
   * could not run yet). The scheduler does not dispatch such a job. A job already handed to a poster is never rechecked.
   */
  isCurrent(s: JobSummary): boolean {
    const key = this.#d.pipeline.recheckKey?.() ?? null;
    return key === null || s.config_hash === key || !s.never_submitted;
  }

  /** Not waiting after a deferral and not held by the pipeline. */
  #available(s: JobSummary, now: number): boolean {
    if (!this.#handles(s)) return false;
    const until = this.#waitUntil.get(s.id);
    if (until !== undefined && until > now) return false;
    return (this.#d.pipeline.holdFor?.(s) ?? null) === null;
  }

  /** settings.audiences: a job of an audience this copy does not handle (imported before it was set) is never prepared. */
  #handles(s: JobSummary): boolean {
    return handledAudiences(this.#d.getSettings()).includes(s.audience_category);
  }

  /** PENDING jobs in the order they are prepared: the type the next slots need first, oldest first within a type. */
  #queue(now: number): JobSummary[] {
    const pending = this.#d.store
      .summaries((s) => s.status === 'PENDING' && !s.has_operation && !this.#parked.has(s.id) && this.#available(s, now))
      .sort(byAge);
    const preferred = this.#d.preferredType?.() ?? null;
    return preferred === null ? pending : [...pending.filter((s) => s.post_type === preferred), ...pending.filter((s) => s.post_type !== preferred)];
  }

  async #resumeInterrupted(): Promise<number> {
    const { store, logger } = this.#d;
    let handled = 0;
    for (const summary of store.summaries((s) => INTERRUPTED.has(s.status) && !s.has_operation).sort(byAge)) {
      try {
        const job = await store.get(summary.id);
        if (job === null || job.operation !== null || !INTERRUPTED.has(job.status)) continue;
        const restartAt = job.status !== 'ANALYZING' && job.analysis !== null ? 'GENERATING' : 'PENDING';
        if (restartAt === 'PENDING') {
          await store.update(job.id, job.revision, (j) => ({ ...j, status: 'PENDING', stage: INTAKE_STAGE }));
          this.#resume.delete(job.id);
        } else {
          if (job.status !== 'GENERATING') await store.update(job.id, job.revision, (j) => ({ ...j, status: 'GENERATING', stage: 'generate' }));
          this.#resume.set(job.id, 'GENERATING');
        }
        handled++;
        logger.info('JOB_RESUMED', `中断されていた準備を${restartAt === 'PENDING' ? '最初から' : '文章の生成から'}やり直します: ${job.id}`, {
          job_id: job.id,
          stage: restartAt === 'PENDING' ? INTAKE_STAGE : 'generate',
          post_type: job.post_type,
          audience_category: job.audience_category,
          previous_status: job.status,
        });
      } catch (err) {
        logger.error('JOB_RESUME_FAILED', `中断されていた準備を再開できませんでした（次の起動で再度試します）: ${errorMessageOf(err)}`, {
          job_id: summary.id,
          error_code: errorCodeOf(err),
          cause: causeOf(err),
        });
      }
    }
    return handled;
  }

  async #processNext(): Promise<boolean> {
    const { store, pipeline } = this.#d;
    // A41 first: the recheck calls no AI, so it also runs while AI work is stopped (quota, budget, key, templates).
    if (await this.#recheckReady()) return true;
    if (!(await this.#checkStop())) return false;
    const now = this.#d.clock.now().getTime();
    for (const [id, from] of [...this.#resume]) {
      const summary = store.summaries((s) => s.id === id)[0];
      if (summary === undefined) {
        this.#resume.delete(id);
        continue;
      }
      if (!this.#available(summary, now)) {
        this.#logHold(summary);
        continue;
      }
      this.#resume.delete(id);
      this.#waitUntil.delete(id);
      const outcome = await this.#execute(id, from);
      if (outcome !== 'skipped') return outcome === 'advanced';
    }
    for (const s of store.summaries((x) => x.status === 'PENDING' && !x.has_operation)) {
      if (pipeline.holdFor?.(s)) this.#logHold(s);
    }
    const prepared = store.summaries((s) => PREPARED.has(s.status)).length;
    if (prepared >= this.#d.getSettings().resources.max_prepared_jobs) return false;
    for (const candidate of this.#queue(now)) {
      this.#waitUntil.delete(candidate.id);
      const outcome = await this.#execute(candidate.id, 'PENDING');
      if (outcome === 'advanced') return true;
      if (outcome === 'deferred') return false; // the next job would most likely meet the same problem now
    }
    return false;
  }

  /** false while the pipeline reports a stop (logged once per stop; its end is logged too). */
  async #checkStop(): Promise<boolean> {
    const { pipeline, logger } = this.#d;
    let stop: PreparationHold | null;
    try {
      stop = this.#d.resourceHold?.() ?? (await pipeline.stopped?.()) ?? null;
    } catch (err) {
      stop = { code: errorCodeOf(err), message: `準備を始められるか確認できませんでした: ${errorMessageOf(err)}` };
    }
    this.#stop = stop;
    const key = stop === null ? null : `${stop.code}|${stop.message}`;
    if (key !== this.#stopLogged) {
      if (stop !== null) logger.warn('PREPARATION_STOPPED', `投稿の準備（AIによる解析・文章作成）を止めています: ${stop.message}`, { error_code: stop.code });
      else if (this.#stopLogged !== null) logger.info('PREPARATION_RESUMED', '投稿の準備を再開します。');
      this.#stopLogged = key;
    }
    return stop === null;
  }

  #logHold(s: JobSummary): void {
    const hold = this.#d.pipeline.holdFor?.(s) ?? null;
    if (hold === null) {
      this.#heldLogged.delete(s.id);
      return;
    }
    const key = `${hold.code}|${hold.message}`;
    if (this.#heldLogged.get(s.id) === key) return;
    this.#heldLogged.set(s.id, key);
    this.#d.logger.info('JOB_HELD', `準備を保留しています: ${s.id}（${hold.message}）`, {
      job_id: s.id,
      post_type: s.post_type,
      audience_category: s.audience_category,
      error_code: hold.code,
    });
  }

  /**
   * A41: every READY job never handed to a poster whose config_hash is not the pipeline's current recheck key is checked
   * against the current rules (also one that was in the middle of a file move when the rules changed), one per call when
   * it has to be written again. One that cannot be checked yet stays stale (isCurrent) and is tried again on the next
   * call. true = a job went back to GENERATING or PENDING.
   */
  async #recheckReady(): Promise<boolean> {
    const { pipeline, store, logger } = this.#d;
    if (pipeline.recheck === undefined || pipeline.recheckKey === undefined) return false;
    const key = pipeline.recheckKey();
    if (key === null) return false;
    const stale = store.summaries((s) => s.status === 'READY' && !s.has_operation && s.never_submitted && s.config_hash !== key && this.#handles(s)).sort(byAge);
    for (const { id } of stale) {
      try {
        const job = await store.get(id);
        if (job === null || job.status !== 'READY' || job.operation !== null || job.config_hash === key || !neverSubmitted(job)) continue;
        const outcome = await pipeline.recheck(job);
        if (outcome.kind === 'skip') return false; // not checkable yet (e.g. no templates): tried again on the next call
        if (outcome.kind === 'current') {
          await store.update(job.id, job.revision, (j) => ({ ...j, ...outcome.record }));
          continue;
        }
        if (outcome.kind === 'restart') {
          const next = await store.update(job.id, job.revision, (j) => ({
            ...j,
            status: 'PENDING',
            stage: INTAKE_STAGE,
            analysis: null,
            draft: null,
            regeneration_count: 0,
            last_error: outcome.error,
          }));
          logger.info('JOB_REVALIDATION_FAILED', `投稿待ちの文章を今の設定で確かめられないため、画像の解析から準備し直します: ${job.id}（${outcome.error.message}）`, {
            ...this.#fieldsOf(next),
            validation_error_code: outcome.error.code,
          });
          return true;
        }
        const next = await store.update(job.id, job.revision, (j) => ({
          ...j,
          status: 'GENERATING',
          stage: 'generate',
          regeneration_count: 0,
          last_error: outcome.error,
        }));
        this.#resume.set(next.id, 'GENERATING');
        logger.info('JOB_REVALIDATION_FAILED', `設定・作業指示書の変更で投稿待ちの文章が検査に通らなくなったため、作り直します: ${job.id}（${outcome.error.message}）`, {
          ...this.#fieldsOf(next),
          validation_error_code: outcome.error.code,
        });
        return true;
      } catch (err) {
        const warned = `${id}|${key}|${errorCodeOf(err)}`;
        if (this.#recheckWarned.has(warned)) continue;
        this.#recheckWarned.add(warned);
        logger.warn('JOB_REVALIDATION_SKIPPED', `投稿待ちの文章を設定の変更に合わせて確認できませんでした（確かめられるまで投稿には使わず、次の確認でもう一度試します）: ${errorMessageOf(err)}`, {
          job_id: id,
          error_code: errorCodeOf(err),
          cause: causeOf(err),
        });
      }
    }
    return false;
  }

  /**
   * advanced: the job was in the expected state and has left it (prepared, failed, or stopped at a later stage);
   * deferred: the pipeline asked it to wait; skipped: it could not be worked on (a PENDING one is parked until the next
   * start: gone, changed, or its first save failed).
   */
  async #execute(id: string, expected: 'PENDING' | ResumeStage): Promise<'advanced' | 'deferred' | 'skipped'> {
    let started = false;
    let deferred = false;
    try {
      const job = await this.#d.store.get(id);
      if (job !== null && job.status === expected && job.operation === null) {
        started = true;
        await this.#advance(job);
      }
    } catch (err) {
      if (err instanceof PreparationDeferred) {
        deferred = true;
        await this.#defer(id, err);
      } else {
        await this.#fail(id, err);
      }
    }
    if (deferred) return 'deferred';
    const status = this.#d.store.summaries((s) => s.id === id)[0]?.status;
    if (expected === 'PENDING' && status === 'PENDING') {
      this.#parked.add(id);
      this.#d.logger.warn('JOB_PARKED', `準備を進められなかったため、次の起動までこのjobは処理しません: ${id}`, { job_id: id });
    }
    return started && status !== undefined && status !== expected ? 'advanced' : 'skipped';
  }

  async #advance(start: Job): Promise<void> {
    const { store, pipeline, logger } = this.#d;
    let job = start;
    if (job.status === 'PENDING') {
      job = await store.update(job.id, job.revision, (j) => ({ ...j, status: 'ANALYZING', stage: 'analyze' }));
      const analysis = (await pipeline.analyze(job)) ?? null;
      job = await store.update(job.id, job.revision, (j) => ({ ...j, analysis, status: 'GENERATING', stage: 'generate' }));
    }
    // A job resumed at VALIDATING checks the draft it already has before anything is generated again.
    let generate = job.status !== 'VALIDATING';
    for (;;) {
      let result: ValidationOutcome;
      if (generate) {
        const made = await this.#generate(job);
        job = made.job;
        result = made.outcome ?? (await pipeline.validate(job));
      } else {
        result = await pipeline.validate(job);
      }
      generate = true;
      if (result.ok) {
        job = await store.update(job.id, job.revision, (j) => ({ ...j, ...(result.record ?? {}), status: 'READY', stage: 'ready', last_error: null }));
        logger.info('JOB_READY', `投稿の準備ができました: ${job.id}`, this.#fieldsOf(job));
        return;
      }
      if (result.regenerate && job.regeneration_count < this.#d.getSettings().ai.max_regenerations) {
        // The reasons stay on the job, so the next draft can be told what to fix (also after a restart).
        job = await store.update(job.id, job.revision, (j) => ({
          ...j,
          regeneration_count: j.regeneration_count + 1,
          status: 'GENERATING',
          stage: 'generate',
          last_error: result.error,
        }));
        logger.info('JOB_REGENERATING', `検証に通らなかったため文章を作り直します（${job.regeneration_count}回目）: ${job.id}`, {
          ...this.#fieldsOf(job),
          regeneration_count: job.regeneration_count,
          validation_error_code: result.error.code,
        });
        continue;
      }
      await this.#markFailed(job, result.regenerate ? this.#limitReached(result.error) : result.error);
      return;
    }
  }

  /**
   * One draft, saved as VALIDATING. An answer the AI could not give in the required form (AI_OUTPUT_INVALID) is a draft
   * that failed its checks (spec 15.1): `outcome` says so and nothing is saved.
   */
  async #generate(job: Job): Promise<{ job: Job; outcome: ValidationOutcome | null }> {
    const { store, pipeline } = this.#d;
    try {
      const draft = (await pipeline.generate(job)) ?? null;
      const provenance = pipeline.provenance?.(job.id) ?? null;
      const saved = await store.update(job.id, job.revision, (j) => ({ ...j, draft, draft_provenance: provenance, status: 'VALIDATING', stage: 'validate' }));
      return { job: saved, outcome: null };
    } catch (err) {
      if (!isOutputInvalid(err)) throw err;
      // The API refused the request itself (not retryable, an HTTP status): a new draft would be refused the same way.
      if (!err.error.retryable && typeof err.error.details_redacted.status === 'number') throw err;
      return { job, outcome: { ok: false, error: err.error, regenerate: true } };
    }
  }

  #limitReached(last: AppError): AppError {
    return appError('VALIDATION_FAILED', last.stage, this.#d.clock, {
      message: `${ERROR_MESSAGES_JA.VALIDATION_FAILED}最後の検査結果: ${last.message}`,
      details: { ...last.details_redacted, validation_error_code: last.code },
    });
  }

  /**
   * Puts a deferred job back where it can restart (ANALYZING → PENDING; GENERATING stays; VALIDATING stays when it has a
   * draft) and keeps it waiting until the deferral's time. Never throws: a job that cannot be saved is left for recovery.
   */
  async #defer(id: string, deferred: PreparationDeferred): Promise<void> {
    const { store, logger } = this.#d;
    try {
      const job = await store.get(id);
      if (job === null || job.operation !== null || !(job.status === 'PENDING' || INTERRUPTED.has(job.status))) {
        logger.error('JOB_DEFER_NOT_SAVED', `準備を待たせようとしましたが、jobの状態が想定と異なるため何もしませんでした: ${id}`, {
          job_id: id,
          status: job?.status ?? null,
          error_code: deferred.error.code,
        });
        return;
      }
      const restart: 'PENDING' | ResumeStage =
        job.status === 'PENDING' || job.status === 'ANALYZING' || job.analysis === null
          ? 'PENDING'
          : job.status === 'VALIDATING' && job.draft !== null
            ? 'VALIDATING'
            : 'GENERATING';
      const stage = restart === 'PENDING' ? INTAKE_STAGE : restart === 'VALIDATING' ? 'validate' : 'generate';
      // last_error is left alone: it may hold the findings the next draft must fix.
      const saved = job.status === restart ? job : await store.update(job.id, job.revision, (j) => ({ ...j, status: restart, stage }));
      if (restart !== 'PENDING') this.#resume.set(id, restart);
      this.#waitUntil.set(id, deferred.retryAt.getTime());
      logger.warn('JOB_WAITING', `${deferred.error.message}（${formatJst(deferred.retryAt)} 以降にもう一度試します）: ${id}`, {
        ...this.#fieldsOf(saved),
        error_code: deferred.error.code,
        retry_at: deferred.retryAt.toISOString(),
      });
    } catch (err) {
      logger.error('JOB_DEFER_NOT_SAVED', `準備を待たせる記録を保存できませんでした（次の起動時の復旧に任せます）: ${errorMessageOf(err)}`, {
        job_id: id,
        error_code: errorCodeOf(err),
        original_error_code: deferred.error.code,
        cause: causeOf(err),
      });
      this.#waitUntil.set(id, deferred.retryAt.getTime());
    }
  }

  /** Turns an exception raised while preparing `id` into a FAILED job. Never throws. */
  async #fail(id: string, cause: unknown): Promise<void> {
    const { store, logger, clock } = this.#d;
    let job: Job | null;
    try {
      job = await store.get(id);
    } catch (err) {
      logger.error('JOB_FAILURE_NOT_SAVED', `失敗したjobを読み直せないため、失敗として保存できませんでした: ${errorMessageOf(err)}`, {
        job_id: id,
        error_code: errorCodeOf(err),
        original_error_code: errorCodeOf(cause),
        cause: causeOf(err),
      });
      return;
    }
    if (job === null || job.operation !== null || !(job.status === 'PENDING' || INTERRUPTED.has(job.status))) {
      logger.error('JOB_FAILURE_NOT_SAVED', `準備中に失敗しましたが、jobの状態が想定と異なるため失敗として保存しませんでした: ${id}`, {
        job_id: id,
        status: job?.status ?? null,
        error_code: errorCodeOf(cause),
        cause: causeOf(cause),
      });
      return;
    }
    const error =
      cause instanceof AppFailure
        ? cause.error
        : appError('INTERNAL_ERROR', job.stage, clock, {
            message: `想定外のエラーが発生したため、処理を止めました（${errorMessageOf(cause)}）。詳細はログを確認してください。`,
            details: { exception: errorMessageOf(cause) },
          });
    await this.#markFailed(job, error, cause);
  }

  /** Moves the job to FAILED (bundle to images/failed/) and writes failure.json. Never throws: problems are logged. */
  async #markFailed(job: Job, error: AppError, cause?: unknown): Promise<void> {
    const { bundles, logger, clock, paths } = this.#d;
    let failed: Job | null;
    let recorded = error;
    try {
      failed = await bundles.transition(job.id, job.revision, (j) => ({ ...j, status: 'FAILED', last_error: error }));
    } catch (err) {
      if (!(err instanceof AppFailure) || err.error.code !== 'IMAGE_NOT_FOUND') {
        logger.error('JOB_FAILURE_NOT_SAVED', `失敗として保存できませんでした（次の起動時の復旧に任せます）: ${errorMessageOf(err)}`, {
          ...this.#fieldsOf(job),
          error_code: errorCodeOf(err),
          original_error_code: error.code,
          cause: causeOf(err),
        });
        return;
      }
      // The bundle folder is gone, so there is nothing to move: record the failure in the job file alone (R17).
      recorded = { ...err.error, details_redacted: { ...err.error.details_redacted, original_error_code: error.code } };
      failed = await this.#failInPlace(job, recorded);
      if (failed === null) return;
    }
    this.#waitUntil.delete(failed.id);
    this.#heldLogged.delete(failed.id);
    logger.error('JOB_FAILED', `${failed.id} を失敗として保存しました: ${recorded.message}`, {
      ...this.#fieldsOf(failed),
      error_code: recorded.code,
      ...(cause instanceof Error && !(cause instanceof AppFailure)
        ? { exception: cause.name, stack: cause.stack?.slice(0, MAX_LOGGED_STACK) ?? null }
        : {}),
    });
    try {
      await writeFailureFile(paths, failed, clock);
    } catch (err) {
      // The FAILED job is already saved; failure.json is only a readable copy.
      logger.error('FAILURE_FILE_FAILED', `failure.json を書けませんでした（jobは失敗として保存済みです）: ${errorMessageOf(err)}`, {
        ...this.#fieldsOf(failed),
        error_code: errorCodeOf(err),
        cause: causeOf(err),
      });
    }
  }

  // R17 without a folder to move: the job file alone records the failure, saved against the revision the caller read (the
  // refused move wrote nothing). A job changed meanwhile, or gone, is not overwritten but left to the startup recovery.
  async #failInPlace(job: Job, error: AppError): Promise<Job | null> {
    const { store, logger } = this.#d;
    try {
      return await store.update(job.id, job.revision, (j) => ({ ...j, status: 'FAILED', last_error: error }));
    } catch (err) {
      const message = `失敗として保存できませんでした（画像のフォルダが無いためjobへの記録だけを試みました。次の起動時の復旧に任せます）: ${errorMessageOf(err)}`;
      logger.error('JOB_FAILURE_NOT_SAVED', message, { ...this.#fieldsOf(job), error_code: errorCodeOf(err), original_error_code: error.code, cause: causeOf(err) });
      return null;
    }
  }

  #fieldsOf(job: Job): { job_id: string; stage: string; post_type: Job['post_type']; audience_category: Job['audience_category'] } {
    return { job_id: job.id, stage: job.stage, post_type: job.post_type, audience_category: job.audience_category };
  }
}
