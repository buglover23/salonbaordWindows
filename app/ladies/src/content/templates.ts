import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Categories, SheetMapping, TemplateMapping, TemplateSheetKind } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, type AppError } from '../shared/errors.js';
import { sha256File, sha256Hex } from '../shared/hash.js';
import type { AudienceCategory } from '../shared/types.js';
import { readJsonFile, writeJsonAtomic } from '../storage/atomic-json.js';
import {
  checkWorkbookFile,
  columnIndex,
  columnLetters,
  parseCellRef,
  parseWorkbook,
  readWorkbookBytes,
  workbookReadFailure,
  type Workbook,
  type WorkbookSheet,
  type XlsxLimits,
} from './xlsx/read-xlsx.js';

// Excel reference library (spec 7.2, plan decisions 5 and 6). The parsed workbook is cached by its sha256; the
// mapping is applied on every load, so editing template_mapping.json never needs the workbook to be parsed again.

const STAGE = 'templates';
/** Bumped whenever the reader's output for the same workbook changes; older caches are then parsed again. */
const IMPORT_VERSION = 1;
const LAST_GOOD_FILE = 'last-good.json';
const MAX_TAG_LENGTH = 50;

export interface TemplateExample {
  title: string;
  menu?: string;
  comment?: string;
  length?: string;
  /** The subgroup label carried down from the mapping's group column (e.g. 「ツーブロック / フェード」). */
  group?: string;
  /** Per-row hashtags (1000PV sheets). Category sheets keep theirs per column: see hashtagGroups(). */
  hashtags: string[];
  source: { sheet: string; row: number };
}

export interface HashtagGroup {
  /** From the column header, e.g. 「ベージュ系」 for 「ハッシュタグ (ベージュ系)」. */
  label: string;
  tags: string[];
  source: { sheet: string; column: string };
}

export interface TemplateImportReport {
  file_path: string;
  file_name: string;
  workbook_sha256: string;
  /** True when the workbook was parsed by this load; false when the cache for the same hash was used. */
  parsed: boolean;
  /** 'last_good_cache': the workbook could not be read, so the last good import of the same file is used. */
  source: 'workbook' | 'last_good_cache';
  /** Rows below the header row holding any value, over all mapped sheets. */
  rows_read: number;
  /** Rows that gave a template entry, a hashtag or a trend word. */
  rows_used: number;
  /** Rows (no column) and single cells (with column) that were not imported, with the reason. */
  skipped: Array<{ sheet: string; row: number; column?: string; reason: string }>;
  /** Columns with a header or values that the mapping neither uses nor ignores. */
  unknown_columns: Array<{ sheet: string; column: string; header: string | null; cells: number }>;
  /** Mapped sheet names the workbook does not have (matched exactly). */
  sheets_missing: string[];
  /** Workbook sheets without a mapping. */
  sheets_unmapped: string[];
  sheets: Array<{ sheet: string; kind: TemplateSheetKind; entries: number; hashtags: number; words: number }>;
}

export interface SeasonPreference {
  /** Words of the post's season (e.g. 冬, 冬カラー): matching titles come first. */
  words: readonly string[];
  /** Words of the other seasons: titles with only these are left out. */
  other_words?: readonly string[];
}

export interface ExampleQuery {
  /** categories.json ids; resolved through their template_categories. */
  category_ids: readonly string[];
  audience: AudienceCategory;
  season?: SeasonPreference;
  n: number;
  /** Varies the order among equally good rows, deterministically (e.g. the job id). */
  seed?: string;
}

export interface TemplateLoadOptions {
  categories?: Categories;
  /** Folder a relative file_path is resolved against (default: the current directory). */
  baseDir?: string;
  /** Replaces the parser (tests count parses with it). */
  parseWorkbook?: (bytes: Uint8Array) => Workbook;
  xlsxLimits?: Partial<XlsxLimits>;
}

interface TemplateEntry extends TemplateExample {
  kind: TemplateSheetKind;
  category: string;
  audiences: readonly AudienceCategory[];
}

interface StoredGroup extends HashtagGroup {
  category: string;
  audiences: readonly AudienceCategory[];
}

// ---------------------------------------------------------------- cache files

const sha256Text = z.string().regex(/^[0-9a-f]{64}$/);
const CachedSheetSchema = z.strictObject({
  name: z.string().min(1),
  rows: z.array(z.tuple([z.number().int().positive(), z.array(z.tuple([z.string().regex(/^[A-Z]{1,3}$/), z.string()]))])),
  merges: z.array(z.strictObject({ from: z.string(), to: z.string() })),
});
type CachedSheet = z.infer<typeof CachedSheetSchema>;

const CacheFileSchema = z
  .strictObject({
    schema_version: z.literal(1),
    import_version: z.literal(IMPORT_VERSION),
    workbook_sha256: sha256Text,
    file_name: z.string(),
    imported_at: z.string(),
    content_sha256: sha256Text,
    sheets: z.array(CachedSheetSchema),
  })
  .superRefine((c, ctx) => {
    if (sha256Hex(JSON.stringify(c.sheets)) !== c.content_sha256) ctx.addIssue({ code: 'custom', message: 'キャッシュの内容が hash と一致しません' });
  });

const LastGoodSchema = z.strictObject({
  schema_version: z.literal(1),
  file_path: z.string().min(1),
  workbook_sha256: sha256Text,
  recorded_at: z.string(),
  /** importIssues() of that import, so the read-only status knows whether templates:import has anything to list. */
  import_issues: z.number().int().nonnegative().optional(),
});

/** Mapped sheets the workbook lacks plus columns the mapping neither uses nor ignores (what templates:import lists). */
export const importIssues = (r: Pick<TemplateImportReport, 'sheets_missing' | 'unknown_columns'>): number => r.sheets_missing.length + r.unknown_columns.length;

// Key order matches CachedSheetSchema so the content hash survives a read back through the schema.
function toCached(workbook: Workbook): CachedSheet[] {
  return workbook.sheets.map((s) => ({
    name: s.name,
    rows: [...s.rows].map(([row, cols]): [number, [string, string][]] => [row, [...cols]]),
    merges: s.merges.map((m) => ({ from: m.from, to: m.to })),
  }));
}

function fromCached(sheets: CachedSheet[]): Workbook {
  return {
    sheets: sheets.map((s) => ({
      name: s.name,
      rows: new Map(s.rows.map(([row, cols]) => [row, new Map(cols)])),
      merges: s.merges.map((m) => ({ ...m })),
    })),
  };
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

class TemplateCache {
  constructor(
    readonly dir: string,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  #file(sha: string): string {
    return join(this.dir, `${sha}.json`);
  }

  /** The cached workbook for `sha`, or null when there is none or it is not valid. */
  async read(sha: string): Promise<Workbook | null> {
    try {
      const r = await readJsonFile(this.#file(sha), CacheFileSchema);
      if (r.kind === 'ok' && r.value.workbook_sha256 === sha) return fromCached(r.value.sheets);
      if (r.kind !== 'missing') {
        this.logger.warn('TEMPLATES_CACHE_INVALID', 'テンプレートのキャッシュが壊れているため使いません。', {
          stage: STAGE,
          workbook_sha256: sha,
          reason: r.kind === 'corrupt' ? r.reason : 'hash が一致しません',
        });
      }
    } catch (err) {
      this.logger.warn('TEMPLATES_CACHE_UNREADABLE', 'テンプレートのキャッシュを読み込めないため使いません。', { stage: STAGE, workbook_sha256: sha, error: err });
    }
    return null;
  }

  /** Best effort: a failed write is logged and the import goes on with the parsed workbook. */
  async write(sha: string, fileName: string, workbook: Workbook): Promise<void> {
    const sheets = toCached(workbook);
    const value = {
      schema_version: 1,
      import_version: IMPORT_VERSION,
      workbook_sha256: sha,
      file_name: fileName,
      imported_at: this.clock.now().toISOString(),
      content_sha256: sha256Hex(JSON.stringify(sheets)),
      sheets,
    };
    try {
      await writeJsonAtomic(this.#file(sha), value);
    } catch (err) {
      this.logger.warn('TEMPLATES_CACHE_WRITE_FAILED', 'テンプレートのキャッシュを保存できませんでした（次回も解析し直します）。', {
        stage: STAGE,
        workbook_sha256: sha,
        error: err,
      });
    }
  }

  /** Records `sha` as the last good import of `filePath` with its issue count (skipped when unchanged). */
  async markLastGood(filePath: string, sha: string, issues: number): Promise<void> {
    const path = join(this.dir, LAST_GOOD_FILE);
    try {
      const current = await readJsonFile(path, LastGoodSchema);
      if (current.kind === 'ok' && current.value.workbook_sha256 === sha && samePath(current.value.file_path, filePath) && current.value.import_issues === issues) return;
      await writeJsonAtomic(path, { schema_version: 1, file_path: filePath, workbook_sha256: sha, recorded_at: this.clock.now().toISOString(), import_issues: issues });
    } catch (err) {
      this.logger.warn('TEMPLATES_CACHE_WRITE_FAILED', 'テンプレートの最終取込の記録を保存できませんでした。', { stage: STAGE, workbook_sha256: sha, error: err });
    }
  }

  /** The last good import of `filePath`, when its cache is still valid. */
  async lastGood(filePath: string): Promise<{ sha: string; workbook: Workbook } | null> {
    let pointer: z.infer<typeof LastGoodSchema>;
    try {
      const r = await readJsonFile(join(this.dir, LAST_GOOD_FILE), LastGoodSchema);
      if (r.kind !== 'ok') return null;
      pointer = r.value;
    } catch {
      return null;
    }
    if (!samePath(pointer.file_path, filePath)) return null;
    const workbook = await this.read(pointer.workbook_sha256);
    return workbook ? { sha: pointer.workbook_sha256, workbook } : null;
  }
}

// ---------------------------------------------------------------- applying the mapping

const nfkc = (s: string): string => s.normalize('NFKC').toLowerCase();

function clean(v: string | undefined): string | undefined {
  const s = v?.replace(/\r\n?/g, '\n').trim();
  return s === undefined || s === '' ? undefined : s;
}

// Comment cells are numbered per block in the workbook (①, ➀, ❶ ...); the number is not part of the text.
const cleanComment = (v: string | undefined): string | undefined => clean(clean(v)?.replace(/^[①-⑳❶-➓]\s*/u, ''));
const cleanGroup = (v: string | undefined): string | undefined => clean(v)?.replace(/\s*\n\s*/g, ' / ');

// One hashtag: no '#', no whitespace inside (a sentence such as 「他キーワードから…使用」 is not a tag).
function cleanTag(v: string): string | undefined {
  const s = v.trim().replace(/^[#＃]+/, '').trim();
  return s !== '' && !/\s/u.test(s) && s.length <= MAX_TAG_LENGTH ? s : undefined;
}

function splitTags(v: string | undefined): string[] {
  if (v === undefined) return [];
  return dedupe(v.split(/[\s/／#＃、,，]+/u).map((s) => s.trim()).filter((s) => s !== '' && s.length <= MAX_TAG_LENGTH));
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = nfkc(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Block headings inside a trend sheet's keyword columns (急上昇ワード, 寒色系カラー, レングス系, ...).
const isTrendHeading = (v: string): boolean => /(ワード|系|系カラー)$/u.test(v.normalize('NFKC'));

function groupLabel(header: string | undefined, column: string): string {
  const text = clean(header)?.normalize('NFKC');
  if (text === undefined) return column;
  const inParens = /\(([^)]+)\)/u.exec(text)?.[1]?.trim();
  if (inParens) return inParens;
  return text.replace(/^ハッシュタグ/u, '').replace(/\s+/gu, ' ').trim() || column;
}

interface Range {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

class SheetView {
  readonly #sheet: WorkbookSheet;
  readonly #ranges: Range[];

  constructor(sheet: WorkbookSheet) {
    this.#sheet = sheet;
    this.#ranges = sheet.merges.flatMap((m) => {
      const a = parseCellRef(m.from);
      const b = parseCellRef(m.to);
      return a && b ? [{ top: a.row, left: a.col, bottom: b.row, right: b.col }] : [];
    });
  }

  own(row: number, col: string): string | undefined {
    return this.#sheet.rows.get(row)?.get(col);
  }

  /** The cell's value, or the value of the merged range it lies in (kept in the range's top-left cell). */
  spanned(row: number, col: string): string | undefined {
    const value = this.own(row, col);
    if (value !== undefined) return value;
    const c = columnIndex(col);
    if (c === undefined) return undefined;
    const range = this.#ranges.find((r) => row >= r.top && row <= r.bottom && c >= r.left && c <= r.right);
    return range ? this.own(range.top, columnLetters(range.left)) : undefined;
  }
}

interface Imported {
  entries: TemplateEntry[];
  groups: StoredGroup[];
  trendWords: string[];
  report: Pick<TemplateImportReport, 'rows_read' | 'rows_used' | 'skipped' | 'unknown_columns' | 'sheets_missing' | 'sheets_unmapped' | 'sheets'>;
}

function importSheet(sheet: WorkbookSheet, m: SheetMapping, out: Imported): void {
  const view = new SheetView(sheet);
  const { hashtags = [], ignore = [], ...single } = m.columns;
  const known = new Set<string>([...Object.values(single).filter((c): c is string => c !== undefined), ...hashtags, ...ignore]);
  const name = sheet.name;
  const entriesBefore = out.entries.length;

  // Unknown columns: anything on the header row or below that the mapping does not account for.
  const unknown = new Map<string, { header: string | null; cells: number }>();
  for (const [row, cols] of sheet.rows) {
    if (row < m.header_row) continue;
    for (const col of cols.keys()) {
      if (known.has(col)) continue;
      const u = unknown.get(col) ?? { header: clean(view.own(m.header_row, col)) ?? null, cells: 0 };
      if (row > m.header_row) u.cells++;
      unknown.set(col, u);
    }
  }
  for (const [column, u] of [...unknown].sort((a, b) => (columnIndex(a[0]) ?? 0) - (columnIndex(b[0]) ?? 0))) {
    out.report.unknown_columns.push({ sheet: name, column, ...u });
  }

  const groups =
    m.kind === 'category'
      ? hashtags.map((column) => ({ column, label: groupLabel(view.spanned(m.header_row, column), column), tags: [] as string[] }))
      : [];
  const words: string[] = [];
  let group: string | undefined;

  for (const [row, cols] of sheet.rows) {
    if (row <= m.header_row || cols.size === 0) continue;
    out.report.rows_read++;
    let used = false;
    let cellSkipped = false;
    if (single.group) group = cleanGroup(view.own(row, single.group)) ?? group;

    if (m.kind !== 'top_titles') {
      hashtags.forEach((column, i) => {
        const value = clean(view.own(row, column));
        if (value === undefined) return;
        if (m.kind === 'trend_words' && isTrendHeading(value)) {
          out.report.skipped.push({ sheet: name, row, column, reason: '見出しとして除外しました' });
          cellSkipped = true;
          return;
        }
        const tag = cleanTag(value);
        if (tag === undefined) {
          out.report.skipped.push({ sheet: name, row, column, reason: 'ハッシュタグとして使えない値です（空白や改行を含みます）' });
          cellSkipped = true;
          return;
        }
        if (m.kind === 'category') groups[i]!.tags.push(tag);
        else words.push(tag);
        used = true;
      });
    }

    const title = single.title ? clean(view.own(row, single.title)) : undefined;
    if (title !== undefined) {
      const entry: TemplateEntry = {
        kind: m.kind,
        category: m.category,
        audiences: m.audiences,
        title,
        hashtags: m.kind === 'top_titles' ? dedupe(hashtags.flatMap((c) => splitTags(view.own(row, c)))) : [],
        source: { sheet: name, row },
      };
      const menu = single.menu ? clean(view.spanned(row, single.menu)) : undefined;
      const comment = single.comment ? cleanComment(view.spanned(row, single.comment)) : undefined;
      const length = single.length ? clean(view.spanned(row, single.length)) : undefined;
      if (menu !== undefined) entry.menu = menu;
      if (comment !== undefined) entry.comment = comment;
      if (length !== undefined) entry.length = length;
      if (group !== undefined) entry.group = group;
      out.entries.push(entry);
      used = true;
    }

    if (used) out.report.rows_used++;
    else if (!cellSkipped) out.report.skipped.push({ sheet: name, row, reason: single.title ? 'タイトルが空です' : '使える値がありません' });
  }

  let tagCount = 0;
  for (const g of groups) {
    const tags = dedupe(g.tags);
    tagCount += tags.length;
    if (tags.length > 0) out.groups.push({ category: m.category, audiences: m.audiences, label: g.label, tags, source: { sheet: name, column: g.column } });
  }
  out.trendWords.push(...words);
  out.report.sheets.push({ sheet: name, kind: m.kind, entries: out.entries.length - entriesBefore, hashtags: tagCount, words: dedupe(words).length });
}

function applyMapping(workbook: Workbook, mapping: TemplateMapping): Imported {
  const out: Imported = {
    entries: [],
    groups: [],
    trendWords: [],
    report: { rows_read: 0, rows_used: 0, skipped: [], unknown_columns: [], sheets_missing: [], sheets_unmapped: [], sheets: [] },
  };
  const byName = new Map(workbook.sheets.map((s) => [s.name, s]));
  for (const m of mapping.sheet_mappings) {
    const sheet = byName.get(m.sheet_name);
    if (sheet) importSheet(sheet, m, out);
    else out.report.sheets_missing.push(m.sheet_name);
  }
  const mapped = new Set(mapping.sheet_mappings.map((m) => m.sheet_name));
  out.report.sheets_unmapped = workbook.sheets.map((s) => s.name).filter((n) => !mapped.has(n));
  out.trendWords = dedupe(out.trendWords);
  return out;
}

// ---------------------------------------------------------------- library

function copyExample(e: TemplateEntry): TemplateExample {
  const x: TemplateExample = { title: e.title, hashtags: [...e.hashtags], source: { ...e.source } };
  if (e.menu !== undefined) x.menu = e.menu;
  if (e.comment !== undefined) x.comment = e.comment;
  if (e.length !== undefined) x.length = e.length;
  if (e.group !== undefined) x.group = e.group;
  return x;
}

function uniqueByTitle(entries: TemplateEntry[]): TemplateEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = nfkc(e.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isTemplateFailure = (err: unknown): err is AppFailure =>
  err instanceof AppFailure && (err.error.code === 'TEMPLATE_MISSING' || err.error.code === 'TEMPLATE_PARSE_ERROR');

/** An unexpected exception of the parser as TEMPLATE_PARSE_ERROR, so the last good import can still be used. */
function unexpectedParseFailure(err: unknown, path: string, clock: Clock): AppFailure {
  if (err instanceof AppFailure) return err;
  const name = err instanceof Error ? err.name : typeof err;
  return new AppFailure(
    appError('TEMPLATE_PARSE_ERROR', STAGE, clock, {
      message: `テンプレートのExcelファイルを読み取れません（想定外のエラー: ${name}。詳細はログを確認してください）: ${path}`,
      details: { path, exception: name },
    }),
  );
}

export class TemplateLibrary {
  readonly report: TemplateImportReport;
  /** 'last_good_cache' while the workbook cannot be read (status should show `warning`). */
  readonly source: 'workbook' | 'last_good_cache';
  /** Why the last good cache is in use; null when the workbook itself was read. */
  readonly warning: AppError | null;
  readonly #entries: readonly TemplateEntry[];
  readonly #groups: readonly StoredGroup[];
  readonly #trendWords: readonly string[];
  readonly #categories: Categories | undefined;

  private constructor(o: { report: TemplateImportReport; warning: AppError | null; imported: Imported; categories: Categories | undefined }) {
    this.report = o.report;
    this.source = o.report.source;
    this.warning = o.warning;
    this.#entries = o.imported.entries;
    this.#groups = o.imported.groups;
    this.#trendWords = o.imported.trendWords;
    this.#categories = o.categories;
  }

  /**
   * Reads the workbook at mapping.file_path (only reading it), reusing `<cacheDir>/<sha256>.json` when the file's hash
   * matches, and applies the mapping. When the workbook is missing or unreadable, the last good import of the same file
   * is used with a warning; without one, TEMPLATE_MISSING / TEMPLATE_PARSE_ERROR is thrown (generation is held, spec 7.2).
   */
  static async load(mapping: TemplateMapping, cacheDir: string, logger: AppLogger, clock: Clock, opts: TemplateLoadOptions = {}): Promise<TemplateLibrary> {
    if (mapping.file_path === null) {
      throw new AppFailure(
        appError('TEMPLATE_MISSING', STAGE, clock, {
          message: 'テンプレートのExcelファイルが設定されていません。template_mapping.json の file_path にファイルの場所を書いてください。',
        }),
      );
    }
    const path = resolve(opts.baseDir ?? process.cwd(), mapping.file_path);
    const cache = new TemplateCache(cacheDir, clock, logger);
    const xlsx = { clock, ...(opts.xlsxLimits ? { limits: opts.xlsxLimits } : {}) };
    const parse = opts.parseWorkbook ?? ((bytes: Uint8Array) => parseWorkbook(bytes, { ...xlsx, path }));

    let loaded: { workbook: Workbook; sha: string; parsed: boolean };
    let warning: AppError | null = null;
    try {
      await checkWorkbookFile(path, xlsx);
      let streamed: string;
      try {
        streamed = await sha256File(path);
      } catch (err) {
        throw workbookReadFailure(path, err, clock);
      }
      const cached = await cache.read(streamed);
      if (cached) {
        loaded = { workbook: cached, sha: streamed, parsed: false };
      } else {
        const bytes = await readWorkbookBytes(path, xlsx);
        // The bytes actually parsed name the cache, even if the file changed after it was hashed.
        const sha = sha256Hex(bytes);
        let workbook: Workbook;
        try {
          workbook = parse(bytes);
        } catch (err) {
          if (!(err instanceof AppFailure)) {
            logger.warn('TEMPLATES_PARSE_UNEXPECTED', 'テンプレートの解析中に想定外のエラーが発生しました。', {
              stage: STAGE,
              exception: err instanceof Error ? err.name : typeof err,
              cause: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
            });
          }
          throw unexpectedParseFailure(err, path, clock);
        }
        loaded = { workbook, sha, parsed: true };
        await cache.write(sha, basename(path), loaded.workbook);
      }
    } catch (err) {
      if (!isTemplateFailure(err)) throw err;
      const fallback = await cache.lastGood(path);
      if (!fallback) throw err;
      warning = err.error;
      loaded = { workbook: fallback.workbook, sha: fallback.sha, parsed: false };
      logger.warn('TEMPLATES_USING_CACHE', `${err.error.message} 前回正常に読み込んだ内容（キャッシュ）で続けます。`, {
        stage: STAGE,
        error_code: err.error.code,
        workbook_sha256: fallback.sha,
      });
    }

    const imported = applyMapping(loaded.workbook, mapping);
    const report: TemplateImportReport = {
      file_path: path,
      file_name: basename(path),
      workbook_sha256: loaded.sha,
      parsed: loaded.parsed,
      source: warning ? 'last_good_cache' : 'workbook',
      ...imported.report,
    };
    if (warning === null) await cache.markLastGood(path, loaded.sha, importIssues(report));
    logger.info('TEMPLATES_LOADED', `テンプレートを読み込みました（${report.rows_used}行、${report.parsed ? '解析' : 'キャッシュを使用'}）。`, {
      stage: STAGE,
      workbook_sha256: report.workbook_sha256,
      parsed: report.parsed,
      source: report.source,
      rows_read: report.rows_read,
      rows_used: report.rows_used,
    });
    if (report.unknown_columns.length > 0 || report.sheets_missing.length > 0) {
      const counts = [
        report.sheets_missing.length > 0 ? `見つからないシート ${report.sheets_missing.length}` : '',
        report.unknown_columns.length > 0 ? `対応表に無い列 ${report.unknown_columns.length}` : '',
      ].filter((c) => c !== '');
      const message = `テンプレートの対応表（template_mapping.json）と合わない列やシートがあります（${counts.join('・')}）。一覧は、ツールを止めて npm.cmd run templates:import で確認できます。`;
      logger.warn('TEMPLATES_IMPORT_ISSUES', message, {
        stage: STAGE,
        sheets_missing: report.sheets_missing,
        unknown_columns: report.unknown_columns.map((u) => `${u.sheet}!${u.column}`),
      });
    }
    return new TemplateLibrary({ report, warning, imported, categories: opts.categories });
  }

  #resolve(categoryIds: readonly string[]): { templateCategories: Set<string>; keywords: string[] } {
    const all = this.#categories ? [...this.#categories.style_categories, ...this.#categories.blog_categories] : [];
    const templateCategories = new Set<string>();
    const keywords: string[] = [];
    for (const id of categoryIds) {
      const entry = all.find((c) => c.id === id);
      if (entry) {
        entry.template_categories.forEach((c) => templateCategories.add(c));
        keywords.push(entry.label, ...entry.allowed_keywords);
      } else if (!this.#categories) {
        templateCategories.add(id); // without categories.json the ids name template categories directly
      }
    }
    return { templateCategories, keywords: keywords.map(nfkc).filter((k) => k !== '') };
  }

  /**
   * Up to `n` example rows from the category sheets of `category_ids` for `audience`. Rows whose title or group holds
   * a category keyword come first, then rows with a word of the given season; rows naming only another season are
   * left out. Ties keep workbook order, or a `seed`-based order.
   */
  examples(q: ExampleQuery): TemplateExample[] {
    if (q.n <= 0) return [];
    const { templateCategories, keywords } = this.#resolve(q.category_ids);
    const current = (q.season?.words ?? []).map(nfkc).filter((w) => w !== '');
    const others = (q.season?.other_words ?? []).map(nfkc).filter((w) => w !== '' && !current.includes(w));
    const candidates = uniqueByTitle(
      this.#entries.filter((e) => e.kind === 'category' && templateCategories.has(e.category) && e.audiences.includes(q.audience)),
    );
    const ranked = candidates.flatMap((e, i) => {
      const title = nfkc(e.title);
      const inSeason = current.some((w) => title.includes(w));
      if (!inSeason && others.some((w) => title.includes(w))) return [];
      const group = e.group === undefined ? '' : nfkc(e.group);
      const relevant = keywords.some((k) => title.includes(k) || group.includes(k));
      const tie = q.seed === undefined ? String(i).padStart(8, '0') : sha256Hex(`${q.seed}\u0000${e.source.sheet}\u0000${e.source.row}`);
      return [{ e, key: [relevant ? 0 : 1, inSeason ? 0 : 1] as const, tie }];
    });
    ranked.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
    return ranked.slice(0, q.n).map((r) => copyExample(r.e));
  }

  /** Up to `n` titles from the 1000PV sheets for `audience`, in workbook order (reference only, spec 7.1). */
  topTitles(audience: AudienceCategory, n: number): TemplateExample[] {
    if (n <= 0) return [];
    return uniqueByTitle(this.#entries.filter((e) => e.kind === 'top_titles' && e.audiences.includes(audience)))
      .slice(0, n)
      .map(copyExample);
  }

  /** Up to `n` titles from the trend sheets, in workbook order. */
  trendTitles(n: number): TemplateExample[] {
    if (n <= 0) return [];
    return uniqueByTitle(this.#entries.filter((e) => e.kind === 'trend_words'))
      .slice(0, n)
      .map(copyExample);
  }

  /** The trend sheets' keywords without the block headings, each once, in workbook order. */
  trendWords(): string[] {
    return [...this.#trendWords];
  }

  /** The hashtag columns of the category sheets for these categories and audience (one group per column). */
  hashtagGroups(q: { category_ids: readonly string[]; audience: AudienceCategory }): HashtagGroup[] {
    const { templateCategories } = this.#resolve(q.category_ids);
    return this.#groups
      .filter((g) => templateCategories.has(g.category) && g.audiences.includes(q.audience))
      .map((g) => ({ label: g.label, tags: [...g.tags], source: { ...g.source } }));
  }
}
