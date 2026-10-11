import { z } from 'zod';
import { HAIR_LENGTHS, OBSERVED_COLOR_FAMILIES } from '../ai/analysis-schema.js';
import { COUNT_UNITS } from '../shared/text.js';
import { DEFAULT_COLOR_TERMS, DEFAULT_NG_WORD_EXCEPTIONS, DEFAULT_RESTRICTED_TERMS, DEFAULT_STYLE_TERMS, RESTRICTION_KINDS } from './dictionaries.js';
import { jstIsoWeekday, parseExportedAt, parseHHmm } from '../shared/time.js';
import { AI_EFFORTS, AUDIENCE_CATEGORIES, MODES, type AudienceCategory } from '../shared/types.js';
import { PageProfileSchema } from '../shared/protocol/profile.js';
import { ADAPTER_IDS } from '../shared/protocol/version.js';

// Every config file is a strict object (unknown keys rejected) with schema_version 1 (spec 5.1).
// Cross-file checks (hashtag categories, schedule capacity) live in the loader, not here.

const schemaVersion = z.literal(1);
const nonEmpty = z.string().min(1);
const textList = z.array(nonEmpty);
const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();
const ratio = z.number().min(0).max(1);

const minutesOrNull = (s: string): number | null => {
  try {
    return parseHHmm(s);
  } catch {
    return null;
  }
};
const isDateKey = (s: string): boolean => {
  try {
    jstIsoWeekday(s);
    return true;
  } catch {
    return false;
  }
};

const hhmm = z.string().refine((s) => minutesOrNull(s) !== null, { error: '時刻は HH:mm 形式（00:00〜23:59）で指定してください' });
const dateKey = z.string().refine(isDateKey, { error: '日付は実在する YYYY-MM-DD 形式で指定してください' });
/** A JST minute, 'YYYY-MM-DD HH:mm'. */
const jstMinute = z.string().refine((s) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) && isDateKey(s.slice(0, 10)) && minutesOrNull(s.slice(11)) !== null, {
  error: '日時は日本時間の YYYY-MM-DD HH:mm 形式（例: 2026-10-12 09:30）で書いてください',
});
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, { error: '64桁の16進数（小文字）で書いてください' });
const isoWeekday = z.number().int().min(1).max(7);
const month = z.number().int().min(1).max(12);

// Spec 5.9: config names the environment variable holding a secret, never the secret itself.
const envName = z.string().refine((s) => /^[A-Z][A-Z0-9_]*$/.test(s), {
  error: '環境変数の名前（英大文字・数字・_）を書いてください。キーの値そのものは書かないでください',
});

// Only the listed schemes, written out with "//" (so "https:example.com" is not silently accepted). Whitespace and
// control characters are refused because the URL parser would silently drop them.
const urlWith = (protocols: readonly string[], error: string) =>
  z.string().refine((s) => {
    const url = URL.parse(s);
    return url !== null && protocols.includes(url.protocol) && /^[a-z]+:\/\//i.test(s) && !/[\s\p{Cc}]/u.test(s);
  }, { error });
const httpsUrl = urlWith(['https:'], 'https:// で始まるURLを書いてください');
const httpUrl = urlWith(['http:', 'https:'], 'http:// または https:// で始まるURLを書いてください');

// One issue per repeated id, at its first repeat.
function uniqueIds(items: readonly { id: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  items.forEach(({ id }, i) => {
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `id「${id}」が重複しています（同じ一覧の中では別々の id にしてください）` });
    }
    seen.add(id);
  });
}

// ---------------------------------------------------------------- settings.json (spec 5.2, Plan 2 decisions 1-3)

// A non-empty list without repeats (e.g. ['mens', 'ladies']).
const audienceList = z
  .array(z.enum(AUDIENCE_CATEGORIES))
  .min(1)
  .superRefine((list, ctx) => {
    if (new Set(list).size !== list.length) ctx.addIssue({ code: 'custom', message: '同じ対象（mens / ladies）が重複しています' });
  });


export const AI_PROVIDERS = ['mock', 'anthropic', 'gemini', 'openai'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

const usd = z.number().nonnegative();
const byStage = <T extends z.ZodType>(value: T) => z.strictObject({ analysis: value, generation: value, check: value });

const ModelPricingSchema = z.strictObject({
  input_per_mtok: usd,
  output_per_mtok: usd,
  cache_read_per_mtok: usd,
  /** When the prices were last checked against the provider's price list. */
  verified_at: dateKey,
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

const AnthropicSettingsSchema = z.strictObject({
  api_key_env: envName,
  /** null = not chosen yet (live readiness reports it). */
  models: byStage(nonEmpty.nullable()),
  /** Always sent explicitly: claude-opus-5-5 would otherwise default to medium. */
  effort: byStage(z.enum(AI_EFFORTS)),
  refusal_fallback: z.boolean(),
  /** USD per million tokens, by model id; cache writes are billed at 1.25 × input. */
  pricing: z.record(nonEmpty, ModelPricingSchema),
});

/** OpenAI reasoning effort values (the SDK's ReasoningEffort; not every model takes every value). */
export const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OpenAiEffort = (typeof OPENAI_EFFORTS)[number];

// The efforts each recommended model accepts (developers.openai.com/api/docs/models, checked 2026-10-09); other models are not checked.
const OPENAI_MODEL_EFFORTS: Readonly<Record<string, readonly OpenAiEffort[]>> = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const openAiPrice = (input: number, cached: number, output: number): ModelPricing => ({ input_per_mtok: input, output_per_mtok: output, cache_read_per_mtok: cached, verified_at: '2026-10-09' });

/** ai.openai when settings.json has none: the model and effort per purpose (owner's final choice 2026-10). */
export const OPENAI_DEFAULTS = {
  models: { analysis: 'gpt-6.1-sol', generation: 'gpt-6-luna', check: 'gpt-6.1-sol' },
  web_search_model: 'gpt-6-astra',
  reasoning_effort: { analysis: 'medium', generation: 'medium', check: 'medium', web_search: 'high' },
  pricing: { 'gpt-6-astra': openAiPrice(10, 1, 50), 'gpt-6.1-sol': openAiPrice(2, 0.1, 10), 'gpt-6-luna': openAiPrice(0.1, 0.01, 0.5) },
  web_search_call_usd: 0.01,
} as const;

const openAiEffort = z.enum(OPENAI_EFFORTS);

/** settings.json ai.openai (used with ai.provider "openai", or an .env stage on openai); the key is OPENAI_API_KEY. */
const OpenAiSettingsSchema = z
  .strictObject({
    models: byStage(nonEmpty),
    /** The model of the trend web look-up (AiRequest.webSearch), whichever stage's model the generation uses. */
    web_search_model: nonEmpty,
    /** Sent as the reasoning effort to the stage's settings model (and to web_search_model for a web search). */
    reasoning_effort: z.strictObject({ analysis: openAiEffort, generation: openAiEffort, check: openAiEffort, web_search: openAiEffort }),
    /** USD per million tokens, by model id. */
    pricing: z.record(nonEmpty, ModelPricingSchema),
    /** USD per web search call (OpenAI bills the search tool per call, on top of the tokens). */
    web_search_call_usd: usd,
  })
  .superRefine((o, ctx) => {
    const pairs = [...(['analysis', 'generation', 'check'] as const).map((s) => [s, o.models[s]] as const), ['web_search', o.web_search_model] as const];
    for (const [key, model] of pairs) {
      const allowed = OPENAI_MODEL_EFFORTS[model];
      const effort = o.reasoning_effort[key];
      if (allowed !== undefined && !allowed.includes(effort)) {
        ctx.addIssue({ code: 'custom', path: ['reasoning_effort', key], message: `${model} では reasoning_effort に "${effort}" を使えません。${allowed.map((e) => `"${e}"`).join('・')} のどれかを書いてください` });
      }
    }
  });

/** Gemini 3 thinking levels (thinkingConfig.thinkingLevel). */
export const GEMINI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

/**
 * A level (Gemini 3), a token budget (Gemini 2.5: -1 = dynamic, 0 = off) or null (the model's default, nothing sent).
 * The API rejects a level on 2.5 models and both at once (ai.google.dev/gemini-api/docs/generate-content/thinking).
 */
const geminiThinking = z.union([z.enum(GEMINI_THINKING_LEVELS), z.number().int().min(-1), z.null()]);
export type GeminiThinking = z.infer<typeof geminiThinking>;

// Models documented as rejecting thinkingLevel "minimal" (ai.google.dev/gemini-api/docs/models).
const NO_MINIMAL_THINKING = ['gemini-3.8-flash', 'gemini-3.7-flash'];

/** The output token limit of the Gemini 3.x Flash models (ai.google.dev/gemini-api/docs/models); more is never sent. */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

const RequestLimitSchema = z.strictObject({
  /** Requests per minute. */
  rpm: posInt,
  /** Requests per quota day (resets at midnight US Pacific). */
  rpd: posInt,
  /** When the numbers were checked in Google AI Studio; null = not checked yet. */
  verified_at: dateKey.nullable(),
});
export type GeminiRequestLimit = z.infer<typeof RequestLimitSchema>;

const GeminiSettingsSchema = z
  .strictObject({
    api_key_env: envName,
    /** The Gemini API version in the request URL (e.g. "v1beta"); null = the SDK's default. For when Google retires one. */
    api_version: z.string().regex(/^[A-Za-z0-9._-]+$/, { error: 'API のバージョン名（半角の英数字、例: v1beta）を書いてください' }).nullable().default(null),
    /** null = not chosen yet (live readiness reports it). */
    models: byStage(nonEmpty.nullable()),
    /** Ruling P2-R18: tried in order within the same call when the stage's model is busy (503) or stopped for the day. */
    fallback_models: byStage(z.array(nonEmpty)),
    thinking: byStage(geminiThinking),
    /** Thinking tokens count toward the output limit, so each stage gets at least this many (the larger of this and the stage's own limit is sent). */
    max_output_tokens: byStage(posInt.max(GEMINI_MAX_OUTPUT_TOKENS)),
    /** true: no charge (estimated spend 0), the per-model limits below pace every call. */
    free_tier: z.boolean(),
    /** Per model id: the limits the app keeps under (required for every model in use on the free tier). */
    limits: z.record(nonEmpty, RequestLimitSchema),
    /** Used only when free_tier is false; USD per million tokens, by model id. */
    pricing: z.record(nonEmpty, ModelPricingSchema),
  })
  .superRefine((g, ctx) => {
    for (const stage of ['analysis', 'generation', 'check'] as const) {
      const thinking = g.thinking[stage];
      if (typeof thinking !== 'string') continue;
      // The stage's thinking is sent to its fallback models too.
      for (const model of [g.models[stage], ...g.fallback_models[stage]]) {
        if (model === null) continue;
        if (model.startsWith('gemini-2.')) {
          ctx.addIssue({
            code: 'custom',
            path: ['thinking', stage],
            message: `${model} では thinking に段階（"low" など）を指定できません。トークン数（整数。-1 は自動、0 はオフ）か null を書いてください`,
          });
        } else if (thinking === 'minimal' && NO_MINIMAL_THINKING.includes(model)) {
          ctx.addIssue({ code: 'custom', path: ['thinking', stage], message: `${model} では thinking に "minimal" を使えません。"low" 以上か null を書いてください` });
        }
      }
    }
  });

export const SettingsSchema = z.strictObject({
  schema_version: schemaVersion,
  mode: z.enum(MODES),
  timezone: z.literal('Asia/Tokyo'),
  data_root: nonEmpty,
  /**
   * The shared layout: the folder (relative to the project root, e.g. "../..") holding .env, images/pending, 設定 and
   * トレンド語 for both copies of the tool. null: everything inside this folder, as before.
   */
  shared_root: nonEmpty.nullable().default(null),
  /** The audiences this copy posts for (one SALON BOARD login per copy); null: both. */
  audiences: audienceList.nullable().default(null),
  server: z.strictObject({
    host: z.literal('127.0.0.1'),
    /** 3001 by default; a second copy of the tool (another SALON BOARD login) uses another port, e.g. 3002. */
    port: z.number().int().min(1024).max(65535),
    /** Chrome extension ids (32 letters a-p); the production id is derived from the committed public key (Plan 3 D1). */
    allowed_extension_ids: z.array(z.string().regex(/^[a-p]{32}$/, { error: '拡張機能のID（a〜p の小文字32文字）を書いてください' })),
    token_env: envName,
  }),
  queue: z.strictObject({
    concurrency: z.literal(1),
    heartbeat_seconds: posInt,
    min_submit_interval_seconds: nonNegInt,
  }),
  ai: z.strictObject({
    /** Ruling P2-R13: Gemini (free tier) by default; each provider keeps its own key, models and prices below. */
    provider: z.enum(AI_PROVIDERS).nullable(),
    gemini: GeminiSettingsSchema,
    anthropic: AnthropicSettingsSchema,
    /** Absent from older settings files: the defaults (a copy, so no caller can change the shared object). */
    openai: OpenAiSettingsSchema.default(() => structuredClone(OPENAI_DEFAULTS)),
    consistency_check: z.enum(['final_only', 'off']),
    dry_run_use_real_ai: z.boolean(),
    budget: z.strictObject({ daily_usd: usd, monthly_usd: usd }),
    timeout_seconds: posInt,
    max_transport_retries: nonNegInt,
    max_regenerations: nonNegInt,
    min_required_attribute_confidence: ratio,
    daily_request_limit: nonNegInt,
  }),
  retry: z
    .strictObject({
      enabled: z.boolean(),
      max_retries: nonNegInt,
      delays_seconds: z.array(posInt),
      jitter_ratio: ratio,
      respect_post_window: z.literal(true),
    })
    .superRefine((r, ctx) => {
      if (r.delays_seconds.length < r.max_retries) {
        ctx.addIssue({
          code: 'custom',
          path: ['delays_seconds'],
          message: `delays_seconds は max_retries（${r.max_retries}）個以上の待機秒数が必要です（現在 ${r.delays_seconds.length} 個）`,
        });
      }
    }),
  duplicates: z.strictObject({
    recent_posts: nonNegInt,
    title_similarity_threshold: ratio,
    body_similarity_threshold: ratio,
    allow_same_image_across_types: z.boolean(),
  }),
  retention: z.strictObject({
    enabled: z.boolean(),
    posted_data_days: z.number().int().min(30),
    cleanup_interval_hours: posInt,
    cleanup_batch_size: posInt,
    keep_dedupe_records: z.literal(true),
    cache_max_mb: posInt,
    backup_max_mb: posInt,
    backup_retention_days: posInt,
  }),
  resources: z.strictObject({
    ai_concurrency: posInt,
    image_concurrency: posInt,
    max_prepared_jobs: posInt,
    intake_batch_size: posInt,
    max_input_file_mb: posInt,
    max_input_pixels: posInt,
    min_free_disk_mb: nonNegInt,
    memory_soft_limit_mb: posInt,
    max_log_total_mb: posInt,
  }),
  launcher: z.strictObject({
    /**
     * true: open Chrome at launcher.chrome_path (and chrome_profile_directory); "auto": find chrome.exe and the Chrome
     * profile that has this copy's extension, then open SALON BOARD there; false: never.
     */
    open_chrome: z.union([z.boolean(), z.literal('auto')]),
    chrome_path: nonEmpty.nullable(),
    chrome_profile_directory: nonEmpty.nullable(),
    restart_limit: nonNegInt,
    restart_window_minutes: posInt,
  }),
  logs: z.strictObject({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    retention_days: posInt,
    max_file_mb: posInt,
    save_failure_screenshots: z.boolean(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** The audiences this copy handles (settings.audiences; both when null). */
export const handledAudiences = (s: Pick<Settings, 'audiences'>): readonly AudienceCategory[] => s.audiences ?? AUDIENCE_CATEGORIES;

// ---------------------------------------------------------------- deployment_checks.json (spec 1.4)

const LimitSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('unlimited'), source: nonEmpty, checked_at: nonEmpty }),
  z.strictObject({ status: z.literal('limited'), value: nonNegInt, unit: nonEmpty, source: nonEmpty, checked_at: nonEmpty }),
  z.strictObject({ status: z.literal('not_applicable'), reason: nonEmpty }),
]);
export type PostingLimit = z.infer<typeof LimitSchema>;

const PostingLimitsSchema = z
  .strictObject({
    daily: LimitSchema,
    monthly: LimitSchema,
    total: LimitSchema,
    image_capacity: LimitSchema,
    /** The total count (with its time). */
    current_count: nonNegInt.nullable(),
    counted_at: nonEmpty.nullable(),
    /** 'jst_calendar' is the only form the quota math supports; other text still parses (a readiness item, P3-R9). */
    quota_period_boundary: nonEmpty.nullable(),
    /** Posts kept free below a limited kind (required when any kind is limited, P3-R9). */
    safety_margin: nonNegInt.nullable().default(null),
    /** How long current_count stays usable. */
    count_valid_days: posInt.nullable().default(null),
    /** The owner's count of today's / this month's posts, replacing our own count from counted_at on. */
    daily_count: z.strictObject({ value: nonNegInt, counted_at: jstMinute }).nullable().default(null),
    monthly_count: z.strictObject({ value: nonNegInt, counted_at: jstMinute }).nullable().default(null),
  })
  .superRefine((p, ctx) => {
    // A count without the time it was taken cannot be compared with the quota period.
    if (p.current_count !== null && p.counted_at === null) {
      ctx.addIssue({ code: 'custom', path: ['counted_at'], message: 'current_count を書いたときは、数えた日時（counted_at）も書いてください' });
    }
  });

// A legacy boolean still parses (readiness reports it); the record binds the owner's check to the profile and URL (P3-R37).
const routeVerified = z.union([
  z.boolean(),
  z.strictObject({
    verified: z.literal(true),
    profile_id: nonEmpty,
    profile_hash: sha256Hex,
    entry_url_sha256: sha256Hex,
    entry_url_display: z.string(),
    checked_at: dateKey,
  }),
]);
const verifiedByAudience = z.strictObject({ mens: routeVerified, ladies: routeVerified });

export const DeploymentChecksSchema = z.strictObject({
  schema_version: schemaVersion,
  automation: z.strictObject({
    status: z.enum(['unknown', 'permitted', 'prohibited']),
    evidence: nonEmpty.nullable(),
    checked_at: nonEmpty.nullable(),
  }),
  posting_limits: z.strictObject({ style: PostingLimitsSchema, blog: PostingLimitsSchema }),
  page_routes_verified: z.strictObject({ style: verifiedByAudience, blog: verifiedByAudience }),
  authentication: z.strictObject({
    checked_at: nonEmpty.nullable(),
    mfa_mode: nonEmpty.nullable(),
    session_expiry_policy: nonEmpty.nullable(),
    /** Limits on logging in from several screens or devices at once (spec 1.4). */
    concurrent_sessions: nonEmpty.nullable().default(null),
  }),
});
export type DeploymentChecks = z.infer<typeof DeploymentChecksSchema>;

// ---------------------------------------------------------------- salon.json (spec 5.3)

export const SalonSchema = z.strictObject({
  schema_version: schemaVersion,
  salon_id: nonEmpty,
  poster_name: nonEmpty,
  expected_account_label: nonEmpty.nullable(),
  staff_option_value: nonEmpty.nullable(),
  /** The style page's coupon by name (profile.coupon): `by_category[confirmed category id]`, else `default`; null = off. */
  coupons: z.strictObject({ default: nonEmpty.nullable().default(null), by_category: z.record(nonEmpty, nonEmpty).default({}) }).default({ default: null, by_category: {} }),
  location_keywords: textList,
  target_audiences: textList,
  strengths: textList,
  verified_menus: textList,
  service_claims: z.strictObject({
    hair_consulting: z.boolean(),
    formal_skeletal_diagnosis: z.boolean(),
  }),
  // Fixed: the posting screen defaults are not configurable (decision 3).
  style_defaults: z.strictObject({
    image_count: z.literal(1),
    feature: z.literal('none'),
    apply_image: z.literal(false),
    model_information: z.literal('none'),
    auto_select_coupon: z.literal(false),
  }),
});
export type Salon = z.infer<typeof SalonSchema>;

// ---------------------------------------------------------------- schedule.json (spec 5.4, decision 2)

const timeRange = z.strictObject({ start: hhmm, end: hhmm }).superRefine((r, ctx) => {
  const start = minutesOrNull(r.start);
  const end = minutesOrNull(r.end);
  if (start !== null && end !== null && start >= end) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: '終了時刻は開始時刻より後にしてください（日跨ぎの営業時間は設定できません）' });
  }
});
const dayHours = z.array(timeRange);

// All seven ISO weekday keys are required; an empty array means closed that day.
const businessHours = z.strictObject({
  '1': dayHours,
  '2': dayHours,
  '3': dayHours,
  '4': dayHours,
  '5': dayHours,
  '6': dayHours,
  '7': dayHours,
});

const postsPerDay = z.number().int().min(0).max(100);

export const ScheduleSchema = z
  .strictObject({
    schema_version: schemaVersion,
    timezone: z.literal('Asia/Tokyo'),
    business_hours: businessHours.nullable(),
    post_start: hhmm,
    post_end: hhmm,
    style_posts_per_day: postsPerDay,
    blog_posts_per_day: postsPerDay,
    active_weekdays: z.array(isoWeekday).superRefine((days, ctx) => {
      if (new Set(days).size !== days.length) {
        ctx.addIssue({ code: 'custom', message: 'active_weekdays に同じ曜日が重複しています' });
      }
    }),
    closed_dates: z.array(dateKey),
    distribution: z.literal('interleaved_even'),
    missed_slot_policy: z.literal('skip'),
    slot_grace_minutes: z.number().int().min(0).max(120),
  })
  .superRefine((s, ctx) => {
    const start = minutesOrNull(s.post_start);
    const end = minutesOrNull(s.post_end);
    if (start !== null && end !== null && start >= end) {
      ctx.addIssue({ code: 'custom', path: ['post_end'], message: 'post_end は post_start より後にしてください（日跨ぎの投稿時間は設定できません）' });
    }
  });
export type ScheduleConfig = z.infer<typeof ScheduleSchema>;

// ---------------------------------------------------------------- keywords.json / hashtags.json (spec 5.5)

/** Comparison key of the dictionaries: NFKC, lower case, without whitespace (as the Validator matches words). */
const dictionaryKey = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

const COLOR_FAMILY_KEYS = OBSERVED_COLOR_FAMILIES.filter((f): f is Exclude<typeof f, 'unknown'> => f !== 'unknown');
const LENGTH_KEYS = HAIR_LENGTHS.filter((l): l is Exclude<typeof l, 'unknown'> => l !== 'unknown');

/** A Japanese message for a record key outside `allowed` (Zod's own text is English). */
const keyError =
  (what: string, allowed: readonly string[]) =>
  (issue: { code?: string }): string | undefined =>
    issue.code === 'invalid_key' || issue.code === 'unrecognized_keys' ? `${what}は次のどれかで書いてください: ${allowed.join(', ')}` : undefined;

const RestrictedTermSchema = z.strictObject({
  term: nonEmpty,
  allowed_only_if: z.enum(RESTRICTION_KINDS),
  note: z.string().default(''),
});

const NgWordExceptionSchema = z
  .strictObject({
    term: nonEmpty,
    /** A literal phrase (not a regular expression) that contains the term. */
    context_pattern: nonEmpty,
  })
  .superRefine((e, ctx) => {
    if (!dictionaryKey(e.context_pattern).includes(dictionaryKey(e.term))) {
      ctx.addIssue({ code: 'custom', path: ['context_pattern'], message: `context_pattern には「${e.term}」を含む言い回しを書いてください（例: 必ずしも）` });
    }
  });

export const KeywordsSchema = z
  .strictObject({
    schema_version: schemaVersion,
    priority_keywords: textList,
    secondary_keywords: textList,
    ng_words: textList,
    excluded_topics: textList,
    season_months: z.record(nonEmpty, z.array(month)),
    season_words: z.record(nonEmpty, textList),
    /** Validator dictionaries (Plan 2 Task 8). Built-in lists apply when a key is missing. */
    color_terms: z
      .partialRecord(z.enum(COLOR_FAMILY_KEYS), z.array(nonEmpty), { error: keyError('color_terms の色の系統', COLOR_FAMILY_KEYS) })
      .default(() => structuredClone(DEFAULT_COLOR_TERMS)),
    style_terms: z
      .partialRecord(z.enum(LENGTH_KEYS), z.array(nonEmpty), { error: keyError('style_terms の長さ', LENGTH_KEYS) })
      .default(() => structuredClone(DEFAULT_STYLE_TERMS)),
    restricted_terms: z.array(RestrictedTermSchema).default(() => structuredClone(DEFAULT_RESTRICTED_TERMS)),
    ng_word_exceptions: z.array(NgWordExceptionSchema).default(() => structuredClone(DEFAULT_NG_WORD_EXCEPTIONS)),
  })
  .superRefine((k, ctx) => {
    const seenTerms = new Set<string>();
    k.restricted_terms.forEach((r, i) => {
      const key = dictionaryKey(r.term);
      if (seenTerms.has(key)) ctx.addIssue({ code: 'custom', path: ['restricted_terms', i, 'term'], message: `restricted_terms の「${r.term}」が重複しています` });
      seenTerms.add(key);
    });
    const seen = new Map<number, number>();
    for (const months of Object.values(k.season_months)) {
      for (const m of months) seen.set(m, (seen.get(m) ?? 0) + 1);
    }
    const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => !seen.has(m));
    const repeated = [...seen].filter(([, n]) => n > 1).map(([m]) => m);
    if (missing.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['season_months'], message: `season_months に含まれない月があります: ${missing.join(', ')}` });
    }
    if (repeated.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['season_months'], message: `season_months で重複している月があります: ${repeated.join(', ')}` });
    }

    const monthKeys = Object.keys(k.season_months);
    const wordKeys = Object.keys(k.season_words);
    const noWords = monthKeys.filter((key) => !wordKeys.includes(key));
    const noMonths = wordKeys.filter((key) => !monthKeys.includes(key));
    if (noWords.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['season_words'], message: `season_words に季節がありません: ${noWords.join(', ')}` });
    }
    if (noMonths.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['season_words'], message: `season_months に無い季節です: ${noMonths.join(', ')}` });
    }
  });
export type Keywords = z.infer<typeof KeywordsSchema>;

export const HashtagsSchema = z
  .strictObject({
    schema_version: schemaVersion,
    target_count: posInt,
    min_count: posInt,
    max_count: posInt,
    common: textList,
    by_category: z.record(nonEmpty, textList),
  })
  .superRefine((h, ctx) => {
    if (!(h.min_count <= h.target_count && h.target_count <= h.max_count)) {
      ctx.addIssue({ code: 'custom', path: ['target_count'], message: 'min_count <= target_count <= max_count にしてください' });
    }
  });
export type Hashtags = z.infer<typeof HashtagsSchema>;

// ---------------------------------------------------------------- trends.json (spec 5.6)

export const TREND_DATA_KINDS = ['interest_over_time', 'related_queries'] as const;
export type TrendDataKind = (typeof TREND_DATA_KINDS)[number];

// The id names the cache file (data/cache/trends/<id>.json): lower-case only, so two ids never share a file on Windows,
// and never a Windows device name (con, nul, com1, ...), which opens a device with or without an extension.
export const TREND_SOURCE_ID_PATTERN = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)$)[a-z0-9][a-z0-9_-]{0,63}$/;
const trendSourceId = z.string().refine((s) => TREND_SOURCE_ID_PATTERN.test(s), {
  error: 'id は英小文字・数字・-・_ の64文字以内で書いてください（取込結果の保存ファイル名になります。con や nul などは使えません）',
});

const ManualImportSourceSchema = z.strictObject({
  id: trendSourceId,
  kind: z.literal('manual_import'),
  enabled: z.boolean(),
  file_path: nonEmpty,
  source_url: httpUrl,
  /** When the CSV was exported from the public page. A bare date means 00:00 JST of that day. */
  exported_at: z.string().refine((s) => parseExportedAt(s) !== null, {
    error: '書き出した日時は、実在する YYYY-MM-DD（例: 2026-10-03）か、時差付きの日時（例: 2026-10-03T10:30:00+09:00）で書いてください',
  }),
  region: nonEmpty,
  period: nonEmpty,
  /** Only the layouts the importer implements; the CSV is parsed as this kind and never guessed (spec 8.4). */
  data_kind: z.enum(TREND_DATA_KINDS),
});
export type ManualImportSource = z.infer<typeof ManualImportSourceSchema>;

const OnlineSourceSchema = z.strictObject({
  id: nonEmpty,
  kind: z.enum(['public_search_api', 'public_feed', 'public_page']),
  enabled: z.boolean(),
  endpoint: httpsUrl,
  api_key_env: envName,
  allowed_domains: textList,
  queries: textList,
});

export const TrendsSchema = z.strictObject({
  schema_version: schemaVersion,
  enabled: z.boolean(),
  refresh_hours: posInt,
  cache_ttl_hours: posInt,
  fallback: z.enum(['manual_and_template']),
  locale: nonEmpty,
  region: nonEmpty,
  sources: z.array(z.discriminatedUnion('kind', [ManualImportSourceSchema, OnlineSourceSchema])).superRefine(uniqueIds),
  trend_words: textList,
  trend_colors: textList,
  trend_styles: textList,
  season_words: textList,
  /** Every Sunday the generation AI looks up men's and women's hair trend words, per audience, on the web (web-trends.ts); off: nothing is fetched. */
  web_search: z.strictObject({ enabled: z.boolean() }).default({ enabled: true }),
});
export type Trends = z.infer<typeof TrendsSchema>;

// ---------------------------------------------------------------- writing_rules.json (spec 5.7)

export const WritingRulesSchema = z.strictObject({
  schema_version: schemaVersion,
  language: nonEmpty,
  tone: nonEmpty,
  conversion_goal: nonEmpty,
  diversity: z.strictObject({
    sentence_lookback: nonNegInt,
    pattern_lookback: nonNegInt,
    avoid_synonym_only_rewrites: z.boolean(),
  }),
  include_hair_consulting: z.boolean(),
  use_season_if_relevant: z.boolean(),
  avoid_keyword_stuffing: z.boolean(),
  avoid_unverified_claims: z.boolean(),
  style_comment_sections: textList,
  blog_sections: textList,
  bookmark_cta_enabled: z.boolean(),
  bookmark_cta_variants: textList,
  allowed_urls: z.array(httpsUrl),
  hashtag_placement: z.enum(['append_to_primary_text']),
  /**
   * Plan 2 decision 10: conservative placeholders until a verified page profile (Plan 3) gives the real limits; the
   * stricter of the two always applies. For the primary text (stylist_comment / body) the limit covers the appended hashtags.
   */
  default_limits: z.strictObject({
    count_unit: z.enum(COUNT_UNITS),
    style: z.strictObject({ title: posInt, stylist_comment: posInt, menu_text: posInt }),
    /** body_max_newlines: line breaks in the final body string, hashtag block included (real screen: 改行80回以下). */
    blog: z.strictObject({ title: posInt, body: posInt, body_max_newlines: nonNegInt.default(80) }),
  }),
});
export type WritingRules = z.infer<typeof WritingRulesSchema>;

// ---------------------------------------------------------------- categories / template_mapping / salonboard_fields (spec 5.8, 5.11)

const CategoryEntrySchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
  /** Who the category is for; template examples are only taken from sheets for the same audience. */
  audiences: audienceList,
  allowed_keywords: textList,
  /** The template_mapping.json `category` values whose sheets hold examples for this category. */
  template_categories: textList,
  /**
   * A category a photo alone cannot justify (a treatment such as 髪質改善, bleach, perm, extensions): the image analysis
   * uses it only when the photo's sidecar category_hint names it, never from the AI's guess. false when omitted.
   */
  requires_verified_menu: z.boolean().default(false),
  /**
   * Ruling P2-R12, requires_verified_menu categories only: the treatment words a photo's confirmed category makes usable
   * besides its own label and allowed_keywords (e.g. 髪質改善 for 髪質改善カラー). They only free words: listing a word
   * here never blocks it on other photos. Empty when omitted.
   */
  verified_terms: textList.default([]),
  salonboard_option_value: nonEmpty.nullable(),
}).superRefine((entry, ctx) => {
  if (!entry.requires_verified_menu && entry.verified_terms.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['verified_terms'],
      message: 'verified_terms は requires_verified_menu が true のカテゴリー（写真だけでは確かめられない施術）にだけ書けます',
    });
  }
});

export const CategoriesSchema = z.strictObject({
  schema_version: schemaVersion,
  style_categories: z.array(CategoryEntrySchema).superRefine(uniqueIds),
  blog_categories: z.array(CategoryEntrySchema).superRefine(uniqueIds),
});
export type Categories = z.infer<typeof CategoriesSchema>;

// Excel column letters, A to XFD.
const MAX_SHEET_ROW = 1_048_576;
const columnLetter = z.string().refine((s) => /^[A-Z]{1,3}$/.test(s) && (s.length < 3 || s <= 'XFD'), {
  error: '列は Excel の列記号（A〜XFD の英大文字）で書いてください',
});

export const TEMPLATE_SHEET_KINDS = ['category', 'top_titles', 'trend_words'] as const;
export type TemplateSheetKind = (typeof TEMPLATE_SHEET_KINDS)[number];

const SheetColumnsSchema = z.strictObject({
  title: columnLetter.optional(),
  menu: columnLetter.optional(),
  comment: columnLetter.optional(),
  length: columnLetter.optional(),
  /** A subgroup label (e.g. 「ツーブロック / フェード」); the last non-empty value is carried down to the rows below it. */
  group: columnLetter.optional(),
  hashtags: z.array(columnLetter).optional(),
  /** Columns known to hold nothing the importer uses (No., model information, images); they are not reported as unknown. */
  ignore: z.array(columnLetter).optional(),
});

const SheetMappingSchema = z
  .strictObject({
    /** Matched exactly, including spaces (e.g. a trailing space in the workbook's sheet name). */
    sheet_name: nonEmpty,
    header_row: z.number().int().min(1).max(MAX_SHEET_ROW),
    category: nonEmpty,
    audiences: audienceList,
    kind: z.enum(TEMPLATE_SHEET_KINDS),
    columns: SheetColumnsSchema,
  })
  .superRefine((m, ctx) => {
    const { hashtags = [], ignore = [], ...single } = m.columns;
    if ((m.kind === 'category' || m.kind === 'top_titles') && single.title === undefined) {
      ctx.addIssue({ code: 'custom', path: ['columns', 'title'], message: `kind が ${m.kind} のシートにはタイトルの列（title）が必要です` });
    }
    if (m.kind === 'trend_words' && hashtags.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['columns', 'hashtags'], message: 'kind が trend_words のシートにはキーワードの列（hashtags）が必要です' });
    }
    // One column may serve only one purpose, or the importer would read the same cell twice.
    const used = new Map<string, string>();
    const uses: [(string | number)[], string | undefined][] = [
      ...Object.entries(single).map(([field, col]): [(string | number)[], string | undefined] => [[field], col]),
      ...hashtags.map((col, i): [(string | number)[], string] => [['hashtags', i], col]),
      ...ignore.map((col, i): [(string | number)[], string] => [['ignore', i], col]),
    ];
    for (const [path, col] of uses) {
      if (col === undefined) continue;
      const first = used.get(col);
      if (first === undefined) {
        used.set(col, String(path[0]));
        continue;
      }
      ctx.addIssue({ code: 'custom', path: ['columns', ...path], message: `列 ${col} は ${first} にも使われています（1つの列は1つの用途にだけ使えます）` });
    }
  });
export type SheetMapping = z.infer<typeof SheetMappingSchema>;

export const TemplateMappingSchema = z.strictObject({
  schema_version: schemaVersion,
  /** The workbook; an absolute path is allowed. It is only ever read (plan decision 5). */
  file_path: nonEmpty.nullable(),
  sheet_mappings: z.array(SheetMappingSchema).superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((m, i) => {
      if (seen.has(m.sheet_name)) {
        ctx.addIssue({ code: 'custom', path: [i, 'sheet_name'], message: `シート「${m.sheet_name}」の対応が重複しています` });
      }
      seen.add(m.sheet_name);
    });
  }),
});
export type TemplateMapping = z.infer<typeof TemplateMappingSchema>;

const PostingRouteSchema = z.strictObject({
  entry_url: nonEmpty.nullable(),
  adapter_id: z.enum(ADAPTER_IDS).nullable(),
  page_profile_id: nonEmpty.nullable(),
});
const routesByAudience = z.strictObject({ mens: PostingRouteSchema, ladies: PostingRouteSchema });

export type { PageProfile } from '../shared/protocol/profile.js';

/** Origin form only: scheme://host[:port], no path or trailing '/' (whether it may be used is the URL policy's call). */
const origin = z.string().refine((s) => URL.parse(s)?.origin === s, {
  error: '接続先は https://ドメイン名 のような origin の形（小文字、パスや末尾の / なし）で書いてください',
});

export const SalonboardFieldsSchema = z.strictObject({
  schema_version: schemaVersion,
  verified_at: nonEmpty.nullable(),
  adapter_version: nonEmpty.nullable(),
  allowed_origins: z.array(origin),
  posting_routes: z.strictObject({ style: routesByAudience, blog: routesByAudience }),
  /** Plan 3 page profiles; only screens the owner surveyed (P3-R7). */
  pages: z.record(nonEmpty, PageProfileSchema),
});
export type SalonboardFields = z.infer<typeof SalonboardFieldsSchema>;

// ---------------------------------------------------------------- registry

// Keys match the ConfigSnapshot property names consumed by the loader.
export const CONFIG_FILES = {
  settings: 'settings.json',
  deploymentChecks: 'deployment_checks.json',
  salon: 'salon.json',
  schedule: 'schedule.json',
  keywords: 'keywords.json',
  hashtags: 'hashtags.json',
  trends: 'trends.json',
  writingRules: 'writing_rules.json',
  categories: 'categories.json',
  templateMapping: 'template_mapping.json',
  salonboardFields: 'salonboard_fields.json',
} as const;
export type ConfigKey = keyof typeof CONFIG_FILES;

export const SCHEMAS = {
  settings: SettingsSchema,
  deploymentChecks: DeploymentChecksSchema,
  salon: SalonSchema,
  schedule: ScheduleSchema,
  keywords: KeywordsSchema,
  hashtags: HashtagsSchema,
  trends: TrendsSchema,
  writingRules: WritingRulesSchema,
  categories: CategoriesSchema,
  templateMapping: TemplateMappingSchema,
  salonboardFields: SalonboardFieldsSchema,
} as const satisfies Record<ConfigKey, z.ZodType>;
