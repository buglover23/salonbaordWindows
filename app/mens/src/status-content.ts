import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { keyStateOf, providerKindFor, type AiProviderKind } from './ai/ai-service.js';
import type { AiSetup } from './ai/ai-setup.js';
import { geminiQuotaStatusLines } from './ai/gemini-status.js';
import { STYLE_MENUS_MISSING_STATUS, styleMenusMissing } from './ai/context.js';
import { UsageMeter, type UsageSummary } from './ai/usage-meter.js';
import type { ConfigSnapshot } from './config/loader.js';
import { handledAudiences } from './config/schemas.js';
import { inspectTemplates, type TemplateStatus } from './content/template-source.js';
import { TrendLibrary, type TrendSourceState } from './content/trends.js';
import { MANUAL_TRENDS_XLSX, manualTrendWords, manualTrendsStatusLine, trendListAudience, trendListNote } from './content/trend-workbook.js';
import { readAllWebTrends, webTrendsStatusLines } from './content/web-trends.js';
import { readWorkbook } from './content/xlsx/read-xlsx.js';
import { loggerFrom } from './logger.js';
import type { Clock } from './shared/clock.js';
import { errorText } from './shared/errors.js';
import { formatJst } from './shared/time.js';
import type { AudienceCategory, Mode } from './shared/types.js';
import type { DataPaths } from './storage/paths.js';
import type { RuntimeStatus } from './storage/runtime-status.js';
import { SerialQueue } from './storage/serial-queue.js';

// Status lines about the content pipeline (Plan 2 Task 9): AI usage against the budget and why AI work is stopped, which
// AI is used, the Excel templates, the trend CSVs and the verified menus style posts need.

export interface AiStatus {
  provider: AiProviderKind | null;
  /** For the real provider: whether its API key is set (the value is never read out); null for the mock. */
  key_set: boolean | null;
  /** The variable of settings.json's real provider key (null for the mock, .env stages or no provider). */
  api_key_env: string | null;
  /** Gemini only: per model, the daily stop, rest or today's count against the cap (geminiQuotaStatusLines). */
  quota_lines: string[];
  usage: UsageSummary | null;
  usage_error: string | null;
  /** Why AI work is stopped (the running tool's record, or the budget as the usage file stands); null when it is not. */
  stop: { code: string; message: string; since: string | null } | null;
}

export interface TrendsStatus {
  state: 'none' | 'valid' | 'expired';
  label: string;
  valid_records: number;
  sources: TrendSourceState[];
  /** The weekly web look-ups, one line per audience (webTrendsStatusLine). */
  web?: readonly string[] | undefined;
  /** 手動のトレンド語.xlsx (manualTrendsStatusLine). */
  manual?: string | undefined;
}

export interface ContentStatus {
  ai: AiStatus;
  templates: TemplateStatus;
  trends: TrendsStatus | null;
  /** Ruling P2-R9: style posts wait while salon.verified_menus is empty. */
  style_menus_missing: boolean;
}

/** The parts the running tool already holds (its AI service, libraries and meter). */
export interface ContentStatusSources {
  provider: AiProviderKind | null;
  keySet: boolean | null;
  keyEnv: string | null;
  usage: () => Promise<UsageSummary>;
  /** geminiQuotaStatusLines with the current settings (read-only). */
  quota: () => Promise<string[]>;
  stop: { code: string; message: string; since: string | null } | null;
  templates: TemplateStatus;
  trends: TrendsStatus | null;
}

export async function contentStatusFrom(config: ConfigSnapshot, src: ContentStatusSources): Promise<ContentStatus> {
  let usage: UsageSummary | null = null;
  let usageError: string | null = null;
  try {
    usage = await src.usage();
  } catch (err) {
    usageError = errorText(err);
  }
  let quotaLines: string[] = [];
  try {
    quotaLines = await src.quota();
  } catch (err) {
    usageError ??= errorText(err);
  }
  return {
    ai: { provider: src.provider, key_set: src.keySet, api_key_env: src.keyEnv, quota_lines: quotaLines, usage, usage_error: usageError, stop: src.stop },
    templates: src.templates,
    trends: src.trends,
    style_menus_missing: styleMenusMissing(config),
  };
}

/**
 * The read-only `status`: everything from the files, without the lock and without writing (the usage file, .env, the
 * template pointer and the saved trend imports are only read; a CSV is only stat'ed, once).
 */
export async function readContentStatus(
  projectRoot: string,
  config: ConfigSnapshot,
  paths: DataPaths,
  clock: Clock,
  runtime: { record: RuntimeStatus | null; running: boolean },
  ai: AiSetup,
  /** The audiences the weekly web look-up covers (webTrendAudiences of the effective routes). */
  webAudiences: readonly AudienceCategory[],
): Promise<ContentStatus> {
  const now = clock.now();
  const { settings } = config;
  const mode: Mode = settings.mode;
  const provider = providerKindFor(settings, mode, ai.config);
  let meter: UsageMeter | null = null;
  let meterError: string | null = null;
  try {
    meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue: new SerialQueue(), getSettings: () => settings, clock });
  } catch (err) {
    meterError = errorText(err);
  }
  const recorded = runtime.running ? (runtime.record?.ai_stop ?? null) : null;
  let stop: AiStatus['stop'] = recorded === null ? null : { ...recorded };
  if (stop === null && provider !== null && provider !== 'mock' && meter !== null) {
    const blocked = (await meter.summary(now)).blocked;
    if (blocked !== null) stop = { code: 'AI_BUDGET_EXCEEDED', message: blocked.message, since: null };
  }
  const templates = await inspectTemplates(config.templateMapping, paths.templateCacheDir, projectRoot, clock);
  const library = new TrendLibrary({ cacheDir: paths.trendCacheDir, baseDir: projectRoot, logger: loggerFrom(() => undefined), clock });
  let trends: TrendsStatus | null = null;
  if (config.trends.enabled) {
    await library.loadCached(config, now);
    const s = library.status(now);
    const states = await readAllWebTrends(paths.trendCacheDir);
    const web = webTrendsStatusLines(states, config.trends.web_search.enabled, now, webAudiences, handledAudiences(settings));
    web[web.length - 1] += trendListNote(paths.trendWorkbookDir, trendListAudience(settings));
    const manualPath = join(paths.trendWorkbookDir, MANUAL_TRENDS_XLSX);
    const manualWords = existsSync(manualPath) ? await readWorkbook(manualPath).then(manualTrendWords, () => null) : { mens: [], ladies: [] };
    trends = { state: s.state, label: s.label, valid_records: library.validRecords(now).length, sources: s.sources, web, manual: manualTrendsStatusLine(manualWords, handledAudiences(settings)) };
  }
  return contentStatusFrom(config, {
    provider,
    ...keyStateOf(provider, ai.config),
    usage: async () => {
      if (meter === null) throw new Error(meterError ?? 'AI利用量の記録を読み取れません');
      return meter.summary(now);
    },
    quota: async () => (meter === null ? [] : geminiQuotaStatusLines(settings.ai, await meter.quotaSummary(now), now, ai.config)),
    stop,
    templates,
    trends,
  });
}

// ---------------------------------------------------------------- Japanese text

const usd = (n: number): string => (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));

function aiLines(ai: AiStatus, mode: Mode): string[] {
  const lines = ['AI（画像の解析・文章の作成）:'];
  if (ai.provider === 'mock') {
    lines.push(
      mode === 'dry_run'
        ? '  使うAI: 模擬（mock）。dry-run の既定で、費用はかからず外部には何も送りません（本物のAIで試すには settings.json の ai.dry_run_use_real_ai を true に）。'
        : '  使うAI: 模擬（mock）。settings.json の ai.provider が "mock" のため、本物のAIは使いません。',
    );
  } else if (ai.provider === 'anthropic' || ai.provider === 'gemini') {
    lines.push(
      ai.provider === 'gemini'
        ? '  使うAI: Google Gemini。写真（縮小・位置情報などを削除したもの）と文章の材料を Google に送ります。'
        : '  使うAI: Anthropic（Claude）。写真（縮小・位置情報などを削除したもの）と文章の材料を Anthropic に送ります。',
    );
    lines.push(ai.key_set === true ? `  APIキー: 設定あり（.env の ${ai.api_key_env}。値は表示しません）` : `  APIキー: 見つかりません（.env に「${ai.api_key_env}=キー」を書いてください）`);
    lines.push(...ai.quota_lines.map((l) => `  ${l}`));
  } else if (ai.provider !== null) {
    lines.push('  使うAI: 段階ごとに指定したAI（上の「AIの設定」）。写真（縮小・位置情報などを削除したもの）と文章の材料をそれぞれのサービスに送ります。');
    lines.push(...ai.quota_lines.map((l) => `  ${l}`));
  } else {
    lines.push('  使うAI: 未設定（.env の AI_<段階>_PROVIDER か settings.json の ai.provider に "gemini"（または "anthropic"・"openai"）を指定してください）。');
  }
  if (ai.usage !== null) {
    const u = ai.usage;
    lines.push(
      `  本日（${u.date}）: ${u.today.requests}回 / 上限 ${u.limits.daily_request_limit}回、見積 ${usd(u.today.est_usd)}ドル / 予算 ${usd(u.limits.daily_usd)}ドル`,
      `  今月（${u.month}）: ${u.month_total.requests}回、見積 ${usd(u.month_total.est_usd)}ドル / 予算 ${usd(u.limits.monthly_usd)}ドル`,
    );
    if (ai.provider === 'mock') lines.push('  ※ 模擬（mock）の呼出しは費用がかからないため、回数にも見積にも数えません。');
  } else {
    lines.push(`  利用量: 読み取れませんでした（${ai.usage_error ?? '不明'}）`);
  }
  if (ai.stop !== null) {
    const since = ai.stop.since === null ? '' : `（${formatJst(new Date(ai.stop.since))} から）`;
    lines.push(`  【停止中】AIの処理を止めています${since}: ${ai.stop.code} ${ai.stop.message}`);
  } else {
    lines.push('  停止: なし');
  }
  return lines;
}

function templateLines(t: TemplateStatus): string[] {
  const lines = ['テンプレート（Excel）:'];
  lines.push(`  ファイル: ${t.file_path ?? '未設定（template_mapping.json の file_path）'}${t.file_path === null ? '' : t.found ? '（あり）' : '（見つかりません）'}`);
  if (t.imported_at !== null) lines.push(`  使っている取込内容: ${formatJst(new Date(t.imported_at))} に読み込んだもの`);
  if (t.found && (t.import_issues ?? 0) > 0) lines.push(`  対応表と合わない列やシートがあります（${t.import_issues}件）。一覧は、ツールを止めて npm.cmd run templates:import で確認できます。`);
  if (t.problem !== null) {
    lines.push(`  【生成を保留中】${t.problem.code} ${t.problem.message}`, '  Excelファイルの場所を直すか、npm.cmd run templates:import で取込結果を確認してください。');
  } else if (t.source === 'last_good_cache') {
    lines.push(`  【注意】Excelファイルを読めないため、前回正常に読み込んだ内容（キャッシュ）で続けています: ${t.warning?.message ?? ''}`);
  }
  return lines;
}

function trendLines(t: TrendsStatus | null): string[] {
  if (t === null) return ['公開トレンド: 使わない設定です（config/trends.json の enabled が false）'];
  const lines = [`公開トレンド: ${t.label}${t.state === 'valid' ? `（有効な語 ${t.valid_records}件）` : ''}`];
  for (const s of t.sources) {
    const expiry = s.expires_at === null ? '' : `、期限 ${formatJst(new Date(s.expires_at))}${s.expired ? '【期限切れ】' : ''}`;
    lines.push(`  ${s.id}: ${s.records}語${expiry}${s.problem === null ? '' : `（${s.problem}）`}`);
  }
  if (t.sources.length === 0) lines.push('  取込元がありません（手順: references/trends/README.md）。');
  for (const line of t.web ?? []) lines.push(`  ${line}`);
  if (t.manual !== undefined) lines.push(`  ${t.manual}`);
  return lines;
}

export function contentLines(c: ContentStatus, mode: Mode): string[] {
  const lines = [...aiLines(c.ai, mode), ...templateLines(c.templates), ...trendLines(c.trends)];
  if (c.style_menus_missing) lines.push(`スタイル投稿: 【保留中】${STYLE_MENUS_MISSING_STATUS}`);
  return lines;
}
