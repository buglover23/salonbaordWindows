import { usesEnvStages, type AiConfigResult } from '../ai/ai-config.js';
import { routeTargetItems } from '../posting/profile/route-resolve.js';
import type { ErrorCode } from '../shared/errors.js';
import { AI_STAGE_JA, AUDIENCE_JA, POST_TYPE_JA } from '../shared/labels.js';
import { MAPPABLE_SOURCE_VALUES, type PageProfile } from '../shared/protocol/profile.js';
import { ADAPTER_VERSION, type RouteKey } from '../shared/protocol/version.js';
import { jstDateKey } from '../shared/time.js';
import { AI_STAGES, type AudienceCategory, type PostType } from '../shared/types.js';
import { PRODUCTION_URL_POLICY, type UrlPolicy } from '../shared/url-policy.js';
import type { ConfigSnapshot } from './loader.js';
import { handledAudiences, type PostingLimit, type SalonboardFields, type Settings } from './schemas.js';

export type { RouteKey };

export interface ReadinessItem {
  code: ErrorCode;
  /** Japanese, operator-facing. */
  detail: string;
}

const LIMITS = [
  ['daily', '日次'],
  ['monthly', '月次'],
  ['total', '累積'],
  ['image_capacity', '画像容量'],
] as const satisfies readonly (readonly [string, string])[];

type RealProvider = 'anthropic' | 'gemini' | 'openai';

/** The models `provider` calls: the check model only while the consistency check is on; Gemini's fallback models after the stages' own. */
export function usedAiModels(ai: Settings['ai'], provider: RealProvider): string[] {
  const models = ai[provider].models;
  // A stage without a model is not called at all, so its fallbacks are not either.
  const stages = AI_STAGES.filter((stage) => (stage !== 'check' || ai.consistency_check !== 'off') && models[stage] !== null);
  const fallbacks = provider === 'gemini' ? stages.flatMap((stage) => ai.gemini.fallback_models[stage]) : [];
  return [...new Set([...stages.map((stage) => models[stage] as string), ...fallbacks])];
}

// Live needs a real provider, a model for every stage, and per model in use a price (or spend cannot be estimated,
// Plan 2 decision 3) or, on the Gemini free tier, its request limits (the pacing works per model); and a budget above zero.
function aiItems(ai: Settings['ai'], env?: AiConfigResult, acceptMock = false): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const add = (detail: string): void => {
    items.push({ code: 'CONFIG_INCOMPLETE', detail });
  };
  if (env !== undefined && (env.issues.length > 0 || usesEnvStages(env))) {
    envAiItems(ai, env, add, acceptMock);
    return items;
  }
  const choose = '本番では gemini・anthropic・openai のどれかを指定してください（settings.json の ai.provider）';
  if (ai.provider === null) add(`AIの提供元が未設定です。${choose}`);
  else if (ai.provider === 'mock') {
    if (!acceptMock) add(`AIの提供元が mock のままです。${choose}`);
  }
  else {
    const p = ai.provider;
    for (const stage of AI_STAGES) {
      if (ai[p].models[stage] === null) add(`${AI_STAGE_JA[stage]}のモデル名が未設定です（settings.json の ai.${p}.models.${stage}）`);
    }
    const freeTier = p === 'gemini' && ai.gemini.free_tier;
    for (const model of usedAiModels(ai, p)) {
      if (freeTier) {
        if (!Object.hasOwn(ai.gemini.limits, model)) add(`モデル「${model}」の無料枠の上限（1分・1日の回数）が未設定です（settings.json の ai.gemini.limits）`);
      } else if (!Object.hasOwn(ai[p].pricing, model)) {
        add(`モデル「${model}」の料金が未設定のため、AIの利用額を見積もれません（settings.json の ai.${p}.pricing）`);
      }
    }
  }
  budgetItems(ai, add);
  return items;
}

function budgetItems(ai: Settings['ai'], add: (detail: string) => void): void {
  if (ai.budget.daily_usd <= 0) add('AIの1日の予算が0です（settings.json の ai.budget.daily_usd）');
  if (ai.budget.monthly_usd <= 0) add('AIの1か月の予算が0です（settings.json の ai.budget.monthly_usd）');
}

// .env stages (ruling P2-R17): resolveAiConfig already checked models, keys and prices of the .env values; what is left
// is a stage with no real service, and the settings.json checks for stages that still come from settings.json.
function envAiItems(ai: Settings['ai'], env: AiConfigResult, add: (detail: string) => void, acceptMock: boolean): void {
  for (const i of env.issues) add(`AIの設定の誤り（${i.file} ${i.path}）: ${i.message}`);
  for (const stage of AI_STAGES) {
    if (stage === 'check' && ai.consistency_check === 'off') continue;
    const s = env.stages[stage];
    if (s.service === 'mock' && acceptMock) continue;
    if (s.service === null || s.service === 'mock') {
      add(`${AI_STAGE_JA[stage]}のAIが${s.service === null ? '未設定' : ' mock のまま'}です（.env の AI_<段階>_PROVIDER か settings.json の ai.provider）`);
    } else if (s.source === 'settings' && (s.service === 'gemini' || s.service === 'claude' || s.service === 'openai')) {
      const p = s.service === 'claude' ? 'anthropic' : s.service;
      if (s.model === null) add(`${AI_STAGE_JA[stage]}のモデル名が未設定です（settings.json の ai.${p}.models.${stage}）`);
      else if (p === 'gemini' && ai.gemini.free_tier) {
        if (!Object.hasOwn(ai.gemini.limits, s.model)) add(`モデル「${s.model}」の無料枠の上限（1分・1日の回数）が未設定です（settings.json の ai.gemini.limits）`);
      } else if (!Object.hasOwn(ai[p].pricing, s.model)) {
        add(`モデル「${s.model}」の料金が未設定のため、AIの利用額を見積もれません（settings.json の ai.${p}.pricing）`);
      }
    }
  }
  budgetItems(ai, add);
}

function globalItems(s: ConfigSnapshot, policy: UrlPolicy, ai?: AiConfigResult, acceptMockAi = false): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const add = (code: ErrorCode, detail: string): void => {
    items.push({ code, detail });
  };

  const { automation, authentication } = s.deploymentChecks;
  if (automation.status === 'unknown') {
    add('EXTERNAL_REQUIREMENT_UNVERIFIED', '自動操作が許可されているか未確認です（deployment_checks.json の automation.status が unknown）');
  } else if (automation.status === 'prohibited') {
    add('AUTOMATION_NOT_PERMITTED', '自動操作は禁止と確認されています（deployment_checks.json の automation.status が prohibited）');
  } else {
    // Spec 1.4: a permission without recorded evidence and date is not a verified permission.
    if (automation.evidence === null) add('EXTERNAL_REQUIREMENT_UNVERIFIED', '自動操作を許可する根拠が記録されていません（deployment_checks.json の automation.evidence）');
    if (automation.checked_at === null) add('EXTERNAL_REQUIREMENT_UNVERIFIED', '自動操作の許可を確認した日が記録されていません（deployment_checks.json の automation.checked_at）');
  }
  if (authentication.checked_at === null) {
    add('EXTERNAL_REQUIREMENT_UNVERIFIED', 'ログイン・認証の条件を確認した日が記録されていません（deployment_checks.json の authentication.checked_at）');
  }
  if (authentication.concurrent_sessions === null) {
    add(
      'EXTERNAL_REQUIREMENT_UNVERIFIED',
      '同時に複数の画面・端末でログインしたときの制限を確認した内容が記録されていません（deployment_checks.json の authentication.concurrent_sessions。オーナーが npm.cmd run checks:record -- auth で記録します）',
    );
  }

  for (const item of aiItems(s.settings.ai, ai, acceptMockAi)) add(item.code, item.detail);
  if (s.salon.expected_account_label === null) add('CONFIG_INCOMPLETE', '投稿先の店舗アカウント表示名が未設定です（salon.json の expected_account_label）');
  const f = s.salonboardFields;
  if (f.allowed_origins.length === 0) add('CONFIG_INCOMPLETE', '許可する接続先（origin）が未設定です（salonboard_fields.json の allowed_origins。オーナーが npm.cmd run checks:record -- origin で記録します）');
  for (const origin of f.allowed_origins) {
    const reason = policy.checkOrigin(origin);
    if (reason !== null) add('CONFIG_INCOMPLETE', `接続先 ${origin} は使えません: ${reason}（salonboard_fields.json の allowed_origins）`);
  }
  if (f.adapter_version !== ADAPTER_VERSION) {
    add('CONFIG_INCOMPLETE', `画面設定の版（salonboard_fields.json の adapter_version）が${f.adapter_version === null ? '未設定' : `「${f.adapter_version}」`}です。このツールの版は「${ADAPTER_VERSION}」です（開発担当が画面設定と一緒に記入します）`);
  }
  return items;
}

const TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'textarea', 'contenteditable']);
const LIMITED_FIELDS = ['title', 'menu_text', 'stylist_comment', 'body', 'hashtags'] as const;
// The logical fields each adapter fills (the real style page has no category select; the blog page has one).
const REQUIRED_FIELDS: Record<PostType, readonly string[]> = {
  style: ['title', 'menu_text', 'stylist_comment', 'image', 'feature', 'apply_image', 'coupon'],
  blog: ['title', 'body', 'category', 'image'],
};

/** What a verified-to-be profile must describe before the adapter can post with it (Task 3 readiness items). */
function profileItems(s: ConfigSnapshot, type: PostType, audience: AudienceCategory, id: string, p: PageProfile, label: string): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const add = (detail: string): void => {
    items.push({ code: 'CONFIG_INCOMPLETE', detail: `${label}${detail}` });
  };
  const of = `の画面profile「${id}」`;
  const f = p.fields;
  // The coupon is handled either by a fields.coupon (left at none) or by the coupon dialog (profile.coupon).
  const missing = REQUIRED_FIELDS[type].filter((k) => f[k] === undefined && !(k === 'coupon' && p.coupon !== undefined));
  if (missing.length > 0) add(`${of}に必要な欄（${missing.join('・')}）がありません`);
  if (type === 'style') {
    if (!Object.keys(f).some((k) => k.startsWith('model_info.')) && p.owner_attestations.model_info_absent_on === null) {
      add(`${of}にモデル情報の欄（model_info.*）がありません（画面に無いときは、オーナーの確認を checks:record profile で記録します）`);
    }
    if (p.poster === null) add(`${of}に投稿者の扱い（poster）が未設定です`);
    else if (p.poster.mode === 'absent_on_screen' && p.owner_attestations.poster_absent_on === null) {
      add(`${of}は投稿者の表示が画面に無いとしていますが、オーナーの確認が記録されていません（checks:record profile で記録します）`);
    }
  }
  // P3-R15: any staff field, required or not, is set to the salon's own option.
  if (f.staff !== undefined && s.salon.staff_option_value === null) {
    add('の画面にスタッフ（投稿者）を選ぶ欄があります。選ぶ選択肢を salon.json の staff_option_value に設定してください（オーナーに確認します）');
  }
  for (const [key, field] of Object.entries(f)) {
    if (field.map === undefined) continue;
    const uncovered = MAPPABLE_SOURCE_VALUES[field.map.source].filter((v) => v !== 'unknown' && field.map?.options[v] === undefined);
    if (uncovered.length > 0) add(`${of}の ${key} に、解析結果 ${uncovered.join(', ')} に対応する選択肢がありません（オーナーが承認した対応表が必要です）`);
  }
  for (const key of LIMITED_FIELDS) {
    const field = f[key];
    if (field === undefined || !TEXT_KINDS.has(field.kind) || p.limits[key] !== undefined) continue;
    if (key === 'hashtags' && p.hashtag.max_tag_length !== null) continue;
    add(`${of}の ${key} の文字数の上限（limits.${key}）が未設定です`);
  }
  if (p.success_signals.completion.length === 0) add(`${of}に登録完了を見分ける条件（success_signals.completion）が未設定です`);
  if (p.success_signals.list === null && p.success_signals.completion_only !== true) add(`${of}に投稿一覧で登録を確かめる方法（success_signals.list）が未設定です`);
  if (p.submit.confirm.kind === 'native_confirm') add(`${of}: 登録ボタンの後に出る確認の小さな画面（OK／キャンセル）には対応していません（開発担当に連絡してください）`);
  // P3-R8: the screen's hashtag place and count must allow the writing rules' tags.
  if (p.hashtag.placement === 'unsupported') add('：この画面にはハッシュタグを入れる場所がありません（仕様の調整が必要です）');
  else if (p.hashtag.max_count !== null && p.hashtag.max_count < s.hashtags.min_count) {
    add(`：画面のハッシュタグ上限（${p.hashtag.max_count}個）が文章ルールの最低数（${s.hashtags.min_count}個）より少ないため、仕様の調整が必要です`);
  }
  if (p.adapter_version !== ADAPTER_VERSION) add(`${of}の版（adapter_version「${p.adapter_version}」）がこのツールの版（「${ADAPTER_VERSION}」）と違います`);
  // Spec 5.8-f: every category this route can post needs its option on the screen.
  if (f.category !== undefined) {
    const open = s.categories[type === 'style' ? 'style_categories' : 'blog_categories'].filter((c) => c.audiences.includes(audience) && c.salonboard_option_value === null);
    if (open.length > 0) {
      add(`のカテゴリー（${open.map((c) => c.label).join('・')}）に、SALON BOARD で選ぶ選択肢（categories.json の salonboard_option_value）が未設定です（開発担当が候補を示し、オーナーが決めます）`);
    }
  }
  return items;
}

// P3-R9: the remaining posts can be computed only in the supported forms.
function quotaItems(s: ConfigSnapshot, type: PostType, label: string, profile: PageProfile | null, now: Date): ReadinessItem[] {
  const p = s.deploymentChecks.posting_limits[type];
  const where = `deployment_checks.json の posting_limits.${type}`;
  const out: string[] = [];
  const unknown = unknownLimitNames(p);
  if (unknown.length > 0) out.push(`の登録件数の上限（${unknown.join('・')}）が確認できていません（${where}）`);
  const limited = LIMITS.filter(([name]) => p[name].status === 'limited');
  if (limited.length > 0 && p.safety_margin === null) out.push(`の上限まで残しておく件数（${where}.safety_margin）が未設定です`);
  if ((p.daily.status === 'limited' || p.monthly.status === 'limited') && p.quota_period_boundary !== 'jst_calendar') {
    out.push(`の1日・1か月の件数の区切り（${where}.quota_period_boundary）が jst_calendar（日本時間の暦日・暦月）ではないため、残り件数を計算できません`);
  }
  if (p.total.status === 'limited' && profile?.count_display?.kind !== 'total' && !countUsable(p.current_count, p.counted_at, p.count_valid_days, now)) {
    out.push(`の累計の件数（${where}.current_count・counted_at・count_valid_days）が未記録か古いため、残り件数を計算できません（オーナーが npm.cmd run checks:record -- count で記録します）`);
  }
  if (p.image_capacity.status === 'limited' && p.image_capacity.unit !== '枚') out.push(`の画像容量の上限は「枚」で記録してください（今は「${p.image_capacity.unit}」。${where}.image_capacity）`);
  return out.map((detail) => ({ code: 'POST_CAPACITY_UNKNOWN', detail: `${label}${detail}` }));
}

function countUsable(count: number | null, countedAt: string | null, validDays: number | null, now: Date): boolean {
  const day = countedAt === null ? null : /^\d{4}-\d{2}-\d{2}/.exec(countedAt)?.[0];
  if (count === null || validDays === null || day === undefined || day === null) return false;
  const age = (Date.parse(`${jstDateKey(now)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  return age >= 0 && age <= validDays;
}

function unknownLimitNames(limits: Record<(typeof LIMITS)[number][0], PostingLimit>): string[] {
  return LIMITS.filter(([name]) => limits[name].status === 'unknown').map(([, label]) => label);
}

function routeItems(s: ConfigSnapshot, type: PostType, audience: AudienceCategory, routes: SalonboardFields['posting_routes'], policy: UrlPolicy, now: Date): ReadinessItem[] {
  const label = `${POST_TYPE_JA[type]}・${AUDIENCE_JA[audience]}`;
  const items = routeTargetItems(s, type, audience, routes, policy);
  const id = routes[type][audience].page_profile_id;
  const profile = id === null ? undefined : s.salonboardFields.pages[id];
  if (id !== null && profile !== undefined && profile.post_type === type) items.push(...profileItems(s, type, audience, id, profile, label));

  // Ruling P2-R9: a style post's menu text is only ever built from verified menus, so none registered blocks style.
  if (type === 'style' && s.salon.verified_menus.length === 0) {
    items.push({ code: 'CONFIG_INCOMPLETE', detail: `${label}のメニュー欄に使える確認済みメニューがありません。salon.json の verified_menus に確認済みのスタイルメニューを登録してください` });
  }

  // Limits are per post type: an unknown style limit holds back both style routes and no blog route.
  items.push(...quotaItems(s, type, label, profile ?? null, now));
  return items;
}

export interface ReadinessOptions {
  /** The effective routing (after URL overrides from instructions); default the one in the config. */
  routes?: SalonboardFields['posting_routes'] | undefined;
  /** The .env AI stages (loadAiSetup); settings.json alone when omitted. */
  ai?: AiConfigResult | undefined;
  /** For the quota items (Plan 3 Task 3); default the system time. */
  now?: Date | undefined;
  /** Which origins may be used (Plan 3 Task 3); default PRODUCTION_URL_POLICY. */
  policy?: UrlPolicy | undefined;
  /** The mock AI does not hold live back (set only by the runtime's test-only override, P3-R41). */
  acceptMockAi?: boolean | undefined;
}

/** P3-R17. */
export const SCREENSHOT_WARNING = '失敗時の画面の保存（settings.json の logs.save_failure_screenshots）は、Plan 3 では画面の保存に対応していないため保存しません';

/** Settings worth a note that never block live posting (status shows them next to the ACL warning). */
export const readinessWarnings = (s: ConfigSnapshot): string[] => (s.settings.logs.save_failure_screenshots ? [SCREENSHOT_WARNING] : []);

/** What still blocks live posting (spec 1.4, 5.1, 5.11). An empty list means nothing blocks. */
export function checkLiveReadiness(s: ConfigSnapshot, opts: ReadinessOptions = {}): { global: ReadinessItem[]; routes: Record<RouteKey, ReadinessItem[]> } {
  const routes = opts.routes ?? s.salonboardFields.posting_routes;
  const policy = opts.policy ?? PRODUCTION_URL_POLICY;
  const now = opts.now ?? new Date();
  // A route of an audience this copy does not handle (settings.audiences) is never missing anything here.
  const handled = handledAudiences(s.settings);
  const route = (type: PostType, audience: AudienceCategory): ReadinessItem[] => (handled.includes(audience) ? routeItems(s, type, audience, routes, policy, now) : []);
  return {
    global: globalItems(s, policy, opts.ai, opts.acceptMockAi === true),
    routes: {
      'style.mens': route('style', 'mens'),
      'style.ladies': route('style', 'ladies'),
      'blog.mens': route('blog', 'mens'),
      'blog.ladies': route('blog', 'ladies'),
    },
  };
}
