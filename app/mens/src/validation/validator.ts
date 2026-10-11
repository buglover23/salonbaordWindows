import { JobDraftPatterns, combineRecentPatterns, type RecentDraftPattern, type RecentPatternsSource } from '../ai/context.js';
import { DraftSchema } from '../ai/draft-schemas.js';
import type { AiUsage } from '../ai/provider.js';
import type { ConfigSnapshot } from '../config/loader.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { runConsistencyCheck, type CheckClaim } from './consistency-check.js';
import { collectDuplicateCandidates, type DuplicateCandidates, type DuplicateSources, type HistoryReader } from './duplicates.js';
import { checkCategoryAndMenus } from './rules/category-menus.js';
import { checkClaims } from './rules/claims.js';
import { checkDuplicateRule } from './rules/duplicates.js';
import { checkHygiene } from './rules/hygiene.js';
import { checkImageConsistency } from './rules/image-consistency.js';
import { checkLimits } from './rules/limits.js';
import { checkQuality } from './rules/quality.js';
import { checkSchema } from './rules/schema.js';
import { NOT_REGENERABLE_RULES, fromDraftViolation, type ValidationContext, type ValidationRule, type Violation } from './types.js';

// The Validator (spec 10, Plan 2 decision 11): deterministic checks in the order of spec 10.1, every finding collected,
// then — only for a draft that passed all of them — the AI consistency check. An AI verdict never removes a deterministic
// finding, and a failed check call never passes a draft.

/** Spec 10.1 steps 2-8, in order (step 1, the schema, runs first on the raw draft). */
export const RULE_GROUPS: readonly { group: number; name: string; rule: ValidationRule }[] = [
  { group: 2, name: 'hygiene', rule: checkHygiene },
  { group: 3, name: 'limits', rule: checkLimits },
  { group: 4, name: 'category_menus', rule: checkCategoryAndMenus },
  { group: 5, name: 'image_consistency', rule: checkImageConsistency },
  { group: 6, name: 'claims', rule: checkClaims },
  { group: 7, name: 'quality', rule: checkQuality },
  { group: 8, name: 'duplicates', rule: checkDuplicateRule },
];

export interface ValidationOutcome {
  /** No finding at all: the draft may become READY. */
  ok: boolean;
  /** Every finding, deterministic ones in spec 10.1 order, then the generator's, then the AI check's. */
  violations: Violation[];
  /**
   * Regenerating may fix the findings: there are some, and none of them needs the owner or a code fix
   * (NOT_REGENERABLE_RULES, e.g. hashtag_limit_conflict). The caller still stops at ai.max_regenerations (spec 10.2).
   */
  regenerate: boolean;
  /** At least one hard finding (spec 10.1: never passes, whatever the AI check says). */
  hard: boolean;
  /** The AI consistency check; null when it did not run (a deterministic finding, or ai.consistency_check 'off'). */
  check: { model: string; usage: AiUsage; claims: CheckClaim[] } | null;
}

function internal(ctx: ValidationContext, message: string, details: Record<string, unknown>): AppFailure {
  return new AppFailure(appError('INTERNAL_ERROR', 'validate', ctx.check?.clock ?? systemClock, { message, retryable: false, details }));
}

const keyOf = (v: Violation): string => JSON.stringify([v.field, v.rule, v.offending_text ?? '']);

/**
 * The deterministic checks only (spec 10.1 steps 1-8 and the generator's findings), e.g. for the re-check right before
 * posting (spec 10.3), which needs no AI call. A draft that does not parse is reported by the schema step alone.
 */
export function runDeterministicChecks(ctx: ValidationContext, draft: unknown): Violation[] {
  if (ctx.generation.job.id !== ctx.job.id || ctx.generation.job.post_type !== ctx.job.post_type || ctx.generation.job.audience_category !== ctx.job.audience_category) {
    throw internal(ctx, `検査に渡された文章生成の参考情報が別のjobのものです（${ctx.generation.job.id}）: ${ctx.job.id}`, {
      job_id: ctx.job.id,
      context_job_id: ctx.generation.job.id,
    });
  }
  const violations = checkSchema(draft, ctx);
  const parsed = DraftSchema.safeParse(draft);
  if (parsed.success) {
    for (const { rule } of RULE_GROUPS) violations.push(...rule(parsed.data, ctx));
  }
  // The generator's findings are about text it already removed (tags) or could not repair; the same finding is not repeated.
  const seen = new Set(violations.map(keyOf));
  for (const g of ctx.generatorViolations ?? []) {
    const v = fromDraftViolation(g);
    if (seen.has(keyOf(v))) continue;
    seen.add(keyOf(v));
    violations.push(v);
  }
  return violations;
}

function outcome(violations: Violation[], check: ValidationOutcome['check']): ValidationOutcome {
  return {
    ok: violations.length === 0,
    violations,
    regenerate: violations.length > 0 && !violations.some((v) => NOT_REGENERABLE_RULES.has(v.rule)),
    hard: violations.some((v) => v.severity === 'hard'),
    check,
  };
}

/**
 * Validates one draft (spec 10): the deterministic groups in order, collecting every finding with a Japanese reason;
 * then, only when none was found and settings.ai.consistency_check is 'final_only', the AI consistency check
 * (contradicted claims → regenerate findings). A failed check call (AI_* errors, image errors) is rethrown: the draft is
 * never passed without it, and the job waits for the next cycle. Without `ctx.check` while the check is on, INTERNAL_ERROR.
 */
export async function validateDraft(ctx: ValidationContext, draft: unknown): Promise<ValidationOutcome> {
  const violations = runDeterministicChecks(ctx, draft);
  if (violations.length > 0 || ctx.snapshot.settings.ai.consistency_check !== 'final_only') return outcome(violations, null);
  const parsed = DraftSchema.parse(draft);
  if (ctx.check === undefined) {
    throw internal(ctx, '画像との整合チェック（ai.consistency_check: final_only）に必要なAIの設定が検査に渡されていません。', { job_id: ctx.job.id });
  }
  const result = await runConsistencyCheck(ctx.check, ctx.job, ctx.generation, parsed);
  return outcome(result.violations, { model: result.model, usage: result.usage, claims: result.claims });
}

// ---------------------------------------------------------------- inputs

export interface ValidationSources extends DuplicateSources {
  /** The posted-text history (HistoryStore): recent patterns and duplicate candidates. */
  history: HistoryReader & RecentPatternsSource;
}

/**
 * The recent patterns (posted + waiting drafts of the job's post type, newest first, without the job) and the duplicate
 * candidates for one job, read fresh from the history and the job store (spec 9.9, 10.3).
 */
export async function loadValidationInputs(
  sources: ValidationSources,
  job: Pick<Job, 'id' | 'post_type'>,
  snapshot: ConfigSnapshot,
  o: { pendingDrafts?: boolean } = {},
): Promise<{ recent: RecentDraftPattern[]; duplicates: DuplicateCandidates }> {
  const { sentence_lookback, pattern_lookback } = snapshot.writingRules.diversity;
  // pendingDrafts false (right before sending): only what was posted counts as recent. Waiting drafts are kept apart
  // when they are written; comparing a draft about to be sent with the newest of many waiting ones made it regenerate
  // at every slot without ever being posted.
  const patterns = o.pendingDrafts === false ? sources.history : combineRecentPatterns(sources.history, new JobDraftPatterns(sources.jobs));
  const recent = await patterns.recent({
    post_type: job.post_type,
    limit: Math.max(sentence_lookback, pattern_lookback),
    exclude_job_id: job.id,
  });
  const duplicates = await collectDuplicateCandidates(sources, { jobId: job.id, recentPosts: snapshot.settings.duplicates.recent_posts });
  return { recent: [...recent], duplicates };
}
