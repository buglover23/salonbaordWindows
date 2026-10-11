import { join } from 'node:path';
import { z } from 'zod';
import { treatmentTerms } from '../ai/context.js';
import type { AiProvider } from '../ai/provider.js';
import { findSalonFact, findWord, looseKey, wordKey } from '../ai/word-rules.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { SalonboardFields } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, errorCodeOf, errorText, type ErrorCode } from '../shared/errors.js';
import { AUDIENCE_JA } from '../shared/labels.js';
import { formatJst, jstDateKey, jstIsoWeekday, jstMinutesOfDay, jstToUtc } from '../shared/time.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { readJsonFile, writeJsonAtomic } from '../storage/atomic-json.js';
import { recordWebTrends, trendListAudience } from './trend-workbook.js';
import { buildClassifier, type TrendConfig, type TrendRecord } from './trends.js';

// Weekly web look-up of hair trend words, men's and women's separately (owner request 2026-10): every Sunday after
// 06:00 JST, while the tool runs, the generation stage's AI searches the web (AiRequest.webSearch; Gemini or OpenAI)
// for rising and commonly used words.
// The words are filtered (NG words, restricted and treatment terms, excluded topics, salon-fact claims, symbols) and saved
// to data/cache/trends/web-trends.json (mens) and web-trends-ladies.json; for 14 days after that Sunday they are offered
// like the public CSV trend words, each only to posts of its own audience.
// A failure is logged, saved with the file and tried again at most every 2 hours that Sunday; posting never waits for it.

export const WEB_TRENDS_FILE = 'web-trends.json';
/** The state file of one audience; mens keeps the original name so earlier look-ups stay valid. */
export const webTrendsFile = (audience: AudienceCategory): string => (audience === 'mens' ? WEB_TRENDS_FILE : `web-trends-${audience}.json`);
const STAGE = 'trends';
const DAY_MS = 86_400_000;
/** Sunday from this time (JST). */
const FETCH_FROM_MINUTES = 6 * 60;
/** A failed look-up is tried again no sooner than this. */
const RETRY_MS = 2 * 3_600_000;
/** The words are used for this many days after the Sunday they were looked up for. */
const VALID_DAYS = 14;
const MAX_WORDS = 30;
const MAX_WORD_CHARS = 20;
const MAX_TOKENS = 4000;
/** Letters, marks, digits and inner spaces only: no URL, hashtag, symbol or emoji. */
const WORD_CHARS = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} ]*[\p{L}\p{M}\p{N}])?$/u;
const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'] as const;

const WebWordSchema = z.strictObject({ word: z.string().min(1), kind: z.enum(['rising', 'common']) });
export type WebWord = z.infer<typeof WebWordSchema>;

const WebTrendsFileSchema = z.strictObject({
  schema_version: z.literal(1),
  /** The last successful look-up (null until one succeeded); the fields below up to sources belong to it. */
  fetched_at: isoUtc.nullable(),
  /** JST date of the Sunday the words were looked up for. */
  week_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  model: z.string().nullable(),
  words: z.array(WebWordSchema),
  sources: z.array(z.string()),
  last_attempt_at: isoUtc,
  /** Japanese reason the last attempt failed; null when it succeeded. */
  last_error: z.string().nullable(),
});
export type WebTrendsFile = z.infer<typeof WebTrendsFileSchema>;

/** What the AI is asked to answer (the words are filtered afterwards). */
const AnswerSchema = z.strictObject({ keywords: z.array(z.strictObject({ word: z.string(), kind: z.enum(['rising', 'common']) })) });

const SYSTEM_FIRST: Record<AudienceCategory, string> = {
  mens: "You research current Japanese men's hair trends for a men's hair salon in Japan. Search the web.",
  ladies: "You research current Japanese women's hair trends for a hair salon in Japan. Search the web.",
};
const system = (audience: AudienceCategory): string =>
  [
    SYSTEM_FIRST[audience],
    'Answer with exactly one JSON object and nothing else: {"keywords":[{"word":"...","kind":"rising"}]}. Do not put citations or links inside the JSON.',
    'kind is "rising" for words whose searches are clearly increasing now, "common" for words people commonly use now.',
  ].join('\n');

const TOPIC: Record<AudienceCategory, string> = {
  mens: '対象: メンズヘア・メンズ髪型・メンズパーマ・メンズカットに関する、スタイル名・カット・質感・髪色・スタイリングの語。',
  ladies: '対象: レディースヘア・女性の髪型・レディースカット・レディースパーマに関する、スタイル名・カット・質感・髪色・スタイリングの語。',
};

function prompt(today: string, audience: AudienceCategory): string {
  return [
    `今日は ${today}（日本時間）です。日本の${AUDIENCE_JA[audience]}ヘアについて、最近検索が増えている語（rising）と、今よく使われている語（common）を Web で検索して調べてください。`,
    TOPIC[audience],
    `条件: 日本語、1語${MAX_WORD_CHARS}文字以内、最大${MAX_WORDS}語。店名・人名・料金・割引・クーポン・予約・ランキング・「人気」「最新」「話題」などの語、URL、ハッシュタグ（#）、記号は入れないでください。`,
  ].join('\n');
}

/** JST date (YYYY-MM-DD) of the Sunday on or before `now`. */
export function weekOf(now: Date): string {
  const today = jstDateKey(now);
  return jstDateKey(new Date(jstToUtc(today, 0).getTime() - (jstIsoWeekday(today) % 7) * DAY_MS));
}

/** Whether the look-up should run now: a Sunday after 06:00 JST, not yet done for this Sunday, no attempt in the last 2 hours. */
export function webTrendsDue(state: WebTrendsFile | null, now: Date): boolean {
  const today = jstDateKey(now);
  if (jstIsoWeekday(today) !== 7 || jstMinutesOfDay(now) < FETCH_FROM_MINUTES) return false;
  if (state === null) return true;
  if (state.week_of === today) return false;
  const since = now.getTime() - Date.parse(state.last_attempt_at);
  return !(since >= 0 && since < RETRY_MS);
}

/**
 * The words that may be stored: NFKC, 2-20 characters, no symbols, no duplicates, and none that names an NG word, a
 * restricted or treatment term (they need a verified menu), an excluded topic or a salon fact (料金・クーポン・予約・人気・最新・話題…).
 */
export function usableWebWords(words: readonly WebWord[], snapshot: ConfigSnapshot): WebWord[] {
  const { keywords, salon } = snapshot;
  const blocked = [...keywords.ng_words, ...keywords.restricted_terms.map((r) => r.term), ...treatmentTerms(snapshot)];
  const excluded = new Set(keywords.excluded_topics.map(wordKey));
  const facts = [...salon.location_keywords, ...salon.strengths];
  const seen = new Set<string>();
  const out: WebWord[] = [];
  for (const w of words) {
    const word = wordKey(w.word);
    const length = [...word].length;
    if (length < 2 || length > MAX_WORD_CHARS || !WORD_CHARS.test(word) || seen.has(looseKey(word))) continue;
    if (excluded.has(word) || findWord(word, blocked) !== null || findSalonFact(word, facts) !== null) continue;
    seen.add(looseKey(word));
    out.push({ word, kind: w.kind });
  }
  return out.slice(0, MAX_WORDS);
}

/** The saved look-up, or null when there is none (a damaged or unreadable file counts as none). */
export async function readWebTrends(cacheDir: string, audience: AudienceCategory): Promise<WebTrendsFile | null> {
  try {
    const r = await readJsonFile(join(cacheDir, webTrendsFile(audience)), WebTrendsFileSchema);
    return r.kind === 'ok' ? r.value : null;
  } catch {
    return null;
  }
}

/** Both audiences' saved look-ups (a missing or damaged one is null). */
export async function readAllWebTrends(cacheDir: string): Promise<Record<AudienceCategory, WebTrendsFile | null>> {
  return { mens: await readWebTrends(cacheDir, 'mens'), ladies: await readWebTrends(cacheDir, 'ladies') };
}

/** The saved words as trend records of that audience while they are in date (14 days after week_of); none when switched off. */
export function webTrendRecords(state: WebTrendsFile | null, config: TrendConfig, now: Date, audience: AudienceCategory): TrendRecord[] {
  if (state === null || state.fetched_at === null || state.week_of === null || !config.trends.enabled || !config.trends.web_search.enabled) return [];
  const expires = jstToUtc(state.week_of, 0).getTime() + VALID_DAYS * DAY_MS;
  if (now.getTime() >= expires || state.words.length === 0) return [];
  const classifier = buildClassifier(config);
  return state.words.map((w) => ({
    keyword: w.word,
    ...classifier.classify(w.word),
    source_id: `${webTrendsFile(audience).replace('.json', '')}:${state.week_of}`,
    source_url: state.sources[0] ?? 'https://www.google.com/',
    source_kind: 'web_search' as const,
    retrieved_at: state.fetched_at as string,
    published_at: null,
    expires_at: new Date(expires).toISOString(),
    region: config.trends.region,
    demand_metric: null,
    metric_definition: null,
    audience,
  }));
}

const dayJa = (key: string): string => `${key}（${WEEKDAY_JA[jstIsoWeekday(key) - 1]}）`;
const monthDayJa = (key: string): string => `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日（日）`;

/** The status line, e.g. 「Web検索のトレンド語（メンズ）: 2026-10-11（日）に取得・18語（次回 10月18日（日））」. */
export function webTrendsStatusLine(state: WebTrendsFile | null, enabled: boolean, now: Date, audience: AudienceCategory): string {
  const head = `Web検索のトレンド語（${AUDIENCE_JA[audience]}）: `;
  if (!enabled) return `${head}使わない設定です（config/trends.json の web_search.enabled が false）`;
  const today = jstDateKey(now);
  const sunday = weekOf(now);
  const next = sunday === today && state?.week_of !== today ? today : jstDateKey(new Date(jstToUtc(sunday, 0).getTime() + 7 * DAY_MS));
  let line: string;
  if (state === null || state.fetched_at === null || state.week_of === null) {
    line = `${head}まだ取得していません（毎週日曜に自動で調べます。次回 ${monthDayJa(next)}）`;
  } else {
    const old = now.getTime() >= jstToUtc(state.week_of, 0).getTime() + VALID_DAYS * DAY_MS ? '・古いため使っていません' : '';
    line = `${head}${dayJa(jstDateKey(new Date(state.fetched_at)))}に取得・${state.words.length}語${old}（次回 ${monthDayJa(next)}）`;
  }
  if (state?.last_error != null) line += `。前回の失敗（${formatJst(new Date(state.last_attempt_at))}）: ${state.last_error}`;
  return line;
}

/**
 * The audiences the weekly look-up covers: those with a posting route (a style or blog entry_url, as status counts a
 * route; pass the effective routes, with the instruction URLs). With no route at all, both (a fresh setup).
 * A second copy of the tool for the other login has only that audience's routes, so each copy looks up its own words.
 * `handled` (EffectiveConfig.audiences, from settings.audiences) limits both cases to the audiences this copy handles.
 */
export function webTrendAudiences(routes: SalonboardFields['posting_routes'], handled: readonly AudienceCategory[] = AUDIENCE_CATEGORIES): AudienceCategory[] {
  const routed = handled.filter((a) => POST_TYPES.some((t) => routes[t][a].entry_url !== null));
  return routed.length === 0 ? [...handled] : routed;
}

/** The status lines, one per audience: an audience that is not looked up (webTrendAudiences) says so. */
export function webTrendsStatusLines(
  states: Record<AudienceCategory, WebTrendsFile | null>,
  enabled: boolean,
  now: Date,
  audiences: readonly AudienceCategory[],
  /** The audiences this copy handles (settings.audiences); the others are left out. Both when omitted. */
  handled: readonly AudienceCategory[] = AUDIENCE_CATEGORIES,
): string[] {
  return handled.map((a) =>
    !enabled || audiences.includes(a) ? webTrendsStatusLine(states[a], enabled, now, a) : `Web検索のトレンド語（${AUDIENCE_JA[a]}）: ${AUDIENCE_JA[a]}の投稿先URLが設定されていないため調べません`,
  );
}

export interface WebTrendsDeps {
  /** The runtime's AiService (or one built the same way): the provider for this mode and why AI work is stopped. */
  ai: { provider(): AiProvider | null; stop(now: Date): Promise<{ code: ErrorCode; message: string } | null> };
  snapshot: () => ConfigSnapshot;
  /** data/cache/trends. */
  cacheDir: string;
  /** トレンド語 (DataPaths.trendWorkbookDir): a successful look-up rewrites the Excel list there; none when left out. */
  workbookDir?: string;
  clock: Clock;
  logger: AppLogger;
  /** The audiences to look up (webTrendAudiences of the effective routes); both when left out. Read by WebTrendsRunner. */
  audiences?: () => readonly AudienceCategory[];
}

/**
 * One look-up now: asks the generation AI (web search), filters the words and saves them. A failure keeps the previous
 * words and records the reason (so does an answer without a usable word); the file is written either way (a failed write
 * is only logged), except for a mock answer, which is never saved. Never throws.
 */
export async function fetchWebTrends(d: WebTrendsDeps, audience: AudienceCategory): Promise<WebTrendsFile> {
  const now = d.clock.now();
  const previous = await readWebTrends(d.cacheDir, audience);
  const ja = AUDIENCE_JA[audience];
  // false for a dry-run mock answer: it must not stand for the week (data/cache is shared with the live mode).
  let save = true;
  const failed = (message: string, error_code: ErrorCode): WebTrendsFile => {
    d.logger[save ? 'warn' : 'info']('WEB_TRENDS_FAILED', `Web検索で${ja}ヘアのトレンド語を調べられませんでした（2時間以上あけて、日曜のうちにもう一度試します）: ${message}`, { stage: STAGE, error_code });
    const base = previous ?? { schema_version: 1 as const, fetched_at: null, week_of: null, model: null, words: [], sources: [] };
    return { ...base, last_attempt_at: now.toISOString(), last_error: message };
  };
  let next: WebTrendsFile;
  const stop = await d.ai.stop(now).catch(() => null);
  const provider = d.ai.provider();
  if (stop !== null) {
    next = failed(`AIの処理が止まっているため（${stop.message}）`, stop.code);
  } else if (provider === null) {
    next = failed('AIを使えない設定のため', 'CONFIG_INCOMPLETE');
  } else {
    try {
      const r = await provider.structured({
        stage: 'generation',
        schema: AnswerSchema,
        system: system(audience),
        content: [{ type: 'text', text: prompt(jstDateKey(now), audience) }],
        maxTokens: MAX_TOKENS,
        webSearch: true,
      });
      const words = usableWebWords(r.value.keywords, d.snapshot());
      save = r.model !== 'mock';
      if (!save) return failed('試運転の仮AI（mock）の答えのため、保存していません', 'CONFIG_INCOMPLETE');
      // No usable word keeps the previous words (week_of unchanged), so the look-up is tried again later that Sunday.
      if (words.length === 0) throw new AppFailure(appError('AI_OUTPUT_INVALID', STAGE, d.clock, { message: `使える語がありませんでした（答えの${r.value.keywords.length}語はすべて除外）`, retryable: true }));
      next = { schema_version: 1, fetched_at: now.toISOString(), week_of: weekOf(now), model: r.model, words, sources: r.sources ?? [], last_attempt_at: now.toISOString(), last_error: null };
      d.logger.info('WEB_TRENDS_FETCHED', `Web検索で${ja}ヘアのトレンド語を調べました（${r.value.keywords.length}語のうち使える語 ${words.length}語）。`, {
        stage: STAGE,
        audience,
        model: r.model,
        answered: r.value.keywords.length,
        words: words.length,
        sources: next.sources.length,
      });
    } catch (err) {
      next = failed(errorText(err), errorCodeOf(err));
    }
  }
  try {
    await writeJsonAtomic(join(d.cacheDir, webTrendsFile(audience)), next);
  } catch (err) {
    d.logger.warn('WEB_TRENDS_WRITE_FAILED', `Web検索の${ja}ヘアのトレンド語を保存できませんでした: ${errorText(err)}`, { stage: STAGE, error_code: errorCodeOf(err) });
  }
  if (next.last_error === null) await recordWebTrends(next, audience, d.cacheDir, d.workbookDir, d.logger, trendListAudience(d.snapshot().settings));
  return next;
}

/**
 * The running tool's weekly look-ups: check() starts them when due and never waits for them; at most one runs at a time
 * (mens first, then ladies; only the audiences with a posting route, see webTrendAudiences). Each audience has its own
 * due and retry state, so a failure of one never holds back the other.
 */
export class WebTrendsRunner {
  readonly #d: WebTrendsDeps;
  // No key: that audience's saved file has not been read yet. Kept in memory, so a failed write cannot cause a retry loop.
  readonly #state: Partial<Record<AudienceCategory, WebTrendsFile | null>> = {};
  #running: Promise<void> | null = null;

  constructor(d: WebTrendsDeps) {
    this.#d = d;
  }

  check(now: Date): void {
    if (this.#running !== null) return;
    this.#running = this.#run(now)
      .catch((err: unknown) => this.#d.logger.warn('WEB_TRENDS_FAILED', `Web検索のトレンド語の確認中にエラーが発生しました: ${errorText(err)}`, { stage: STAGE, error_code: errorCodeOf(err) }))
      .finally(() => {
        this.#running = null;
      });
  }

  /** Settles when no look-up is running (the stop waits for it, so nothing writes after the lock is released). */
  idle(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #run(now: Date): Promise<void> {
    const { trends } = this.#d.snapshot();
    if (!trends.enabled || !trends.web_search.enabled) return;
    for (const audience of this.#d.audiences?.() ?? AUDIENCE_CATEGORIES) {
      if (!(audience in this.#state)) this.#state[audience] = await readWebTrends(this.#d.cacheDir, audience);
      if (webTrendsDue(this.#state[audience] ?? null, now)) this.#state[audience] = await fetchWebTrends(this.#d, audience);
    }
  }
}
