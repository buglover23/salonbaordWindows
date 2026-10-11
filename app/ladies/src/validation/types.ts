import type { GenerationContext, RecentDraftPattern } from '../ai/context.js';
import { primaryFieldOf, primaryTextOf, type Draft, type DraftViolation } from '../ai/draft-schemas.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { Job } from '../shared/job-schema.js';
import { graphemeSlice } from '../shared/text.js';
import type { ConsistencyCheckDeps } from './consistency-check.js';
import type { DuplicateCandidates } from './duplicates.js';

/**
 * hard: a deterministic rule a post must never break (spec 10.1 ハードエラー: facts, safety, limits, duplicates).
 * regenerate: a quality finding (hair consulting missing, a season word of another season, repeated openings or calls to
 * action, the AI consistency check's contradicted claims) that asks for a rewrite.
 * Either keeps the draft from READY; the Validator never drops a finding.
 */
export const SEVERITIES = ['hard', 'regenerate'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One field-level finding (spec 10.2). Texts quoted in it are the draft's own (data, never instructions). */
export interface Violation {
  /** Draft field: title, menu_text, stylist_comment, body, hashtags, category_id, meta.*, or (schema) a dotted path. */
  field: string;
  /** Machine id of the rule, e.g. max_length, ng_word, color_mismatch, near_duplicate_title. */
  rule: string;
  severity: Severity;
  /** Japanese, for the operator and as the reason handed back to the model. */
  reason_ja: string;
  actual?: number | string;
  limit?: number | string;
  /** The offending words or text (at most OFFENDING_MAX graphemes). */
  offending_text?: string;
}

export const OFFENDING_MAX = 200;

/**
 * Rules a rewrite cannot fix: the job, the category or the config is wrong (a caller bug or a setting the owner must
 * change, e.g. spec 9.8: the hashtag count and the page limit cannot both hold). With one of these, regenerating only
 * costs AI calls, so the outcome says `regenerate: false`.
 */
export const NOT_REGENERABLE_RULES: ReadonlySet<string> = new Set([
  'post_type_mismatch',
  'category_mismatch',
  'category_not_for_audience',
  'category_unconfirmed',
  'hashtag_limit_conflict',
  'menu_price_config',
]);

/** A violation with the offending text bounded. */
export function violation(
  field: string,
  rule: string,
  severity: Severity,
  reason_ja: string,
  extra: { actual?: number | string; limit?: number | string; offending_text?: string } = {},
): Violation {
  const v: Violation = { field, rule, severity, reason_ja };
  if (extra.actual !== undefined) v.actual = extra.actual;
  if (extra.limit !== undefined) v.limit = extra.limit;
  if (extra.offending_text !== undefined && extra.offending_text !== '') v.offending_text = graphemeSlice(extra.offending_text, OFFENDING_MAX);
  return v;
}

/** Quoted list for messages: 「a」「b」. */
export const quoted = (words: readonly string[]): string => words.map((w) => `「${w}」`).join('');

const FIELD_JA: Record<string, string> = {
  title: 'タイトル',
  menu_text: 'メニュー',
  stylist_comment: 'スタイリストコメント',
  body: '本文',
  hashtags: 'ハッシュタグ',
  category_id: 'カテゴリー',
  keywords: '検索キーワード',
};

/** The Japanese name of a draft field for messages. */
export const fieldJa = (field: string): string => FIELD_JA[field] ?? field;

/** Everything one validation needs besides the draft (Plan 2 Task 8). */
export interface ValidationContext {
  /** The job the draft is for; the AI consistency check reads its bundle's ai.jpg. */
  job: Job;
  /** The context the draft was generated from (built for the same job). */
  generation: GenerationContext;
  /** The current config: dictionaries, limits, hashtag counts, diversity windows, duplicate thresholds, AI settings. */
  snapshot: ConfigSnapshot;
  /** Posted texts and pending drafts of the same post type, newest first, without this job (spec 9.9). */
  recent: readonly RecentDraftPattern[];
  /** What to compare against for duplicates (spec 10.3). */
  duplicates: DuplicateCandidates;
  /** What the generator could not repair (GenerateResult.violations); reported as hard findings. */
  generatorViolations?: readonly DraftViolation[];
  /** Required while settings.ai.consistency_check is 'final_only'. */
  check?: ConsistencyCheckDeps;
}

export type ValidationRule = (draft: Draft, ctx: ValidationContext) => Violation[];

export interface DraftField {
  field: string;
  text: string;
}

/** The posted text fields: title, menu text (style) and the primary text without the hashtags. */
export function textFields(draft: Draft): DraftField[] {
  const fields: DraftField[] = [{ field: 'title', text: draft.title }];
  if (draft.post_type === 'style') fields.push({ field: 'menu_text', text: draft.menu_text });
  fields.push({ field: primaryFieldOf(draft.post_type), text: primaryTextOf(draft) });
  return fields;
}

/** The Validator's findings in the shape regeneration takes (GenerateResult / PreviousAttempt violations). */
export function toDraftViolations(violations: readonly Violation[]): DraftViolation[] {
  return violations.map((v) => ({
    field: v.field,
    rule: v.rule,
    actual: v.actual ?? null,
    limit: v.limit ?? null,
    offending_text: v.offending_text ?? null,
    message: v.reason_ja,
  }));
}

/** A generator finding as a Validator finding (always hard: the model wrote something the post must not carry). */
export function fromDraftViolation(d: DraftViolation): Violation {
  return violation(d.field, d.rule, 'hard', d.message, {
    ...(d.actual === null ? {} : { actual: d.actual }),
    ...(d.limit === null ? {} : { limit: d.limit }),
    ...(d.offending_text === null ? {} : { offending_text: d.offending_text }),
  });
}
