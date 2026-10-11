import { readFile, stat } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { systemClock, type Clock } from '../../shared/clock.js';
import { AppFailure, appError } from '../../shared/errors.js';
import { errnoCode, withTransientRetry } from '../../storage/atomic-json.js';
import { ExtractBudget, extractZipEntry, listZipEntries, XlsxFormatError, type ZipEntry, type ZipLimits } from './zip.js';

// Read-only OOXML (.xlsx) reader (plan decision 5): cell text only. Formulas are never evaluated (the cached <v> is
// used as written), external links / drawings / media / macros are never opened, and the file is only read.

export interface WorkbookSheet {
  name: string;
  /** Row number → column letters → text. Only non-empty values; inside a merged range only the top-left cell has one. */
  rows: Map<number, Map<string, string>>;
  /** Merged ranges, normalised to top-left → bottom-right. */
  merges: Array<{ from: string; to: string }>;
}

export interface Workbook {
  /** Worksheets in workbook order (chart and dialog sheets have no cells and are left out). */
  sheets: WorkbookSheet[];
}

export interface XlsxLimits extends ZipLimits {
  /** Largest workbook file read at all. */
  maxFileBytes: number;
}

const MIB = 1024 * 1024;
export const XLSX_LIMITS: Readonly<XlsxLimits> = Object.freeze({
  maxFileBytes: 200 * MIB,
  maxEntryBytes: 50 * MIB,
  maxTotalBytes: 200 * MIB,
  maxEntries: 10_000,
});

export interface XlsxReadOptions {
  limits?: Partial<XlsxLimits>;
  clock?: Clock;
}

const MAX_ROW = 1_048_576;
const MAX_COL = 16_384;
// Bounds the work spent clearing values inside merged ranges.
const MAX_MERGE_VISITS = 5_000_000;
const STAGE = 'templates';

// ---------------------------------------------------------------- cell references

/** 'A' → 1, 'XFD' → 16384; undefined for anything else. */
export function columnIndex(letters: string): number | undefined {
  if (!/^[A-Z]{1,3}$/.test(letters)) return undefined;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_COL ? n : undefined;
}

/** 1 → 'A', 16384 → 'XFD'. */
export function columnLetters(index: number): string {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 'B12' → { col: 2, row: 12 }; '$' markers are accepted; undefined when out of the sheet. */
export function parseCellRef(ref: string): { col: number; row: number } | undefined {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref.trim().toUpperCase());
  if (!m) return undefined;
  const col = columnIndex(m[1]!);
  const row = Number(m[2]);
  return col !== undefined && row >= 1 && row <= MAX_ROW ? { col, row } : undefined;
}

// ---------------------------------------------------------------- XML helpers (fast-xml-parser, preserveOrder)

type XNode = Record<string, unknown>;
const ATTRS = ':@';
const TEXT = '#text';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Entities are decoded below (predefined + numeric only); DOCTYPE is refused before parsing, so nothing expands.
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g, (whole, name?: string, dec?: string, hex?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

// ST_Xstring escapes characters XML cannot carry as _xHHHH_ (and a literal "_x" as _x005F_x).
function unescapeOoxml(s: string): string {
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : s;
}

function tagOf(n: XNode): string | undefined {
  for (const key of Object.keys(n)) if (key !== ATTRS) return key;
  return undefined;
}

function childrenOf(n: XNode): XNode[] {
  const tag = tagOf(n);
  const value = tag === undefined ? undefined : n[tag];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

const elements = (nodes: XNode[], tag: string): XNode[] => nodes.filter((n) => tagOf(n) === tag);
const firstElement = (nodes: XNode[], tag: string): XNode | undefined => nodes.find((n) => tagOf(n) === tag);

function attr(n: XNode, name: string): string | undefined {
  const attrs = n[ATTRS];
  if (typeof attrs !== 'object' || attrs === null) return undefined;
  const value = (attrs as Record<string, unknown>)[name];
  return typeof value === 'string' ? decodeXml(value) : undefined;
}

function textOf(n: XNode): string {
  let s = '';
  for (const child of childrenOf(n)) {
    if (tagOf(child) === TEXT) s += String(child[TEXT]);
  }
  return decodeXml(s);
}

// <si> / <is>: plain <t>, or rich-text runs <r><t>; phonetic readings (<rPh>) are not part of the value.
function richText(n: XNode): string {
  let s = '';
  for (const child of childrenOf(n)) {
    const tag = tagOf(child);
    if (tag === 't') s += textOf(child);
    else if (tag === 'r') for (const t of elements(childrenOf(child), 't')) s += textOf(t);
  }
  return unescapeOoxml(s);
}

function decodePart(bytes: Uint8Array, part: string): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new XlsxFormatError(`文字コードを読み取れません: ${part}`, { part });
  }
}

function parseXml(bytes: Uint8Array, part: string, rootTag: string): XNode {
  const text = decodePart(bytes, part);
  if (/<!DOCTYPE/i.test(text)) throw new XlsxFormatError(`XMLに DOCTYPE 宣言があるため読み取りません: ${part}`, { part });
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new XlsxFormatError(`XMLが壊れています: ${part}（${valid.err.line}行目）`, { part, line: valid.err.line });
  let nodes: unknown;
  try {
    nodes = parser.parse(text);
  } catch {
    throw new XlsxFormatError(`XMLを読み取れません: ${part}`, { part });
  }
  const root = Array.isArray(nodes) ? (nodes as XNode[]).find((n) => tagOf(n) === rootTag) : undefined;
  if (!root) throw new XlsxFormatError(`${part} の形式が想定と異なります（${rootTag} がありません）`, { part });
  return root;
}

// ---------------------------------------------------------------- package

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

class Package {
  readonly #bytes: Uint8Array;
  readonly #entries = new Map<string, ZipEntry>();
  readonly #budget: ExtractBudget;

  constructor(bytes: Uint8Array, limits: XlsxLimits) {
    this.#bytes = bytes;
    for (const entry of listZipEntries(bytes, limits)) this.#entries.set(entry.name.toLowerCase(), entry);
    this.#budget = new ExtractBudget(limits);
  }

  // OPC part names compare case-insensitively.
  has(part: string): boolean {
    return this.#entries.has(part.toLowerCase());
  }

  xml(part: string, rootTag: string): XNode {
    const entry = this.#entries.get(part.toLowerCase());
    if (!entry) throw new XlsxFormatError(`ブック内の部品がありません: ${part}`, { part });
    return parseXml(extractZipEntry(this.#bytes, entry, this.#budget), part, rootTag);
  }

  relationships(sourcePart: string): Relationship[] {
    const slash = sourcePart.lastIndexOf('/');
    const relsPart = `${sourcePart.slice(0, slash + 1)}_rels/${sourcePart.slice(slash + 1)}.rels`;
    if (!this.has(relsPart)) return [];
    return elements(childrenOf(this.xml(relsPart, 'Relationships')), 'Relationship').map((rel) => {
      const external = attr(rel, 'TargetMode') === 'External';
      const target = attr(rel, 'Target') ?? '';
      return {
        id: attr(rel, 'Id') ?? '',
        type: attr(rel, 'Type') ?? '',
        // External targets are kept unresolved and never opened.
        target: external ? target : resolveTarget(sourcePart, target),
        external,
      };
    });
  }
}

// A relationship target is relative to the source part's folder, or absolute from the package root.
function resolveTarget(sourcePart: string, target: string): string {
  let t = target.replace(/\\/g, '/');
  try {
    t = decodeURIComponent(t);
  } catch {
    // Not percent-encoded; use as written.
  }
  const segments = t.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const segment of t.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new XlsxFormatError(`ブックの外を参照しています: ${target}`, { target });
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

// ---------------------------------------------------------------- workbook

function cellValue(c: XNode, sst: readonly string[], where: string): string | undefined {
  const type = attr(c, 't') ?? 'n';
  const kids = childrenOf(c);
  if (type === 'inlineStr') {
    const is = firstElement(kids, 'is');
    return is ? richText(is) : undefined;
  }
  const v = firstElement(kids, 'v');
  // No cached value: an empty styled cell or a formula Excel never calculated. Never evaluated here.
  if (!v) return undefined;
  const raw = textOf(v);
  switch (type) {
    case 's': {
      const s = /^\s*\d+\s*$/.test(raw) ? sst[Number(raw)] : undefined;
      if (s === undefined) throw new XlsxFormatError(`共有文字列の番号が不正です: ${where}`, { cell: where });
      return s;
    }
    case 'str':
      return unescapeOoxml(raw);
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'e':
      return undefined; // #N/A, #REF! ... are not text
    default:
      return raw; // numbers and dates: the cached text exactly as stored
  }
}

interface Range {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function parseRange(ref: string, where: string): Range {
  const [a, b = a] = ref.split(':');
  const from = a === undefined ? undefined : parseCellRef(a);
  const to = b === undefined ? undefined : parseCellRef(b);
  if (!from || !to) throw new XlsxFormatError(`結合セルの範囲が不正です: ${where} ${ref}`, { range: ref });
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.col, to.col),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.col, to.col),
  };
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function parseWorksheet(root: XNode, name: string, sst: readonly string[]): WorkbookSheet {
  const cells = new Map<number, Map<number, string>>();
  const sheetData = firstElement(childrenOf(root), 'sheetData');
  let previousRow = 0;
  for (const rowEl of sheetData ? elements(childrenOf(sheetData), 'row') : []) {
    const r = attr(rowEl, 'r');
    const rowNo = r === undefined ? previousRow + 1 : Number(r);
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > MAX_ROW) throw new XlsxFormatError(`行番号が不正です: ${name} ${r ?? ''}`, { sheet: name });
    previousRow = rowNo;
    let previousCol = 0;
    for (const c of elements(childrenOf(rowEl), 'c')) {
      const ref = attr(c, 'r');
      const pos = ref === undefined ? { col: previousCol + 1, row: rowNo } : parseCellRef(ref);
      if (!pos || pos.col > MAX_COL) throw new XlsxFormatError(`セル番地が不正です: ${name} ${ref ?? ''}`, { sheet: name });
      previousCol = pos.col;
      const value = cellValue(c, sst, `${name} ${columnLetters(pos.col)}${pos.row}`);
      if (value === undefined || value === '') continue;
      let line = cells.get(pos.row);
      if (!line) cells.set(pos.row, (line = new Map()));
      line.set(pos.col, value);
    }
  }

  const ranges: Range[] = [];
  const mergeCells = firstElement(childrenOf(root), 'mergeCells');
  for (const m of mergeCells ? elements(childrenOf(mergeCells), 'mergeCell') : []) ranges.push(parseRange(attr(m, 'ref') ?? '', name));

  // Excel keeps a merged range's value in its top-left cell; anything stored elsewhere in the range is not shown.
  const rowNumbers = [...cells.keys()].sort((a, b) => a - b);
  let visits = 0;
  for (const range of ranges) {
    for (let i = lowerBound(rowNumbers, range.top); i < rowNumbers.length && rowNumbers[i]! <= range.bottom; i++) {
      if (++visits > MAX_MERGE_VISITS) throw new XlsxFormatError(`結合セルが多すぎます: ${name}`, { sheet: name });
      const rowNo = rowNumbers[i]!;
      const line = cells.get(rowNo)!;
      for (const col of [...line.keys()]) {
        if (col >= range.left && col <= range.right && !(rowNo === range.top && col === range.left)) line.delete(col);
      }
    }
  }

  const rows = new Map<number, Map<string, string>>();
  for (const rowNo of rowNumbers) {
    const line = cells.get(rowNo)!;
    if (line.size === 0) continue;
    rows.set(rowNo, new Map([...line].sort((a, b) => a[0] - b[0]).map(([col, v]) => [columnLetters(col), v])));
  }
  const merges = ranges.map((r) => ({ from: `${columnLetters(r.left)}${r.top}`, to: `${columnLetters(r.right)}${r.bottom}` }));
  return { name, rows, merges };
}

const endsWithType = (rel: Relationship, type: string): boolean => rel.type.endsWith(`/${type}`);

function parsePackage(bytes: Uint8Array, limits: XlsxLimits): Workbook {
  const pkg = new Package(bytes, limits);

  // The package relationships name the workbook part; xl/workbook.xml is the usual place.
  const office = pkg.relationships('').find((rel) => !rel.external && endsWithType(rel, 'officeDocument'));
  const workbookPart = office?.target ?? 'xl/workbook.xml';
  if (!pkg.has(workbookPart)) {
    throw new XlsxFormatError(`workbook.xml がありません（Excelのファイルではない可能性があります）: ${workbookPart}`, { part: workbookPart });
  }
  const workbook = pkg.xml(workbookPart, 'workbook');
  const rels = pkg.relationships(workbookPart);
  const byId = new Map(rels.map((rel) => [rel.id, rel]));

  const sstRel = rels.find((rel) => !rel.external && endsWithType(rel, 'sharedStrings'));
  const sst = sstRel && pkg.has(sstRel.target) ? elements(childrenOf(pkg.xml(sstRel.target, 'sst')), 'si').map(richText) : [];

  const sheets: WorkbookSheet[] = [];
  const names = new Set<string>();
  const sheetsEl = firstElement(childrenOf(workbook), 'sheets');
  for (const sheetEl of sheetsEl ? elements(childrenOf(sheetsEl), 'sheet') : []) {
    const name = attr(sheetEl, 'name');
    if (name === undefined || name === '') throw new XlsxFormatError('名前の無いシートがあります', { part: workbookPart });
    if (names.has(name)) throw new XlsxFormatError(`同じ名前のシートが複数あります: ${name}`, { sheet: name });
    names.add(name);
    // r:id loses its prefix (removeNSPrefix).
    const rel = byId.get(attr(sheetEl, 'id') ?? '');
    if (!rel) throw new XlsxFormatError(`シート「${name}」の参照先がありません`, { sheet: name });
    if (rel.external) throw new XlsxFormatError(`シート「${name}」がブックの外を参照しています`, { sheet: name });
    if (!endsWithType(rel, 'worksheet')) continue;
    if (!pkg.has(rel.target)) throw new XlsxFormatError(`シート「${name}」の部品がありません: ${rel.target}`, { sheet: name, part: rel.target });
    sheets.push(parseWorksheet(pkg.xml(rel.target, 'worksheet'), name, sst));
  }
  return { sheets };
}

// ---------------------------------------------------------------- public API

const limitsOf = (opts: XlsxReadOptions): XlsxLimits => ({ ...XLSX_LIMITS, ...opts.limits });

function parseFailure(clock: Clock, reason: string, details: Record<string, unknown>, path?: string): AppFailure {
  const where = path === undefined ? '' : `（${path}）`;
  return new AppFailure(
    appError('TEMPLATE_PARSE_ERROR', STAGE, clock, {
      message: `テンプレートのExcelファイルを読み取れません: ${reason}${where}`,
      details: { ...details, reason, ...(path === undefined ? {} : { path }) },
    }),
  );
}

function parseWith(bytes: Uint8Array, opts: XlsxReadOptions, path?: string): Workbook {
  try {
    return parsePackage(bytes, limitsOf(opts));
  } catch (err) {
    if (err instanceof XlsxFormatError) throw parseFailure(opts.clock ?? systemClock, err.message, err.details, path);
    throw err;
  }
}

/**
 * Parses workbook bytes already in memory. Anything unreadable → AppFailure TEMPLATE_PARSE_ERROR
 * (naming `opts.path` when given).
 */
export function parseWorkbook(bytes: Uint8Array, opts: XlsxReadOptions & { path?: string } = {}): Workbook {
  return parseWith(bytes, opts, opts.path);
}

/** TEMPLATE_MISSING for a workbook file that cannot be opened or read (errno in the details). */
export function workbookReadFailure(path: string, err: unknown, clock: Clock = systemClock): AppFailure {
  const code = errnoCode(err);
  const message =
    code === 'ENOENT' || code === 'ENOTDIR'
      ? `テンプレートのExcelファイルが見つかりません: ${path}`
      : `テンプレートのExcelファイルを読み込めません（${code ?? (err instanceof Error ? err.message : String(err))}）: ${path}`;
  return new AppFailure(appError('TEMPLATE_MISSING', STAGE, clock, { message, details: { path, errno: code ?? null } }));
}

const sizeText = (bytes: number): string => `${Math.round((bytes / MIB) * 10) / 10} MB`;

/** Checks that `path` is a regular file within maxFileBytes; returns its size. Failures as for readWorkbookBytes. */
export async function checkWorkbookFile(path: string, opts: XlsxReadOptions = {}): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const limits = limitsOf(opts);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await withTransientRetry(() => stat(path));
  } catch (err) {
    throw workbookReadFailure(path, err, clock);
  }
  if (!info.isFile()) {
    throw new AppFailure(appError('TEMPLATE_MISSING', STAGE, clock, { message: `テンプレートのExcelファイルの場所がファイルではありません: ${path}`, details: { path } }));
  }
  if (info.size > limits.maxFileBytes) {
    throw parseFailure(clock, `ファイルが大きすぎます（${sizeText(info.size)}、上限 ${sizeText(limits.maxFileBytes)}）`, { size: info.size }, path);
  }
  return info.size;
}

/**
 * Reads the whole file once (no lock is kept) without ever writing to it.
 * Missing / not a file / unreadable → TEMPLATE_MISSING; larger than maxFileBytes → TEMPLATE_PARSE_ERROR.
 */
export async function readWorkbookBytes(path: string, opts: XlsxReadOptions = {}): Promise<Uint8Array> {
  const clock = opts.clock ?? systemClock;
  const limits = limitsOf(opts);
  await checkWorkbookFile(path, opts);
  let bytes: Buffer;
  try {
    bytes = await withTransientRetry(() => readFile(path));
  } catch (err) {
    throw workbookReadFailure(path, err, clock);
  }
  // The file may have grown since the check.
  if (bytes.length > limits.maxFileBytes) {
    throw parseFailure(clock, `ファイルが大きすぎます（${sizeText(bytes.length)}、上限 ${sizeText(limits.maxFileBytes)}）`, { size: bytes.length }, path);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Reads and parses a workbook file (read-only). See readWorkbookBytes / parseWorkbook for the failures. */
export async function readWorkbook(path: string, opts: XlsxReadOptions = {}): Promise<Workbook> {
  return parseWith(await readWorkbookBytes(path, opts), opts, path);
}
