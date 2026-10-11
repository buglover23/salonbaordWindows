import { join } from 'node:path';
import type { RestrictionKind } from '../config/dictionaries.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { AppliedRef, EffectiveOverlay } from '../content/instructions/merge.js';
import type { TemplateImportReport, TemplateLibrary } from '../content/templates.js';
import type { TrendLibrary, TrendRecord } from '../content/trends.js';
import type { AppLogger } from '../logger.js';
import { effectiveLimits, limitLength, type Encoding, type LimitSpec } from '../posting/profile/limits.js';
import { effectivePlacement, type Placement } from '../posting/profile/placement.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import type { Job } from '../shared/job-schema.js';
import { AUDIENCE_JA } from '../shared/labels.js';
import type { PageProfile } from '../shared/protocol/profile.js';
import { graphemeLength, graphemeSlice, splitSentences, type CountUnit } from '../shared/text.js';
import { jstDateKey } from '../shared/time.js';
import type { AudienceCategory, JobStatus, PostType } from '../shared/types.js';
import type { RetryOptions } from '../storage/atomic-json.js';
import { bundleRelDir } from '../storage/bundles.js';
import type { DataPaths } from '../storage/paths.js';
import { SIDECAR_FILE, inspectSidecar } from '../storage/sidecar.js';
import type { Analysis } from './analysis-schema.js';
import { analysisCategories, boundedIds, hintIgnoredMessage, locateBundle, resolveHint, retryCommandFor, type CategoryEntry } from './analyzer.js';
import {
  CTA_PATTERNS,
  DraftSchema,
  MAX_MENU_ITEMS,
  composeMenuText,
  primaryTextOf,
  type ContentAngle,
  type CtaPattern,
  type Draft,
  type TitlePattern,
} from './draft-schemas.js';
import { FACE_SHAPE_TERMS, HAIR_CONSULTING, cleanTagWord, findSalonFact, findUnverifiedTreatment, findUnverifiedTreatments, findWord, looseKey, wordKey } from './word-rules.js';

export { MAX_TAG_GRAPHEMES, cleanTagWord } from './word-rules.js';

// Everything one generation call may rely on (spec 9.1), assembled deterministically from config, the instruction
// overlay, the Excel library, the trend cache, the photo's analysis and sidecar, and recent drafts. Untrusted strings
// (analysis, sidecar notes, Excel rows, trend words, instruction text, recent openings) stay plain data here; the prompt
// builders wrap them as reference data.

const STAGE = 'generate';

/** Trend records below this relevance_score are not offered (trends.ts: 0.9 category match, 0.6 beauty word, 0.3 other). */
export const TREND_MIN_RELEVANCE = 0.5;
export const MAX_EXAMPLES = 5;
export const MAX_PUBLIC_TRENDS = 10;
export const MAX_MANUAL_TRENDS = 10;
export const MAX_EXCEL_TRENDS = 5;
export const MAX_HASHTAG_CANDIDATES = 40;
/** Spec 10.2 / Plan 2 Task 7: aim for 85 % of a limit, so a near miss is still within it. */
export const TARGET_LENGTH_RATIO = 0.85;
/** Recent openings / CTA sentences are shown shortened to this many graphemes. */
export const MAX_RECENT_SENTENCE = 80;
/**
 * Titles of this many recent drafts of the same post type are passed on (more than the openings: spec 10.3 compares
 * titles with far more posts, so a repeated title would only cost a regeneration).
 */
export const RECENT_TITLE_LOOKBACK = 20;
/** Spec 9.4: written only when salon.service_claims.formal_skeletal_diagnosis confirms the salon offers it. */
export const SKELETAL_DIAGNOSIS = '骨格診断';

/**
 * Treatments a photo cannot prove (spec 6.2, 9.8): never claimed, nor used as a keyword or hashtag, unless this photo's
 * sidecar category_hint confirms a category whose words hold them (ruling P2-R15: menu names never do). Extended with
 * the labels and keywords of every requires_verified_menu category (ruling P2-R5), minus words that also belong to a
 * category that needs no verification. verified_terms never add to this list: they only free words on a photo whose
 * category is confirmed (P2-R12).
 */
export const BASE_TREATMENT_TERMS: readonly string[] = ['髪質改善', 'ブリーチ', '縮毛矯正', 'ストレートパーマ', 'ストパー', 'デジタルパーマ', 'デジパ', '白髪染め'];

// ---------------------------------------------------------------- sources

/** The Excel reference library as generation uses it (TemplateLibrary). */
export type TemplateSource = Pick<TemplateLibrary, 'examples' | 'hashtagGroups' | 'trendWords'> & {
  readonly report: Pick<TemplateImportReport, 'workbook_sha256'>;
};

/**
 * Public trend records (TrendLibrary). The caller loads the library (loadCached / importConfigured) at most once per
 * cycle; the context only reads the records already in memory, never the CSV.
 */
/** manualWords: the audience's words in the owner's 手動のトレンド語.xlsx (TrendFeed), used like trends.json trend_words. */
export type TrendSource = Pick<TrendLibrary, 'validRecords'> & { manualWords?(audience: AudienceCategory): readonly string[] };

/** The effective instruction overlay for generation (Plan 2 Task 2 EffectiveConfig fits this shape). */
export interface InstructionView {
  /** Effective priority keywords for the cell (config base, instruction add/replace/delete, instruction exclusions applied). */
  keywordsFor(type: PostType, audience: AudienceCategory): readonly string[];
  /** 除外検索ワード: removed from every keyword source by NFKC exact match. */
  readonly excludedKeywords: readonly string[];
  /** 文章方針 bullets for the cell. */
  writingPolicies(type: PostType, audience: AudienceCategory): readonly string[];
  /** Instruction files that set keywords, exclusions or policies for the cell (cited as instruction:<file>). */
  filesFor?(type: PostType, audience: AudienceCategory): readonly string[];
}

export interface MergedInstructions {
  effective: EffectiveOverlay;
  applied: readonly AppliedRef[];
}

/** An InstructionView from the merged instruction files; without them, the config alone (priority_keywords, no policies). */
export function instructionView(snapshot: ConfigSnapshot, merged?: MergedInstructions | null): InstructionView {
  if (merged === undefined || merged === null) {
    return { keywordsFor: () => snapshot.keywords.priority_keywords, excludedKeywords: [], writingPolicies: () => [], filesFor: () => [] };
  }
  const { effective, applied } = merged;
  return {
    keywordsFor: (t, a) => effective.keywords[t][a],
    excludedKeywords: effective.excluded_keywords,
    writingPolicies: (t, a) => effective.writing_policies[t][a],
    filesFor: (t, a) =>
      applied.filter((r) => r.items.some((i) => i === `keywords.${t}.${a}` || i === `writing_policies.${t}.${a}` || i === 'excluded_keywords')).map((r) => r.file),
  };
}

/** What one recent draft of the same post type used (spec 9.9 rotation). */
export interface RecentDraftPattern {
  job_id: string;
  post_type: PostType;
  /** When the draft was made or posted (ISO); newest first. */
  at: string;
  title: string;
  title_pattern: TitlePattern;
  content_angle: ContentAngle;
  opening_pattern: string;
  cta_pattern: CtaPattern;
  /** First sentence of the primary text (without hashtags). */
  opening: string;
  /** Last sentence of the primary text (the call to action). */
  cta: string;
}

export interface RecentPatternQuery {
  post_type: PostType;
  limit: number;
  /** The job being generated (a regeneration never avoids its own earlier draft as "recent"). */
  exclude_job_id?: string;
}

/** Recent drafts, newest first. Task 8's history store implements it for posted drafts. */
export interface RecentPatternsSource {
  recent(q: RecentPatternQuery): Promise<readonly RecentDraftPattern[]>;
}

/** A line that is only a 【…】 heading (allowed in blog bodies): neither an opening nor a call to action. */
const HEADING_ONLY = /^【[^】]*】$/u;

/** Words that mark the sentence carrying each call to action (spec 9.9). */
const CTA_MARKERS: Record<CtaPattern, readonly string[]> = {
  style_consult: ['相談', 'ヘアコンサルティング', 'カウンセリング', '提案'],
  show_image: ['画像', '写真', '見せ'],
  bookmark: ['ブックマーク', '保存'],
  visit_consult: ['来店'],
  reservation_guidance: ['予約'],
};

/** The sentences of a primary text, without lines that are only a 【…】 heading. */
export const postSentences = (text: string): string[] => splitSentences(text).filter((s) => !HEADING_ONLY.test(s));

/** The call-to-action sentence: the last sentence holding a word of `cta`, otherwise the last sentence ('' if none). */
export function ctaSentence(sentences: readonly string[], cta: CtaPattern): string {
  const marked = sentences.filter((s) => findWord(s, CTA_MARKERS[cta]) !== null);
  return marked.at(-1) ?? sentences.at(-1) ?? '';
}

/**
 * The rotation data of a stored draft: opening = first sentence of the primary text, cta = the sentence carrying the
 * draft's call to action (ctaSentence), both skipping lines that are only a 【…】 heading.
 */
export function patternFromDraft(jobId: string, at: string, draft: Draft): RecentDraftPattern {
  const sentences = postSentences(primaryTextOf(draft));
  return {
    job_id: jobId,
    post_type: draft.post_type,
    at,
    title: draft.title,
    title_pattern: draft.meta.title_pattern,
    content_angle: draft.meta.content_angle,
    opening_pattern: draft.meta.opening_pattern,
    cta_pattern: draft.meta.cta_pattern,
    opening: sentences[0] ?? '',
    cta: ctaSentence(sentences, draft.meta.cta_pattern),
  };
}

const byNewest = (a: RecentDraftPattern, b: RecentDraftPattern): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.job_id < b.job_id ? -1 : 1);

function selectRecent(items: Iterable<RecentDraftPattern>, q: RecentPatternQuery): RecentDraftPattern[] {
  const seen = new Set<string>();
  const out: RecentDraftPattern[] = [];
  for (const p of [...items].filter((p) => p.post_type === q.post_type && p.job_id !== q.exclude_job_id).sort(byNewest)) {
    if (seen.has(p.job_id)) continue;
    seen.add(p.job_id);
    out.push({ ...p });
  }
  return out.slice(0, Math.max(0, q.limit));
}

/** Recent patterns kept in memory (tests, and a cache for callers that already hold the drafts). */
export class InMemoryRecentPatterns implements RecentPatternsSource {
  readonly #items: RecentDraftPattern[] = [];

  constructor(items: readonly RecentDraftPattern[] = []) {
    this.#items.push(...items.map((p) => ({ ...p })));
  }

  add(p: RecentDraftPattern): void {
    this.#items.push({ ...p });
  }

  async recent(q: RecentPatternQuery): Promise<readonly RecentDraftPattern[]> {
    return selectRecent(this.#items, q);
  }
}

/** Jobs whose draft is made but not yet posted (spec 9.9: READY drafts count as recent too). */
export const PENDING_DRAFT_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['READY', 'POSTING', 'VERIFYING', 'VERIFY_REQUIRED']);

export interface DraftJobReader {
  summaries(filter?: (s: { id: string; status: JobStatus; post_type: PostType }) => boolean): readonly { id: string }[];
  get(id: string): Promise<Job | null>;
}

/** Recent patterns from the drafts of jobs in PENDING_DRAFT_STATUSES (read from the job store on each call). */
export class JobDraftPatterns implements RecentPatternsSource {
  readonly #store: DraftJobReader;

  constructor(store: DraftJobReader) {
    this.#store = store;
  }

  async recent(q: RecentPatternQuery): Promise<readonly RecentDraftPattern[]> {
    const ids = this.#store.summaries((s) => PENDING_DRAFT_STATUSES.has(s.status) && s.post_type === q.post_type && s.id !== q.exclude_job_id).map((s) => s.id);
    const found: RecentDraftPattern[] = [];
    for (const id of ids) {
      const job = await this.#store.get(id);
      if (job === null || !PENDING_DRAFT_STATUSES.has(job.status)) continue;
      const draft = DraftSchema.safeParse(job.draft);
      if (draft.success && draft.data.post_type === q.post_type) found.push(patternFromDraft(job.id, job.updated_at, draft.data));
    }
    return selectRecent(found, q);
  }
}

/** All sources together, newest first; a job seen in several sources counts once. */
export function combineRecentPatterns(...sources: RecentPatternsSource[]): RecentPatternsSource {
  return {
    async recent(q) {
      const all = await Promise.all(sources.map((s) => s.recent(q)));
      return selectRecent(all.flat(), q);
    },
  };
}

// ---------------------------------------------------------------- the context

export type LimitField = 'title' | 'menu_text' | 'stylist_comment' | 'body';

/** One constraint on a field (Plan 3: a page profile may count a line break as 2, or bytes in Shift_JIS). */
export type FieldLimit = LimitSpec;

export interface GenerationLimits {
  /** Every constraint per field (the defaults and, once verified, the page profile's); a draft must meet all of them. */
  fields: Partial<Record<LimitField, FieldLimit[]>>;
  /**
   * Graphemes to aim for: 85 % of the strictest constraint. For the primary field (stylist_comment / body) this is the
   * whole final string, hashtags included (spec 9.8).
   */
  targets: Partial<Record<LimitField, number>>;
  primary_field: 'stylist_comment' | 'body';
  /** Graphemes to aim for in the primary text itself, leaving room for the hashtag block. */
  primary_text_target: number;
  /** Estimated graphemes of the line break and the hashtag block at hashtags.suggested_count. */
  hashtag_reserve: number;
  /** Line breaks allowed in the final primary string (blog: 改行80回以下); null when the page has no such cap. */
  max_newlines: number | null;
  /** Where the hashtags go (P3-R8): the route's verified page profile decides, else writing_rules. */
  placement: Placement;
  /** The page's character encoding (characters it cannot carry are findings). */
  encoding: Encoding;
  /** The verified profile's hashtag field: count, per-tag length and the field's own limits; null without one. */
  profile_hashtag: (PageProfile['hashtag'] & { limits: FieldLimit[] }) | null;
}

export interface ContextExample {
  /** Evidence id: excel:<sheet>!<row>. */
  id: string;
  title: string;
  menu: string | null;
  comment: string | null;
  hashtags: string[];
}

export interface ContextTrendWord {
  /**
   * Evidence id: trend:<source id>:<hash> (public CSV; web search: source id web-trends:<week_of> for mens, web-trends-ladies:<week_of> for ladies), trend:manual:<hash>
   * (trends.json), trend:excel:<hash> (workbook).
   */
  id: string;
  word: string;
  /** web_search: the weekly men's and women's hair words (per audience) the AI looked up on the web (web-trends.ts), used like public_csv. */
  origin: 'public_csv' | 'web_search' | 'manual' | 'excel';
  /** fresh: an unexpired public import; undated: hand-kept words with no date (never to be called 最新). */
  freshness: 'fresh' | 'undated';
  source_id: string | null;
  retrieved_at: string | null;
  expires_at: string | null;
  /** The record names the post's category (strongest relevance). */
  category_match: boolean;
}

export interface ContextSidecar {
  category_hint: string | null;
  /** salon.verified_menus entries the sidecar's verified_menu_ids name (NFKC-equal), in sidecar order. */
  verified_menus: string[];
  /** verified_menu_ids matching no salon.verified_menus entry (logged; never offered as menus). */
  unmatched_menu_ids: string[];
  /** Free wording about who the style is for; reference only (never decides the audience, never about the model). */
  target_audience: string | null;
  notes: string | null;
}

export interface RecentPatternSummary {
  /** Titles of the last RECENT_TITLE_LOOKBACK drafts. */
  titles: string[];
  /** Openings of the last diversity.sentence_lookback drafts (shortened). */
  openings: string[];
  /** Last sentences (calls to action) of the last diversity.sentence_lookback drafts (shortened). */
  ctas: string[];
  opening_patterns: string[];
  cta_patterns: CtaPattern[];
  /** title_pattern + content_angle of the last diversity.pattern_lookback drafts. */
  pairs: { title_pattern: TitlePattern; content_angle: ContentAngle }[];
}

export interface GenerationContext {
  job: { id: string; post_type: PostType; audience_category: AudienceCategory; attempt: number };
  /** The instant the post is planned for (ISO, UTC); the season follows its JST date. */
  scheduled_at: string;
  /** The analyzer's result (model output: data) without model_info, which only fills the SALON BOARD form (P3-R50). */
  analysis: Omit<Analysis, 'model_info'>;
  sidecar: ContextSidecar | null;
  salon: {
    poster_name: string;
    verified_menus: string[];
    location_keywords: string[];
    strengths: string[];
    service_claims: { hair_consulting: boolean; formal_skeletal_diagnosis: boolean };
  };
  category: { id: string; label: string; keywords: string[]; requires_verified_menu: boolean };
  season: { key: string; month: number; date: string; words: string[] };
  examples: ContextExample[];
  trends: ContextTrendWord[];
  /** Effective search keywords for post type × audience, after every exclusion. */
  keywords: string[];
  excluded_keywords: string[];
  writing_policies: string[];
  recent: RecentPatternSummary;
  limits: GenerationLimits;
  hashtags: { min: number; target: number; max: number; suggested: number; candidates: string[] };
  /**
   * NG words and the restricted_terms marked never (keywords.json: 100%, 確実に, 小顔になる, ...), 骨格診断 (and the
   * formal_skeletal_diagnosis terms) unless the salon offers it formally, and ヘアコンサルティング when the salon does not
   * offer it (service_claims). Matched by containment (findWord).
   */
  forbidden_words: string[];
  /** Treatment words this photo has no verification for (matched with findUnverifiedTreatment). */
  unverified_treatments: string[];
  /**
   * Treatment phrases verified for this photo (the label, keywords and verified_terms of the category its category_hint
   * confirmed; never a menu name or the analysis, ruling P2-R15, except ハイトーン seen with enough confidence, P2-R15a): usable even when they contain a shorter unverified
   * term (ブリーチなしカラー with ブリーチ unverified). Task 8 applies the same rule with findUnverifiedTreatment, to every
   * field but the verbatim menu_text.
   */
  verified_treatments: string[];
  /**
   * Style posts only (null for blog). mode 'sidecar': exactly `fixed` (the owner's menus for this photo, used as written
   * even when they name a treatment the photo has no verification for); 'choose': 1-3 of `allowed` (salon.verified_menus
   * without the entries naming such a treatment or a forbidden word).
   */
  menus: { mode: 'sidecar' | 'choose'; allowed: string[]; fixed: string[]; max_items: number } | null;
  writing: {
    tone: string;
    conversion_goal: string;
    sections: string[];
    include_hair_consulting: boolean;
    use_season_if_relevant: boolean;
    avoid_keyword_stuffing: boolean;
    avoid_synonym_only_rewrites: boolean;
    /** Wording examples for the bookmark / show-the-image calls to action (to rotate, not to copy every time). */
    cta_examples: string[];
    allowed_cta_patterns: CtaPattern[];
    /** No verified official reservation route is configured yet, so never (spec 9.9). */
    reservation_guidance_allowed: boolean;
    skeletal_diagnosis_allowed: boolean;
  };
  /** Every id a draft may cite in evidence_refs. */
  evidence_ids: string[];
  refs: { template_hash: string; trend_source_refs: string[]; instruction_files: string[] };
}

export interface GenerationContextDeps {
  snapshot: ConfigSnapshot;
  /** Locates the job's bundle (sidecar.json). */
  paths: DataPaths;
  templates: TemplateSource;
  /** null: no public trend library (only hand-kept and Excel words). */
  trends: TrendSource | null;
  /** Defaults to the config alone (no instruction files). */
  instructions?: InstructionView;
  recent: RecentPatternsSource;
  clock: Clock;
  logger?: AppLogger;
  retry?: RetryOptions;
  /** The verified page profile of the job's route (Plan 3): its limits, hashtag placement and encoding. */
  profile?: PageProfile | null;
}

// ---------------------------------------------------------------- helpers

const shortHash = (s: string): string => sha256Hex(wordKey(s)).slice(0, 8);

function dedupe(list: Iterable<string>, key: (s: string) => string = wordKey): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const k = key(s);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

const colorStem = (color: string): string | null => (color === 'unknown' || color === 'その他' ? null : color.replace(/系$/u, ''));

/**
 * Ruling P2-R9: true while salon.verified_menus is empty, so no style job can get a draft. The pipeline checks this
 * before analysing a style job and holds it (spec 15.1: CONFIG_INCOMPLETE waits until the config is fixed) instead of
 * paying for an analysis that ends in CONFIG_INCOMPLETE.
 */
export function styleMenusMissing(snapshot: ConfigSnapshot): boolean {
  return snapshot.salon.verified_menus.length === 0;
}

/** The status line for style jobs held by styleMenusMissing (they resume once menus are registered). */
export const STYLE_MENUS_MISSING_STATUS =
  'salon.json の verified_menus に確認済みのスタイルメニューが登録されていないため、スタイル投稿の準備を止めています。登録すると自動で再開します。';

/**
 * The style post's menus are only ever salon.verified_menus entries (ruling P2-R9); none registered → stop before any AI
 * call. The last line of defence behind styleMenusMissing: a job that reaches it is FAILED, so the message names the
 * retry command.
 */
export function menusMissing(clock: Clock, jobId: string): AppFailure {
  return new AppFailure(
    appError('CONFIG_INCOMPLETE', STAGE, clock, {
      message: `スタイル投稿のメニューに使える確認済みメニューがありません。salon.json の verified_menus に確認済みのスタイルメニューを登録してください。登録後、${retryCommandFor(jobId)} で再開してください。`,
      retryable: false,
      details: { job_id: jobId, config_file: 'salon.json', field: 'verified_menus' },
    }),
  );
}

const UNIT_JA: Record<CountUnit, string> = { grapheme: '文字', codepoint: '文字（コードポイント）', utf16: '文字（UTF-16）', bytes: 'バイト' };

function seasonOf(snapshot: ConfigSnapshot, at: Date): { key: string; month: number; date: string; words: string[]; otherWords: string[] } {
  const date = jstDateKey(at);
  const month = Number(date.slice(5, 7));
  const entry = Object.entries(snapshot.keywords.season_months).find(([, months]) => months.includes(month));
  // The schema guarantees all 12 months are covered exactly once.
  const key = entry?.[0] ?? '';
  const words = snapshot.keywords.season_words[key] ?? [];
  const otherWords = Object.entries(snapshot.keywords.season_words)
    .filter(([k]) => k !== key)
    .flatMap(([, w]) => w);
  return { key, month, date, words: [...words], otherWords };
}

/**
 * The words a confirmed requires_verified_menu category makes usable (rulings P2-R5, P2-R12): its label, its
 * allowed_keywords and its verified_terms (e.g. 髪質改善 for 髪質改善カラー, パーマ for メンズパーマ). Empty for a category
 * that needs no verification. Context, prompt, generator and Validator all take the photo's treatment words from this.
 */
export function confirmedCategoryTerms(category: CategoryEntry): string[] {
  return category.requires_verified_menu ? dedupe([category.label, ...category.allowed_keywords, ...category.verified_terms]) : [];
}

/**
 * Treatment words that need verification: BASE_TREATMENT_TERMS and the keywords.json restricted_terms marked
 * verified_menu (酸熱トリートメント, TOKIOトリートメント, ノンジアミン, ...) always, plus the labels and allowed_keywords of the
 * requires_verified_menu categories unless a category without that flag also uses the word (its label, keywords or
 * hashtags.by_category list), e.g. 透明感カラー or 艶カラー. hashtags.common never frees a word: it applies to every post.
 * verified_terms are left out: they free words on a confirmed photo (treatmentWords) and never block a word elsewhere
 * (スパイラル巻き on a hair-set photo, スパイラルパーマ on a confirmed perm photo). Context, prompt, generator and Validator
 * all use this one list.
 */
export function treatmentTerms(snapshot: ConfigSnapshot): string[] {
  const all = [...snapshot.categories.style_categories, ...snapshot.categories.blog_categories];
  const needs = new Set(all.filter((c) => c.requires_verified_menu).map((c) => c.id));
  const free = new Set<string>(
    [
      ...all.filter((c) => !c.requires_verified_menu).flatMap((c) => [c.label, ...c.allowed_keywords]),
      ...Object.entries(snapshot.hashtags.by_category)
        .filter(([key]) => !needs.has(key))
        .flatMap(([, tags]) => tags),
    ].map(looseKey),
  );
  const fromCategories = all.filter((c) => c.requires_verified_menu).flatMap((c) => [c.label, ...c.allowed_keywords]);
  return dedupe([...BASE_TREATMENT_TERMS, ...restrictedTerms(snapshot, 'verified_menu'), ...fromCategories.filter((t) => !free.has(looseKey(t)))], looseKey);
}

/** keywords.json restricted_terms of one kind. */
export function restrictedTerms(snapshot: ConfigSnapshot, kind: RestrictionKind): string[] {
  return snapshot.keywords.restricted_terms.filter((r) => r.allowed_only_if === kind).map((r) => r.term);
}

/**
 * The photo's treatment words (rulings P2-R5, P2-R12, P2-R15). Unverified: every treatment term except the confirmed
 * category's words (confirmedCategoryTerms; the caller only passes a requires_verified_menu category the sidecar's
 * category_hint confirmed). Verified: the category's words that contain a treatment term. Only that hint frees a word
 * (P2-R15): neither a menu name (salon.verified_menus, the sidecar's verified_menu_ids) nor the analysis counts here,
 * whatever it says and however confident it is (photoTreatmentWords adds the one appearance word, P2-R15a). A null
 * category (not confirmed) frees nothing.
 * findUnverifiedTreatment lets a verified phrase cover the shorter terms inside it; a shorter verified word never covers
 * a longer term (パーマ does not cover デジタルパーマ).
 */
export function treatmentWords(snapshot: ConfigSnapshot, category: CategoryEntry | null): { unverified: string[]; verified: string[] } {
  const terms = treatmentTerms(snapshot);
  const termKeys = terms.map(looseKey);
  const own = category === null ? [] : confirmedCategoryTerms(category);
  const ownKeys = new Set(own.map(looseKey));
  return {
    unverified: terms.filter((t) => !ownKeys.has(looseKey(t))),
    verified: dedupe(
      own.filter((p) => termKeys.some((t) => looseKey(p).includes(t))),
      looseKey,
    ),
  };
}

/** Ruling P2-R15a: a word of the bleach_color category that only describes how the hair looks (spec 9.5), not a treatment. */
export const APPEARANCE_COLOR_TERM = 'ハイトーン';

/**
 * The photo's treatment words: treatmentWords plus ruling P2-R15a. ハイトーン is usable (verified) when the analysis saw a
 * ハイトーン colour with confidence >= ai.min_required_attribute_confidence, without category_hint; ブリーチ, ブリーチカラー and
 * the other treatment words stay as treatmentWords leaves them. Context, prompt, generator and Validator all use this.
 */
export function photoTreatmentWords(
  snapshot: ConfigSnapshot,
  category: CategoryEntry | null,
  analysis: Pick<Analysis, 'observed_color'>,
): { unverified: string[]; verified: string[] } {
  const words = treatmentWords(snapshot, category);
  const color = analysis.observed_color;
  const key = looseKey(APPEARANCE_COLOR_TERM);
  if (color.value !== APPEARANCE_COLOR_TERM || color.confidence < snapshot.settings.ai.min_required_attribute_confidence) return words;
  if (!words.unverified.some((t) => looseKey(t) === key)) return words;
  return { unverified: words.unverified.filter((t) => looseKey(t) !== key), verified: dedupe([...words.verified, APPEARANCE_COLOR_TERM], looseKey) };
}

/** What one registered menu names, for the owner's message when choose mode has no menu left (ruling P2-R15). */
interface MenuDiagnosis {
  menu: string;
  /** It holds a forbidden word (no category_hint can help). */
  forbidden: boolean;
  /** Every treatment term it names, whatever the photo's category (findUnverifiedTreatments, text order). */
  treatments: string[];
  /** The categories (this audience) whose category_hint alone would make it choosable. */
  fixers: CategoryEntry[];
  /** Its treatment terms that no single category's words free (縮毛矯正 with the shipped categories). */
  uncovered: string[];
}

/**
 * For a message only (never confirms anything): what each menu names and which single category_hint, if any, would
 * make it choosable, by applying treatmentWords for every requires_verified_menu category of the audience exactly as a
 * confirmed hint would.
 */
function diagnoseMenus(snapshot: ConfigSnapshot, categories: readonly CategoryEntry[], menus: readonly string[], forbidden: readonly string[]): MenuDiagnosis[] {
  const all = treatmentTerms(snapshot);
  const hintable = categories.filter((c) => c.requires_verified_menu).map((c) => ({ c, words: treatmentWords(snapshot, c) }));
  const frees = (text: string, w: { unverified: string[]; verified: string[] }): boolean => findUnverifiedTreatment(text, w.unverified, w.verified) === null;
  return menus.map((menu) => {
    const treatments = findUnverifiedTreatments(menu, all, []);
    const isForbidden = findWord(menu, forbidden) !== null;
    return {
      menu,
      forbidden: isForbidden,
      treatments,
      fixers: isForbidden ? [] : hintable.filter((h) => frees(menu, h.words)).map((h) => h.c),
      uncovered: treatments.filter((t) => !hintable.some((h) => frees(t, h.words))),
    };
  });
}

/** Menus named in one CONFIG_INCOMPLETE message at most (the details keep the bounded lists). */
const MAX_MENUS_IN_MESSAGE = 3;

/**
 * CONFIG_INCOMPLETE when choose mode has no registered menu left for this photo (ruling P2-R15): names every
 * unconfirmed treatment, gives a category_hint example only for a category whose hint alone makes a menu choosable,
 * and says plainly when no hint can (a menu naming treatments of different categories, of which a photo has one hint;
 * a treatment no category's words hold, such as 縮毛矯正 with the shipped categories).
 */
function noMenuLeft(o: {
  snapshot: ConfigSnapshot;
  categories: readonly CategoryEntry[];
  forbidden: readonly string[];
  /** The unconfirmed treatment words the registered menus name (findUnverifiedTreatments for this photo). */
  named: readonly string[];
  unverified: readonly string[];
  /** The sidecar's category_hint: none, one naming a category of the audience, or one naming none. */
  hint: 'none' | 'valid' | 'unmatched';
  audience: AudienceCategory;
  failedSidecar: string;
  clock: Clock;
  jobId: string;
}): AppFailure {
  const diagnosis = diagnoseMenus(o.snapshot, o.categories, o.snapshot.salon.verified_menus, o.forbidden);
  const fixable = diagnosis.filter((d) => d.fixers.length > 0);
  const hintIds = [...new Set(fixable.flatMap((d) => d.fixers.map((c) => c.id)))];
  const multi = diagnosis.filter((d) => !d.forbidden && d.fixers.length === 0 && d.uncovered.length === 0 && d.treatments.length > 1);
  const uncovered = dedupe(diagnosis.flatMap((d) => (d.fixers.length === 0 ? d.uncovered : [])), looseKey);
  const named = boundedIds(o.named);
  const list = (b: { ids: string[]; more: number }): string => `${b.ids.join('、')}${b.more > 0 ? ` ほか${b.more}件` : ''}`;

  const parts = ['この写真のスタイル投稿に使える確認済みメニューがありません。'];
  parts.push(
    o.named.length > 0
      ? `salon.json の verified_menus のメニューは、どれも、この写真で確認されていない施術の名前（${list(named)}）か、使えない語（NG語など）を含んでいます。メニュー名だけでは施術の確認になりません。`
      : 'salon.json の verified_menus のメニューは、どれも、使えない語（NG語など）を含んでいます。',
  );
  if (o.hint === 'unmatched') parts.push(`今の ${SIDECAR_FILE} の category_hint は、${AUDIENCE_JA[o.audience]}のカテゴリー（categories.json の id か名前）のどれにも一致しません。`);
  const first = fixable[0];
  const firstId = first?.fixers[0]?.id;
  if (first !== undefined && firstId !== undefined) {
    const example = `（categories.json の id か名前。例: {"category_hint": "${firstId}"} なら「${first.menu}」を選べます）`;
    parts.push(
      o.hint === 'valid'
        ? `category_hint は1つのカテゴリーしか書けません。この写真がその施術の写真なら、${o.failedSidecar} の category_hint をその施術のカテゴリー${example}に書き換えてください。`
        : `その施術の写真なら、${o.failedSidecar} に category_hint でその施術のカテゴリー${example}を書いてください。`,
    );
  }
  for (const d of multi.slice(0, MAX_MENUS_IN_MESSAGE)) {
    parts.push(`「${d.menu}」は、別々のカテゴリーの施術（${d.treatments.join('、')}）を含むため、category_hint（1つしか書けません）では選べるようになりません。`);
  }
  if (uncovered.length > 0) {
    parts.push(
      `${list(boundedIds(uncovered))} は categories.json のどのカテゴリーの語にも入っていないため、category_hint では選べるようになりません。この施術について書きたい場合は、categories.json に requires_verified_menu を true にしたカテゴリーを追加し、その verified_terms にこの施術の語（例: ["${uncovered[0] ?? ''}"]）を書いてから、その id を category_hint に書いてください。`,
    );
  }
  parts.push(
    first !== undefined
      ? `ほかに、施術名を含まないメニュー（カットなど）を verified_menus に登録するか、${SIDECAR_FILE} の verified_menu_ids でこの写真のメニューを指定する方法もあります。`
      : `施術名を含まないメニュー（カットなど）を verified_menus に登録するか、${SIDECAR_FILE} の verified_menu_ids でこの写真のメニューを指定してください。`,
  );
  parts.push(`そのあと ${retryCommandFor(o.jobId)} で再開してください。`);
  return new AppFailure(
    appError('CONFIG_INCOMPLETE', STAGE, o.clock, {
      message: parts.join(''),
      retryable: false,
      details: {
        job_id: o.jobId,
        config_file: 'salon.json',
        field: 'verified_menus',
        menu_treatments: named.ids,
        hint_category_ids: boundedIds(hintIds).ids,
        multi_category_menus: boundedIds(multi.map((d) => d.menu)).ids,
        uncovered_treatments: boundedIds(uncovered).ids,
        unverified_treatments: o.unverified.slice(0, 10),
      },
    }),
  );
}

/**
 * Rulings P2-R5 / P2-R15, re-applied against the sidecar as it is now (the stored analysis may be older than an edit of
 * it): a requires_verified_menu category counts only when the valid sidecar's category_hint names it (`hinted`, the
 * category resolveHint found for it). A menu name (salon.verified_menus, the sidecar's verified_menu_ids) or the
 * analysis never confirms a category, whatever it says.
 */
export function confirmedByHint(category: CategoryEntry, hinted: CategoryEntry | undefined): boolean {
  return !category.requires_verified_menu || category.id === hinted?.id;
}

/** Every word a draft's hashtags may come from besides its own title and text (spec 9.8: content, category, trends). */
export function hashtagPool(ctx: GenerationContext): Set<string> {
  return new Set(
    [
      ...ctx.hashtags.candidates,
      ...ctx.category.keywords,
      ...ctx.analysis.style_features.map((f) => f.value),
      ...ctx.season.words,
      ...ctx.trends.map((t) => t.word),
      ...ctx.examples.flatMap((e) => e.hashtags),
      ...ctx.keywords,
      ...ctx.verified_treatments,
    ]
      .map(looseKey)
      .filter((k) => k !== ''),
  );
}

/**
 * A hashtag is related to the post when it is one of the context's words (hashtagPool) or the post's own title or
 * primary text contains it (spec 9.8). The generator drops other tags; the Validator (Task 8) applies the same rule.
 */
export function isRelatedTag(tag: string, pool: ReadonlySet<string>, postText: string): boolean {
  const k = looseKey(tag);
  return k !== '' && (pool.has(k) || looseKey(postText).includes(k));
}

function evidenceForAnalysis(a: Analysis): string[] {
  const ids: string[] = [];
  if (a.hair_length.value !== 'unknown') ids.push('analysis.hair_length');
  if (a.observed_color.value !== 'unknown') ids.push('analysis.observed_color');
  if (a.style_features.length > 0) ids.push('analysis.style_features');
  if (a.bangs.value !== 'unknown') ids.push('analysis.bangs');
  if (a.texture.value !== 'unknown') ids.push('analysis.texture');
  if (a.impressions.length > 0) ids.push('analysis.impressions');
  return ids;
}

const DEFAULT_TAG_GRAPHEMES = 5;

/** '\n' + n tags of `avg` graphemes, each with '#', separated by spaces. */
const reserveFor = (n: number, avg: number): number => (n <= 0 ? 0 : 1 + n * (avg + 1) + (n - 1));

/** A constraint expressed in graphemes, conservatively (UTF-8 Japanese takes 3 bytes per character). */
const asGraphemes = (l: FieldLimit): number => (l.unit === 'bytes' ? Math.floor(l.max / 3) : l.max);

const LIMIT_FIELDS: readonly LimitField[] = ['title', 'menu_text', 'stylist_comment', 'body'];

/**
 * Limits for one post type: writing_rules.default_limits, plus the route's verified page profile when given (effectiveLimits:
 * every constraint must hold). Targets are 85 % of the strictest; when the hashtags are appended, the primary text leaves
 * room for the suggested number of them, using fewer (not below min_count) when the text would get under half its target.
 */
export function resolveLimits(
  snapshot: ConfigSnapshot,
  postType: PostType,
  candidates: readonly string[],
  profile: PageProfile | null = null,
): { limits: GenerationLimits; suggested: number } {
  const all = effectiveLimits(profile, snapshot.writingRules.default_limits, postType);
  const placement = effectivePlacement(profile, snapshot.writingRules.hashtag_placement);
  const fields: Partial<Record<LimitField, FieldLimit[]>> = {};
  const targets: Partial<Record<LimitField, number>> = {};
  for (const field of LIMIT_FIELDS) {
    const list = all[field];
    if (list === undefined) continue;
    fields[field] = list;
    targets[field] = Math.floor(Math.min(...list.map(asGraphemes)) * TARGET_LENGTH_RATIO);
  }
  const primary = postType === 'style' ? 'stylist_comment' : 'body';
  const total = targets[primary] ?? 0;
  const sample = candidates.slice(0, 12).map(graphemeLength);
  const avg = sample.length === 0 ? DEFAULT_TAG_GRAPHEMES : Math.min(8, Math.max(3, Math.ceil(sample.reduce((a, b) => a + b, 0) / sample.length)));
  const { min_count, target_count } = snapshot.hashtags;
  let suggested = Math.max(min_count, Math.min(target_count, profile?.hashtag.max_count ?? target_count));
  const appended = placement === 'append_to_primary_text';
  while (appended && suggested > min_count && total - reserveFor(suggested, avg) < Math.floor(total / 2)) suggested--;
  const reserve = appended ? reserveFor(suggested, avg) : 0;
  const caps = (fields[primary] ?? []).flatMap((l) => (l.max_newlines === undefined ? [] : [l.max_newlines]));
  return {
    limits: {
      fields,
      targets,
      primary_field: primary,
      primary_text_target: Math.max(0, total - reserve),
      hashtag_reserve: reserve,
      max_newlines: caps.length === 0 ? null : Math.min(...caps),
      placement,
      encoding: profile?.encoding ?? 'utf-8',
      profile_hashtag: profile === null ? null : { ...profile.hashtag, limits: all.hashtags ?? [] },
    },
    suggested,
  };
}

/** Prefer a TOP / time-series record over a RISING one for the same word (Task 4 forward note); otherwise the first. */
const isRising = (r: TrendRecord): boolean => r.metric_definition?.includes('RISING') === true;

// ---------------------------------------------------------------- building

/**
 * The GenerationContext of one job (spec 9.1, Plan 2 Task 7). `scheduledAt` is the planned posting instant (the season
 * follows its JST date; pass the current time while no slot is assigned). Throws before any AI call:
 * - CONFIG_INCOMPLETE for a style job while salon.verified_menus is empty (styleMenusMissing), when the photo's sidecar
 *   names menus none of which is registered or whose joined text exceeds the menu limit, or when every registered menu
 *   names a treatment this photo's category_hint does not confirm (or a forbidden word) (rulings P2-R9, P2-R15);
 * - IMAGE_ANALYSIS_UNCERTAIN when neither the current sidecar's category_hint nor the analysis gives a category usable
 *   for the job's audience, counting a requires_verified_menu category only while that hint names it (rulings P2-R5,
 *   P2-R15). The hint comes first even when the stored analysis does not list it (as the analyzer orders it), so a job
 *   retried with its stored analysis after the owner added the hint uses it.
 */
export async function buildGenerationContext(deps: GenerationContextDeps, job: Job, analysis: Analysis, scheduledAt: Date): Promise<GenerationContext> {
  const { snapshot, clock, logger } = deps;
  const { post_type: postType, audience_category: audience } = job;
  const fields = { job_id: job.id, stage: STAGE, post_type: postType, audience_category: audience };
  const { salon, writingRules, hashtags: hashtagRules } = snapshot;
  if (postType === 'style' && styleMenusMissing(snapshot)) throw menusMissing(clock, job.id);
  const categories = analysisCategories(snapshot, audience);
  /** Where the owner writes the photo's sidecar once the failure moves the bundle to the failed folder. */
  const failedSidecar = join(deps.paths.modeRoot, ...bundleRelDir({ ...job, status: 'FAILED' }).split('/'), SIDECAR_FILE);

  // Sidecar facts (only a valid sidecar; the analyzer already logged problems with it).
  const { dir } = locateBundle(job, deps.paths, clock, 'generate');
  const read = await inspectSidecar(dir, deps.retry === undefined ? {} : { retry: deps.retry });
  let sidecar: ContextSidecar | null = null;
  if (read.kind === 'valid') {
    const byKey = new Map(salon.verified_menus.map((m) => [wordKey(m), m]));
    const ids = read.sidecar.verified_menu_ids ?? [];
    const matched = dedupe(ids.flatMap((id) => byKey.get(wordKey(id)) ?? []));
    const unmatched = ids.filter((id) => !byKey.has(wordKey(id)));
    sidecar = {
      category_hint: read.sidecar.category_hint ?? null,
      verified_menus: matched,
      unmatched_menu_ids: unmatched,
      target_audience: read.sidecar.target_audience ?? null,
      notes: read.sidecar.notes === undefined || read.sidecar.notes.trim() === '' ? null : read.sidecar.notes,
    };
    if (unmatched.length > 0) {
      const shown = boundedIds(unmatched);
      logger?.warn('SIDECAR_MENU_UNVERIFIED', `${SIDECAR_FILE} の verified_menu_ids のうち、salon.json の verified_menus に無いものは使いません: ${shown.ids.join(', ')}`, {
        ...fields,
        unmatched_menu_ids: shown.ids,
        unmatched_more: shown.more,
      });
    }
    if (postType === 'style' && ids.length > 0 && matched.length === 0) {
      throw new AppFailure(
        appError('CONFIG_INCOMPLETE', STAGE, clock, {
          message: `${SIDECAR_FILE} の verified_menu_ids が salon.json の verified_menus のどれとも一致しないため、スタイルメニューを決められません。verified_menus に登録するか ${SIDECAR_FILE} を直してから、${retryCommandFor(job.id)} で再開してください。`,
          retryable: false,
          details: { job_id: job.id, unmatched_menu_ids: boundedIds(unmatched).ids },
        }),
      );
    }
  } else if (read.kind === 'invalid') {
    logger?.debug('GENERATION_SIDECAR_UNUSABLE', `${SIDECAR_FILE} を使えないため、無いものとして文章を作ります。`, fields);
  }

  // Category: the sidecar's category_hint as it is now first, as the analyzer puts it (a stored analysis made before the
  // hint was written never lists a requires_verified_menu category, so retrying with it after adding the hint must still
  // work), then the analysis' ids that fit the audience; a requires_verified_menu category counts only while that hint
  // names it (rulings P2-R5, P2-R15).
  const rawHint = sidecar?.category_hint ?? null;
  const hinted = rawHint === null ? undefined : resolveHint(rawHint, categories);
  if (rawHint !== null && hinted === undefined) {
    logger?.warn('GENERATION_CATEGORY_HINT_IGNORED', hintIgnoredMessage(job, rawHint, categories), fields);
  }
  const fromAnalysis = analysis.suggested_category_ids.flatMap((id) => categories.find((c) => c.id === id) ?? []);
  const listed = hinted === undefined ? fromAnalysis : [hinted, ...fromAnalysis.filter((c) => c.id !== hinted.id)];
  if (hinted !== undefined && fromAnalysis[0]?.id !== hinted.id) {
    logger?.info('GENERATION_CATEGORY_FROM_HINT', `${SIDECAR_FILE} の category_hint のカテゴリー（${hinted.id}）を、保存済みの画像解析のカテゴリーより先に使います。`, {
      ...fields,
      category_id: hinted.id,
      analysis_category_ids: boundedIds(analysis.suggested_category_ids).ids,
    });
  }
  const unconfirmed = listed.filter((c) => !confirmedByHint(c, hinted));
  const category = listed.find((c) => confirmedByHint(c, hinted));
  if (unconfirmed.length > 0) {
    logger?.warn(
      'GENERATION_CATEGORY_UNCONFIRMED',
      `写真だけでは裏付けられないカテゴリーが ${SIDECAR_FILE} の category_hint で確認されていないため、使いません: ${unconfirmed.map((c) => c.id).join(', ')}`,
      { ...fields, category_ids: unconfirmed.map((c) => c.id) },
    );
  }
  if (category === undefined) {
    const message =
      unconfirmed.length > 0
        ? `画像解析で選ばれたカテゴリー（${unconfirmed.map((c) => c.label).join('、')}）は写真だけでは裏付けられない施術のカテゴリーで、今の ${SIDECAR_FILE} の category_hint で確認されていないため、文章を作れません。${rawHint === null ? '' : `今の category_hint は${AUDIENCE_JA[audience]}のカテゴリー（categories.json の id か名前）のどれにも一致しません。`}メニュー名（verified_menu_ids）だけでは確認になりません。そのカテゴリーで正しければ ${failedSidecar} に category_hint（例: {"category_hint": "${unconfirmed[0]?.id ?? ''}"}）を書いてから、${retryCommandFor(job.id)} で再開してください。`
        : `画像解析の結果に、${AUDIENCE_JA[audience]}のカテゴリー（categories.json）として使えるものがないため、文章を作れません。${retryCommandFor(job.id)} で解析からやり直してください。`;
    throw new AppFailure(
      appError('IMAGE_ANALYSIS_UNCERTAIN', STAGE, clock, {
        message,
        retryable: false,
        details: { job_id: job.id, category_ids: boundedIds(analysis.suggested_category_ids).ids, unconfirmed_category_ids: unconfirmed.map((c) => c.id) },
      }),
    );
  }

  // A season's colour word (秋カラー) reads as a colour service: offered only for a colour style (the category names カラー).
  const colourStyle = [category.label, ...category.allowed_keywords].some((w) => w.includes('カラー'));
  const seasonAll = seasonOf(snapshot, scheduledAt);
  const season = { ...seasonAll, words: seasonAll.words.filter((w) => colourStyle || !w.includes('カラー')) };
  const instructions = deps.instructions ?? instructionView(snapshot);
  const excluded = new Set([...instructions.excludedKeywords, ...snapshot.keywords.excluded_topics].map(wordKey));
  const skeletalAllowed = salon.service_claims.formal_skeletal_diagnosis;
  const consultingOffered = salon.service_claims.hair_consulting;
  const includeConsulting = writingRules.include_hair_consulting && consultingOffered;
  const forbidden = dedupe([
    ...snapshot.keywords.ng_words,
    ...restrictedTerms(snapshot, 'never'),
    ...(skeletalAllowed ? [] : [SKELETAL_DIAGNOSIS, ...restrictedTerms(snapshot, 'formal_skeletal_diagnosis')]),
    ...(consultingOffered ? [] : [HAIR_CONSULTING]),
  ]);
  const { unverified, verified } = photoTreatmentWords(snapshot, category, analysis);
  /** No forbidden word (containment) and no unverified treatment outside a verified phrase. */
  const allowedWording = (word: string): boolean => findWord(word, forbidden) === null && findUnverifiedTreatment(word, unverified, verified) === null;
  /** Also not excluded (NFKC exact) and, unless the post includes it, not ヘアコンサルティング (a style preference). */
  const usable = (word: string): boolean =>
    looseKey(word) !== '' && !excluded.has(wordKey(word)) && allowedWording(word) && (includeConsulting || findWord(word, [HAIR_CONSULTING]) === null);
  const salonFacts = [...salon.location_keywords, ...salon.strengths];
  /**
   * A hashtag also never states a face shape (it would read as a statement about the person, spec 6.2 / 9.4) or a salon
   * fact the config does not state (spec 9.1 / 9.8); the generator drops such tags the same way.
   */
  const tagUsable = (tag: string): boolean => usable(tag) && findWord(tag, FACE_SHAPE_TERMS) === null && findSalonFact(tag, salonFacts) === null;
  /**
   * Search keywords and trend words that state a salon fact the config does not (人気, 話題, 最新, クーポン, 予約, ...)
   * are not offered either: the model would read them as wording to use (spec 9.1, 9.8).
   */
  const factSkipped = new Map<string, string>();
  const factFree = (word: string): boolean => {
    if (findSalonFact(word, salonFacts) === null) return true;
    factSkipped.set(wordKey(word), word);
    return false;
  };

  const keywords = dedupe(instructions.keywordsFor(postType, audience)).filter((w) => usable(w) && factFree(w));
  const categoryKeywords = dedupe([category.label, ...category.allowed_keywords]).filter(usable);

  const examples: ContextExample[] = deps.templates
    .examples({ category_ids: [category.id], audience, season: { words: season.words, other_words: season.otherWords }, n: MAX_EXAMPLES, seed: job.id })
    .map((e) => ({
      id: `excel:${e.source.sheet}!${e.source.row}`,
      title: e.title,
      menu: e.menu ?? null,
      comment: e.comment ?? null,
      hashtags: dedupe(e.hashtags.flatMap((t) => cleanTagWord(t) ?? [])).filter(tagUsable),
    }));

  // Trend words: fresh public records first (relevance-thresholded, audience-compatible), then hand-kept and Excel words.
  const now = new Date(Math.max(clock.now().getTime(), scheduledAt.getTime()));
  const features = analysis.style_features.map((f) => f.value);
  const stem = colorStem(analysis.observed_color.value);
  const relevanceTerms = [...categoryKeywords, ...features, ...(stem === null ? [] : [stem])].map(looseKey).filter((k) => k.length >= 2);
  const related = (word: string): boolean => {
    const k = looseKey(word);
    return relevanceTerms.some((t) => k.includes(t) || t.includes(k));
  };
  const trends: ContextTrendWord[] = [];
  if (snapshot.trends.enabled) {
    const audienceIds = new Set(categories.map((c) => c.id));
    const picked = new Map<string, TrendRecord>();
    for (const r of deps.trends?.validRecords(now) ?? []) {
      if (r.relevance_score < TREND_MIN_RELEVANCE || !usable(r.keyword)) continue;
      if (r.audience !== undefined && r.audience !== audience) continue;
      if (r.category_ids.length > 0 && !r.category_ids.some((id) => audienceIds.has(id))) continue;
      if (!factFree(r.keyword)) continue;
      const key = wordKey(r.keyword);
      const kept = picked.get(key);
      if (kept === undefined || (isRising(kept) && !isRising(r))) picked.set(key, r);
    }
    const ranked = [...picked.values()]
      .map((r, i) => ({ r, i, match: r.category_ids.includes(category.id) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || b.r.relevance_score - a.r.relevance_score || a.i - b.i)
      .slice(0, MAX_PUBLIC_TRENDS);
    for (const { r, match } of ranked) {
      trends.push({
        id: `trend:${r.source_id}:${shortHash(r.keyword)}`,
        word: r.keyword,
        origin: r.source_kind === 'web_search' ? 'web_search' : 'public_csv',
        freshness: 'fresh',
        source_id: r.source_id,
        retrieved_at: r.retrieved_at,
        expires_at: r.expires_at,
        category_match: match,
      });
    }
    const taken = new Set(trends.map((t) => wordKey(t.word)));
    const undated = (word: string, origin: 'manual' | 'excel'): ContextTrendWord => ({
      id: `trend:${origin}:${shortHash(word)}`,
      word,
      origin,
      freshness: 'undated',
      source_id: null,
      retrieved_at: null,
      expires_at: null,
      category_match: related(word),
    });
    const { trend_words, trend_colors, trend_styles, season_words } = snapshot.trends;
    const manual = dedupe([...trend_words, ...(deps.trends?.manualWords?.(audience) ?? []), ...trend_colors, ...trend_styles, ...season_words]).filter((w) => usable(w) && !taken.has(wordKey(w)) && factFree(w));
    for (const w of manual.slice(0, MAX_MANUAL_TRENDS)) {
      trends.push(undated(w, 'manual'));
      taken.add(wordKey(w));
    }
    const excel = dedupe(deps.templates.trendWords()).filter((w) => usable(w) && related(w) && !taken.has(wordKey(w)) && factFree(w));
    for (const w of excel.slice(0, MAX_EXCEL_TRENDS)) {
      trends.push(undated(w, 'excel'));
      taken.add(wordKey(w));
    }
  }
  if (factSkipped.size > 0) {
    const shown = boundedIds([...factSkipped.values()]);
    logger?.info(
      'GENERATION_SALON_FACT_WORDS_SKIPPED',
      `人気・話題・料金・予約など、設定に無い店舗の事実を示す検索ワード・トレンド語を${factSkipped.size}件、文章の材料から外しました: ${shown.ids.join(', ')}`,
      { ...fields, skipped: factSkipped.size, words: shown.ids, words_more: shown.more },
    );
  }

  // Hashtag candidates, most specific first.
  const groups = deps.templates.hashtagGroups({ category_ids: [category.id], audience }).filter((g) => {
    const label = looseKey(g.label);
    if (stem !== null && (label === looseKey(analysis.observed_color.value) || label.includes(looseKey(stem)))) return true;
    return relevanceTerms.some((t) => label.includes(t) || t.includes(label));
  });
  const candidates = dedupe(
    [
      ...(hashtagRules.by_category[category.id] ?? []),
      ...categoryKeywords,
      ...groups.flatMap((g) => g.tags.slice(0, 10)),
      ...trends.filter((t) => (t.origin === 'public_csv' || t.origin === 'web_search') && t.category_match).map((t) => t.word),
      ...(hashtagRules.by_category[audience] ?? []),
      ...features,
      ...(writingRules.use_season_if_relevant ? season.words : []),
      ...hashtagRules.common,
      ...keywords,
    ].flatMap((t) => cleanTagWord(t) ?? []),
  )
    .filter(tagUsable)
    .slice(0, MAX_HASHTAG_CANDIDATES);

  const { limits, suggested } = resolveLimits(snapshot, postType, candidates, deps.profile ?? null);

  // Style menus (rulings P2-R9, P2-R15): the sidecar's verified set as is (only the verbatim menu field may then name a
  // treatment the category_hint does not confirm), otherwise the registered menus that name no such treatment and no
  // forbidden word (spec 6.2, 9.8), so the model never picks a menu asserting an unconfirmed treatment.
  /** Every unconfirmed treatment word the menus name, de-duplicated (for the owner's messages). */
  const treatmentsNamedBy = (list: readonly string[]): string[] => dedupe(list.flatMap((m) => findUnverifiedTreatments(m, unverified, verified)), looseKey);
  let menus: GenerationContext['menus'] = null;
  if (postType === 'style') {
    const fixed = [...(sidecar?.verified_menus ?? [])];
    if (fixed.length > 0) {
      const named = treatmentsNamedBy(fixed);
      if (named.length > 0) {
        const shown = boundedIds(named);
        const namedKeys = new Set(named.map(looseKey));
        const uncovered = dedupe(diagnoseMenus(snapshot, categories, fixed, forbidden).flatMap((d) => d.uncovered.filter((t) => namedKeys.has(looseKey(t)))), looseKey);
        logger?.info(
          'GENERATION_MENU_TREATMENT_UNCONFIRMED',
          `${SIDECAR_FILE} で指定したメニューは、メニュー欄にはそのまま使いますが、category_hint で確認されていない施術（${shown.ids.join('、')}）はタイトル・コメント・ハッシュタグに書きません。その施術について書くときは、${SIDECAR_FILE} の category_hint でその施術のカテゴリーを指定してください（1つだけ書けます）。${uncovered.length > 0 ? `${boundedIds(uncovered).ids.join('、')} は categories.json のどのカテゴリーの語にも入っていないため、書くにはそのカテゴリー（requires_verified_menu を true にし、verified_terms にその語を書いたもの）を追加する必要があります。` : ''}`,
          { ...fields, menu_treatments: shown.ids, menu_treatments_more: shown.more, uncovered_treatments: boundedIds(uncovered).ids },
        );
      }
      const text = composeMenuText(fixed);
      const over = (limits.fields.menu_text ?? []).find((l) => limitLength(text, l) > l.max);
      if (over !== undefined) {
        throw new AppFailure(
          appError('CONFIG_INCOMPLETE', STAGE, clock, {
            message: `${SIDECAR_FILE} の verified_menu_ids のメニューをつなげると「${text}」（${limitLength(text, over)}${UNIT_JA[over.unit]}）になり、メニュー欄の上限（${over.max}${UNIT_JA[over.unit]}）を超えます。${SIDECAR_FILE} のメニューを減らしてから、${retryCommandFor(job.id)} で再開してください。`,
            retryable: false,
            details: { job_id: job.id, menu_text_length: limitLength(text, over), limit: over.max, unit: over.unit },
          }),
        );
      }
      menus = { mode: 'sidecar', allowed: [...salon.verified_menus], fixed, max_items: MAX_MENU_ITEMS };
    } else {
      const allowed = salon.verified_menus.filter(allowedWording);
      if (allowed.length === 0) {
        throw noMenuLeft({
          snapshot,
          categories,
          forbidden,
          named: treatmentsNamedBy(salon.verified_menus),
          unverified,
          hint: hinted !== undefined ? 'valid' : rawHint !== null ? 'unmatched' : 'none',
          audience,
          failedSidecar,
          clock,
          jobId: job.id,
        });
      }
      if (allowed.length < salon.verified_menus.length) {
        logger?.info('GENERATION_MENUS_LIMITED', `category_hint で確認されていない施術（またはNG語）を含むメニューは、選べるメニューから外しました（${salon.verified_menus.length - allowed.length}件）。`, {
          ...fields,
          left_out: salon.verified_menus.length - allowed.length,
        });
      }
      menus = { mode: 'choose', allowed, fixed: [], max_items: MAX_MENU_ITEMS };
    }
  }

  const { sentence_lookback, pattern_lookback } = writingRules.diversity;
  const recentItems = await deps.recent.recent({
    post_type: postType,
    limit: Math.max(sentence_lookback, pattern_lookback, RECENT_TITLE_LOOKBACK),
    exclude_job_id: job.id,
  });
  const sentencesOf = recentItems.slice(0, sentence_lookback);
  const recent: RecentPatternSummary = {
    titles: dedupe(recentItems.slice(0, RECENT_TITLE_LOOKBACK).map((p) => graphemeSlice(p.title, MAX_RECENT_SENTENCE))),
    openings: dedupe(sentencesOf.map((p) => graphemeSlice(p.opening, MAX_RECENT_SENTENCE))),
    ctas: dedupe(sentencesOf.map((p) => graphemeSlice(p.cta, MAX_RECENT_SENTENCE))),
    opening_patterns: dedupe(sentencesOf.map((p) => p.opening_pattern)),
    cta_patterns: [...new Set(sentencesOf.map((p) => p.cta_pattern))],
    pairs: recentItems.slice(0, pattern_lookback).map((p) => ({ title_pattern: p.title_pattern, content_angle: p.content_angle })),
  };

  const { model_info, ...forText } = structuredClone(analysis);
  void model_info; // P3-R50: model_info never reaches a prompt, a check or a draft

  const allowedCtas = CTA_PATTERNS.filter((c) => c !== 'reservation_guidance' && (c !== 'bookmark' || writingRules.bookmark_cta_enabled));

  const instructionFiles = dedupe(instructions.filesFor?.(postType, audience) ?? []);
  const evidence = dedupe([
    ...evidenceForAnalysis(analysis),
    `category:${category.id}`,
    `season:${season.key}`,
    ...salon.verified_menus.map((_, i) => `menu:${i}`),
    'salon.poster_name',
    ...salon.strengths.map((_, i) => `salon.strength:${i}`),
    ...salon.location_keywords.map((_, i) => `salon.location_keyword:${i}`),
    ...(consultingOffered ? ['salon.hair_consulting'] : []),
    ...(skeletalAllowed ? ['salon.formal_skeletal_diagnosis'] : []),
    ...(sidecar?.category_hint ? ['sidecar.category_hint'] : []),
    ...(sidecar && sidecar.verified_menus.length > 0 ? ['sidecar.verified_menu_ids'] : []),
    ...(sidecar?.target_audience ? ['sidecar.target_audience'] : []),
    ...(sidecar?.notes ? ['sidecar.notes'] : []),
    ...examples.map((e) => e.id),
    ...trends.map((t) => t.id),
    ...instructionFiles.map((f) => `instruction:${f}`),
  ]);

  return {
    job: { id: job.id, post_type: postType, audience_category: audience, attempt: job.regeneration_count },
    scheduled_at: scheduledAt.toISOString(),
    analysis: forText,
    sidecar,
    salon: {
      poster_name: salon.poster_name,
      verified_menus: [...salon.verified_menus],
      location_keywords: [...salon.location_keywords],
      strengths: [...salon.strengths],
      service_claims: { ...salon.service_claims },
    },
    category: { id: category.id, label: category.label, keywords: categoryKeywords, requires_verified_menu: category.requires_verified_menu },
    season: { key: season.key, month: season.month, date: season.date, words: season.words.filter(usable) },
    examples,
    trends,
    keywords,
    excluded_keywords: dedupe([...instructions.excludedKeywords, ...snapshot.keywords.excluded_topics]),
    writing_policies: dedupe(instructions.writingPolicies(postType, audience)),
    recent,
    limits,
    hashtags: { min: hashtagRules.min_count, target: hashtagRules.target_count, max: Math.min(hashtagRules.max_count, deps.profile?.hashtag.max_count ?? hashtagRules.max_count), suggested, candidates },
    forbidden_words: forbidden,
    unverified_treatments: unverified,
    verified_treatments: verified,
    menus,
    writing: {
      tone: writingRules.tone,
      conversion_goal: writingRules.conversion_goal,
      sections: [...(postType === 'style' ? writingRules.style_comment_sections : writingRules.blog_sections)],
      include_hair_consulting: includeConsulting,
      use_season_if_relevant: writingRules.use_season_if_relevant,
      avoid_keyword_stuffing: writingRules.avoid_keyword_stuffing,
      avoid_synonym_only_rewrites: writingRules.diversity.avoid_synonym_only_rewrites,
      cta_examples: writingRules.bookmark_cta_enabled ? [...writingRules.bookmark_cta_variants] : [],
      allowed_cta_patterns: allowedCtas,
      reservation_guidance_allowed: false,
      skeletal_diagnosis_allowed: skeletalAllowed,
    },
    evidence_ids: evidence,
    refs: {
      template_hash: deps.templates.report.workbook_sha256,
      trend_source_refs: dedupe(trends.map((t) => (t.origin === 'public_csv' || t.origin === 'web_search' ? (t.source_id ?? '') : t.origin === 'manual' ? 'trends.json' : 'excel'))),
      instruction_files: instructionFiles,
    },
  };
}
