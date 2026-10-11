import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import type { Settings } from '../config/schemas.js';
import { AppFailure, errorCodeOf, errorText } from '../shared/errors.js';
import { AUDIENCE_JA } from '../shared/labels.js';
import { formatJst } from '../shared/time.js';
import { AUDIENCE_CATEGORIES, type AudienceCategory } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { createFileExclusive, errnoCode, readJsonFile, writeFileAtomic, writeJsonAtomic } from '../storage/atomic-json.js';
import type { WebTrendsFile } from './web-trends.js';
import { readWorkbook, type Workbook, type WorkbookSheet } from './xlsx/read-xlsx.js';

// The owner's Excel view of the weekly web look-ups (owner request 2026-10): every successful look-up is kept in
// data/cache/trends/web-trends-history.json and the whole list is written to トレンド語\トレンド語一覧.xlsx, one sheet per
// audience (the tool rewrites it, so it is view-only). Words to use are added by hand in トレンド語\手動のトレンド語.xlsx
// (sheets メンズ / レディース), which the tool creates once as a template and afterwards only reads (an empty file in the
// old one-sheet layout is replaced by the new template at start).

export const TREND_HISTORY_FILE = 'web-trends-history.json';
export const TREND_LIST_XLSX = 'トレンド語一覧.xlsx';
export const MANUAL_TRENDS_XLSX = '手動のトレンド語.xlsx';
/** The sheet of the first, one-sheet template; its words (or the first sheet's) are mens words when no audience sheet exists. */
const OLD_MANUAL_SHEET = '手動のトレンド語';
const MANUAL_MEMO = 'A列に1行1語。保存して閉じると、1分ほどで使われます';
const STAGE = 'trends';
const MAX_WEEKS = 104;
const MAX_MANUAL_WORDS = 100;
const MAX_MANUAL_CHARS = 30;
const KIND_JA = { rising: '上昇中', common: 'よく使われる' } as const;

/** How a workbook is named to the owner, e.g. トレンド語\トレンド語一覧.xlsx. */
export const shownPath = (file: string): string => `トレンド語\\${file}`;

/**
 * The one audience whose own list this copy writes: in the shared layout (one トレンド語 folder for both copies) a copy
 * that handles exactly one audience writes トレンド語一覧（メンズ）.xlsx or （レディース）, so the two never overwrite each
 * other. null: the one list of both audiences, as before.
 */
export const trendListAudience = (s: Pick<Settings, 'shared_root' | 'audiences'>): AudienceCategory | null =>
  s.shared_root !== null && s.audiences?.length === 1 ? s.audiences[0]! : null;

/** The list workbook's file name for trendListAudience. */
export const trendListFile = (only: AudienceCategory | null): string => (only === null ? TREND_LIST_XLSX : `トレンド語一覧（${AUDIENCE_JA[only]}）.xlsx`);

const HistoryEntrySchema = z.strictObject({
  week_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fetched_at: isoUtc,
  model: z.string(),
  words: z.array(z.strictObject({ word: z.string(), kind: z.enum(['rising', 'common']) })),
  sources: z.array(z.string()),
  /** Left out by files written before the ladies look-up existed: mens. */
  audience: z.enum(AUDIENCE_CATEGORIES).optional(),
});
export type TrendHistoryEntry = z.infer<typeof HistoryEntrySchema>;
const HistorySchema = z.strictObject({ schema_version: z.literal(1), weeks: z.array(HistoryEntrySchema) });

// ---------------------------------------------------------------- xlsx writer (inline strings, one bold header row)

/** XML text: characters XML 1.0 cannot carry are dropped, & < > " are escaped. */
export function xmlText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000) out += ch;
  }
  return out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface XlsxSheet {
  name: string;
  /** Column widths in characters, from column A. */
  widths: number[];
  /** Row 1 is the header (bold, frozen). */
  rows: string[][];
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const col = (i: number): string => String.fromCharCode(65 + i); // ponytail: columns A-Z only; enough for these sheets

function sheetXml(sheet: XlsxSheet): string {
  const cols = sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const rows = sheet.rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => (v === '' ? '' : `<c r="${col(c)}${r + 1}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`))
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts>` +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** A complete .xlsx package (OOXML zip). */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const n = sheets.length;
  const ids = sheets.map((_, i) => i + 1);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        ids.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(`${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(
      `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${ids.map((i) => `<Relationship Id="rId${i}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}` +
        `<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------- history and the list workbook

/** The saved weeks, newest first; [] when there are none (a damaged file counts as none). */
export async function readTrendHistory(cacheDir: string): Promise<TrendHistoryEntry[]> {
  try {
    const r = await readJsonFile(join(cacheDir, TREND_HISTORY_FILE), HistorySchema);
    return r.kind === 'ok' ? r.value.weeks : [];
  } catch {
    return [];
  }
}

const audienceOf = (w: TrendHistoryEntry): AudienceCategory => w.audience ?? 'mens';

/** The list shows a word only in the week it first appeared (owner request 2026-10): later weeks list new words only. */
function firstAppearances(weeks: readonly TrendHistoryEntry[]): TrendHistoryEntry[] {
  const seen = new Set<string>();
  const isNew = (word: string): boolean => {
    const key = word.normalize('NFKC').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return [...weeks]
    .sort((a, b) => a.week_of.localeCompare(b.week_of))
    .map((w) => ({ ...w, words: w.words.filter((x) => isNew(x.word)) }))
    .reverse();
}

/** One entry per week and audience (a later look-up replaces it), newest first, at most 104 weeks per audience. */
export function mergeHistory(weeks: readonly TrendHistoryEntry[], entry: TrendHistoryEntry): TrendHistoryEntry[] {
  const kept: Record<AudienceCategory, number> = { mens: 0, ladies: 0 };
  return [entry, ...weeks.filter((w) => w.week_of !== entry.week_of || audienceOf(w) !== audienceOf(entry))]
    .sort((a, b) => b.week_of.localeCompare(a.week_of) || AUDIENCE_CATEGORIES.indexOf(audienceOf(a)) - AUDIENCE_CATEGORIES.indexOf(audienceOf(b)))
    .filter((w) => ++kept[audienceOf(w)] <= MAX_WEEKS);
}

/** Sheets メンズ and レディース (the words), then 調べた元 (the sources of both); `only`: that audience's sheet and sources. */
export function trendListSheets(weeks: readonly TrendHistoryEntry[], only: AudienceCategory | null = null): XlsxSheet[] {
  if (only !== null) weeks = weeks.filter((w) => audienceOf(w) === only);
  return [
    ...(only === null ? AUDIENCE_CATEGORIES : [only]).map((audience) => ({
      name: AUDIENCE_JA[audience],
      widths: [14, 24, 14, 18],
      rows: [
        ['週（日曜）', '語', '種類', '取得日時'],
        ...firstAppearances(weeks.filter((w) => audienceOf(w) === audience)).flatMap((w) => w.words.map((x) => [w.week_of, x.word, KIND_JA[x.kind], formatJst(new Date(w.fetched_at))])),
      ],
    })),
    { name: '調べた元', widths: [14, 12, 80], rows: [['週（日曜）', '対象', 'URL'], ...weeks.flatMap((w) => w.sources.map((u) => [w.week_of, AUDIENCE_JA[audienceOf(w)], u]))] },
  ];
}

const isLocked = (err: unknown): boolean => {
  const code = err instanceof AppFailure ? err.error.details_redacted['errno'] : errnoCode(err);
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
};

/** Rewrites トレンド語一覧.xlsx (trendListFile) from the history. Never throws: a locked or failed write is logged and redone next time. */
export async function writeTrendList(workbookDir: string, weeks: readonly TrendHistoryEntry[], logger: AppLogger, only: AudienceCategory | null = null): Promise<void> {
  const file = trendListFile(only);
  try {
    await writeFileAtomic(join(workbookDir, file), buildXlsx(trendListSheets(weeks, only)));
  } catch (err) {
    const message = isLocked(err)
      ? `${file} を開いているため更新できませんでした。閉じると次の取得のときに書き直します`
      : `${file} を書き込めませんでした（次の取得のときに書き直します）: ${errorText(err)}`;
    logger.warn('TREND_WORKBOOK_WRITE_FAILED', message, { stage: STAGE, error_code: errorCodeOf(err) });
  }
}

const entryOf = (s: WebTrendsFile, audience: AudienceCategory): TrendHistoryEntry | null =>
  s.fetched_at === null || s.week_of === null || s.model === null || s.words.length === 0
    ? null
    : { week_of: s.week_of, fetched_at: s.fetched_at, model: s.model, words: s.words, sources: s.sources, audience };

/** After a successful look-up: adds it to the history and, when workbookDir is given, rewrites the list. Never throws. */
export async function recordWebTrends(
  s: WebTrendsFile,
  audience: AudienceCategory,
  cacheDir: string,
  workbookDir: string | undefined,
  logger: AppLogger,
  only: AudienceCategory | null = null,
): Promise<void> {
  const entry = entryOf(s, audience);
  if (entry === null) return;
  const weeks = mergeHistory(await readTrendHistory(cacheDir), entry);
  try {
    await writeJsonAtomic(join(cacheDir, TREND_HISTORY_FILE), { schema_version: 1, weeks });
  } catch (err) {
    logger.warn('TREND_HISTORY_WRITE_FAILED', `トレンド語の記録（${TREND_HISTORY_FILE}）を保存できませんでした: ${errorText(err)}`, { stage: STAGE, error_code: errorCodeOf(err) });
  }
  if (workbookDir !== undefined) await writeTrendList(workbookDir, weeks, logger, only);
}

const mtimeOf = async (path: string): Promise<number | null> => (await stat(path).catch(() => null))?.mtimeMs ?? null;

/** The 手動のトレンド語.xlsx template: sheets メンズ and レディース, each with a header and a memo row. */
export const manualTemplateSheets = (): XlsxSheet[] =>
  AUDIENCE_CATEGORIES.map((audience) => ({ name: AUDIENCE_JA[audience], widths: [24, 60], rows: [['語', 'メモ（任意）'], ['', MANUAL_MEMO]] }));

const hasAudienceSheets = (wb: Workbook): boolean => wb.sheets.some((s) => AUDIENCE_CATEGORIES.some((a) => s.name === AUDIENCE_JA[a]));

/** The untouched old template: one sheet holding nothing but the header 語 | メモ（任意） and the memo in B2. */
const isUntouchedOldTemplate = (wb: Workbook): boolean =>
  wb.sheets.length === 1 &&
  !hasAudienceSheets(wb) &&
  [...wb.sheets[0]!.rows].every(([row, cells]) =>
    [...cells].every(([col, v]) => v.trim() === '' || (row === 1 && v.trim() === (col === 'A' ? '語' : col === 'B' ? 'メモ（任意）' : null)) || (row === 2 && col === 'B')),
  );

/**
 * At tool start (no AI call): creates 手動のトレンド語.xlsx once when it is missing (an exclusive create: two copies of the
 * tool sharing the folder never overwrite each other's or the owner's file), or replaces it with the new template
 * when it is the untouched old one-sheet template, adds a look-up saved before the history existed, and
 * rewrites トレンド語一覧.xlsx (trendListFile of `only`) when it is missing or older than the history. Never throws.
 */
export async function syncTrendWorkbooks(
  states: Record<AudienceCategory, WebTrendsFile | null>,
  cacheDir: string,
  workbookDir: string,
  logger: AppLogger,
  only: AudienceCategory | null = null,
): Promise<void> {
  const manual = join(workbookDir, MANUAL_TRENDS_XLSX);
  const failed =
    (failure: string) =>
    (err: unknown): void =>
      logger.warn('TREND_WORKBOOK_WRITE_FAILED', `${MANUAL_TRENDS_XLSX} ${failure}: ${errorText(err)}`, { stage: STAGE, error_code: errorCodeOf(err) });
  const writeTemplate = (failure: string): Promise<void> => writeFileAtomic(manual, buildXlsx(manualTemplateSheets())).catch(failed(failure));
  if (!existsSync(manual)) {
    await createFileExclusive(manual, buildXlsx(manualTemplateSheets())).then(() => undefined, failed('を作れませんでした'));
  } else {
    // A file that cannot be read now is left alone (TrendFeed reports it); one the owner wrote anything in is never written.
    const wb = await readWorkbook(manual).catch(() => null);
    if (wb !== null && isUntouchedOldTemplate(wb)) {
      await writeTemplate('をシート「メンズ」「レディース」の形にできませんでした（次の起動でもう一度試します）');
    }
  }
  const weeks = await readTrendHistory(cacheDir);
  let recorded = false;
  for (const audience of AUDIENCE_CATEGORIES) {
    const state = states[audience];
    const entry = state === null ? null : entryOf(state, audience);
    if (state === null || entry === null || weeks.some((w) => w.week_of === entry.week_of && audienceOf(w) === audience)) continue;
    await recordWebTrends(state, audience, cacheDir, workbookDir, logger, only);
    recorded = true;
  }
  if (recorded || weeks.length === 0) return;
  const listTime = await mtimeOf(join(workbookDir, trendListFile(only)));
  const historyTime = await mtimeOf(join(cacheDir, TREND_HISTORY_FILE));
  if (listTime === null || (historyTime !== null && historyTime > listTime)) await writeTrendList(workbookDir, weeks, logger, only);
}

// ---------------------------------------------------------------- manual words

/** Column A from row 2 down: NFKC + trim, no empty or duplicate, at most 100 words of 30 characters. */
function sheetWords(sheet: WorkbookSheet | undefined): string[] {
  const out: string[] = [];
  for (const [row, cells] of sheet?.rows ?? []) {
    const word = (cells.get('A') ?? '').normalize('NFKC').trim();
    if (row < 2 || word === '' || [...word].length > MAX_MANUAL_CHARS || out.includes(word)) continue;
    out.push(word);
    if (out.length === MAX_MANUAL_WORDS) break;
  }
  return out;
}

/**
 * The hand-kept words per audience: sheet メンズ and sheet レディース. A workbook with neither (the old layout) holds
 * mens words only, from sheet 手動のトレンド語 or else the first sheet.
 */
export function manualTrendWords(wb: Workbook): Record<AudienceCategory, string[]> {
  const sheet = (a: AudienceCategory): WorkbookSheet | undefined => wb.sheets.find((s) => s.name === AUDIENCE_JA[a]);
  if (!hasAudienceSheets(wb)) return { mens: sheetWords(wb.sheets.find((s) => s.name === OLD_MANUAL_SHEET) ?? wb.sheets[0]), ladies: [] };
  return { mens: sheetWords(sheet('mens')), ladies: sheetWords(sheet('ladies')) };
}

/**
 * The status line, e.g. 「手動のトレンド語: メンズ 3語・レディース 0語（トレンド語\手動のトレンド語.xlsx）」; null: the file
 * could not be read. `handled` (settings.audiences): the sheets this copy reads; both when omitted.
 */
export function manualTrendsStatusLine(words: Record<AudienceCategory, readonly string[]> | null, handled: readonly AudienceCategory[] = AUDIENCE_CATEGORIES): string {
  const where = shownPath(MANUAL_TRENDS_XLSX);
  const sheets = handled.map((a) => `「${AUDIENCE_JA[a]}」`).join('');
  if (words === null) return `手動のトレンド語: 読み取れません（${where} を保存して閉じてください）`;
  if (handled.every((a) => words[a].length === 0)) return `手動のトレンド語: まだありません（${where} のシート${sheets}に書けます）`;
  return `手動のトレンド語: ${handled.map((a) => `${AUDIENCE_JA[a]} ${words[a].length}語`).join('・')}（${where}）`;
}

/** 「（一覧: トレンド語\トレンド語一覧.xlsx）」 (trendListFile of `only`) when the list exists, else ''. */
export const trendListNote = (workbookDir: string, only: AudienceCategory | null = null): string =>
  existsSync(join(workbookDir, trendListFile(only))) ? `（一覧: ${shownPath(trendListFile(only))}）` : '';
