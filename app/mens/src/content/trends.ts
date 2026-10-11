import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ConfigSnapshot } from '../config/loader.js';
import { TREND_DATA_KINDS, TREND_SOURCE_ID_PATTERN, type ManualImportSource, type TrendDataKind } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, type AppError } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import { parseExportedAt } from '../shared/time.js';
import { AUDIENCE_CATEGORIES } from '../shared/types.js';
import { isoUtc, issueSummary } from '../shared/zod-helpers.js';
import { errnoCode, readJsonFile, withTransientRetry, writeJsonAtomic } from '../storage/atomic-json.js';
import {
  TrendCsvError,
  decodeCsvBytes,
  excerpt,
  parseCsv,
  parseInterestOverTime,
  parseRelatedQueries,
  type InterestOverTime,
  type RelatedQueryRow,
} from './trends-csv.js';

// Public-trend library for the manual CSV path (spec 5.6, 8.2-8.4). The CSVs are Google Trends exports the operator placed
// under references/trends/; they are only ever read. Each source's records are cached as <cacheDir>/<source id>.json together
// with the CSV's sha256, and the CSV is parsed again only when its hash (or anything that shapes the records) changes.
// Nothing is fetched from the network, and nothing here claims a word is "rising" unless the CSV itself says so.

const STAGE = 'trends';
/** Bumped whenever the records built from the same CSV change; older caches are then built again. */
const IMPORT_VERSION = 2;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_KEYWORD_CHARS = 60;
const MAX_SKIPPED_KEPT = 100;
/** An exported_at this far ahead of now is a typo, not clock skew; it would stretch the records' expiry. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

/** Shown wherever trends are mentioned while nothing usable is imported (spec 8.4). */
export const TRENDS_NOT_IMPORTED_LABEL = '公開トレンド未取込';
const TRENDS_IMPORTED_LABEL = '公開トレンド取込済み（手動CSV）';

export type TrendConfig = Pick<ConfigSnapshot, 'trends' | 'keywords' | 'categories'>;

// ---------------------------------------------------------------- records (spec 8.2)

const TrendRecordSchema = z
  .strictObject({
    keyword: z.string().min(1),
    category_ids: z.array(z.string().min(1)),
    source_id: z.string().min(1),
    source_url: z.string().min(1),
    /** web_search: built in memory from data/cache/trends/web-trends.json (web-trends.ts), never stored in a CSV cache. */
    source_kind: z.enum(['manual_import', 'web_search']),
    retrieved_at: isoUtc,
    published_at: z.null(),
    expires_at: isoUtc,
    region: z.string().min(1),
    relevance_score: z.number().min(0).max(1),
    demand_metric: z.number().nullable(),
    metric_definition: z.string().min(1).nullable(),
    /** web_search only: the audience the words were looked up for (generation uses them only for that audience). */
    audience: z.enum(AUDIENCE_CATEGORIES).optional(),
  })
  .superRefine((r, ctx) => {
    // A value without the definition that explains it must never be stored (spec 8.2).
    if (r.demand_metric !== null && r.metric_definition === null) {
      ctx.addIssue({ code: 'custom', path: ['metric_definition'], message: 'demand_metric には metric_definition が必要です' });
    }
  });
export type TrendRecord = z.infer<typeof TrendRecordSchema>;

const SkippedSchema = z.strictObject({ line: z.number().int().positive().nullable(), keyword: z.string().nullable(), reason: z.string().min(1) });
export type TrendSkippedItem = z.infer<typeof SkippedSchema>;

const sha256Text = z.string().regex(/^[0-9a-f]{64}$/);
const CacheFileSchema = z.strictObject({
  schema_version: z.literal(1),
  import_version: z.literal(IMPORT_VERSION),
  source_id: z.string().min(1),
  data_kind: z.enum(TREND_DATA_KINDS),
  file_name: z.string(),
  file_sha256: sha256Text,
  /**
   * The CSV's size and mtime when it was read. loadCached() compares them with the file now (it never reads the CSV), so a
   * replaced file is noticed without parsing it.
   */
  file_size: z.number().int().nonnegative(),
  file_mtime_ms: z.number().nonnegative(),
  /** Hash of everything besides the CSV that shapes the records (source info, ttl, category and beauty-word lists). */
  context_sha256: sha256Text,
  imported_at: isoUtc,
  retrieved_at: isoUtc,
  expires_at: isoUtc,
  items_read: z.number().int().nonnegative(),
  skipped: z.array(SkippedSchema),
  records: z.array(TrendRecordSchema),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

// Read first, so a file written by another import_version is recognised as outdated rather than as damaged.
const VersionProbeSchema = z.looseObject({ import_version: z.number().int() });
type CacheRead = { kind: 'ok'; value: CacheFile } | { kind: 'missing' } | { kind: 'outdated' } | { kind: 'invalid' };
const outdatedLogged = new Set<string>();

// ---------------------------------------------------------------- reports and status

export interface TrendSourceReport {
  id: string;
  data_kind: TrendDataKind;
  source_url: string;
  /** The CSV's absolute path. */
  file_path: string;
  file_name: string;
  /** imported: the CSV was parsed now; cached: its hash matched the saved import; failed: it could not be used. */
  status: 'imported' | 'cached' | 'failed';
  file_sha256: string | null;
  file_missing: boolean;
  /** True when the CSV could not be used but an earlier import of this source still is. */
  using_previous_import: boolean;
  /** Records in use, after the excluded words were removed. */
  records: number;
  /** Words removed because keywords.json lists them in excluded_topics. */
  excluded: string[];
  /** Search terms (interest_over_time) or query rows (related_queries) found in the CSV. */
  items_read: number;
  skipped: TrendSkippedItem[];
  retrieved_at: string | null;
  expires_at: string | null;
  expired: boolean;
  error: AppError | null;
}

export interface TrendImportReport {
  /** trends.json `enabled`; when false nothing is imported. */
  enabled: boolean;
  sources: TrendSourceReport[];
}

export interface TrendSourceState {
  id: string;
  /** Records held for this source (expired ones included). */
  records: number;
  expires_at: string | null;
  expired: boolean;
  file_missing: boolean;
  /** Japanese reason the source is not fully usable (last import failure, missing CSV, not imported yet); null when fine. */
  problem: string | null;
}

export interface TrendStatus {
  /** none: nothing imported; valid: at least one unexpired record; expired: records exist but all are past their expiry. */
  state: 'none' | 'valid' | 'expired';
  /** 「公開トレンド未取込」 unless state is valid. */
  label: string;
  sources: TrendSourceState[];
}

interface LoadedSource {
  state: TrendSourceState;
  records: TrendRecord[];
}

// ---------------------------------------------------------------- relevance and categories

/**
 * relevance_score is a coarse heuristic for ranking, not a judgement: a keyword that contains a category's label or
 * allowed keyword scores 0.9; one that contains a beauty word (this list, or the salon's own keyword lists) scores 0.6;
 * anything else 0.3. Comparison is NFKC and lower-case; Latin terms must match as whole words (so "chair" is not "hair").
 */
export const BEAUTY_TERMS: readonly string[] = [
  'ヘア', '髪', '美容', '美容室', '美容院', 'サロン', 'カラー', 'カット', 'パーマ', 'ボブ', 'ショート', 'ロング', 'ミディアム', '前髪',
  'トリートメント', 'ヘアケア', 'ブリーチ', 'ハイライト', 'メッシュ', 'グラデーション', 'ベージュ', 'グレージュ', 'アッシュ', 'ブラウン',
  'ヘアアレンジ', 'ヘアセット', 'ヘアオイル', 'シャンプー', '頭皮', 'スカルプ', 'ヘッドスパ', '白髪', '縮毛', 'ストレート', 'レイヤー',
  'ウルフ', 'マッシュ', 'ツーブロック', 'フェード', '刈り上げ', 'メンズ', 'エクステ', '透明感', 'ツヤ', 'くせ毛', 'ウェーブ',
  'hair', 'haircut', 'hairstyle', 'color', 'colour', 'perm', 'bob', 'bangs', 'fringe', 'salon', 'highlight', 'bleach', 'balayage',
  'fade', 'undercut', 'mullet', 'layer', 'shampoo', 'treatment', 'keratin', 'curl',
];

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const codePoints = (s: string): number => [...s].length;

function termMatcher(term: string): (haystack: string) => boolean {
  if (!/^[\x20-\x7e]+$/.test(term)) return (haystack) => haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:e?s)?(?:$|[^a-z0-9])`);
  return (haystack) => whole.test(haystack);
}

export interface Classifier {
  /** Changes whenever the category or beauty-word lists change. */
  fingerprint: string;
  classify(keyword: string): { category_ids: string[]; relevance_score: number };
}

export function buildClassifier(config: TrendConfig): Classifier {
  const unique = (list: string[]): string[] => [...new Set(list)];
  const usable = (list: readonly string[]): string[] => unique(list.map(norm).filter((t) => codePoints(t) >= 2));
  const categories = [...config.categories.style_categories, ...config.categories.blog_categories].map((c) => ({
    id: c.id,
    terms: usable([c.label, ...c.allowed_keywords]),
  }));
  const { keywords, trends } = config;
  const beautyTerms = unique([
    ...BEAUTY_TERMS.map(norm),
    ...usable([...keywords.priority_keywords, ...keywords.secondary_keywords, ...trends.trend_words, ...trends.trend_colors, ...trends.trend_styles]),
  ]);

  const categoryMatchers = categories.map((c) => ({ id: c.id, matches: c.terms.map(termMatcher) }));
  const beautyMatchers = beautyTerms.map(termMatcher);
  return {
    fingerprint: sha256Hex(JSON.stringify({ categories, beautyTerms })),
    classify(keyword) {
      const text = norm(keyword);
      const category_ids = unique(categoryMatchers.filter((c) => c.matches.some((m) => m(text))).map((c) => c.id));
      const relevance_score = category_ids.length > 0 ? 0.9 : beautyMatchers.some((m) => m(text)) ? 0.6 : 0.3;
      return { category_ids, relevance_score };
    },
  };
}

// ---------------------------------------------------------------- building records from the parsed CSV

const UNIT_JA = { week: '週', day: '日', month: 'か月' } as const;
const EXPECTED_LAYOUT_JA: Record<TrendDataKind, string> = {
  interest_over_time: '時系列（見出し行の最初の列が 週／日／月 または Week／Day／Month、他の列が検索した語、その下に期間ごとの 0〜100 の値）',
  related_queries: '関連クエリ（トップ／注目 または TOP／RISING の区分と、その下の「語,値」の行）',
};

interface Candidate {
  keyword: string;
  line: number | null;
  demand_metric: number | null;
  metric_definition: string | null;
}

function interestCandidates(parsed: InterestOverTime, src: ManualImportSource): Candidate[] {
  const headerLine = parsed.header_line;
  const unit = UNIT_JA[parsed.unit];
  return parsed.terms.map((t) => {
    const numbers = t.values.filter((v): v is number => v !== null);
    if (numbers.length === 0) return { keyword: t.term, line: headerLine, demand_metric: null, metric_definition: null };
    const missing = t.values.length - numbers.length;
    const notes = [
      t.below_one > 0 ? `「<1」の${t.below_one}${unit}は0として計算` : '',
      missing > 0 ? `欠けた${missing}${unit}は除いて計算` : '',
    ].filter((n) => n !== '');
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    return {
      keyword: t.term,
      line: headerLine,
      demand_metric: Math.round(mean * 10) / 10,
      metric_definition:
        'Googleトレンド「人気度の動向」の関心度（期間内の最大値を100とした相対値で、検索件数ではありません）の期間平均。' +
        `期間: ${src.period}（データ: ${parsed.first_key}〜${parsed.last_key}、${parsed.points}${unit}分）、地域: ${src.region}` +
        notes.map((n) => `。${n}`).join(''),
    };
  });
}

function relatedCandidates(rows: RelatedQueryRow[], src: ManualImportSource): Candidate[] {
  const where = `期間: ${src.period}、地域: ${src.region}`;
  const head = 'Googleトレンド「関連キーワード（関連クエリ）」';
  return rows.map((r) => {
    if (r.value.kind === 'index') {
      return {
        keyword: r.query,
        line: r.line,
        demand_metric: r.value.value,
        metric_definition: `${head}の「トップ」の人気度（最も検索されたクエリを100とした相対値で、検索件数ではありません）。${where}`,
      };
    }
    if (r.value.kind === 'percent') {
      return {
        keyword: r.query,
        line: r.line,
        demand_metric: r.value.value,
        metric_definition: `${head}の「注目（RISING）」の増加率（前の期間と比べた検索数の増加率で、単位は%です。検索件数ではありません）。${where}`,
      };
    }
    // Breakout is a label, not a number: the word is kept without any metric (nothing is invented, nothing is called 急上昇).
    return { keyword: r.query, line: r.line, demand_metric: null, metric_definition: null };
  });
}

/**
 * Single line, whitespace collapsed; null when nothing is left. Invisible format characters (zero-width, bidi overrides,
 * tag characters: \p{Cf}) and private-use characters (\p{Co}) are removed, control characters become spaces.
 */
function cleanKeyword(raw: string): string | null {
  const s = raw.replace(/[\p{Cf}\p{Co}]+/gu, '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return s === '' ? null : s;
}

// ---------------------------------------------------------------- reading the CSV

/**
 * What can be seen of the CSV without opening it: its size and mtime, that it is gone (missing, or something that is not a
 * file), or that it cannot be checked (`unknown`: permissions or a lock that outlasted the retries).
 */
type CsvStat = { kind: 'file'; size: number; mtimeMs: number } | { kind: 'missing' } | { kind: 'not_file' } | { kind: 'unknown' };

async function statCsv(path: string): Promise<CsvStat> {
  try {
    const info = await withTransientRetry(() => stat(path));
    return info.isFile() ? { kind: 'file', size: info.size, mtimeMs: info.mtimeMs } : { kind: 'not_file' };
  } catch (err) {
    const code = errnoCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unknown' };
  }
}

type CsvRead =
  | { ok: true; bytes: Uint8Array; csv: Extract<CsvStat, { kind: 'file' }> }
  | { ok: false; csv: CsvStat; reason: 'missing' | 'not_file' | 'unknown' | 'too_large' | 'unreadable'; message: string };

/** Reads the CSV whose stat was just taken; the message says what is wrong (the caller adds what to do next). */
async function readCsvFile(path: string, fileName: string, csv: CsvStat): Promise<CsvRead> {
  const name = `トレンドのCSV「${fileName}」`;
  const missing = (): CsvRead => ({
    ok: false,
    csv: { kind: 'missing' },
    reason: 'missing',
    message: `${name}が見つかりません（${path}）。Google トレンドから書き出したCSVを置くか、config/trends.json の file_path を直してください。`,
  });
  const tooLarge = (bytes: number, seen: CsvStat): CsvRead => ({
    ok: false,
    csv: seen,
    reason: 'too_large',
    message: `${name}が大きすぎます（${(bytes / 1024 / 1024).toFixed(1)}MB。上限は${MAX_CSV_BYTES / 1024 / 1024}MBです）。Google トレンドから書き出したファイルを指定してください。`,
  });
  if (csv.kind === 'missing') return missing();
  if (csv.kind === 'not_file') {
    return { ok: false, csv, reason: 'not_file', message: `${name}はファイルではありません（${path}）。config/trends.json の file_path を直してください。` };
  }
  if (csv.kind === 'unknown') {
    return { ok: false, csv, reason: 'unknown', message: `${name}を確認できません（アクセス権またはロック）。他のソフトで開いている場合は閉じてください。` };
  }
  if (csv.size > MAX_CSV_BYTES) return tooLarge(csv.size, csv);
  try {
    // The stat was taken before the read: a file replaced in between only makes the recorded stat look stale, the safe direction.
    const bytes = await withTransientRetry(() => readFile(path));
    return bytes.byteLength > MAX_CSV_BYTES ? tooLarge(bytes.byteLength, csv) : { ok: true, bytes, csv };
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return missing();
    return { ok: false, csv, reason: 'unreadable', message: `${name}を読み込めません（${code ?? '不明なエラー'}）。他のソフトで開いている場合は閉じてください。` };
  }
}

// ---------------------------------------------------------------- cache

class TrendCache {
  constructor(
    readonly dir: string,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  #file(id: string): string {
    // Schema-validated ids are plain names; anything else must never become a path.
    if (!TREND_SOURCE_ID_PATTERN.test(id)) {
      throw new AppFailure(appError('INTERNAL_ERROR', STAGE, this.clock, { message: `トレンドの取込元 id が不正です: ${id}`, details: { source_id: id } }));
    }
    return join(this.dir, `${id}.json`);
  }

  /**
   * The saved import of `id`. `outdated`: written by another import_version (an upgrade, not damage); `invalid`: damaged
   * (logged every time). Callers treat both like "nothing saved", but loadCached tells the operator which it was.
   */
  async read(id: string): Promise<CacheRead> {
    try {
      const probe = await readJsonFile(this.#file(id), VersionProbeSchema);
      if (probe.kind === 'missing') return { kind: 'missing' };
      if (probe.kind === 'ok' && probe.value.import_version !== IMPORT_VERSION) {
        // Once per process and source, so a status loop does not repeat it; the next import replaces the file.
        const key = `${this.dir}|${id}`;
        if (!outdatedLogged.has(key)) {
          outdatedLogged.add(key);
          this.logger.info('TRENDS_CACHE_OUTDATED', 'トレンドの取込結果（キャッシュ）は古い形式のため使いません。npm.cmd run trends:refresh で取り込み直してください。', {
            stage: STAGE,
            source_id: id,
            saved_import_version: probe.value.import_version,
            import_version: IMPORT_VERSION,
          });
        }
        return { kind: 'outdated' };
      }
      const full = probe.kind === 'ok' ? CacheFileSchema.safeParse(probe.value) : null;
      if (full?.success && full.data.source_id === id) return { kind: 'ok', value: full.data };
      this.logger.warn('TRENDS_CACHE_INVALID', 'トレンドの取込結果（キャッシュ）が壊れているため使いません。', {
        stage: STAGE,
        source_id: id,
        reason: probe.kind === 'corrupt' ? probe.reason : full?.success ? '取込元の id が一致しません' : `内容が不正です: ${issueSummary(full!.error).join('; ')}`,
      });
    } catch (err) {
      if (err instanceof AppFailure && err.error.code === 'INTERNAL_ERROR') throw err;
      this.logger.warn('TRENDS_CACHE_UNREADABLE', 'トレンドの取込結果（キャッシュ）を読み込めないため使いません。', { stage: STAGE, source_id: id, error: err });
    }
    return { kind: 'invalid' };
  }

  /** Best effort: a failed write is logged and the import goes on with what was just built. */
  async write(id: string, value: CacheFile): Promise<void> {
    try {
      await writeJsonAtomic(this.#file(id), value);
    } catch (err) {
      this.logger.warn('TRENDS_CACHE_WRITE_FAILED', 'トレンドの取込結果（キャッシュ）を保存できませんでした（次回も取り込み直します）。', {
        stage: STAGE,
        source_id: id,
        error: err,
      });
    }
  }
}

// ---------------------------------------------------------------- library

export interface TrendLibraryOptions {
  /** data/cache/trends. */
  cacheDir: string;
  /** Folder a relative file_path is resolved against (the project root). */
  baseDir: string;
  logger: AppLogger;
  clock: Clock;
}

const manualSources = (config: TrendConfig): ManualImportSource[] =>
  config.trends.sources.filter((s): s is ManualImportSource => s.kind === 'manual_import' && s.enabled);

const withoutFinalStop = (s: string): string => s.replace(/。$/u, '');

const REFRESH_COMMAND = 'npm.cmd run trends:refresh';

interface ExpectedImport {
  retrievedAt: string;
  expiresAt: string;
  /** Everything besides the CSV bytes that shapes the records; a saved import with another value is out of date. */
  contextSha: string;
}

/** What an import made now would carry, computed from the current config alone (no CSV needed). */
function expectedImport(src: ManualImportSource, exportedAt: Date, ttlHours: number, classifier: Classifier): ExpectedImport {
  const retrievedAt = exportedAt.toISOString();
  const expiresAt = new Date(exportedAt.getTime() + ttlHours * HOUR_MS).toISOString();
  const contextSha = sha256Hex(
    JSON.stringify({
      import_version: IMPORT_VERSION,
      source: { id: src.id, source_url: src.source_url, region: src.region, period: src.period, data_kind: src.data_kind },
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      classifier: classifier.fingerprint,
    }),
  );
  return { retrievedAt, expiresAt, contextSha };
}

type PreviousReason = 'ok' | 'not_imported' | 'outdated_format' | 'config_changed' | 'csv_changed' | 'csv_unknown' | 'csv_missing' | 'csv_not_file';

/**
 * THE rule for whether a saved import may still be used, shared by loadCached (read-only status) and by the fallback of a
 * failed importConfigured, so the two never disagree. It is usable only if
 *  - it was saved in the current format and matches the current config (ttl, exported_at, source info, word lists), and
 *  - the CSV is gone (the import was made from it and is still in date), or the CSV is the one it was made from:
 *    same size and mtime as recorded, or (when the bytes were read) the same sha256.
 * A CSV that was replaced (even by one that cannot be imported) or cannot be checked makes it unusable.
 */
function judgePrevious(read: CacheRead, expected: ExpectedImport | null, csv: CsvStat, sha256: string | null): { use: CacheFile | null; reason: PreviousReason } {
  if (read.kind === 'outdated') return { use: null, reason: 'outdated_format' };
  if (read.kind !== 'ok') return { use: null, reason: 'not_imported' };
  const cached = read.value;
  if (expected === null || cached.context_sha256 !== expected.contextSha) return { use: null, reason: 'config_changed' };
  if (csv.kind === 'unknown') return { use: null, reason: 'csv_unknown' };
  if (csv.kind === 'missing') return { use: cached, reason: 'csv_missing' };
  if (csv.kind === 'not_file') return { use: cached, reason: 'csv_not_file' };
  const same = (csv.size === cached.file_size && csv.mtimeMs === cached.file_mtime_ms) || (sha256 !== null && sha256 === cached.file_sha256);
  return same ? { use: cached, reason: 'ok' } : { use: null, reason: 'csv_changed' };
}

/** The `problem` shown by status for each outcome of judgePrevious (null when there is nothing to report). */
function previousProblem(reason: PreviousReason, fileName: string): string | null {
  switch (reason) {
    case 'ok':
      return null;
    case 'not_imported':
      return `取込結果がありません。${REFRESH_COMMAND} で取り込んでください`;
    case 'outdated_format':
      return `取込形式が更新されたため ${REFRESH_COMMAND} で取り込み直してください`;
    case 'config_changed':
      return `設定が変わったため ${REFRESH_COMMAND} が必要です`;
    case 'csv_changed':
      return `CSVが変わったため ${REFRESH_COMMAND} が必要です（読み取れないときは、Google トレンドから書き出し直すか、元のCSVに戻してください）`;
    case 'csv_unknown':
      return `CSVを確認できません（アクセス権またはロック）。ロックを解いてから ${REFRESH_COMMAND} を実行してください`;
    case 'csv_missing':
      return `CSV「${fileName}」が見つかりません（前回の取込結果は期限まで使えます）。新しく書き出したCSVを置いたら ${REFRESH_COMMAND} を実行してください`;
    case 'csv_not_file':
      return `「${fileName}」はファイルではありません。config/trends.json の file_path を直してから ${REFRESH_COMMAND} を実行してください`;
  }
}

/** What follows the description of a failed import: what happens to the previous import, and the command to run next. */
function failureTail(reason: PreviousReason): string {
  switch (reason) {
    case 'ok':
    case 'csv_missing':
    case 'csv_not_file':
      return `前回取り込んだ内容は、期限まで引き続き使われます。直したら ${REFRESH_COMMAND} を実行してください。`;
    case 'config_changed':
      return `設定が変わっているため、前回の取込結果は使いません。直したら ${REFRESH_COMMAND} を実行してください。`;
    case 'csv_changed':
      return `CSVが置き換わっているため、前回の取込結果は使いません。Google トレンドから書き出し直すか、元のCSVに戻してから ${REFRESH_COMMAND} を実行してください。`;
    case 'csv_unknown':
      return `CSVを確認できないため（アクセス権またはロック）、前回の取込結果は使いません。ロックを解いてから ${REFRESH_COMMAND} を実行してください。`;
    case 'not_imported':
    case 'outdated_format':
      return `直したら ${REFRESH_COMMAND} を実行してください。`;
  }
}

export class TrendLibrary {
  readonly #baseDir: string;
  readonly #logger: AppLogger;
  readonly #clock: Clock;
  readonly #cache: TrendCache;
  #sources: LoadedSource[] = [];

  constructor(o: TrendLibraryOptions) {
    this.#baseDir = o.baseDir;
    this.#logger = o.logger;
    this.#clock = o.clock;
    this.#cache = new TrendCache(o.cacheDir, o.clock, o.logger);
  }

  /**
   * Imports every enabled manual_import source: reads its CSV (read-only), reuses the saved import when the CSV's hash and
   * the shaping inputs are unchanged, otherwise parses only the declared data_kind and saves the records atomically.
   * A source that cannot be used never throws: it is reported as failed (TREND_FETCH_FAILED), the earlier import of that
   * source (if any) stays in use until it expires, and the other sources are still imported (spec 8.3).
   */
  async importConfigured(config: TrendConfig, now: Date): Promise<TrendImportReport> {
    if (!config.trends.enabled) {
      this.#sources = [];
      return { enabled: false, sources: [] };
    }
    const classifier = buildClassifier(config);
    const excluded = new Set(config.keywords.excluded_topics.map(norm));
    const reports: TrendSourceReport[] = [];
    const loaded: LoadedSource[] = [];
    for (const src of manualSources(config)) {
      const outcome = await this.#importSource(src, config, classifier, excluded, now);
      reports.push(outcome.report);
      loaded.push(outcome.loaded);
    }
    this.#sources = loaded;
    return { enabled: true, sources: reports };
  }

  /**
   * Loads the saved imports only, for read-only callers such as `status`: the CSV is never read or parsed and nothing is
   * written. A saved import is used only under the rule of judgePrevious(): it matches the current config (source info, ttl,
   * exported_at, category and beauty-word lists) and the CSV is gone or still has the size and mtime recorded at import;
   * otherwise the source is unusable (no records, a Japanese `problem`) until `npm.cmd run trends:refresh` runs, so
   * out-of-date expiry is never shown as current. A failed importConfigured() applies the same rule, so the two agree.
   * Limit: a CSV rewritten with the same size and mtime cannot be noticed without reading it; importConfigured() does.
   */
  async loadCached(config: TrendConfig, now: Date): Promise<void> {
    if (!config.trends.enabled) {
      this.#sources = [];
      return;
    }
    const classifier = buildClassifier(config);
    const excluded = new Set(config.keywords.excluded_topics.map(norm));
    const loaded: LoadedSource[] = [];
    for (const src of manualSources(config)) {
      const path = resolve(this.#baseDir, src.file_path);
      const cached = await this.#cache.read(src.id);
      const csv = await statCsv(path);
      const exportedAt = parseExportedAt(src.exported_at);
      const expected = exportedAt === null ? null : expectedImport(src, exportedAt, config.trends.cache_ttl_hours, classifier);
      const { use, reason } = judgePrevious(cached, expected, csv, null);
      loaded.push(this.#loaded(src.id, use, excluded, { fileMissing: csv.kind === 'missing', problem: previousProblem(reason, basename(path)) }, now));
    }
    this.#sources = loaded;
  }

  /** Unexpired records of every imported source (expiry is exclusive: a record is valid while now < expires_at). */
  validRecords(now: Date): TrendRecord[] {
    return this.#sources.flatMap((s) => s.records.filter((r) => Date.parse(r.expires_at) > now.getTime()).map((r) => ({ ...r, category_ids: [...r.category_ids] })));
  }

  status(now: Date): TrendStatus {
    const sources = this.#sources.map((s) => ({ ...s.state, expired: s.state.expires_at !== null && Date.parse(s.state.expires_at) <= now.getTime() }));
    const state = this.validRecords(now).length > 0 ? 'valid' : this.#sources.some((s) => s.records.length > 0) ? 'expired' : 'none';
    return { state, label: state === 'valid' ? TRENDS_IMPORTED_LABEL : TRENDS_NOT_IMPORTED_LABEL, sources };
  }

  // ---------------------------------------------------------------- one source

  #loaded(id: string, use: CacheFile | null, excluded: ReadonlySet<string>, o: { fileMissing: boolean; problem: string | null }, now: Date): LoadedSource {
    const records = (use?.records ?? []).filter((r) => !excluded.has(norm(r.keyword)));
    const expiresAt = use?.expires_at ?? null;
    return {
      records,
      state: {
        id,
        records: records.length,
        expires_at: expiresAt,
        expired: expiresAt !== null && Date.parse(expiresAt) <= now.getTime(),
        file_missing: o.fileMissing,
        problem: o.problem,
      },
    };
  }

  #failure(src: ManualImportSource, fileName: string, message: string, details: Record<string, unknown> = {}): AppError {
    return appError('TREND_FETCH_FAILED', STAGE, this.#clock, {
      message,
      // Re-reading the same file cannot fix it; the operator has to change the file or the setting.
      retryable: false,
      details: { source_id: src.id, file_name: fileName, data_kind: src.data_kind, ...details },
    });
  }

  async #importSource(
    src: ManualImportSource,
    config: TrendConfig,
    classifier: Classifier,
    excluded: ReadonlySet<string>,
    now: Date,
  ): Promise<{ report: TrendSourceReport; loaded: LoadedSource }> {
    const path = resolve(this.#baseDir, src.file_path);
    const fileName = basename(path);
    const exportedAt = parseExportedAt(src.exported_at);
    const cacheRead = await this.#cache.read(src.id);
    const cached = cacheRead.kind === 'ok' ? cacheRead.value : null;
    const expected = exportedAt === null ? null : expectedImport(src, exportedAt, config.trends.cache_ttl_hours, classifier);

    let csv = await statCsv(path);
    let status: TrendSourceReport['status'] = 'failed';
    let use: CacheFile | null = null;
    let fileSha: string | null = null;
    // What went wrong, without what happens next: that depends on the previous import (see judgePrevious).
    let failure: { message: string; details: Record<string, unknown> } | null = null;

    if (exportedAt === null || expected === null) {
      failure = { message: `取込元「${src.id}」の exported_at「${src.exported_at}」を日時として読み取れません。config/trends.json を直してください。`, details: { reason: 'exported_at' } };
    } else if (exportedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      failure = {
        message: `取込元「${src.id}」の exported_at（${src.exported_at}）が現在より先の日時です。期限を不当に延ばしてしまうため取り込みません。CSVを書き出した日時に直してください。`,
        details: { reason: 'exported_at' },
      };
    } else {
      const read = await readCsvFile(path, fileName, csv);
      if (!read.ok) {
        csv = read.csv;
        failure = { message: read.message, details: { reason: read.reason } };
      } else {
        fileSha = sha256Hex(read.bytes);
        if (cached !== null && cached.file_sha256 === fileSha && cached.context_sha256 === expected.contextSha) {
          use = cached;
          status = 'cached';
          this.#logger.debug('TRENDS_CACHE_REUSED', 'トレンドのCSVに変更が無いため、保存済みの取込結果を使います。', { stage: STAGE, source_id: src.id, file_sha256: fileSha });
          if (cached.file_size !== read.csv.size || cached.file_mtime_ms !== read.csv.mtimeMs) {
            // Same content, touched file (sync, copy): record the new stat so the read-only status keeps trusting the import.
            use = { ...cached, file_size: read.csv.size, file_mtime_ms: read.csv.mtimeMs };
            await this.#cache.write(src.id, use);
          }
        } else {
          try {
            const built = this.#build(src, read.bytes, { fileName, fileSha, fileSize: read.csv.size, fileMtimeMs: read.csv.mtimeMs, ...expected }, classifier);
            await this.#cache.write(src.id, built);
            use = built;
            status = 'imported';
            this.#logger.info('TRENDS_IMPORTED', `トレンドのCSV「${fileName}」を取り込みました（${built.records.length}語）。`, {
              stage: STAGE,
              source_id: src.id,
              data_kind: src.data_kind,
              file_sha256: fileSha,
              records: built.records.length,
              skipped: built.skipped.length,
            });
          } catch (err) {
            if (!(err instanceof TrendCsvError)) throw err;
            failure = {
              message: `トレンドのCSV「${fileName}」を読み取れません（data_kind: ${src.data_kind}。想定する形: ${EXPECTED_LAYOUT_JA[src.data_kind]}）。${withoutFinalStop(err.message)}。`,
              details: { reason: 'layout' },
            };
          }
        }
      }
    }

    let error: AppError | null = null;
    if (failure !== null) {
      // The earlier import of this source stays in use (spec 8.3) only under the same rule loadCached applies, so a replaced
      // CSV that cannot be imported, or a changed config, never leaves an old expiry looking current.
      const decision = judgePrevious(cacheRead, expected, csv, fileSha);
      use = decision.use;
      error = this.#failure(src, fileName, `${failure.message}${failureTail(decision.reason)}`, { ...failure.details, previous_import: decision.reason });
      this.#logger.warn('TRENDS_IMPORT_FAILED', error.message, {
        stage: STAGE,
        source_id: src.id,
        error_code: 'TREND_FETCH_FAILED',
        using_previous_import: use !== null,
        previous_import: decision.reason,
      });
    }

    const loaded = this.#loaded(src.id, use, excluded, { fileMissing: csv.kind === 'missing', problem: error?.message ?? null }, now);
    const keptKeywords = new Set(loaded.records.map((r) => r.keyword));
    const report: TrendSourceReport = {
      id: src.id,
      data_kind: src.data_kind,
      source_url: src.source_url,
      file_path: path,
      file_name: fileName,
      status,
      file_sha256: fileSha,
      file_missing: csv.kind === 'missing',
      using_previous_import: error !== null && use !== null,
      records: loaded.records.length,
      excluded: (use?.records ?? []).filter((r) => !keptKeywords.has(r.keyword)).map((r) => r.keyword),
      items_read: use?.items_read ?? 0,
      skipped: use?.skipped ?? [],
      retrieved_at: use?.retrieved_at ?? null,
      expires_at: use?.expires_at ?? null,
      expired: loaded.state.expired,
      error,
    };
    return { report, loaded };
  }

  /** Parses the CSV as the source's declared data_kind and builds the cache file. Throws TrendCsvError when it does not fit. */
  #build(
    src: ManualImportSource,
    bytes: Uint8Array,
    o: { fileName: string; fileSha: string; fileSize: number; fileMtimeMs: number } & ExpectedImport,
    classifier: Classifier,
  ): CacheFile {
    const rows = parseCsv(decodeCsvBytes(bytes));
    const candidates =
      src.data_kind === 'interest_over_time' ? interestCandidates(parseInterestOverTime(rows), src) : relatedCandidates(parseRelatedQueries(rows), src);

    const seen = new Set<string>();
    const skipped: TrendSkippedItem[] = [];
    const records: TrendRecord[] = [];
    for (const c of candidates) {
      const keyword = cleanKeyword(c.keyword);
      const skip = (reason: string): void => {
        skipped.push({ line: c.line, keyword: keyword === null ? null : excerpt(keyword), reason });
      };
      if (keyword === null) {
        skip('語が空です');
      } else if (codePoints(keyword) > MAX_KEYWORD_CHARS) {
        skip(`語が長すぎます（${MAX_KEYWORD_CHARS}文字まで）`);
      } else if (seen.has(norm(keyword))) {
        skip('同じ語が既にあります');
      } else {
        seen.add(norm(keyword));
        const { category_ids, relevance_score } = classifier.classify(keyword);
        // Keys in spec 8.2 order.
        records.push({
          keyword,
          category_ids,
          source_id: src.id,
          source_url: src.source_url,
          source_kind: 'manual_import',
          retrieved_at: o.retrievedAt,
          published_at: null,
          expires_at: o.expiresAt,
          region: src.region,
          relevance_score,
          demand_metric: c.demand_metric,
          metric_definition: c.metric_definition,
        });
      }
    }
    if (records.length === 0) {
      throw new TrendCsvError(`取り込める語がありません（${candidates.length}件すべてを取り込みませんでした: ${skipped[0]?.reason ?? '理由不明'}）`);
    }
    return {
      schema_version: 1,
      import_version: IMPORT_VERSION,
      source_id: src.id,
      data_kind: src.data_kind,
      file_name: o.fileName,
      file_sha256: o.fileSha,
      file_size: o.fileSize,
      file_mtime_ms: o.fileMtimeMs,
      context_sha256: o.contextSha,
      imported_at: this.#clock.now().toISOString(),
      retrieved_at: o.retrievedAt,
      expires_at: o.expiresAt,
      items_read: candidates.length,
      skipped: skipped.slice(0, MAX_SKIPPED_KEPT),
      records,
    };
  }
}
