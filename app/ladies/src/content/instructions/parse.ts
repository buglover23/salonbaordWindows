import type { RouteKey } from '../../config/readiness.js';
import { sha256Hex } from '../../shared/hash.js';
import { jstIsoWeekday } from '../../shared/time.js';
import type { AudienceCategory, PostType } from '../../shared/types.js';

// Deterministic grammar for the files in instructions/ (spec 5.10-5.11, plan decision 7). Nothing is guessed from free
// text: a line is either one of the forms below or reported as ignored content.

export const INSTRUCTION_SECTIONS = ['営業時間', '投稿時間', '検索ワード', '除外検索ワード', '文章方針', '投稿先URL'] as const;
export type InstructionSection = (typeof INSTRUCTION_SECTIONS)[number];

/** Warning code for lines that are not used (not an ErrorCode: the file still applies). */
export const IGNORED_CONTENT_CODE = 'INSTRUCTION_IGNORED_CONTENT';
/** The record file's saved last valid contents could not be used (store.ts). */
export const CACHE_IGNORED_CODE = 'INSTRUCTION_CACHE_IGNORED';
/**
 * Warning code (not an ErrorCode: the item applies): an instruction's hours or post window leave too little time for the
 * configured counts, so that weekday gets fewer posts (Ruling P2-R11, effective-config.ts).
 */
export const CAPACITY_REDUCED_CODE = 'INSTRUCTION_CAPACITY_REDUCED';
export type InstructionIssueCode =
  | 'INSTRUCTION_INVALID'
  | 'INSTRUCTION_CONFLICT'
  | typeof IGNORED_CONTENT_CODE
  | typeof CACHE_IGNORED_CODE
  | typeof CAPACITY_REDUCED_CODE;

export interface InstructionIssue {
  code: InstructionIssueCode;
  /** File name inside instructions/ ('' for problems with the folder itself). */
  file: string;
  /** 1-based line in the original file; null when the issue is about the file as a whole. */
  line: number | null;
  /** The setting concerned, e.g. 'business_hours.2', 'keywords.style.mens', 'routes.blog.ladies'; null when general. */
  item: string | null;
  /** Japanese, names the file and line and says how to fix it. */
  message: string;
  /** Japanese, what is in effect meanwhile (e.g. 「前回の正しい内容で動作中」); null for ignored-content warnings. */
  note: string | null;
  /** For conflicts and combined capacity shortages: the other files involved. */
  related_files: string[];
  /**
   * Set when the problem matters only from this future date (YYYY-MM-DD: a document that has not started yet); absent
   * when it concerns what applies now.
   */
  upcoming_from?: string;
}

export type ScopePostType = 'common' | PostType;
export type ScopeAudience = 'common' | AudienceCategory;
export interface InstructionScope {
  post_type: ScopePostType;
  audience: ScopeAudience;
}
/** Inclusive JST calendar dates (YYYY-MM-DD); null = no limit on that side. */
export interface InstructionPeriod {
  start: string | null;
  end: string | null;
}

export type WeekdayKey = '1' | '2' | '3' | '4' | '5' | '6' | '7';
export const WEEKDAY_KEYS: readonly WeekdayKey[] = ['1', '2', '3', '4', '5', '6', '7'];
export interface TimeRange {
  start: string;
  end: string;
}
export type KeywordOp = 'add' | 'replace' | 'delete';

export interface ParsedInstruction {
  file: string;
  sha256: string;
  state: 'enabled' | 'disabled';
  priority: number;
  scope: InstructionScope;
  period: InstructionPeriod;
  /** Line of each section heading present in the file. */
  sections: Partial<Record<InstructionSection, number>>;
  /** 全曜日 already expanded; an individual weekday line wins over it. [] = closed. */
  business_hours: Partial<Record<WeekdayKey, { ranges: TimeRange[]; line: number }>>;
  closed_dates: { date: string; line: number }[];
  post_window: { start: string; end: string; line: number } | null;
  /** null when the section is absent or names no word. `line` is the 操作 line. */
  keywords: { op: KeywordOp; words: string[]; line: number } | null;
  excluded_keywords: { word: string; line: number }[];
  writing_policies: { text: string; line: number }[];
  routes: Partial<Record<RouteKey, { url: string; line: number }>>;
  /** Lines that were not used (INSTRUCTION_IGNORED_CONTENT); empty for a disabled file. */
  ignored: InstructionIssue[];
}

export type ParseResult = ParsedInstruction | { invalid: InstructionIssue[] };

// ---------------------------------------------------------------- constants

type MetaField = 'state' | 'priority' | 'post_type' | 'audience' | 'start' | 'end';
// Maps, not object literals: a line such as "constructor: x" must not find an Object.prototype member.
const META_KEYS: ReadonlyMap<string, MetaField> = new Map([
  ['状態', 'state'],
  ['優先度', 'priority'],
  ['対象', 'post_type'],
  ['対象カテゴリー', 'audience'],
  // The long-vowel mark is often left out; reading it as unknown would silently widen the scope to 共通.
  ['対象カテゴリ', 'audience'],
  ['適用開始', 'start'],
  ['適用終了', 'end'],
]);

const POST_TYPE_VALUES: ReadonlyMap<string, ScopePostType> = new Map([
  ['共通', 'common'],
  ['スタイル', 'style'],
  ['ブログ', 'blog'],
]);
const AUDIENCE_VALUES: ReadonlyMap<string, ScopeAudience> = new Map([
  ['共通', 'common'],
  ['メンズ', 'mens'],
  ['レディース', 'ladies'],
]);

const WEEKDAY_NAMES: ReadonlyMap<string, WeekdayKey | 'all'> = new Map([
  ['全曜日', 'all'],
  ['月曜日', '1'],
  ['火曜日', '2'],
  ['水曜日', '3'],
  ['木曜日', '4'],
  ['金曜日', '5'],
  ['土曜日', '6'],
  ['日曜日', '7'],
  // Without the trailing 日, as often written.
  ['月曜', '1'],
  ['火曜', '2'],
  ['水曜', '3'],
  ['木曜', '4'],
  ['金曜', '5'],
  ['土曜', '6'],
  ['日曜', '7'],
]);
const CLOSED_DATES_KEY = '臨時休業';
const CLOSED_VALUE = '休業';

const KEYWORD_OPS: ReadonlyMap<string, KeywordOp> = new Map([
  ['追加', 'add'],
  ['置換', 'replace'],
  ['削除', 'delete'],
]);

export const ROUTE_LABELS: Readonly<Record<RouteKey, string>> = {
  'style.mens': 'スタイル・メンズ',
  'style.ladies': 'スタイル・レディース',
  'blog.mens': 'ブログ・メンズ',
  'blog.ladies': 'ブログ・レディース',
};
const ROUTE_BY_LABEL: ReadonlyMap<string, RouteKey> = new Map(Object.entries(ROUTE_LABELS).map(([key, label]) => [label, key as RouteKey]));

const SECTION_ITEM: Readonly<Record<InstructionSection, string>> = {
  営業時間: 'business_hours',
  投稿時間: 'post_window',
  検索ワード: 'keywords',
  除外検索ワード: 'excluded_keywords',
  文章方針: 'writing_policies',
  投稿先URL: 'routes',
};

/** Longest keyword, in code points. A longer bullet is almost always a sentence written in the wrong section. */
export const MAX_KEYWORD_LENGTH = 30;
/** Instruction files are short notes; anything larger is refused before reading (store.ts). */
export const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

// Writing policies are passed to the AI as reference data. Lines that try to change the system or state facts
// (prices, discounts) are not policies (spec 5.10: no command execution, key changes or Validator switches; no new
// facts about services or prices).
const SYSTEM_DIRECTIVE =
  /validator|バリデータ|バリデーター|検証|検査|api|トークン|token|パスワード|password|cookie|クッキー|コマンド|command|スクリプト|script|環境変数|\.env|設定ファイル|config|プロンプト|prompt|禁止語|ng語|ngワード|無視して|指示を無視|https?:/i;
const FACT_CLAIM = /\d[\d,.万千百]*\s*円|料金|価格|値段|割引|値引|クーポン|無料|\d\s*%\s*(?:off|オフ)/i;

// ---------------------------------------------------------------- helpers

/** Strict UTF-8 (an ANSI or UTF-16 file is reported, not mangled); a leading BOM is dropped. */
export function decodeInstructionBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'UTF-8として読み取れません（メモ帳などで文字コードを UTF-8 にして保存し直してください）' };
  }
}

/** Key used to compare and de-duplicate words: NFKC, whitespace collapsed, trimmed (spec 5.10). */
export function wordKey(word: string): string {
  return word.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function at(file: string, line: number | null): string {
  return line === null ? file : `${file} ${line}行目`;
}

function issue(code: InstructionIssueCode, file: string, line: number | null, item: string | null, message: string): InstructionIssue {
  return { code, file, line, item, message, note: null, related_files: [] };
}

/** A real calendar date written as YYYY-MM-DD. */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  try {
    jstIsoWeekday(s);
    return true;
  } catch {
    return false;
  }
}

/** H:mm or HH:mm within 00:00-23:59, normalised to HH:mm; null otherwise. */
function parseTime(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const splitList = (value: string): string[] => value.split(/\s*[,、]\s*/u).filter((part) => part !== '');

interface Line {
  no: number;
  text: string;
}

/**
 * Removes HTML comments and fenced code blocks, keeping every line (blanked) so line numbers stay those of the file.
 * Reports the first comment or fence that is never closed.
 */
function stripMarkup(rawLines: string[]): { lines: Line[]; unclosed: { kind: 'comment' | 'fence'; line: number } | null } {
  const lines: Line[] = [];
  let commentFrom: number | null = null;
  let fence: { char: string; len: number; line: number } | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const no = i + 1;
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      lines.push({ no, text: '' });
      continue;
    }
    if (commentFrom === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
      if (open) {
        fence = { char: open[1]![0]!, len: open[1]!.length, line: no };
        lines.push({ no, text: '' });
        continue;
      }
    }
    let kept = '';
    let rest = raw;
    while (rest !== '') {
      if (commentFrom !== null) {
        const end = rest.indexOf('-->');
        if (end < 0) break;
        rest = rest.slice(end + 3);
        commentFrom = null;
        continue;
      }
      const start = rest.indexOf('<!--');
      if (start < 0) {
        kept += rest;
        break;
      }
      kept += rest.slice(0, start);
      rest = rest.slice(start + 4);
      commentFrom = no;
    }
    lines.push({ no, text: kept.normalize('NFKC').trim() });
  }

  const unclosed = commentFrom !== null ? { kind: 'comment' as const, line: commentFrom } : fence !== null ? { kind: 'fence' as const, line: fence.line } : null;
  return { lines, unclosed };
}

type Heading = { level: number; name: string };

function heading(text: string): Heading | null {
  const m = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(text);
  if (!m) return null;
  return { level: m[1]!.length, name: (m[2] ?? '').replace(/[ \t]+#+$/, '').trim() };
}

function keyValue(text: string): { key: string; value: string } | null {
  const m = /^([^:]+?)\s*:\s*(.*)$/.exec(text);
  return m ? { key: m[1]!, value: m[2]!.trim() } : null;
}

/** The text of a list item ('' for an empty one), or null when the line is not a list item. */
function bullet(text: string): string | null {
  const m = /^(?:[-*+](?:[ \t]+(.*))?|・[ \t]*(.*))$/.exec(text);
  if (!m) return null;
  // A task-list checkbox (- [ ] / - [x]) is not part of the text.
  return (m[1] ?? m[2] ?? '').replace(/^\[[ xX]?\]\s*/u, '').replace(/\s+/gu, ' ').trim();
}

// Zero-width and bidi format characters, private-use and control characters: invisible or deceptive in prompts, posts
// and the terminal, so they are removed from words and policies (as Ruling P2-R6 does for trend keywords).
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cc}]/gu;
const visible = (text: string): string => text.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();

function invisibleLine(file: string, line: Line, item: string): InstructionIssue {
  return issue(IGNORED_CONTENT_CODE, file, line.no, item, `${at(file, line.no)}: 見えない文字（ゼロ幅の文字・制御文字など）しか無いため使いません。内容を書き直すか、行を消してください`);
}

/** A Markdown horizontal rule (---, ***, ___). */
const isRule = (text: string): boolean => /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text);

const isSection = (name: string): name is InstructionSection => (INSTRUCTION_SECTIONS as readonly string[]).includes(name);

/** A short, safe excerpt of an unknown line for the warning: only a key before ':' (values may hold secrets). */
function unknownLine(file: string, line: Line, hint: string): InstructionIssue {
  const kv = keyValue(line.text);
  const subject = kv !== null && [...kv.key].length <= 20 ? `「${kv.key}」の行` : 'この行';
  return issue(IGNORED_CONTENT_CODE, file, line.no, null, `${at(file, line.no)}: ${subject}は指示書の書式に当てはまらないため使いません。${hint}`);
}

const GENERAL_HINT = '説明やメモは <!-- --> で囲むと警告が出ません。書ける内容は instructions/README.md を見てください';

/**
 * Inside a section: the section key a malformed line starts with (e.g. 「火曜日 休業」 or 「開始 10:00」 without the colon),
 * else null.
 */
function nearMissKey(text: string, keys: readonly string[]): string | null {
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    if (!text.startsWith(key)) continue;
    return text.slice(key.length).startsWith(':') ? null : key;
  }
  return null;
}

const META_NAMES_LONGEST_FIRST = [...META_KEYS.keys()].sort((a, b) => b.length - a.length);
const META_VALUE_WORDS = ['有効', '無効', '共通', 'スタイル', 'ブログ', 'メンズ', 'レディース'];
const META_EXAMPLES: Readonly<Record<MetaField, string>> = {
  state: '有効',
  priority: '20',
  post_type: 'スタイル',
  audience: 'メンズ',
  start: '2026-12-26',
  end: '2027-01-05',
};

// What a setting line looks like, for lines that read like a note (「対象のお客様: …」, 「対象は…」).
const META_FORMS: Readonly<Record<MetaField, string>> = {
  state: '状態: 有効／無効',
  priority: '優先度: 20',
  post_type: '対象: 共通／スタイル／ブログ',
  audience: '対象カテゴリー: 共通／メンズ／レディース',
  start: '適用開始: 2026-12-26',
  end: '適用終了: 2027-01-05',
};

interface HeaderNearMiss {
  key: string;
  field: MetaField;
  value: string;
  /** Written like a note: the key runs on before ':' (対象のお客様:, 適用終了日:) or is followed by は. */
  noteLike: boolean;
}

/**
 * Before the first ##: the metadata key a malformed line was meant to be, with the value written, or null for a free
 * note. It counts as meant for key K when it is「K…: value」 (適用終了日:, 優先度（…）:), or K followed by spaces, '=' or
 * は and a value, or K directly followed by a digit or a known value (対象スタイル). 「対象のお客様向けのメモ」 stays a note.
 */
function headerNearMiss(text: string): HeaderNearMiss | null {
  const kv = keyValue(text);
  for (const key of META_NAMES_LONGEST_FIRST) {
    if (!text.startsWith(key)) continue;
    const field = META_KEYS.get(key)!;
    if (kv !== null && kv.key.startsWith(key)) return { key, field, value: kv.value, noteLike: true };
    const rest = text.slice(key.length);
    const spaced = /^(?:([\s=]+)|は\s*)(\S.*)$/u.exec(rest);
    if (spaced) return { key, field, value: spaced[2]!.trim(), noteLike: spaced[1] === undefined };
    if (/^\d/u.test(rest) || META_VALUE_WORDS.some((w) => rest.startsWith(w))) return { key, field, value: rest.trim(), noteLike: false };
    return null;
  }
  return null;
}

function nearMissMessage(key: string, example: string): string {
  return `「${key}」の行の書き方が正しくありません。「${key}: ${example}」のように、「${key}」のすぐ後に「:」を付けて書いてください`;
}

/** The fix hint for a malformed header line: a note-like one may be either a note or a setting. */
function headerNearMissMessage(near: HeaderNearMiss): string {
  const canonical = near.field === 'audience' ? '対象カテゴリー' : near.key;
  if (!near.noteLike) return nearMissMessage(canonical, META_EXAMPLES[near.field]);
  return `この行は「${canonical}」の設定として読めません。メモなら <!-- と --> で囲んでください。設定なら『${META_FORMS[near.field]}』のように書いてください`;
}

// Bullets that only mark an unfinished template: TODO / 未定 / 例 / 記入例 (spec 5.10: examples and TODOs never apply).
const PLACEHOLDER = /^(?:[[(【「<]\s*(?:todo|未定|記入例|例)\s*[\])】」>]|(?:todo|未定|記入例|例)(?=$|[\s:=.,。、)\]】」>-]))/iu;

function placeholderLine(file: string, line: Line, item: string): InstructionIssue {
  return issue(IGNORED_CONTENT_CODE, file, line.no, item, `${at(file, line.no)}: この行は記入例・未定の印（TODO・未定・例・記入例）のため使いません。実際の内容を書くか、行を消してください`);
}

// ---------------------------------------------------------------- header

interface MetaLine {
  field: MetaField;
  key: string;
  value: string;
  line: number;
}

interface Header {
  priority: number;
  scope: InstructionScope;
  period: InstructionPeriod;
}

function parseHeader(file: string, meta: MetaLine[], invalid: InstructionIssue[]): Header {
  const header: Header = { priority: 0, scope: { post_type: 'common', audience: 'common' }, period: { start: null, end: null } };
  const seen = new Map<string, number>();
  for (const m of meta) {
    if (m.field === 'state') continue;
    const first = seen.get(m.field);
    if (first !== undefined) {
      invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 「${m.key}」が${first}行目にも書かれています。1つにしてください`));
      continue;
    }
    seen.set(m.field, m.line);
    if (m.value === '') continue; // empty = not specified
    switch (m.field) {
      case 'priority': {
        const n = /^\d{1,3}$/.test(m.value) ? Number(m.value) : Number.NaN;
        if (Number.isInteger(n) && n >= 0 && n <= 100) header.priority = n;
        else invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 優先度は 0〜100 の整数で書いてください（大きいほど優先されます）`));
        break;
      }
      case 'post_type': {
        const v = POST_TYPE_VALUES.get(m.value);
        if (v !== undefined) header.scope.post_type = v;
        else invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 対象は 共通・スタイル・ブログ のどれかで書いてください`));
        break;
      }
      case 'audience': {
        const v = AUDIENCE_VALUES.get(m.value);
        if (v !== undefined) header.scope.audience = v;
        else invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 対象カテゴリーは 共通・メンズ・レディース のどれかで書いてください`));
        break;
      }
      case 'start':
      case 'end': {
        if (isRealDate(m.value)) header.period[m.field] = m.value;
        else invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 「${m.key}」の日付が正しくありません。実在する日付を 2026-10-03 のように YYYY-MM-DD で書いてください`));
        break;
      }
    }
  }
  const { start, end } = header.period;
  if (start !== null && end !== null && start > end) {
    invalid.push(issue('INSTRUCTION_INVALID', file, seen.get('end') ?? null, null, `${at(file, seen.get('end') ?? null)}: 適用開始（${start}）が適用終了（${end}）より後になっています。日付を確認してください`));
  }
  return header;
}

// ---------------------------------------------------------------- sections

interface Ctx {
  file: string;
  invalid: InstructionIssue[];
  ignored: InstructionIssue[];
  out: ParsedInstruction;
}

function bad(ctx: Ctx, line: number, item: string, message: string): void {
  ctx.invalid.push(issue('INSTRUCTION_INVALID', ctx.file, line, item, `${at(ctx.file, line)}: ${message}`));
}

const RANGE = /^(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})$/u;
const RANGE_HINT = '10:00-20:00 のように「開始-終了」を HH:mm（00:00〜23:59）で書き、時間帯が複数なら「10:00-13:00, 14:00-20:00」とします';

function parseRanges(ctx: Ctx, line: number, value: string): TimeRange[] | null {
  const parts = splitList(value);
  if (parts.includes(CLOSED_VALUE)) {
    if (parts.length === 1) return [];
    bad(ctx, line, 'business_hours', `休業 と時間帯を同じ行に書くことはできません。休業の日は「休業」だけを書いてください`);
    return null;
  }
  const ranges: TimeRange[] = [];
  for (const part of parts) {
    const m = RANGE.exec(part);
    const start = m ? parseTime(m[1]!) : null;
    const end = m ? parseTime(m[2]!) : null;
    if (start === null || end === null) {
      bad(ctx, line, 'business_hours', `時間帯「${part}」を読み取れません。${RANGE_HINT}`);
      return null;
    }
    if (minutes(start) >= minutes(end)) {
      bad(ctx, line, 'business_hours', `時間帯「${part}」の終了時刻は開始時刻より後にしてください（日跨ぎの営業時間は書けません）`);
      return null;
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => minutes(a.start) - minutes(b.start));
  for (let i = 1; i < ranges.length; i++) {
    if (minutes(ranges[i]!.start) < minutes(ranges[i - 1]!.end)) {
      bad(ctx, line, 'business_hours', `時間帯 ${ranges[i - 1]!.start}-${ranges[i - 1]!.end} と ${ranges[i]!.start}-${ranges[i]!.end} が重なっています。重ならないように書いてください`);
      return null;
    }
  }
  return ranges;
}

function parseBusinessHours(ctx: Ctx, lines: Line[]): void {
  let all: { ranges: TimeRange[]; line: number } | null = null;
  const days = new Map<WeekdayKey, { ranges: TimeRange[]; line: number }>();
  const seen = new Map<string, number>();
  const dates = new Set<string>();
  for (const line of lines) {
    const kv = keyValue(line.text);
    const day = kv === null ? undefined : WEEKDAY_NAMES.get(kv.key);
    if (kv !== null && kv.key === CLOSED_DATES_KEY) {
      for (const date of splitList(kv.value)) {
        if (!isRealDate(date)) {
          bad(ctx, line.no, 'business_hours', `臨時休業の日付「${date}」が正しくありません。実在する日付を 2026-12-31 のように YYYY-MM-DD で書き、複数なら「, 」で区切ってください`);
          continue;
        }
        if (!dates.has(date)) {
          dates.add(date);
          ctx.out.closed_dates.push({ date, line: line.no });
        }
      }
      continue;
    }
    if (kv === null || day === undefined) {
      const key = nearMissKey(line.text, [...WEEKDAY_NAMES.keys(), CLOSED_DATES_KEY]);
      if (key !== null) {
        bad(ctx, line.no, 'business_hours', `${nearMissMessage(key, key === CLOSED_DATES_KEY ? '2026-12-31' : '10:00-20:00')}（曜日は1行に1つずつ書きます）`);
        continue;
      }
      ctx.ignored.push(unknownLine(ctx.file, line, '営業時間には「全曜日」「月曜日」〜「日曜日」（例: 火曜日: 10:00-20:00 / 火曜日: 休業）と「臨時休業: YYYY-MM-DD」だけを書けます'));
      continue;
    }
    const first = seen.get(day);
    if (first !== undefined) {
      bad(ctx, line.no, 'business_hours', `「${kv.key}」と同じ曜日が${first}行目にも書かれています。1つにしてください`);
      continue;
    }
    seen.set(day, line.no);
    if (kv.value === '') continue;
    const ranges = parseRanges(ctx, line.no, kv.value);
    if (ranges === null) continue;
    if (day === 'all') all = { ranges, line: line.no };
    else days.set(day, { ranges, line: line.no });
  }
  for (const key of WEEKDAY_KEYS) {
    const value = days.get(key) ?? all;
    if (value !== null) ctx.out.business_hours[key] = { ranges: value.ranges.map((r) => ({ ...r })), line: value.line };
  }
}

function parsePostWindow(ctx: Ctx, lines: Line[], headingLine: number): void {
  const found: Partial<Record<'開始' | '終了', { value: string; line: number }>> = {};
  for (const line of lines) {
    const kv = keyValue(line.text);
    const key = kv?.key;
    if (kv === null || (key !== '開始' && key !== '終了')) {
      const near = nearMissKey(line.text, ['開始', '終了']);
      if (near !== null) bad(ctx, line.no, 'post_window', nearMissMessage(near, '10:00'));
      else ctx.ignored.push(unknownLine(ctx.file, line, '投稿時間には「開始: HH:mm」と「終了: HH:mm」だけを書けます'));
      continue;
    }
    const first = found[key];
    if (first !== undefined) {
      bad(ctx, line.no, 'post_window', `「${key}」が${first.line}行目にも書かれています。1つにしてください`);
      continue;
    }
    found[key] = { value: kv.value, line: line.no };
  }
  const start = found['開始'];
  const end = found['終了'];
  const startValue = start?.value ?? '';
  const endValue = end?.value ?? '';
  if (startValue === '' && endValue === '') return;
  const where = start?.line ?? end?.line ?? headingLine;
  if (startValue === '' || endValue === '') {
    bad(ctx, where, 'post_window', '投稿時間は「開始」と「終了」の両方を書いてください（片方だけ変える場合も、両方の時刻を書きます）');
    return;
  }
  const s = parseTime(startValue);
  const e = parseTime(endValue);
  if (s === null || e === null) {
    bad(ctx, s === null ? start!.line : end!.line, 'post_window', '時刻は 10:00 のように HH:mm（00:00〜23:59）で書いてください');
    return;
  }
  if (minutes(s) >= minutes(e)) {
    bad(ctx, end!.line, 'post_window', `終了（${e}）は開始（${s}）より後にしてください（日跨ぎの投稿時間は書けません）`);
    return;
  }
  ctx.out.post_window = { start: s, end: e, line: where };
}

/** Bullet words, de-duplicated by wordKey; a malformed word makes the file invalid (the set must be exact). */
function collectWords(ctx: Ctx, line: Line, item: string, words: Map<string, { word: string; line: number }>): boolean {
  const raw = bullet(line.text);
  if (raw === null) return false;
  const word = visible(raw);
  if (word === '') {
    if (raw !== '') ctx.ignored.push(invisibleLine(ctx.file, line, item));
    return true;
  }
  if (PLACEHOLDER.test(word)) {
    ctx.ignored.push(placeholderLine(ctx.file, line, item));
    return true;
  }
  if (/[,、]/u.test(word)) {
    bad(ctx, line.no, item, `「${word}」に区切り記号があります。1行に1語ずつ「- 語」の形で書いてください`);
    return true;
  }
  if ([...word].length > MAX_KEYWORD_LENGTH) {
    bad(ctx, line.no, item, `語が長すぎます（${MAX_KEYWORD_LENGTH}文字まで）。文章ではなく、検索に使う語を1行に1語ずつ書いてください`);
    return true;
  }
  const key = wordKey(word);
  if (!words.has(key)) words.set(key, { word: key, line: line.no });
  return true;
}

function parseKeywords(ctx: Ctx, lines: Line[]): void {
  let op: { op: KeywordOp | null; line: number } | null = null;
  const words = new Map<string, { word: string; line: number }>();
  for (const line of lines) {
    const kv = bullet(line.text) === null ? keyValue(line.text) : null;
    if (kv !== null && kv.key === '操作') {
      if (op !== null) {
        bad(ctx, line.no, 'keywords', `検索ワードの操作は1ファイルに1種類です（${op.line}行目にもあります）。追加と削除などを併用するときはファイルを分けてください`);
        continue;
      }
      const value = kv.value === '' ? null : KEYWORD_OPS.get(kv.value);
      if (value === undefined) {
        bad(ctx, line.no, 'keywords', '操作は 追加・置換・削除 のどれかで書いてください');
        continue;
      }
      op = { op: value, line: line.no };
      continue;
    }
    if (collectWords(ctx, line, 'keywords', words)) continue;
    if (nearMissKey(line.text, ['操作']) !== null) bad(ctx, line.no, 'keywords', nearMissMessage('操作', '追加'));
    else ctx.ignored.push(unknownLine(ctx.file, line, '検索ワードには「操作: 追加／置換／削除」と、その語を「- 語」の箇条書きで書きます'));
  }
  const firstWord = [...words.values()][0];
  if (firstWord === undefined) {
    // An empty 操作: with no words is just an unfilled template.
    if (op !== null && op.op !== null) {
      ctx.ignored.push(
        issue(IGNORED_CONTENT_CODE, ctx.file, op.line, 'keywords', `${at(ctx.file, op.line)}: 検索ワードの操作に対象の語が無いため、検索ワードは変更しません（空の置換で既存の語を消すことはありません）`),
      );
    }
    return;
  }
  if (op === null || op.op === null) {
    bad(ctx, op?.line ?? firstWord.line, 'keywords', '検索ワードの「操作: 追加／置換／削除」を書いてください（どの操作をするか書かれていない語は使えません）');
    return;
  }
  ctx.out.keywords = { op: op.op, words: [...words.values()].map((w) => w.word), line: op.line };
}

function parseExcluded(ctx: Ctx, lines: Line[]): void {
  const words = new Map<string, { word: string; line: number }>();
  for (const line of lines) {
    if (!collectWords(ctx, line, 'excluded_keywords', words)) {
      ctx.ignored.push(unknownLine(ctx.file, line, '除外検索ワードは「- 語」の箇条書きで1行に1語ずつ書きます'));
    }
  }
  ctx.out.excluded_keywords = [...words.values()];
}

function parsePolicies(ctx: Ctx, lines: Line[]): void {
  for (const line of lines) {
    const raw = bullet(line.text);
    if (raw === null) {
      ctx.ignored.push(unknownLine(ctx.file, line, '文章方針は先頭に「- 」を付けた箇条書きで書いてください'));
      continue;
    }
    const text = visible(raw);
    if (text === '') {
      if (raw !== '') ctx.ignored.push(invisibleLine(ctx.file, line, 'writing_policies'));
      continue;
    }
    if (PLACEHOLDER.test(text)) {
      ctx.ignored.push(placeholderLine(ctx.file, line, 'writing_policies'));
      continue;
    }
    if (SYSTEM_DIRECTIVE.test(text)) {
      ctx.ignored.push(
        issue(IGNORED_CONTENT_CODE, ctx.file, line.no, 'writing_policies', `${at(ctx.file, line.no)}: この文章方針はシステムの設定・検査・認証に関わる内容のため使いません。文章方針には文体や伝えたいことだけを書けます`),
      );
      continue;
    }
    if (FACT_CLAIM.test(text)) {
      ctx.ignored.push(
        issue(IGNORED_CONTENT_CODE, ctx.file, line.no, 'writing_policies', `${at(ctx.file, line.no)}: 料金・割引・クーポンなどの事実は文章方針では指定できないため使いません（店舗の情報は config/salon.json で管理します）`),
      );
      continue;
    }
    ctx.out.writing_policies.push({ text, line: line.no });
  }
}

function parseRoutes(ctx: Ctx, lines: Line[]): void {
  const seen = new Map<RouteKey, number>();
  for (const line of lines) {
    const kv = keyValue(line.text);
    const key = kv === null ? undefined : ROUTE_BY_LABEL.get(kv.key);
    if (kv === null || key === undefined) {
      const near = nearMissKey(line.text, Object.values(ROUTE_LABELS));
      if (near !== null) {
        const nearKey = ROUTE_BY_LABEL.get(near)!;
        bad(ctx, line.no, `routes.${nearKey}`, nearMissMessage(near, 'https://（確認した投稿画面のURL）'));
        continue;
      }
      ctx.ignored.push(unknownLine(ctx.file, line, `投稿先URLは「${Object.values(ROUTE_LABELS).join('」「')}」のキーごとに「キー: URL」と書きます`));
      continue;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      bad(ctx, line.no, `routes.${key}`, `「${kv.key}」が${first}行目にも書かれています。1つにしてください`);
      continue;
    }
    seen.set(key, line.no);
    if (kv.value !== '') ctx.out.routes[key] = { url: kv.value, line: line.no };
  }
}

function hasItems(p: ParsedInstruction): boolean {
  return (
    Object.keys(p.business_hours).length > 0 ||
    p.closed_dates.length > 0 ||
    p.post_window !== null ||
    p.keywords !== null ||
    p.excluded_keywords.length > 0 ||
    p.writing_policies.length > 0 ||
    Object.keys(p.routes).length > 0
  );
}

// ---------------------------------------------------------------- entry point

/**
 * Parses one instruction file. A file whose 状態 is missing, empty or 無効 is `disabled` (nothing in it is used and no
 * warning is produced). An enabled file either parses completely or is `{ invalid }` as a whole; lines that fit no form
 * are returned in `ignored`. `opts.sha256` lets the caller record the hash of the file's bytes.
 */
export function parseInstructionFile(fileName: string, text: string, opts: { sha256?: string } = {}): ParseResult {
  const file = fileName;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a BOM left by the caller
  const { lines, unclosed } = stripMarkup(body.split(/\r\n|\r|\n/));

  // Pass 1: split into the header (before the first ##) and sections.
  const meta: MetaLine[] = [];
  const misplacedMeta: MetaLine[] = [];
  const strayLines: Line[] = [];
  const headingWarnings: InstructionIssue[] = [];
  const sections = new Map<InstructionSection, { line: number; lines: Line[] }>();
  const duplicates: { name: InstructionSection; line: number; first: number }[] = [];
  let current: { lines: Line[] } | null = null;
  let inHeader = true;
  let inUnknownSection = false;

  for (const line of lines) {
    if (line.text === '' || isRule(line.text)) continue;
    const h = heading(line.text);
    if (h !== null) {
      if (h.level === 2) {
        inHeader = false;
        if (isSection(h.name)) {
          const existing = sections.get(h.name);
          if (existing !== undefined) {
            duplicates.push({ name: h.name, line: line.no, first: existing.line });
            current = { lines: [] }; // read but discarded: the file is invalid anyway
          } else {
            current = { lines: [] };
            sections.set(h.name, { line: line.no, lines: current.lines });
          }
          inUnknownSection = false;
        } else {
          current = null;
          inUnknownSection = true;
          headingWarnings.push(
            issue(IGNORED_CONTENT_CODE, file, line.no, null, `${at(file, line.no)}: 見出し「## ${h.name}」は認識できないため、この見出しの下の内容は使いません。使える見出しは ${INSTRUCTION_SECTIONS.map((s) => `## ${s}`).join('、')} です`),
          );
        }
        continue;
      }
      if (isSection(h.name)) {
        headingWarnings.push(issue(IGNORED_CONTENT_CODE, file, line.no, null, `${at(file, line.no)}: 見出しは「## ${h.name}」のように # を2つ付けて書いてください（この行は見出しとして使いません）`));
        continue;
      }
      if (h.level === 1) continue; // a title
      if (!inUnknownSection) strayLines.push(line);
      continue;
    }
    const kv = keyValue(line.text);
    const field = kv === null ? undefined : META_KEYS.get(kv.key);
    if (kv !== null && field !== undefined) {
      const m: MetaLine = { field, key: kv.key, value: kv.value, line: line.no };
      // Also under an unknown heading: a period or scope must never be dropped without the file being rejected.
      if (inHeader) meta.push(m);
      else misplacedMeta.push(m);
      continue;
    }
    if (inHeader) strayLines.push(line);
    else if (current !== null) current.lines.push(line);
  }

  // State first: a disabled file is not looked at any further.
  const stateLines = meta.filter((m) => m.field === 'state');
  const misplacedState = misplacedMeta.find((m) => m.field === 'state' && m.value === '有効');
  const values = new Set(stateLines.map((m) => m.value).filter((v) => v !== ''));
  // A malformed 状態 line is never silent: 無効 is read as disabled (revocation is the safe direction) with a warning;
  // anything else is invalid, so the file's last valid content stays in use.
  const stateNearMiss =
    values.size === 0
      ? strayLines.flatMap((l) => {
          const near = headerNearMiss(l.text);
          return near !== null && near.field === 'state' ? [{ line: l.no, near }] : [];
        })[0]
      : undefined;
  if (stateNearMiss !== undefined && misplacedState === undefined) {
    if (!stateNearMiss.near.value.startsWith('無効')) {
      const hint = stateNearMiss.near.noteLike ? headerNearMissMessage(stateNearMiss.near) : `${nearMissMessage('状態', '有効')}（無効にするときは「状態: 無効」）`;
      return { invalid: [issue('INSTRUCTION_INVALID', file, stateNearMiss.line, null, `${at(file, stateNearMiss.line)}: ${hint}`)] };
    }
    return {
      ...emptyDocument(file, opts.sha256 ?? sha256Hex(text), 'disabled'),
      ignored: [
        issue(IGNORED_CONTENT_CODE, file, stateNearMiss.line, null, `${at(file, stateNearMiss.line)}: 「状態」の後に「:」がありませんが、「無効」と読み取って、この指示書は無効として扱います。「状態: 無効」と書いてください`),
      ],
    };
  }
  if (values.size === 0 || (values.size === 1 && values.has('無効'))) {
    if (misplacedState === undefined) return emptyDocument(file, opts.sha256 ?? sha256Hex(text), 'disabled');
    return {
      invalid: [issue('INSTRUCTION_INVALID', file, misplacedState.line, null, `${at(file, misplacedState.line)}: 「状態」などの見出し情報は、最初の ## 見出しより前に書いてください`)],
    };
  }
  const nonEmptyState = stateLines.filter((m) => m.value !== '');
  if (!(values.size === 1 && values.has('有効') && nonEmptyState.length === 1)) {
    const where = nonEmptyState.find((m) => m.value !== '有効' && m.value !== '無効') ?? nonEmptyState[1] ?? nonEmptyState[0]!;
    return {
      invalid: [issue('INSTRUCTION_INVALID', file, where.line, null, `${at(file, where.line)}: 状態は 有効 または 無効 のどちらか1つを1行だけ書いてください`)],
    };
  }

  const invalid: InstructionIssue[] = [];
  if (unclosed !== null) {
    const mark = unclosed.kind === 'comment' ? '<!--' : '```';
    const close = unclosed.kind === 'comment' ? '-->' : '```';
    invalid.push(issue('INSTRUCTION_INVALID', file, unclosed.line, null, `${at(file, unclosed.line)}: ${mark} が閉じられていません（${close} で閉じてください）。閉じるまでの内容を読めません`));
  }
  for (const m of misplacedMeta) {
    invalid.push(issue('INSTRUCTION_INVALID', file, m.line, null, `${at(file, m.line)}: 「${m.key}」などの見出し情報は、最初の ## 見出しより前に書いてください`));
  }
  for (const d of duplicates) {
    invalid.push(issue('INSTRUCTION_INVALID', file, d.line, SECTION_ITEM[d.name], `${at(file, d.line)}: 見出し「## ${d.name}」が${d.first}行目にもあります。1つの見出しにまとめてください`));
  }
  const header = parseHeader(file, meta, invalid);

  const out: ParsedInstruction = { ...emptyDocument(file, opts.sha256 ?? sha256Hex(text), 'enabled'), ...header };
  const ctx: Ctx = { file, invalid, ignored: [], out };
  for (const line of strayLines) {
    const near = headerNearMiss(line.text);
    if (near === null) {
      ctx.ignored.push(unknownLine(file, line, GENERAL_HINT));
      continue;
    }
    invalid.push(issue('INSTRUCTION_INVALID', file, line.no, null, `${at(file, line.no)}: ${headerNearMissMessage(near)}`));
  }
  ctx.ignored.push(...headingWarnings);

  for (const name of INSTRUCTION_SECTIONS) {
    const section = sections.get(name);
    if (section === undefined) continue;
    out.sections[name] = section.line;
    switch (name) {
      case '営業時間':
        parseBusinessHours(ctx, section.lines);
        break;
      case '投稿時間':
        parsePostWindow(ctx, section.lines, section.line);
        break;
      case '検索ワード':
        parseKeywords(ctx, section.lines);
        break;
      case '除外検索ワード':
        parseExcluded(ctx, section.lines);
        break;
      case '文章方針':
        parsePolicies(ctx, section.lines);
        break;
      case '投稿先URL':
        parseRoutes(ctx, section.lines);
        break;
    }
  }

  if (invalid.length > 0) return { invalid: invalid.sort(byLine) };
  if (!hasItems(out)) {
    ctx.ignored.push(issue(IGNORED_CONTENT_CODE, file, null, null, `${file}: 状態は有効ですが、反映できる内容がありません（見出しの下に値を書いてください。書き方は instructions/README.md）`));
  }
  out.ignored = ctx.ignored.sort(byLine);
  return out;
}

// File-level issues (no line) come after the line-level ones.
const byLine = (a: InstructionIssue, b: InstructionIssue): number => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);

function emptyDocument(file: string, sha256: string, state: ParsedInstruction['state']): ParsedInstruction {
  return {
    file,
    sha256,
    state,
    priority: 0,
    scope: { post_type: 'common', audience: 'common' },
    period: { start: null, end: null },
    sections: {},
    business_hours: {},
    closed_dates: [],
    post_window: null,
    keywords: null,
    excluded_keywords: [],
    writing_policies: [],
    routes: {},
    ignored: [],
  };
}
