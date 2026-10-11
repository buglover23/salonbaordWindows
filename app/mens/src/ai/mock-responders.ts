import type { ConfigSnapshot } from '../config/loader.js';
import { AI_STAGES, type AiStage, type AudienceCategory } from '../shared/types.js';
import { CheckRequestMetaSchema } from '../validation/consistency-check.js';
import type { Analysis } from './analysis-schema.js';
import { AnalysisRequestMetaSchema, analysisCategories } from './analyzer.js';
import { postSentences } from './context.js';
import { GenerationRequestMetaSchema } from './generator.js';
import { mockDraftOutput } from './mock-generation.js';
import { mockValueFor, type MockAiProvider, type MockResponder } from './mock-provider.js';

type SnapshotSource = ConfigSnapshot | (() => ConfigSnapshot);
type ResponderFactory = (getSnapshot: () => ConfigSnapshot) => MockResponder;

/** Visible-feature categories first; otherwise the first category that needs no verified menu. */
const PREFERRED_CATEGORIES: Record<AudienceCategory, readonly string[]> = {
  ladies: ['one_color', 'korean_style', 'short'],
  mens: ['mash', 'two_block', 'center_part'],
};

type Profile = Omit<Analysis, 'suggested_category_ids'>;

/** The mock's スタイルのモデル情報 (P3-R50): mostly confident, the face shape not readable (so the page keeps 設定しない for it). */
const MODEL_INFO: Analysis['model_info'] = {
  hair_amount: { value: 'normal', confidence: 0.85 },
  hair_texture: { value: 'normal', confidence: 0.82 },
  thickness: { value: 'normal', confidence: 0.81 },
  curl: { value: 'none', confidence: 0.88 },
  face_shape: { value: 'unknown', confidence: 0.3 },
  age_group: { value: '20s', confidence: 0.84 },
};

const PROFILES: Record<AudienceCategory, Profile> = {
  ladies: {
    schema_version: 1,
    hair_length: { value: 'medium', confidence: 0.92 },
    observed_color: { value: 'ブラウン系', confidence: 0.88 },
    style_features: [
      { value: '顔周りレイヤー', confidence: 0.9 },
      { value: 'くびれ', confidence: 0.84 },
      { value: 'ワンカラー', confidence: 0.8 },
    ],
    bangs: { value: 'see_through', confidence: 0.8 },
    texture: { value: 'straight', confidence: 0.82 },
    impressions: ['柔らかい', '自然な動き', '上品'],
    unknowns: ['実施した施術メニュー', '使用した薬剤'],
    quality_issues: [],
    not_hair_photo: false,
    model_info: MODEL_INFO,
  },
  mens: {
    schema_version: 1,
    hair_length: { value: 'short', confidence: 0.93 },
    observed_color: { value: 'ブラウン系', confidence: 0.85 },
    style_features: [
      { value: 'マッシュ', confidence: 0.9 },
      { value: '刈り上げ', confidence: 0.85 },
      { value: '自然な束感', confidence: 0.8 },
    ],
    bangs: { value: 'full', confidence: 0.82 },
    texture: { value: 'straight', confidence: 0.8 },
    impressions: ['清潔感', '爽やか', '自然な動き'],
    unknowns: ['実施した施術メニュー', '使用した薬剤'],
    quality_issues: [],
    not_hair_photo: false,
    model_info: MODEL_INFO,
  },
};

/**
 * A plausible fixed analysis per audience (the job id does not change it): confidences at least
 * ai.min_required_attribute_confidence, and a category the analyzer accepts for the audience.
 */
const analysisResponder: ResponderFactory = (getSnapshot) => (req) => {
  const meta = AnalysisRequestMetaSchema.safeParse(req.meta);
  if (!meta.success) return mockValueFor(req.schema, req.seed ?? '', req.stage);
  const snapshot = getSnapshot();
  const audience = meta.data.audience_category;
  const min = snapshot.settings.ai.min_required_attribute_confidence;
  const sure = <T extends { confidence: number }>(attr: T): T => ({ ...attr, confidence: Math.max(attr.confidence, min) });
  const allowed = analysisCategories(snapshot, audience)
    .filter((c) => !c.requires_verified_menu)
    .map((c) => c.id);
  const category = PREFERRED_CATEGORIES[audience].find((id) => allowed.includes(id)) ?? allowed[0];
  const p = PROFILES[audience];
  const analysis: Analysis = {
    ...p,
    hair_length: sure(p.hair_length),
    observed_color: sure(p.observed_color),
    style_features: p.style_features.map(sure),
    bangs: sure(p.bangs),
    texture: sure(p.texture),
    impressions: [...p.impressions],
    suggested_category_ids: category === undefined ? [] : [category],
    unknowns: [...p.unknowns],
    quality_issues: [...p.quality_issues],
    model_info: structuredClone(p.model_info),
  };
  return analysis;
};

/**
 * A deterministic draft built from the context facts in the request meta (mock-generation.ts): the context category,
 * verified menus, 8-12 candidate hashtags within the limits, and meta varied by the seed (job id + attempt).
 */
const generationResponder: ResponderFactory = () => (req) => {
  const meta = GenerationRequestMetaSchema.safeParse(req.meta);
  if (!meta.success) return mockValueFor(req.schema, req.seed ?? '', req.stage);
  return mockDraftOutput(meta.data, req.seed ?? meta.data.job_id);
};

const MOCK_CHECK_REASON = '写真と画像解析の内容に合っています（模擬判定）';

/**
 * The consistency check of a dry-run: every sentence of the title and the primary text is a supported claim (the
 * Validator's deterministic checks already ran; the mock never invents a contradiction). Without the check meta, no
 * claims (never a schema-derived verdict, which could be a random contradiction).
 */
const checkResponder: ResponderFactory = () => (req) => {
  const meta = CheckRequestMetaSchema.safeParse(req.meta);
  if (!meta.success) return { claims: [] };
  const m = meta.data;
  const primaryField = m.post_type === 'style' ? 'stylist_comment' : 'body';
  return {
    claims: [
      { field: 'title', text: m.title, verdict: 'supported', reason: MOCK_CHECK_REASON },
      ...postSentences(m.primary_text).map((text) => ({ field: primaryField, text, verdict: 'supported', reason: MOCK_CHECK_REASON })),
    ],
  };
};

/** One entry per stage that has realistic dry-run output; stages without one get the schema-derived value. */
const DEFAULT_RESPONDERS: Partial<Record<AiStage, ResponderFactory>> = {
  analysis: analysisResponder,
  generation: generationResponder,
  check: checkResponder,
};

/**
 * Gives the mock realistic outputs so a dry-run flows through the real pipeline without AI costs (Plan 2 decision 2).
 * Pass a function to follow config reloads. Responders given in the mock's own options (tests) keep priority.
 */
export function registerDefaultMockResponders(mock: MockAiProvider, snapshot: SnapshotSource): void {
  const getSnapshot = typeof snapshot === 'function' ? snapshot : () => snapshot;
  for (const stage of AI_STAGES) {
    const make = DEFAULT_RESPONDERS[stage];
    if (make !== undefined) mock.setDefaultResponder(stage, make(getSnapshot));
  }
}
