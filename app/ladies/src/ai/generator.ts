import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { graphemeLength, graphemeSlice } from '../shared/text.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../shared/types.js';
import type { RetryOptions } from '../storage/atomic-json.js';
import type { DataPaths } from '../storage/paths.js';
import { HAIR_LENGTHS, OBSERVED_COLOR_FAMILIES } from './analysis-schema.js';
import { boundedIds, locateBundle } from './analyzer.js';
import { hashtagPool, isRelatedTag, menusMissing, type FieldLimit, type GenerationContext } from './context.js';
import {
  BlogDraftOutputSchema,
  CONTENT_ANGLES,
  CTA_PATTERNS,
  DraftSchema,
  MAX_DRAFT_KEYWORDS,
  MAX_EVIDENCE_REFS,
  MENU_SEPARATOR,
  OPENING_PATTERN_MAX,
  StyleDraftOutputSchema,
  TITLE_PATTERNS,
  composeMenuText,
  type Draft,
  type DraftOutput,
  type DraftViolation,
} from './draft-schemas.js';
import { prepareAiImage } from './prepare-image.js';
import { buildGenerationPrompt, type PreviousAttempt, type RegenerationInput } from './prompts/common.js';
import type { AiProvider, AiUsage } from './provider.js';
import { FACE_SHAPE_TERMS, cleanTagWord, findSalonFact, findUnverifiedTreatment, findWord, wordKey } from './word-rules.js';

/** Plan 2 Task 7: claude-opus-5-5 always thinks, and thinking tokens count toward max_tokens (as ruling P2-R4). */
export const GENERATION_MAX_TOKENS = 8000;

const STAGE = 'generate';

/** What the mock's generation responder can rely on in AiRequest.meta (never sent to a real provider, never logged). */
export const GenerationRequestMetaSchema = z.strictObject({
  job_id: z.string(),
  attempt: z.number().int().nonnegative(),
  post_type: z.enum(POST_TYPES),
  audience_category: z.enum(AUDIENCE_CATEGORIES),
  category: z.strictObject({ id: z.string(), label: z.string(), keywords: z.array(z.string()) }),
  analysis: z.strictObject({
    hair_length: z.enum(HAIR_LENGTHS),
    observed_color: z.enum(OBSERVED_COLOR_FAMILIES),
    style_features: z.array(z.string()),
    impressions: z.array(z.string()),
  }),
  season: z.strictObject({ key: z.string(), words: z.array(z.string()) }),
  /** registered: salon.verified_menus in order (evidence id menu:<index>, as the prompt numbers them); allowed may be a subset. */
  menus: z.strictObject({
    mode: z.enum(['sidecar', 'choose', 'none']),
    allowed: z.array(z.string()),
    fixed: z.array(z.string()),
    max_items: z.number().int(),
    registered: z.array(z.string()),
  }),
  hashtags: z.strictObject({ min: z.number().int(), max: z.number().int(), suggested: z.number().int(), candidates: z.array(z.string()) }),
  /** Strictest limits in graphemes (bytes converted conservatively); null when the field has none. */
  limits: z.strictObject({
    title: z.number().int(),
    title_target: z.number().int(),
    primary: z.number().int(),
    primary_text_target: z.number().int(),
    menu_text: z.number().int().nullable(),
  }),
  keywords: z.array(z.string()),
  /** Matched by containment. */
  forbidden_words: z.array(z.string()),
  /** Matched with findUnverifiedTreatment against verified_treatments. */
  unverified_treatments: z.array(z.string()),
  verified_treatments: z.array(z.string()),
  excluded_keywords: z.array(z.string()),
  recent: z.strictObject({
    titles: z.array(z.string()),
    openings: z.array(z.string()),
    ctas: z.array(z.string()),
    opening_patterns: z.array(z.string()),
    cta_patterns: z.array(z.enum(CTA_PATTERNS)),
    pairs: z.array(z.strictObject({ title_pattern: z.enum(TITLE_PATTERNS), content_angle: z.enum(CONTENT_ANGLES) })),
  }),
  allowed_cta_patterns: z.array(z.enum(CTA_PATTERNS)),
  include_hair_consulting: z.boolean(),
  use_season: z.boolean(),
  evidence_ids: z.array(z.string()),
});
export type GenerationRequestMeta = z.infer<typeof GenerationRequestMetaSchema>;

export interface GeneratorDeps {
  provider: AiProvider;
  paths: DataPaths;
  /** settings.resources.max_input_pixels for the AI image. */
  maxInputPixels?: number;
  clock: Clock;
  logger?: AppLogger;
  /** Replaces the real waits between retries of transient file locks (tests). */
  retry?: RetryOptions;
}

export interface GenerateResult {
  draft: Draft;
  usage: AiUsage;
  model: string;
  /**
   * What the deterministic normalisation could not repair (e.g. no verified menu left, a call to action that is not
   * allowed). The Validator (Task 8) reports these with its own findings.
   */
  violations: DraftViolation[];
  /** The regeneration input that was sent; null on a first attempt. */
  regeneration: RegenerationInput | null;
}

const strictest = (list: readonly FieldLimit[] | undefined): number | null =>
  list === undefined || list.length === 0 ? null : Math.min(...list.map((l) => (l.unit === 'bytes' ? Math.floor(l.max / 3) : l.max)));

/** Facts for the mock's responder (AiRequest.meta); `attempt` is the job's regeneration_count for this call. */
export function generationMeta(ctx: GenerationContext, attempt: number = ctx.job.attempt): GenerationRequestMeta {
  const { limits } = ctx;
  return {
    job_id: ctx.job.id,
    attempt,
    post_type: ctx.job.post_type,
    audience_category: ctx.job.audience_category,
    category: { id: ctx.category.id, label: ctx.category.label, keywords: [...ctx.category.keywords] },
    analysis: {
      hair_length: ctx.analysis.hair_length.value,
      observed_color: ctx.analysis.observed_color.value,
      style_features: ctx.analysis.style_features.map((f) => f.value),
      impressions: [...ctx.analysis.impressions],
    },
    season: { key: ctx.season.key, words: [...ctx.season.words] },
    menus:
      ctx.menus === null
        ? { mode: 'none', allowed: [], fixed: [], max_items: 0, registered: [...ctx.salon.verified_menus] }
        : { ...ctx.menus, allowed: [...ctx.menus.allowed], fixed: [...ctx.menus.fixed], registered: [...ctx.salon.verified_menus] },
    hashtags: { min: ctx.hashtags.min, max: ctx.hashtags.max, suggested: ctx.hashtags.suggested, candidates: [...ctx.hashtags.candidates] },
    limits: {
      title: strictest(limits.fields.title) ?? 0,
      title_target: limits.targets.title ?? 0,
      primary: strictest(limits.fields[limits.primary_field]) ?? 0,
      primary_text_target: limits.primary_text_target,
      menu_text: strictest(limits.fields.menu_text),
    },
    keywords: [...ctx.keywords],
    forbidden_words: [...ctx.forbidden_words],
    unverified_treatments: [...ctx.unverified_treatments],
    verified_treatments: [...ctx.verified_treatments],
    excluded_keywords: [...ctx.excluded_keywords],
    recent: structuredClone(ctx.recent),
    allowed_cta_patterns: [...ctx.writing.allowed_cta_patterns],
    include_hair_consulting: ctx.writing.include_hair_consulting,
    use_season: ctx.writing.use_season_if_relevant,
    evidence_ids: [...ctx.evidence_ids],
  };
}

const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').trim();

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

const HASHTAG_LINE = /^(?:[#＃][^\s#＃]+\s*)+$/u;

/** A primary text whose last lines are only hashtags (the model appended them itself): the text and those tags. */
function splitTrailingTags(text: string): { text: string; tags: string[] } {
  const lines = text.split('\n');
  const tags: string[] = [];
  while (lines.length > 1 && HASHTAG_LINE.test((lines.at(-1) ?? '').trim())) {
    tags.unshift(...(lines.pop() ?? '').trim().split(/\s+/u));
  }
  return { text: lines.join('\n').trim(), tags };
}

interface Normalised {
  draft: Draft;
  violations: DraftViolation[];
}

type TagRule = 'forbidden_word' | 'unverified_treatment' | 'salon_fact';

const TAG_RULE_MESSAGE: Record<TagRule, (tags: string) => string> = {
  forbidden_word: (tags) => `使えない語（NG語など）を含むハッシュタグを除きました: ${tags}。タイトルや本文にもその語を使わないでください。`,
  unverified_treatment: (tags) => `この写真で確認されていない施術のハッシュタグを除きました: ${tags}。タイトルや本文でもその施術を書かないでください。`,
  salon_fact: (tags) => `料金・場所・予約・人気など、店舗の事実を示すハッシュタグを除きました: ${tags}。設定に無い店舗の事実は書かないでください。`,
};

/**
 * Hashtags as stored: without '#', only usable tag words (cleanTagWord), de-duplicated, without excluded keywords, face
 * shapes and tags unrelated to the post (isRelatedTag), cut to hashtags.max. Tags holding a forbidden word, an
 * unverified treatment or a salon fact are dropped too and reported as violations naming them (spec 9.8, 10.1 step 6),
 * so the Validator rejects the draft and the regeneration feedback names them.
 */
function normaliseTags(rawTags: readonly string[], ctx: GenerationContext, postText: string): { hashtags: string[]; violations: DraftViolation[]; counts: Record<string, number> } {
  const excluded = new Set(ctx.excluded_keywords.map(wordKey));
  const pool = hashtagPool(ctx);
  const facts = [...ctx.salon.location_keywords, ...ctx.salon.strengths];
  const counts = { unusable: 0, duplicate: 0, excluded: 0, face_shape: 0, unrelated: 0, over_max: 0 };
  const offending: Record<TagRule, string[]> = { forbidden_word: [], unverified_treatment: [], salon_fact: [] };
  const cleaned = rawTags.flatMap((t) => cleanTagWord(t) ?? []);
  counts.unusable = rawTags.length - cleaned.length;
  const unique = dedupe(cleaned);
  counts.duplicate = cleaned.length - unique.length;
  const kept: string[] = [];
  for (const t of unique) {
    if (excluded.has(wordKey(t))) counts.excluded++;
    else if (findWord(t, ctx.forbidden_words) !== null) offending.forbidden_word.push(t);
    else if (findUnverifiedTreatment(t, ctx.unverified_treatments, ctx.verified_treatments) !== null) offending.unverified_treatment.push(t);
    else if (findSalonFact(t, facts) !== null) offending.salon_fact.push(t);
    else if (findWord(t, FACE_SHAPE_TERMS) !== null) counts.face_shape++;
    else if (!isRelatedTag(t, pool, postText)) counts.unrelated++;
    else kept.push(t);
  }
  const hashtags = kept.slice(0, ctx.hashtags.max);
  counts.over_max = kept.length - hashtags.length;
  const violations = (Object.keys(offending) as TagRule[])
    .filter((rule) => offending[rule].length > 0)
    .map((rule): DraftViolation => {
      const shown = graphemeSlice(offending[rule].map((t) => `#${t}`).join(' '), 200);
      return { field: 'hashtags', rule, actual: offending[rule].length, limit: null, offending_text: shown, message: TAG_RULE_MESSAGE[rule](shown) };
    });
  return { hashtags, violations, counts: { ...counts, ...Object.fromEntries(Object.entries(offending).map(([k, v]) => [k, v.length])) } };
}

/**
 * The model's answer as a stored draft, deterministically: text trimmed (never shortened), hashtags normalised
 * (normaliseTags); keywords and evidence ids de-duplicated (unknown evidence ids dropped) and capped; the category
 * forced to the context's; style menus only the entries this photo may use (ruling P2-R9, P2-R5).
 */
function normalise(out: DraftOutput, ctx: GenerationContext, log: (event: string, message: string, fields: Record<string, unknown>) => void): Normalised {
  const violations: DraftViolation[] = [];
  const excluded = new Set(ctx.excluded_keywords.map(wordKey));

  const primaryRaw = out.post_type === 'style' ? out.stylist_comment : out.body;
  const { text: primary, tags: inlineTags } = splitTrailingTags(cleanText(primaryRaw));
  if (inlineTags.length > 0) log('GENERATION_INLINE_HASHTAGS_MOVED', '本文の末尾に書かれたハッシュタグを、ハッシュタグ欄に移しました。', { tags: inlineTags.length });

  const title = cleanText(out.title);
  const rawTags = [...inlineTags, ...out.hashtags];
  const tagResult = normaliseTags(rawTags, ctx, `${title}\n${primary}`);
  const hashtags = tagResult.hashtags;
  violations.push(...tagResult.violations);
  const droppedTags = rawTags.length - hashtags.length;
  if (droppedTags > 0) {
    log('GENERATION_HASHTAGS_NORMALISED', `ハッシュタグを整えました（使えない・重複・投稿に関係のない語など${droppedTags}件を除外）。`, {
      dropped: droppedTags,
      kept: hashtags.length,
      ...tagResult.counts,
    });
  }

  const keywords = dedupe(out.keywords.map((k) => k.trim()))
    .filter((k) => !excluded.has(wordKey(k)))
    .slice(0, MAX_DRAFT_KEYWORDS);
  const known = new Set(ctx.evidence_ids);
  const refs = dedupe(out.evidence_refs.map((r) => r.trim()), (s) => s);
  const evidence = refs.filter((r) => known.has(r)).slice(0, MAX_EVIDENCE_REFS);
  if (evidence.length < refs.length) log('GENERATION_EVIDENCE_DROPPED', '根拠として示されたidのうち、参考データに無いものを除きました。', { dropped: refs.length - evidence.length });

  if (out.category_id !== ctx.category.id) {
    log('GENERATION_CATEGORY_OVERRIDDEN', `AIの出力したカテゴリーを、画像解析で決めたカテゴリー（${ctx.category.id}）に戻しました。`, {
      returned_category: graphemeSlice(out.category_id, 64),
      category_id: ctx.category.id,
    });
  }

  const opening = graphemeSlice(out.meta.opening_pattern.replace(/\s+/gu, ' ').trim(), OPENING_PATTERN_MAX);
  const meta = { ...out.meta, opening_pattern: opening };
  if (!ctx.writing.allowed_cta_patterns.includes(meta.cta_pattern)) {
    violations.push({
      field: 'meta.cta_pattern',
      rule: 'cta_not_allowed',
      actual: meta.cta_pattern,
      limit: ctx.writing.allowed_cta_patterns.join(','),
      offending_text: null,
      message:
        meta.cta_pattern === 'reservation_guidance'
          ? '確認済みの予約導線が設定されていないため、予約の案内は使えません。'
          : `この案内（${meta.cta_pattern}）は設定で使わないことになっています。`,
    });
  }

  const common = {
    title,
    category_id: ctx.category.id,
    keywords,
    hashtags,
    evidence_refs: evidence,
    meta,
  };
  if (out.post_type === 'blog') {
    return { draft: { post_type: 'blog', ...common, body: primary }, violations };
  }

  // Style menus (ruling P2-R9): only salon.verified_menus entries this photo may use (ctx.menus.allowed: none naming an
  // unverified treatment); the sidecar's set, when it names one, is used as is.
  const menus = ctx.menus;
  const registered = new Map(ctx.salon.verified_menus.map((m) => [wordKey(m), m]));
  const allowed = new Set(menus?.allowed ?? []);
  const entries = out.menu_items.map((item) => ({ item, entry: ctx.salon.verified_menus.includes(item) ? item : registered.get(wordKey(item)) }));
  const unregistered = entries.flatMap((e) => (e.entry === undefined ? [e.item] : []));
  const notForPhoto = dedupe(entries.flatMap((e) => (e.entry !== undefined && !allowed.has(e.entry) ? [e.entry] : [])));
  const matched = dedupe(entries.flatMap((e) => (e.entry !== undefined && allowed.has(e.entry) ? [e.entry] : [])));
  if (unregistered.length > 0) {
    const shown = boundedIds(unregistered);
    log('GENERATION_MENU_DROPPED', `確認済みメニュー（salon.json の verified_menus）に無いメニューを除きました: ${shown.ids.join(', ')}`, {
      dropped_menu_items: shown.ids,
      dropped_more: shown.more,
    });
  }
  if (notForPhoto.length > 0 && menus?.mode !== 'sidecar') {
    const shown = boundedIds(notForPhoto);
    log('GENERATION_MENU_DROPPED', `この写真で確認できない施術を含むメニューを除きました: ${shown.ids.join(', ')}`, { dropped_menu_items: shown.ids, dropped_more: shown.more });
  }
  const unverified = [...unregistered, ...notForPhoto];
  let items: string[];
  if (menus?.mode === 'sidecar') {
    items = [...menus.fixed];
    const extra = matched.filter((m) => !menus.fixed.includes(m));
    if (extra.length > 0 || matched.length !== menus.fixed.length) {
      log('GENERATION_MENU_FIXED', 'メニューは sidecar.json で指定された確認済みメニューを使いました（AIの選択は使いません）。', { returned: out.menu_items.length });
    }
  } else {
    items = matched.slice(0, menus?.max_items ?? matched.length);
    if (matched.length > items.length) log('GENERATION_MENU_TRIMMED', `メニューは最大${items.length}件までにしました。`, { returned: matched.length });
  }
  if (items.length === 0) {
    violations.push({
      field: 'menu_text',
      rule: 'unverified_menu',
      actual: out.menu_items.length,
      limit: null,
      offending_text: unverified.length === 0 ? null : graphemeSlice(unverified.join(MENU_SEPARATOR), 200),
      message: 'この写真に使える確認済みメニュー（salon.json の verified_menus のうち、確認できない施術を含まないもの）から選ばれたメニューがありません。',
    });
  }
  return { draft: { post_type: 'style', ...common, menu_text: composeMenuText(items), stylist_comment: primary }, violations };
}

/**
 * Generates one draft for `job` from its GenerationContext (spec 9, 10.2), using the AI stage `generation` (model and
 * effort from settings.ai, applied by the provider). The prepared ai.jpg is sent with the request; `previous` turns the
 * call into a regeneration (the previous draft, its violations and the target lengths are handed back as data).
 * Before any AI call, a style job without verified menus stops with CONFIG_INCOMPLETE (ruling P2-R9). Provider failures
 * (AI_OUTPUT_INVALID for a schema-invalid answer, AI_* transport and budget errors) pass through unchanged.
 */
export async function generateDraft(deps: GeneratorDeps, job: Job, context: GenerationContext, previous?: PreviousAttempt): Promise<GenerateResult> {
  const { provider, clock, logger } = deps;
  if (context.job.id !== job.id || context.job.post_type !== job.post_type || context.job.audience_category !== job.audience_category) {
    throw new AppFailure(
      appError('INTERNAL_ERROR', STAGE, clock, {
        message: `文章生成の参考情報が別のjobのものです（${context.job.id}）: ${job.id}`,
        retryable: false,
        details: { job_id: job.id, context_job_id: context.job.id },
      }),
    );
  }
  if (job.post_type === 'style' && (context.salon.verified_menus.length === 0 || context.menus === null)) throw menusMissing(clock, job.id);
  // The attempt (seed, regeneration count) follows the job passed in, so a context built once can serve every attempt.
  const attempt = job.regeneration_count;
  if (previous !== undefined && attempt === 0) {
    throw new AppFailure(
      appError('INTERNAL_ERROR', STAGE, clock, {
        message: `文章の作り直しなのに、jobの再生成回数が0のままです（同じ下書きが繰り返されるため止めました）: ${job.id}`,
        retryable: false,
        details: { job_id: job.id, regeneration_count: attempt },
      }),
    );
  }

  const fields = { job_id: job.id, stage: STAGE, post_type: job.post_type, audience_category: job.audience_category };
  const retry = deps.retry === undefined ? {} : { retry: deps.retry };
  const { dir, source } = locateBundle(job, deps.paths, clock, 'generate');
  const image = await prepareAiImage(dir, source, { clock, ...retry, ...(deps.maxInputPixels === undefined ? {} : { maxInputPixels: deps.maxInputPixels }) });
  const prompt = buildGenerationPrompt(context, previous, attempt);
  const schema = job.post_type === 'style' ? StyleDraftOutputSchema : BlogDraftOutputSchema;
  const result = await provider.structured<DraftOutput>({
    stage: 'generation',
    schema,
    system: prompt.system,
    content: [
      { type: 'image_jpeg_base64', data: image.data },
      { type: 'text', text: prompt.text },
    ],
    maxTokens: GENERATION_MAX_TOKENS,
    seed: `${job.id}#${attempt}`,
    meta: generationMeta(context, attempt),
  });
  const { draft, violations } = normalise(result.value, context, (event, message, extra) => logger?.info(event, message, { ...fields, ...extra }));
  const checked = DraftSchema.safeParse(draft);
  if (!checked.success) {
    throw new AppFailure(
      appError('INTERNAL_ERROR', STAGE, clock, {
        message: '生成した下書きが保存できる形になっていません。詳細はログを確認してください。',
        retryable: false,
        details: { job_id: job.id, issues: checked.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), code: i.code })) },
      }),
    );
  }
  logger?.info('DRAFT_GENERATED', `下書きを作成しました: ${job.id}（${previous === undefined ? '初回' : `再生成${attempt}回目`}、タイトル${graphemeLength(checked.data.title)}文字）`, {
    ...fields,
    model: result.model,
    attempt,
    hashtags: checked.data.hashtags.length,
    pre_violations: violations.map((v) => `${v.field}:${v.rule}`),
  });
  return { draft: checked.data, usage: result.usage, model: result.model, violations, regeneration: prompt.regeneration };
}
