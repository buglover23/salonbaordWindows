import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loggerFrom, type AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf, errorText } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import { jstDateKey } from '../shared/time.js';
import { AUDIENCE_CATEGORIES, type AudienceCategory } from '../shared/types.js';
import { handledAudiences, type Settings } from '../config/schemas.js';
import { MANUAL_TRENDS_XLSX, manualTrendWords, manualTrendsStatusLine, trendListAudience, trendListNote } from './trend-workbook.js';
import { TrendLibrary, type TrendConfig, type TrendRecord, type TrendStatus } from './trends.js';
import { readWebTrends, webTrendRecords, webTrendsFile, webTrendsStatusLines, type WebTrendsFile } from './web-trends.js';
import { readWorkbook } from './xlsx/read-xlsx.js';

// The manual trend CSVs as the running tool holds them (spec 8.3-8.4): imported at startup and again only when
// config/trends.json, the words that shape the records, or a CSV file (size / modification time) change. The records
// are kept in memory, so generation never reads a CSV. A warning about one source is logged once per JST day.
// The weekly web look-ups (web-trends.json for mens, web-trends-ladies.json) are read again whenever their file changes,
// and their words join the records. The owner's 手動のトレンド語.xlsx is read again whenever its size or modification time changes.

export interface TrendFeedDeps {
  /** With `settings` (the running tool's snapshot): only the audiences this copy handles are shown, and its own list is named. */
  config: () => TrendConfig & { settings?: Pick<Settings, 'audiences' | 'shared_root'> };
  /** data/cache/trends. */
  cacheDir: string;
  /** The project root: relative file_path values are resolved against it. */
  baseDir: string;
  /** トレンド語 (DataPaths.trendWorkbookDir): 手動のトレンド語.xlsx is read from there; none when left out. */
  workbookDir?: string;
  logger: AppLogger;
  clock: Clock;
}

async function csvStamp(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * A logger that passes a warning (or error) about one trend source on once per JST day: the same source keeps the same
 * problem until the owner fixes it, and the tool looks at it every 30 seconds.
 */
export function dailyDedupedLogger(base: AppLogger, clock: Clock): AppLogger {
  const seen = new Map<string, string>();
  return loggerFrom((level, event, message, fields) => {
    if (level === 'warn' || level === 'error') {
      const source = typeof fields?.source_id === 'string' ? fields.source_id : '';
      const key = `${event}|${source}|${message}`;
      const day = jstDateKey(clock.now());
      if (seen.get(key) === day) return;
      seen.set(key, day);
    }
    base[level](event, message, fields);
  });
}

export class TrendFeed {
  readonly #d: TrendFeedDeps;
  readonly #library: TrendLibrary;
  #key: string | null = null;
  readonly #web: Record<AudienceCategory, WebTrendsFile | null> = { mens: null, ladies: null };
  readonly #webStamp: Record<AudienceCategory, string> = { mens: '', ladies: '' };
  #manual: Record<AudienceCategory, string[]> = { mens: [], ladies: [] };
  #manualStamp = 'missing';
  #manualWarned = '';

  constructor(d: TrendFeedDeps) {
    this.#d = d;
    this.#library = new TrendLibrary({ cacheDir: d.cacheDir, baseDir: d.baseDir, logger: dailyDedupedLogger(d.logger, d.clock), clock: d.clock });
  }

  /** Imports the configured CSVs when their settings or files changed since the last import. Never throws. */
  async refresh(now: Date): Promise<void> {
    for (const audience of AUDIENCE_CATEGORIES) {
      const webStamp = await csvStamp(join(this.#d.cacheDir, webTrendsFile(audience)));
      if (webStamp === this.#webStamp[audience]) continue;
      this.#web[audience] = await readWebTrends(this.#d.cacheDir, audience);
      this.#webStamp[audience] = webStamp;
    }
    await this.#refreshManual();
    const config = this.#d.config();
    const stamps = await Promise.all(
      config.trends.sources.map(async (s) => (s.kind === 'manual_import' && s.enabled ? csvStamp(resolve(this.#d.baseDir, s.file_path)) : '')),
    );
    const key = sha256Hex(JSON.stringify([config.trends, config.keywords.excluded_topics, config.categories, stamps]));
    if (key === this.#key) return;
    try {
      await this.#library.importConfigured(config, now);
      this.#key = key;
    } catch (err) {
      // Left unset, so the next check tries again.
      this.#d.logger.warn('TRENDS_REFRESH_FAILED', `トレンドの取込中にエラーが発生しました（次の確認でもう一度試します）: ${errorText(err)}`, {
        stage: 'trends',
        error_code: errorCodeOf(err),
      });
    }
  }

  /** A file that cannot be read (locked while saving, damaged) keeps the last good words; warned once per file state. */
  async #refreshManual(): Promise<void> {
    if (this.#d.workbookDir === undefined) return;
    const path = join(this.#d.workbookDir, MANUAL_TRENDS_XLSX);
    const stamp = await csvStamp(path);
    if (stamp === this.#manualStamp) return;
    try {
      this.#manual = stamp === 'missing' ? { mens: [], ladies: [] } : manualTrendWords(await readWorkbook(path));
      this.#manualStamp = stamp;
    } catch (err) {
      if (this.#manualWarned === stamp) return;
      this.#manualWarned = stamp;
      this.#d.logger.warn('MANUAL_TRENDS_READ_FAILED', `${MANUAL_TRENDS_XLSX} を読み取れませんでした（前回読めた語で続けます。保存して閉じると読み直します）: ${errorText(err)}`, {
        stage: 'trends',
        error_code: errorCodeOf(err),
      });
    }
  }

  /** The owner's hand-kept words of that audience from 手動のトレンド語.xlsx, used like trends.json trend_words. */
  manualWords(audience: AudienceCategory): readonly string[] {
    return this.#manual[audience];
  }

  /** The status line of 手動のトレンド語.xlsx. */
  manualStatusLine(): string {
    return manualTrendsStatusLine(this.#manual, this.#handled());
  }

  #handled(): readonly AudienceCategory[] {
    const s = this.#d.config().settings;
    return s === undefined ? AUDIENCE_CATEGORIES : handledAudiences(s);
  }

  validRecords(now: Date): TrendRecord[] {
    const web = AUDIENCE_CATEGORIES.flatMap((a) => webTrendRecords(this.#web[a], this.#d.config(), now, a));
    return [...this.#library.validRecords(now), ...web];
  }

  /** The status lines of the weekly web look-ups, one per audience (`audiences`: those looked up); the last names the list workbook. */
  webStatusLines(now: Date, audiences: readonly AudienceCategory[]): string[] {
    const { settings } = this.#d.config();
    const lines = webTrendsStatusLines(this.#web, this.#d.config().trends.web_search.enabled, now, audiences, this.#handled());
    if (this.#d.workbookDir !== undefined) lines[lines.length - 1] += trendListNote(this.#d.workbookDir, settings === undefined ? null : trendListAudience(settings));
    return lines;
  }

  status(now: Date): TrendStatus {
    return this.#library.status(now);
  }
}
