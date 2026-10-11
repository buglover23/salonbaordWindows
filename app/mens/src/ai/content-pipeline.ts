import { z } from 'zod';
import type { ConfigSnapshot } from '../config/loader.js';
import type { EffectiveConfig } from '../content/effective-config.js';
import type { InstructionScanResult } from '../content/instructions/store.js';
import type { TemplateLibrary } from '../content/templates.js';
import type {
  ContentPipeline,
  PreparationHold,
  ReadyRecord,
  RecheckOutcome,
  ValidationOutcome,
} from '../execution/job-processor.js';
import { PreparationDeferred } from '../execution/job-processor.js';
import type { AppLogger } from '../logger.js';
import { layoutProfile } from '../posting/profile/route-resolve.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, type AppError, type ErrorCode } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import type { Job } from '../shared/job-schema.js';
import { graphemeSlice } from '../shared/text.js';
import type { RetryOptions } from '../storage/atomic-json.js';
import type { JobSummary } from '../storage/job-store.js';
import type { DataPaths } from '../storage/paths.js';
import type { ConsistencyCheckDeps } from '../validation/consistency-check.js';
import { collectDuplicateCandidates, type DedupeReader } from '../validation/duplicates.js';
import { checkDuplicateRule } from '../validation/rules/duplicates.js';
import { fieldJa, toDraftViolations, type ValidationContext, type Violation } from '../validation/types.js';
import { loadValidationInputs, runDeterministicChecks, validateDraft, type ValidationSources } from '../validation/validator.js';
import type { AiService } from './ai-service.js';
import { AnalysisSchema, type Analysis } from './analysis-schema.js';
import { analyzeJob, retryCommandFor } from './analyzer.js';
import {
  STYLE_MENUS_MISSING_STATUS,
  buildGenerationContext,
  combineRecentPatterns,
  instructionView,
  JobDraftPatterns,
  styleMenusMissing,
  type GenerationContext,
  type InstructionView,
  type TrendSource,
} from './context.js';
import { DraftSchema, type Draft, type DraftViolation } from './draft-schemas.js';
import { generateDraft } from './generator.js';
import { StagedAiProvider } from './registry.js';
import type { PreviousAttempt } from './prompts/common.js';

// The real ContentPipeline (Plan 2 Task 9): analysis (analyzer.ts), generation from the GenerationContext (context.ts,
// generator.ts) and the Validator (validator.ts) behind the Plan 1 JobProcessor, which keeps owning the job states, the
// regeneration loop (ai.max_regenerations, spec 10.2) and failure.json. This class decides what a failed AI call means:
// a stop of all AI work (budget, key, AI settings), a wait (transient problems, bounded per job), or a failed job.

/** A job that keeps meeting a transient problem fails after this many waits (spec 15.1: AI retries have an upper limit). */
export const MAX_PREPARATION_WAITS = 3;
/** Wait before the 1st, 2nd and 3rd retry of a job after a transient problem. */
export const PREPARATION_WAIT_MS: readonly number[] = [60_000, 300_000, 900_000];
/** A job stopped by a stop of all AI work is looked at again after this long (the stop check decides when it resumes). */
const STOP_RECHECK_MS = 60_000;
/** Findings listed in the Japanese message of a failed validation (all of them stay in the details). */
const MAX_LISTED_FINDINGS = 5;
const MAX_STORED_FINDINGS = 20;
const MAX_STORED_EXCERPT = 80;

/** Problems that pass by themselves: the job waits instead of failing. */
const WAIT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['FILE_IO_ERROR', 'DISK_FULL']);
const DUPLICATE_RULES: ReadonlySet<string> = new Set([
  'duplicate_title',
  'duplicate_body',
  'near_duplicate_title',
  'near_duplicate_body',
  'copied_previous_text',
  'excel_title_copy',
  'excel_comment_copy',
]);
/** last_error codes whose details carry the findings the next draft must fix. */
const FEEDBACK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['VALIDATION_FAILED', 'DUPLICATE_CONTENT', 'AI_OUTPUT_INVALID']);

const StoredViolationSchema = z.object({
  field: z.string(),
  rule: z.string(),
  actual: z.union([z.number(), z.string()]).nullable(),
  limit: z.union([z.number(), z.string()]).nullable(),
  offending_text: z.string().nullable(),
  message: z.string(),
});

type Step = 'analyze' | 'generate' | 'validate';

export interface TemplateHolder {
  readonly library: TemplateLibrary | null;
  readonly problem: AppError | null;
}

export interface ContentPipelineDeps {
  ai: Pick<AiService, 'provider' | 'stop' | 'noteFailure' | 'noteSuccess'>;
  snapshot: () => ConfigSnapshot;
  /** config + instruction overlay: keywords, exclusions, writing policies; its hash is the A41 recheck key. */
  effective: () => EffectiveConfig;
  /** The latest instruction scan (files cited as instruction refs); null before the first one. */
  instructions: () => InstructionScanResult | null;
  templates: TemplateHolder;
  /** Public trend records already in memory (TrendFeed); null: none configured. */
  trends: TrendSource | null;
  /** history.json and the job store (recent patterns, duplicate candidates), dedupe.json for older hashes. */
  sources: ValidationSources & { dedupe?: DedupeReader };
  paths: DataPaths;
  clock: Clock;
  logger: AppLogger;
  retry?: RetryOptions;
}

interface Memo {
  /** sha256 of the draft this context produced. */
  draftKey: string;
  /** The effective hash the context was built under: a memo made under older rules is not used (A41). */
  hash: string;
  context: GenerationContext;
  generatorViolations: DraftViolation[];
}

const draftKeyOf = (draft: unknown): string => sha256Hex(JSON.stringify(draft));

/** A failed validation as the job's error: the findings in Japanese (message) and as data for the next draft (details). */
export function validationError(violations: readonly Violation[], clock: Clock): AppError {
  const code: ErrorCode = violations.length > 0 && violations.every((v) => DUPLICATE_RULES.has(v.rule)) ? 'DUPLICATE_CONTENT' : 'VALIDATION_FAILED';
  const listed = violations.slice(0, MAX_LISTED_FINDINGS).map((v) => `${fieldJa(v.field)}: ${v.reason_ja}`);
  const more = violations.length > MAX_LISTED_FINDINGS ? ` ほか${violations.length - MAX_LISTED_FINDINGS}件` : '';
  const stored = toDraftViolations(violations.slice(0, MAX_STORED_FINDINGS)).map((v) => ({
    ...v,
    offending_text: v.offending_text === null ? null : graphemeSlice(v.offending_text, MAX_STORED_EXCERPT),
  }));
  return appError(code, 'validate', clock, {
    message: `生成した文章が検査に通りませんでした（${violations.length}件）: ${listed.join(' ／ ')}${more}`,
    retryable: false,
    details: { violations: stored, findings: violations.length, rules: [...new Set(violations.map((v) => v.rule))].slice(0, MAX_STORED_FINDINGS) },
  });
}

/** The previous draft and what was wrong with it, for a regeneration (from the job, so it survives a restart). */
export function previousAttemptOf(job: Job): PreviousAttempt | undefined {
  if (job.regeneration_count === 0) return undefined;
  const draft = DraftSchema.safeParse(job.draft);
  const error = job.last_error;
  if (!draft.success || error === null || !FEEDBACK_CODES.has(error.code)) return undefined;
  const stored = z.array(StoredViolationSchema).safeParse(error.details_redacted.violations);
  const violations: DraftViolation[] = stored.success
    ? stored.data
    : [{ field: '(全体)', rule: error.code.toLowerCase(), actual: null, limit: null, offending_text: null, message: error.message }];
  return { draft: draft.data, violations };
}

export class RealContentPipeline implements ContentPipeline {
  readonly #d: ContentPipelineDeps;
  /** Transient problems per job since its last successful step. */
  readonly #waits = new Map<string, number>();
  readonly #memo = new Map<string, Memo>();
  readonly #provenance = new Map<string, NonNullable<Job['draft_provenance']>>();

  constructor(d: ContentPipelineDeps) {
    this.#d = d;
  }

  async stopped(): Promise<PreparationHold | null> {
    const ai = await this.#d.ai.stop(this.#d.clock.now());
    if (ai !== null) return { code: ai.code, message: ai.message };
    const templates = this.#d.templates.problem;
    if (templates !== null) return { code: templates.code, message: `${templates.message} テンプレートが読めるまで文章の生成を保留します。` };
    return null;
  }

  /** Ruling P2-R9 / Task 7: style jobs wait (no analysis, no AI cost) while no verified menu is registered. */
  holdFor(job: JobSummary): PreparationHold | null {
    if (job.post_type === 'style' && styleMenusMissing(this.#d.snapshot())) return { code: 'CONFIG_INCOMPLETE', message: STYLE_MENUS_MISSING_STATUS };
    return null;
  }

  provenance(jobId: string): Job['draft_provenance'] {
    const p = this.#provenance.get(jobId) ?? null;
    this.#provenance.delete(jobId);
    return p;
  }

  recheckKey(): string | null {
    return this.#d.effective().hash;
  }

  analyze(job: Job): Promise<unknown> {
    return this.#step(job, 'analyze', async () => {
      const provider = this.#provider();
      const { paths, clock, logger, retry } = this.#d;
      return analyzeJob({ provider, paths, snapshot: this.#d.snapshot(), clock, logger, ...(retry === undefined ? {} : { retry }) }, job);
    });
  }

  generate(job: Job): Promise<unknown> {
    return this.#step(job, 'generate', async () => {
      const provider = this.#provider();
      const { paths, clock, logger, retry } = this.#d;
      const hash = this.#d.effective().hash;
      const context = await this.#context(job);
      const snapshot = this.#d.snapshot();
      const result = await generateDraft(
        { provider, paths, clock, logger, maxInputPixels: snapshot.settings.resources.max_input_pixels, ...(retry === undefined ? {} : { retry }) },
        job,
        context,
        previousAttemptOf(job),
      );
      this.#memo.set(job.id, { draftKey: draftKeyOf(result.draft), hash, context, generatorViolations: result.violations });
      // P3-R41: the service that wrote it (the generation stage's own service when stages differ).
      const name = provider instanceof StagedAiProvider ? provider.stages.generation.name : provider.name;
      if (name !== 'staged') this.#provenance.set(job.id, { provider: name, model: result.model, prompt_version: null, generated_at: clock.now().toISOString() });
      return result.draft;
    });
  }

  validate(job: Job): Promise<ValidationOutcome> {
    return this.#step(job, 'validate', async () => {
      const memo = this.#memo.get(job.id);
      const current = this.#d.effective().hash;
      const usable = memo !== undefined && memo.draftKey === draftKeyOf(job.draft) && memo.hash === current;
      const hash = usable ? memo.hash : current;
      const context = usable ? memo.context : await this.#context(job);
      const vctx = await this.#validationContext(job, context, usable ? memo.generatorViolations : []);
      const outcome = await validateDraft(vctx, job.draft);
      if (!outcome.ok) {
        this.#memo.delete(job.id);
        return { ok: false, error: validationError(outcome.violations, this.#d.clock), regenerate: outcome.regenerate };
      }
      // Spec 10.3: compared once more right before READY, with the candidates as they are now (the AI check takes time).
      const draft = DraftSchema.parse(job.draft);
      const fresh = await collectDuplicateCandidates(this.#d.sources, { jobId: job.id, recentPosts: vctx.snapshot.settings.duplicates.recent_posts });
      const late = checkDuplicateRule(draft, { ...vctx, duplicates: fresh });
      this.#memo.delete(job.id);
      if (late.length > 0) return { ok: false, error: validationError(late, this.#d.clock), regenerate: true };
      if (outcome.check !== null) {
        this.#d.logger.info('DRAFT_CHECKED', `画像との整合チェックに合格しました: ${job.id}（${outcome.check.claims.length}件の記述を確認）`, {
          job_id: job.id,
          stage: 'validate',
          post_type: job.post_type,
          audience_category: job.audience_category,
          model: outcome.check.model,
        });
      }
      return { ok: true, record: this.#record(job, draft, context, hash) };
    });
  }

  /**
   * A41: a READY draft checked against the current rules without any AI call (deterministic checks only). Skipped while
   * the templates are not available (the context cannot be built).
   */
  async recheck(job: Job): Promise<RecheckOutcome> {
    if (this.#d.templates.library === null) return { kind: 'skip' };
    const { clock } = this.#d;
    // A draft or analysis this version cannot read (e.g. one made before the AI pipeline) never stays READY.
    if (!AnalysisSchema.safeParse(job.analysis).success) {
      return { kind: 'restart', error: appError('VALIDATION_FAILED', 'validate', clock, { message: '保存されている画像解析の結果が今の形式ではないため、解析からやり直します。' }) };
    }
    const draft = DraftSchema.safeParse(job.draft);
    if (!draft.success || draft.data.post_type !== job.post_type) {
      return { kind: 'regenerate', error: appError('VALIDATION_FAILED', 'validate', clock, { message: '投稿待ちの下書きが今の形式ではないため、作り直します。' }) };
    }
    const hash = this.#d.effective().hash;
    let context: GenerationContext;
    try {
      context = await this.#context(job);
    } catch (err) {
      if (err instanceof AppFailure) return { kind: 'regenerate', error: err.error };
      throw err;
    }
    const violations = runDeterministicChecks(await this.#validationContext(job, context, [], false), draft.data);
    if (violations.length > 0) return { kind: 'regenerate', error: validationError(violations, this.#d.clock) };
    return { kind: 'current', record: this.#record(job, draft.data, context, hash) };
  }

  #provider() {
    const provider = this.#d.ai.provider();
    // stopped() reports why; a job that got here anyway waits for it.
    if (provider === null) {
      throw new PreparationDeferred(
        appError('CONFIG_INCOMPLETE', 'ai', this.#d.clock, { message: 'AIを使えないため、準備を待っています（状態表示で理由を確認してください）。' }),
        new Date(this.#d.clock.now().getTime() + STOP_RECHECK_MS),
      );
    }
    return provider;
  }

  #templates(): TemplateLibrary {
    const library = this.#d.templates.library;
    if (library === null) {
      const problem = this.#d.templates.problem ?? appError('TEMPLATE_MISSING', 'templates', this.#d.clock);
      throw new PreparationDeferred(problem, new Date(this.#d.clock.now().getTime() + STOP_RECHECK_MS));
    }
    return library;
  }

  #analysis(job: Job): Analysis {
    const parsed = AnalysisSchema.safeParse(job.analysis);
    if (parsed.success) return parsed.data;
    throw new AppFailure(
      appError('INTERNAL_ERROR', 'generate', this.#d.clock, {
        message: `保存されている画像解析の結果を読み取れないため、文章を作れません。${retryCommandFor(job.id)} で解析からやり直してください。`,
        retryable: false,
        details: { job_id: job.id },
      }),
    );
  }

  #instructionView(snapshot: ConfigSnapshot): InstructionView {
    const effective = this.#d.effective();
    const scan = this.#d.instructions();
    const files = instructionView(snapshot, scan === null ? null : { effective: scan.overlay, applied: scan.applied });
    return {
      keywordsFor: (t, a) => effective.keywordsFor(t, a),
      excludedKeywords: effective.excludedKeywords,
      writingPolicies: (t, a) => effective.writingPolicies(t, a),
      ...(files.filesFor === undefined ? {} : { filesFor: files.filesFor }),
    };
  }

  #context(job: Job): Promise<GenerationContext> {
    const snapshot = this.#d.snapshot();
    const { sources, paths, clock, logger, retry } = this.#d;
    const scheduledAt = job.scheduled_at === null ? clock.now() : new Date(job.scheduled_at);
    return buildGenerationContext(
      {
        snapshot,
        paths,
        templates: this.#templates(),
        trends: this.#d.trends,
        instructions: this.#instructionView(snapshot),
        recent: combineRecentPatterns(sources.history, new JobDraftPatterns(sources.jobs)),
        clock,
        logger,
        // P2-D10 / P3-R8: the verified page profile of the job's route sets limits, hashtag placement and encoding.
        profile: layoutProfile(this.#d.effective(), job.post_type, job.audience_category),
        ...(retry === undefined ? {} : { retry }),
      },
      job,
      this.#analysis(job),
      scheduledAt,
    );
  }

  /** `withCheck`: false for the deterministic checks alone (no AI provider needed). */
  async #validationContext(job: Job, context: GenerationContext, generatorViolations: DraftViolation[], withCheck = true): Promise<ValidationContext> {
    const snapshot = this.#d.snapshot();
    const { paths, clock, logger, retry } = this.#d;
    // The A41 recheck (withCheck false: right before sending) compares with posted history only.
    const inputs = await loadValidationInputs(this.#d.sources, job, snapshot, { pendingDrafts: withCheck });
    const check: ConsistencyCheckDeps | undefined =
      withCheck && snapshot.settings.ai.consistency_check === 'final_only'
        ? {
            provider: this.#provider(),
            paths,
            clock,
            logger,
            maxInputPixels: snapshot.settings.resources.max_input_pixels,
            ...(retry === undefined ? {} : { retry }),
          }
        : undefined;
    return {
      job,
      generation: context,
      snapshot,
      recent: inputs.recent,
      duplicates: inputs.duplicates,
      generatorViolations,
      ...(check === undefined ? {} : { check }),
    };
  }

  /**
   * What the READY job records about how its draft was made (spec 11.1). config_hash is the A41 recheck key: the hash the
   * context was built under, so a change made meanwhile is caught by the next recheck.
   */
  #record(job: Job, draft: Draft, context: GenerationContext, hash: string): ReadyRecord {
    const scan = this.#d.instructions();
    const files = new Set(context.refs.instruction_files);
    const refs = new Map<string, string>();
    for (const a of scan?.applied ?? []) if (files.has(a.file) && !refs.has(a.file)) refs.set(a.file, a.sha256);
    return {
      content_hash: draftKeyOf(draft),
      config_hash: hash,
      instruction_refs: [...refs].map(([file_name, sha256]) => ({ file_name, sha256 })),
      template_hash: context.refs.template_hash,
      trend_source_refs: [...context.refs.trend_source_refs],
    };
  }

  /** Runs one step; a failure becomes a stop, a wait (PreparationDeferred) or the job's failure. */
  async #step<T>(job: Job, step: Step, fn: () => Promise<T>): Promise<T> {
    try {
      const value = await fn();
      this.#waits.delete(job.id);
      this.#d.ai.noteSuccess(step);
      return value;
    } catch (err) {
      throw this.#onFailure(job, step, err);
    }
  }

  #onFailure(job: Job, step: Step, err: unknown): unknown {
    if (!(err instanceof AppFailure)) return err;
    const { clock } = this.#d;
    const now = clock.now();
    const error = err.error;
    const kind = this.#d.ai.noteFailure(error, now, step);
    if (kind === 'stop') return new PreparationDeferred(error, new Date(now.getTime() + STOP_RECHECK_MS));
    // The provider says asking again cannot help (e.g. it refused this photo): fail now with its own message.
    if (error.code === 'AI_OUTPUT_INVALID' && !error.retryable) return err;
    // An answer that is not in the required form is a draft to regenerate during generation (JobProcessor); in analysis
    // and in the consistency check it is waited out like a transient problem (a failed check never passes a draft).
    const waits = kind === 'wait' || WAIT_CODES.has(error.code) || (error.code === 'AI_OUTPUT_INVALID' && step !== 'generate');
    if (!waits) return err;
    // A pacing or rest refusal the provider made before sending anything (details.reason, attempts 1) costs nothing:
    // the job simply comes back at resume_at without spending a wait (Task 10 integration table).
    const d = error.details_redacted;
    const resumeAt = typeof d.resume_at === 'string' ? Date.parse(d.resume_at) : Number.NaN;
    if (kind === 'wait' && typeof d.reason === 'string' && d.attempts === 1 && !Number.isNaN(resumeAt)) {
      return new PreparationDeferred(error, new Date(Math.max(resumeAt, now.getTime())));
    }
    const n = (this.#waits.get(job.id) ?? 0) + 1;
    if (n > MAX_PREPARATION_WAITS) {
      this.#waits.delete(job.id);
      return new AppFailure(
        appError(error.code, step, clock, {
          message: `${error.message} 時間をおいて${MAX_PREPARATION_WAITS}回やり直しても解決しなかったため、失敗として保存しました。原因（AIサービスの状況・ネットワーク・ファイルの使用中など）を確認してから、${retryCommandFor(job.id)} で再開してください。`,
          retryable: true,
          details: { ...error.details_redacted, preparation_waits: MAX_PREPARATION_WAITS },
        }),
      );
    }
    this.#waits.set(job.id, n);
    const backoff = PREPARATION_WAIT_MS[Math.min(n - 1, PREPARATION_WAIT_MS.length - 1)] ?? 60_000;
    const retryAfter = typeof error.details_redacted.retry_after_seconds === 'number' ? error.details_redacted.retry_after_seconds * 1000 : 0;
    return new PreparationDeferred(error, new Date(Math.max(now.getTime() + Math.max(backoff, retryAfter), Number.isNaN(resumeAt) ? 0 : resumeAt)));
  }
}
