import { jstIsoWeekday } from '../shared/time.js';

// Parsers for the two Google Trends CSV layouts the manual import supports (spec 8.4). A file that does not match the
// declared layout is refused with the line that broke it; nothing is guessed. Messages are Japanese and name the
// line only: the caller adds the file name.

export class TrendCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrendCsvError';
  }
}

export interface CsvRow {
  /** 1-based line where the record starts. */
  line: number;
  cells: string[];
}

const nfkc = (s: string): string => s.normalize('NFKC').trim();

/**
 * A short, single-line excerpt of file content for a message: invisible format and private-use characters are removed;
 * control characters, line breaks (including U+2028 / U+2029) and tabs become one space; 30 characters at most.
 */
export function excerpt(s: string): string {
  const flat = s.replace(/[\p{Cf}\p{Co}]+/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return [...flat].length > 30 ? `${[...flat].slice(0, 30).join('')}…` : flat;
}

const RESAVE_HINT = 'Excel などで保存し直すときは「CSV UTF-8（コンマ区切り）」を選んでください';

/** Decodes the file as UTF-8 (a leading BOM is dropped). UTF-16 and other encodings are refused, not mangled. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new TrendCsvError(`UTF-16 で保存されているため読み取れません。${RESAVE_HINT}。`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TrendCsvError(`UTF-8 として読み取れません（文字コードが Shift_JIS などの可能性があります）。${RESAVE_HINT}。`);
  }
}

/** RFC 4180 style: quoted cells may hold commas, quotes ("") and line breaks; LF, CRLF and CR all end a record. */
export function parseCsv(text: string): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let line = 1;
  let rowLine = 1;
  let rowOpen = false;
  let i = 0;

  const endRow = (): void => {
    cells.push(field);
    rows.push({ line: rowLine, cells });
    cells = [];
    field = '';
    rowOpen = false;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (!rowOpen) {
      rowOpen = true;
      rowLine = line;
    }
    if (ch === '"' && field === '') {
      const openedAt = line;
      let closed = false;
      i++;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        if (c === '\r' || c === '\n') {
          line++;
          field += '\n';
          i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
          continue;
        }
        field += c;
        i++;
      }
      if (!closed) throw new TrendCsvError(`行${openedAt}: 引用符（"）が閉じていません`);
      const next = src[i];
      if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
        throw new TrendCsvError(`行${openedAt}: 引用符で囲んだ値の後ろに余計な文字があります`);
      }
    } else if (ch === ',') {
      cells.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line++;
    } else {
      field += ch;
      i++;
    }
  }
  if (rowOpen) endRow();
  return rows;
}

// ---------------------------------------------------------------- shared row helpers

/** Cells without the empty ones Excel appends to every row. */
function trimmedCells(row: CsvRow): string[] {
  const cells = [...row.cells];
  while (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells;
}

// The only text allowed before the layout proper: blank lines and Google's category line.
const CATEGORY_LINE = /^(?:カテゴリ|カテゴリー|category)\s*[:：]\s*\S/iu;

function firstContentRow(rows: readonly CsvRow[]): number {
  let i = 0;
  while (i < rows.length) {
    const cells = trimmedCells(rows[i]!);
    if (cells.length === 0 || (cells.length === 1 && CATEGORY_LINE.test(nfkc(cells[0]!)))) i++;
    else break;
  }
  return i;
}

const SECTION_NAMES: Record<string, 'top' | 'rising'> = { トップ: 'top', top: 'top', 注目: 'rising', 急上昇: 'rising', rising: 'rising' };
const sectionOf = (cell: string): 'top' | 'rising' | undefined => SECTION_NAMES[nfkc(cell).toLowerCase()];

type Unit = 'week' | 'day' | 'month';
const UNIT_NAMES: Record<string, Unit> = { 週: 'week', week: 'week', 日: 'day', day: 'day', 月: 'month', month: 'month' };
const unitOf = (cell: string): Unit | undefined => UNIT_NAMES[nfkc(cell).toLowerCase()];

const UNITS_HINT = '週・日・月（Week・Day・Month）の単位で書き出したファイルだけ取り込めます';

// ---------------------------------------------------------------- interest_over_time

export interface InterestTerm {
  term: string;
  /** One entry per data row: 0-100, 0 for "<1", null for an empty cell. */
  values: (number | null)[];
  /** How many "<1" cells were read as 0. */
  below_one: number;
}

export interface InterestOverTime {
  /** Line of the header row (where the searched terms are). */
  header_line: number;
  unit: Unit;
  first_key: string;
  last_key: string;
  points: number;
  terms: InterestTerm[];
}

// Google appends the region to every search term: "ヘアカラー: (日本)" / "hair color: (Japan)".
const REGION_SUFFIX = /\s*[:：]\s*[(（][^)）]*[)）]\s*$/u;

function validDateKey(key: string): boolean {
  try {
    jstIsoWeekday(key);
    return true;
  } catch {
    return false;
  }
}

function parseInterestValue(raw: string, term: string, line: number): { value: number | null; belowOne: boolean } {
  const v = nfkc(raw);
  if (v === '') return { value: null, belowOne: false };
  if (v === '<1') return { value: 0, belowOne: true };
  if (/^\d{1,3}$/.test(v) && Number(v) <= 100) return { value: Number(v), belowOne: false };
  throw new TrendCsvError(`行${line}: 「${excerpt(term)}」の値「${excerpt(raw)}」は 0〜100 の整数か「<1」ではありません`);
}

/**
 * Google Trends "interest over time": optional category line, then a header whose first cell is 週/日/月 (Week/Day/Month)
 * and whose other cells are the searched terms (region suffix removed), then one row per period.
 */
export function parseInterestOverTime(rows: readonly CsvRow[]): InterestOverTime {
  const headerAt = firstContentRow(rows);
  const headerRow = rows[headerAt];
  if (headerRow === undefined) throw new TrendCsvError('ファイルが空です（時系列の見出し行がありません）');
  const headerCells = trimmedCells(headerRow);
  const first = headerCells[0]!;
  const unit = unitOf(first);
  if (unit === undefined) {
    if (sectionOf(first) !== undefined) {
      throw new TrendCsvError(`行${headerRow.line}: 関連クエリ（トップ／注目）の形式のファイルです。data_kind を related_queries にして取り込んでください`);
    }
    if (/^(?:time|datetime|hour|時間|時刻)/iu.test(nfkc(first))) {
      throw new TrendCsvError(`行${headerRow.line}: 時間単位のデータには対応していません。${UNITS_HINT}`);
    }
    throw new TrendCsvError(
      `行${headerRow.line}: 時系列の見出し行（最初の列が「週」「日」「月」または Week / Day / Month）が見つかりません（見つかった内容: 「${excerpt(first)}」）。${UNITS_HINT}`,
    );
  }
  if (headerCells.length < 2) throw new TrendCsvError(`行${headerRow.line}: 見出し行に検索した語の列がありません`);

  const terms: string[] = [];
  const seen = new Set<string>();
  headerCells.slice(1).forEach((cell, j) => {
    const term = cell.trim().replace(REGION_SUFFIX, '').trim();
    if (term === '') throw new TrendCsvError(`行${headerRow.line}: 見出し行の${j + 2}列目の語が空です`);
    const key = nfkc(term).toLowerCase();
    if (seen.has(key)) throw new TrendCsvError(`行${headerRow.line}: 同じ語「${excerpt(term)}」の列が2つあります`);
    seen.add(key);
    terms.push(term);
  });

  const keyPattern = unit === 'month' ? /^\d{4}-(?:0[1-9]|1[0-2])$/ : /^\d{4}-\d{2}-\d{2}$/;
  const columns: InterestTerm[] = terms.map((term) => ({ term, values: [], below_one: 0 }));
  const keys: string[] = [];
  let ended = false;
  for (const row of rows.slice(headerAt + 1)) {
    const cells = trimmedCells(row);
    if (cells.length === 0) {
      ended = true;
      continue;
    }
    if (ended) throw new TrendCsvError(`行${row.line}: 時系列のデータの後ろに別の内容があります`);
    const key = nfkc(cells[0]!);
    if (!keyPattern.test(key) || (unit !== 'month' && !validDateKey(key))) {
      throw new TrendCsvError(`行${row.line}: 日付「${excerpt(cells[0]!)}」が${unit === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'} の形式の実在する日付ではありません`);
    }
    if (cells.length - 1 > terms.length) {
      throw new TrendCsvError(`行${row.line}: 見出しの語（${terms.length}個）より多い列があります`);
    }
    columns.forEach((col, j) => {
      const { value, belowOne } = parseInterestValue(cells[j + 1] ?? '', col.term, row.line);
      col.values.push(value);
      if (belowOne) col.below_one++;
    });
    keys.push(key);
  }
  if (keys.length === 0) throw new TrendCsvError(`行${headerRow.line}: 見出し行の後ろにデータ行がありません`);
  return { header_line: headerRow.line, unit, first_key: keys[0]!, last_key: keys[keys.length - 1]!, points: keys.length, terms: columns };
}

// ---------------------------------------------------------------- related_queries

export type RelatedValue = { kind: 'index'; value: number } | { kind: 'percent'; value: number } | { kind: 'breakout' };

export interface RelatedQueryRow {
  section: 'top' | 'rising';
  query: string;
  value: RelatedValue;
  line: number;
}

const QUERY_HEADERS = new Set(['query', 'queries', 'クエリ', '関連クエリ', '検索キーワード', 'キーワード']);
const VALUE_HEADERS = new Set(['value', '値', '人気度', '増加率', '上昇率']);

function parseRelatedValue(section: 'top' | 'rising', raw: string): RelatedValue | null {
  const v = nfkc(raw);
  if (section === 'top') return /^\d{1,3}$/.test(v) && Number(v) <= 100 ? { kind: 'index', value: Number(v) } : null;
  if (/^(?:breakout|ブレイクアウト)$/iu.test(v)) return { kind: 'breakout' };
  const m = /^\+?\s*(\d{1,3}(?:,\d{3})+|\d{1,9})\s*%$/.exec(v);
  return m ? { kind: 'percent', value: Number(m[1]!.replaceAll(',', '')) } : null;
}

/**
 * Google Trends "related queries": a TOP (トップ) and/or RISING (注目) section, each followed by `query,value` rows.
 * TOP values are 0-100; RISING values are `+250%` or Breakout (ブレイクアウト).
 */
export function parseRelatedQueries(rows: readonly CsvRow[]): RelatedQueryRow[] {
  const start = firstContentRow(rows);
  if (start >= rows.length) throw new TrendCsvError('ファイルが空です（トップ／注目の区分がありません）');

  const out: RelatedQueryRow[] = [];
  const seenSections = new Set<'top' | 'rising'>();
  let section: 'top' | 'rising' | null = null;
  let sectionOpen = false;
  let expectHeader = false;

  for (const row of rows.slice(start)) {
    const cells = trimmedCells(row);
    if (cells.length === 0) {
      sectionOpen = false;
      continue;
    }
    const heading = cells.length === 1 ? sectionOf(cells[0]!) : undefined;
    if (heading !== undefined) {
      if (seenSections.has(heading)) throw new TrendCsvError(`行${row.line}: 「${excerpt(cells[0]!)}」の区分が2回あります`);
      seenSections.add(heading);
      section = heading;
      sectionOpen = true;
      expectHeader = true;
      continue;
    }
    if (section === null) {
      if (unitOf(cells[0]!) !== undefined) {
        throw new TrendCsvError(`行${row.line}: 時系列（週・日・月ごとの関心度）の形式のファイルです。data_kind を interest_over_time にして取り込んでください`);
      }
      throw new TrendCsvError(
        `行${row.line}: 関連クエリの区分名の行（トップ／注目、または TOP／RISING）が見つかりません（見つかった内容: 「${excerpt(cells[0]!)}」）`,
      );
    }
    if (!sectionOpen) throw new TrendCsvError(`行${row.line}: 区分名の行が無いまま、データが続いています`);
    if (cells.length !== 2) throw new TrendCsvError(`行${row.line}: 「語, 値」の2列ではありません（${cells.length}列）`);

    const [query, rawValue] = [cells[0]!.trim(), cells[1]!];
    const value = parseRelatedValue(section, rawValue);
    if (expectHeader) {
      expectHeader = false;
      if (value === null && QUERY_HEADERS.has(nfkc(query).toLowerCase()) && VALUE_HEADERS.has(nfkc(rawValue).toLowerCase())) continue;
    }
    if (value === null) {
      const expected = section === 'top' ? '0〜100 の整数' : '「+250%」の形かブレイクアウト（Breakout）';
      throw new TrendCsvError(`行${row.line}: 値「${excerpt(rawValue)}」は${section === 'top' ? 'トップ' : '注目'}の値（${expected}）ではありません`);
    }
    out.push({ section, query, value, line: row.line });
  }
  if (out.length === 0) throw new TrendCsvError('トップ／注目の区分の下にデータ行がありません');
  return out;
}
