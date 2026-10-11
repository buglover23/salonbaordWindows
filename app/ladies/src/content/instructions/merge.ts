import type { ConfigSnapshot } from '../../config/loader.js';
import type { RouteKey } from '../../config/readiness.js';
import type { ScheduleConfig } from '../../config/schemas.js';
import { sha256Hex } from '../../shared/hash.js';
import type { PageProfile } from '../../shared/protocol/profile.js';
import { matchProfileUrl } from '../../shared/protocol/url-match.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../../shared/labels.js';
import { jstToUtc } from '../../shared/time.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type PostType } from '../../shared/types.js';
import { PRODUCTION_URL_POLICY, type UrlPolicy } from '../../shared/url-policy.js';
import {
  IGNORED_CONTENT_CODE,
  ROUTE_LABELS,
  WEEKDAY_KEYS,
  wordKey,
  type InstructionIssue,
  type InstructionPeriod,
  type InstructionScope,
  type KeywordOp,
  type ParsedInstruction,
  type TimeRange,
  type WeekdayKey,
} from './parse.js';

// Plan decisions 8 and 9: documents are layered per item (priority asc, then scope specificity asc; later wins). Two
// documents conflict only at the same priority with the same or incomparable scope and different values; a conflict or
// an invalid item blocks only that item, and disabled, deleted or expired documents simply stop contributing.

export type BusinessHours = NonNullable<ScheduleConfig['business_hours']>;
export type ByCell<T> = Record<PostType, Record<AudienceCategory, T>>;

/** What the instruction files change on top of the config. Absent / empty fields change nothing. */
export interface EffectiveOverlay {
  /** All seven weekdays; weekdays no document sets keep the config value (or 00:00-23:59 when the config has none). */
  business_hours?: BusinessHours;
  /** Added to schedule.closed_dates. */
  closed_dates_add: string[];
  /** Replaces schedule.post_start / post_end. */
  post_window?: { start: string; end: string };
  /** The effective priority keywords per post type × audience (config base, instruction ops, exclusions applied). */
  keywords: ByCell<string[]>;
  /** Removed from every keyword source (manual, Excel, trends) by NFKC exact match. */
  excluded_keywords: string[];
  writing_policies: ByCell<string[]>;
  /** entry_url overrides per route; validated against the allowed origins. */
  routes: Partial<Record<RouteKey, string>>;
}

export interface AppliedRef {
  file: string;
  sha256: string;
  priority: number;
  scope: InstructionScope;
  period: InstructionPeriod;
  /** The settings this document contributed, e.g. 'business_hours.2', 'keywords.style.mens', 'routes.blog.ladies'. */
  items: string[];
}

export interface MergeResult {
  effective: EffectiveOverlay;
  /** INSTRUCTION_INVALID / INSTRUCTION_CONFLICT: the item named is not applied from the documents involved. */
  issues: InstructionIssue[];
  applied: AppliedRef[];
  /** INSTRUCTION_IGNORED_CONTENT: lines or policies that were left out; everything else still applies. */
  ignored: InstructionIssue[];
}

const NOT_APPLIED = 'この項目は反映していません';
const NONE_APPLIED = 'この項目にはどちらの指示も反映していません';

export const MAX_POLICY_BULLETS = 10;
export const MAX_POLICY_CHARS = 600;
// Stands for "no business-hours limit" on a weekday: post_end is at most 23:59, so the post window is never cut.
const UNRESTRICTED: TimeRange = { start: '00:00', end: '23:59' };
const WEEKDAY_JA: Record<WeekdayKey, string> = { '1': '月曜日', '2': '火曜日', '3': '水曜日', '4': '木曜日', '5': '金曜日', '6': '土曜日', '7': '日曜日' };
const SESSION_QUERY_KEY = /jsessionid|session|token|sid|auth|passw|secret/i;

interface Cell {
  type: PostType;
  audience: AudienceCategory;
}
const CELLS: readonly Cell[] = POST_TYPES.flatMap((type) => AUDIENCE_CATEGORIES.map((audience) => ({ type, audience })));
const cellId = (c: Cell): string => `${c.type}.${c.audience}`;
const cellJa = (c: Cell): string => `${POST_TYPE_JA[c.type]}×${AUDIENCE_JA[c.audience]}`;
const ROUTE_KEYS = Object.keys(ROUTE_LABELS) as RouteKey[];

const ITEM_ORDER: readonly string[] = [
  ...WEEKDAY_KEYS.map((d) => `business_hours.${d}`),
  'closed_dates',
  'post_window',
  ...CELLS.map((c) => `keywords.${cellId(c)}`),
  'excluded_keywords',
  ...CELLS.map((c) => `writing_policies.${cellId(c)}`),
  ...ROUTE_KEYS.map((k) => `routes.${k}`),
];

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dims = (s: InstructionScope): number => (s.post_type === 'common' ? 0 : 1) + (s.audience === 'common' ? 0 : 1);
const isGlobal = (s: InstructionScope): boolean => s.post_type === 'common' && s.audience === 'common';
const covers = (s: InstructionScope, c: Cell): boolean => (s.post_type === 'common' || s.post_type === c.type) && (s.audience === 'common' || s.audience === c.audience);
/** Application order: lower priority first, then broader scope first; the file name only makes the output stable. */
const byLayer = (a: ParsedInstruction, b: ParsedInstruction): number => a.priority - b.priority || dims(a.scope) - dims(b.scope) || compareText(a.file, b.file);
const at = (file: string, line: number | null): string => (line === null ? file : `${file} ${line}行目`);

/** Start date 00:00 JST inclusive, end date's next 00:00 JST exclusive (spec 5.10). */
export function periodState(period: InstructionPeriod, now: Date): 'upcoming' | 'active' | 'expired' {
  const t = now.getTime();
  if (period.start !== null && t < jstToUtc(period.start, 0).getTime()) return 'upcoming';
  if (period.end !== null && t >= jstToUtc(period.end, 24 * 60).getTime()) return 'expired';
  return 'active';
}

/** The value with object keys sorted at every level, so equal data always serializes the same. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** sha256 of the overlay with sorted keys: equal overlays always hash the same. */
export function effectiveHash(overlay: EffectiveOverlay): string {
  return sha256Hex(JSON.stringify(canonical(overlay)));
}

function dedupeWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = wordKey(w);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- URL check (spec 5.11)

const PLAN3_ORIGIN_MESSAGE =
  '投稿先URLは、SALON BOARD の正規の接続先（origin）を画面調査で確認して config/salonboard_fields.json の allowed_origins に登録するまで使えません（この確認は Plan 3 の画面調査で行います）';

/** The origins of config.salonboardFields.allowed_origins the URL policy accepts (production: https domain names only). */
export function allowedOriginSet(list: readonly string[], policy: UrlPolicy = PRODUCTION_URL_POLICY): Set<string> {
  const out = new Set<string>();
  for (const entry of list) {
    const url = URL.parse(entry);
    if (url !== null && policy.checkOrigin(url.origin) === null) out.add(url.origin);
  }
  return out;
}

export interface RouteUrlOptions {
  /** Which origins may be used (default production: https domain names on the standard port). */
  policy?: UrlPolicy | undefined;
  /** The route's page profile: the URL must be one of its pages (path allow-list, P2-T1). */
  profile?: { id: string; profile: PageProfile } | null | undefined;
}

/**
 * Checks an entry URL written in an instruction file. The reasons never repeat the URL (it may carry a secret); only the
 * origin or a query key name is named.
 */
export function checkRouteUrl(raw: string, allowed: ReadonlySet<string>, opts: RouteUrlOptions = {}): { ok: true; url: string } | { ok: false; reason: string } {
  if (allowed.size === 0) return { ok: false, reason: PLAN3_ORIGIN_MESSAGE };
  if (/[\s\p{Cc}]/u.test(raw)) return { ok: false, reason: 'URLに空白や制御文字を含めないでください' };
  const url = /^https?:\/\//i.test(raw) ? URL.parse(raw) : null;
  if (url === null) return { ok: false, reason: 'https:// で始まる完全なURLを書いてください（途中からのパスは使えません。ブラウザのアドレス欄からURLをそのまま写してください）' };
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?#\\]/)[0] ?? '';
  if (url.username !== '' || url.password !== '' || authority.includes('@')) {
    return { ok: false, reason: 'URLにユーザー名やパスワード（「@」より前の部分）を含めないでください' };
  }
  const originProblem = (opts.policy ?? PRODUCTION_URL_POLICY).checkOrigin(url.origin);
  if (originProblem !== null) return { ok: false, reason: `${originProblem}（投稿先URLの接続先）` };
  if (raw.includes('#')) return { ok: false, reason: 'URLの「#」以降（フラグメント）は書かないでください' };
  if (/;|%3b/i.test(url.pathname)) return { ok: false, reason: 'URLのパスに「;」を含めないでください（セッション情報を付ける書き方のため使えません）' };
  for (const key of url.searchParams.keys()) {
    if (SESSION_QUERY_KEY.test(key)) {
      const name = [...key].length <= 30 ? `「${key}」` : '';
      return { ok: false, reason: `URLに${name}というセッション・認証情報らしい項目があります。ログイン情報を含まない投稿画面のURLを書いてください` };
    }
  }
  if (!allowed.has(url.origin)) {
    return { ok: false, reason: `接続先 ${url.origin} は許可されていない接続先です（config/salonboard_fields.json の allowed_origins にある確認済みの接続先だけ使えます）` };
  }
  if (opts.profile && !matchProfileUrl(url.href, opts.profile.profile.url_match).ok) {
    return { ok: false, reason: `URLの場所（パスや ? 以降の項目）が、この投稿先の画面設定（画面profile「${opts.profile.id}」）にある投稿画面と合いません。投稿画面を開いたときのアドレス欄のURLを写してください` };
  }
  return { ok: true, url: url.href };
}

// ---------------------------------------------------------------- per-document item checks

interface Usable {
  doc: ParsedInstruction;
  /** Business hours, closed dates, post window and exclusions may come only from 共通×共通 documents. */
  global: boolean;
  routes: Partial<Record<RouteKey, { url: string; line: number }>>;
}

function checkItems(doc: ParsedInstruction, check: (key: RouteKey, url: string) => ReturnType<typeof checkRouteUrl>, issues: InstructionIssue[]): Usable {
  const global = isGlobal(doc.scope);
  const invalid = (line: number | null, item: string, message: string): void => {
    issues.push({ code: 'INSTRUCTION_INVALID', file: doc.file, line, item, message: `${at(doc.file, line)}: ${message}`, note: NOT_APPLIED, related_files: [] });
  };
  if (!global) {
    const storeWide = '「対象: 共通」と「対象カテゴリー: 共通」の指示書にだけ書けます';
    if (Object.keys(doc.business_hours).length > 0 || doc.closed_dates.length > 0) {
      invalid(doc.sections['営業時間'] ?? null, 'business_hours', `営業時間・臨時休業は店舗全体の設定のため、${storeWide}。共通の指示書に移してください`);
    }
    if (doc.post_window !== null) {
      invalid(doc.sections['投稿時間'] ?? null, 'post_window', `投稿時間は店舗全体の設定のため、${storeWide}。共通の指示書に移してください`);
    }
    if (doc.excluded_keywords.length > 0) {
      invalid(doc.sections['除外検索ワード'] ?? null, 'excluded_keywords', `除外検索ワードはすべての投稿の候補から外すため、${storeWide}。共通の指示書に移してください`);
    }
  }
  const routes: Usable['routes'] = {};
  for (const key of ROUTE_KEYS) {
    const route = doc.routes[key];
    if (route === undefined) continue;
    if (!global) {
      invalid(route.line, `routes.${key}`, `投稿先URL「${ROUTE_LABELS[key]}」は、キーで送信先が決まるため、対象・対象カテゴリーとも共通の指示書（例: 投稿先URL設定.md）に書いてください`);
      continue;
    }
    const checked = check(key, route.url);
    if (!checked.ok) {
      invalid(route.line, `routes.${key}`, `投稿先URL「${ROUTE_LABELS[key]}」は使えません。${checked.reason}`);
      continue;
    }
    routes[key] = { url: checked.url, line: route.line };
  }
  return { doc, global, routes };
}

// ---------------------------------------------------------------- override items (hours, post window, URLs)

interface Claim<T> {
  doc: ParsedInstruction;
  value: T;
  /** Equal keys = equal values. */
  key: string;
  line: number;
}

/**
 * Later priority wins; a priority group whose documents disagree is skipped (conflict reported), so the item falls back to
 * lower priorities or the config. Claims must be sorted by priority.
 */
function resolveOverride<T>(claims: Claim<T>[], item: string, label: string, describe: ((v: T) => string) | null, issues: InstructionIssue[]): Claim<T>[] | null {
  let winners: Claim<T>[] | null = null;
  for (const group of groupBy(claims, (c) => String(c.doc.priority))) {
    if (new Set(group.map((c) => c.key)).size <= 1) {
      winners = group;
      continue;
    }
    const sorted = [...group].sort((a, b) => compareText(a.doc.file, b.doc.file));
    const first = sorted[0]!;
    const where = sorted.map((c) => at(c.doc.file, c.line)).join(' と ');
    const values = describe === null ? '' : `（${sorted.map((c) => `${c.doc.file}: ${describe(c.value)}`).join(' / ')}）`;
    issues.push({
      code: 'INSTRUCTION_CONFLICT',
      file: first.doc.file,
      line: first.line,
      item,
      message: `${where}: 優先度 ${first.doc.priority} が同じで、${label}の値が食い違っています${values}。値をそろえるか、優先したい指示書の優先度を上げてください`,
      note: NONE_APPLIED,
      related_files: [...new Set(sorted.slice(1).map((c) => c.doc.file))].filter((f) => f !== first.doc.file),
    });
  }
  return winners;
}

const describeRanges = (ranges: TimeRange[]): string => (ranges.length === 0 ? '休業' : ranges.map((r) => `${r.start}-${r.end}`).join(', '));

// ---------------------------------------------------------------- keywords (decision 9)

interface KeywordClaim {
  doc: ParsedInstruction;
  op: KeywordOp;
  words: string[];
  keys: Set<string>;
  line: number;
}

const OP_JA: Record<KeywordOp, string> = { add: '追加', replace: '置換', delete: '削除' };

function listWords(keys: Iterable<string>): string {
  return [...keys].map((k) => `「${k}」`).join('');
}

/** Why two operations in the same layer cannot be applied in either order with the same result; null if they can. */
function keywordConflict(a: KeywordClaim, b: KeywordClaim): string | null {
  if (a.op === b.op) {
    if (a.op !== 'replace') return null;
    const same = a.keys.size === b.keys.size && [...a.keys].every((k) => b.keys.has(k));
    return same ? null : `置換する語の組が違います（${a.doc.file}: ${a.words.join('、')} / ${b.doc.file}: ${b.words.join('、')}）`;
  }
  const [x, y] = a.op === 'replace' || (a.op === 'add' && b.op === 'delete') ? [a, b] : [b, a];
  if (x.op === 'replace' && y.op === 'add') {
    const extra = [...y.keys].filter((k) => !x.keys.has(k));
    return extra.length === 0 ? null : `置換と追加が同時にあり、追加する語${listWords(extra)}が置換の組にありません`;
  }
  const overlap = [...y.keys].filter((k) => x.keys.has(k));
  if (overlap.length === 0) return null;
  return x.op === 'replace' ? `置換する語${listWords(overlap)}を削除しようとしています` : `同じ語${listWords(overlap)}を追加と削除の両方で指定しています`;
}

interface PairConflict {
  a: KeywordClaim;
  b: KeywordClaim;
  reason: string;
  cells: Cell[];
}

// ---------------------------------------------------------------- units (used by the store's last-valid fallback)

/** The parts of a document that can be taken from another version of it independently. */
export type InstructionUnit = `business_hours.${WeekdayKey}` | 'closed_dates' | 'post_window' | 'keywords' | 'excluded_keywords' | 'writing_policies' | `routes.${RouteKey}`;

const HOUR_UNITS: InstructionUnit[] = WEEKDAY_KEYS.map((d): InstructionUnit => `business_hours.${d}`);

/** The units an issue's `item` refers to ([] when it names none). */
export function unitsOfItem(item: string | null): InstructionUnit[] {
  if (item === null) return [];
  if (item === 'business_hours') return [...HOUR_UNITS, 'closed_dates'];
  if ((HOUR_UNITS as string[]).includes(item)) return [item as InstructionUnit];
  if (item === 'closed_dates' || item === 'post_window' || item === 'excluded_keywords') return [item];
  if (item === 'keywords' || item.startsWith('keywords.')) return ['keywords'];
  if (item.startsWith('routes.') && (ROUTE_KEYS as string[]).includes(item.slice('routes.'.length))) return [item as InstructionUnit];
  return [];
}

/**
 * A copy of `doc` with only the given units (`keep` true) or with all but them (`keep` false). A kept-only copy is an
 * older version brought back for those units, so its ignored-content warnings are dropped.
 */
export function selectUnits(doc: ParsedInstruction, units: ReadonlySet<InstructionUnit>, keep: boolean): ParsedInstruction {
  const has = (unit: InstructionUnit): boolean => units.has(unit) === keep;
  const businessHours: ParsedInstruction['business_hours'] = {};
  for (const day of WEEKDAY_KEYS) {
    const value = doc.business_hours[day];
    if (value !== undefined && has(`business_hours.${day}`)) businessHours[day] = value;
  }
  const routes: ParsedInstruction['routes'] = {};
  for (const key of ROUTE_KEYS) {
    const value = doc.routes[key];
    if (value !== undefined && has(`routes.${key}`)) routes[key] = value;
  }
  return {
    ...doc,
    business_hours: businessHours,
    closed_dates: has('closed_dates') ? doc.closed_dates : [],
    post_window: has('post_window') ? doc.post_window : null,
    keywords: has('keywords') ? doc.keywords : null,
    excluded_keywords: has('excluded_keywords') ? doc.excluded_keywords : [],
    writing_policies: has('writing_policies') ? doc.writing_policies : [],
    routes,
    ignored: keep ? [] : doc.ignored,
  };
}

/** The document sets the unit. */
export function hasUnit(doc: ParsedInstruction, unit: InstructionUnit): boolean {
  if (unit.startsWith('business_hours.')) return doc.business_hours[unit.slice('business_hours.'.length) as WeekdayKey] !== undefined;
  if (unit.startsWith('routes.')) return doc.routes[unit.slice('routes.'.length) as RouteKey] !== undefined;
  switch (unit) {
    case 'closed_dates':
      return doc.closed_dates.length > 0;
    case 'post_window':
      return doc.post_window !== null;
    case 'keywords':
      return doc.keywords !== null;
    case 'excluded_keywords':
      return doc.excluded_keywords.length > 0;
    default:
      return doc.writing_policies.length > 0;
  }
}

/** Item names in their canonical order (weekdays, closed dates, post window, keywords, exclusions, policies, URLs). */
export function sortItems(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => ITEM_ORDER.indexOf(a) - ITEM_ORDER.indexOf(b));
}

// ---------------------------------------------------------------- merge

/**
 * Builds the overlay for `now` from the parsed documents (plan decisions 8 and 9). Only enabled documents inside their
 * period contribute; problems are reported for enabled documents that are active or not yet started.
 */
export function mergeInstructions(
  base: ConfigSnapshot,
  docs: readonly ParsedInstruction[],
  now: Date,
  opts: { allowedOrigins: readonly string[]; policy?: UrlPolicy | undefined },
): MergeResult {
  const issues: InstructionIssue[] = [];
  const ignored: InstructionIssue[] = [];
  const items = new Map<ParsedInstruction, Set<string>>();
  const mark = (doc: ParsedInstruction, item: string): void => {
    const set = items.get(doc);
    if (set === undefined) items.set(doc, new Set([item]));
    else set.add(item);
  };

  const live = docs.filter((d) => d.state === 'enabled' && periodState(d.period, now) !== 'expired').sort(byLayer);
  for (const d of live) ignored.push(...d.ignored);
  // A disabled file has warnings only when its 状態 line was malformed (read as 無効); that must not go unnoticed.
  for (const d of docs) if (d.state === 'disabled') ignored.push(...d.ignored);
  const allowed = allowedOriginSet(opts.allowedOrigins, opts.policy);
  const check = (key: RouteKey, url: string): ReturnType<typeof checkRouteUrl> => {
    const [type, audience] = key.split('.') as [PostType, AudienceCategory];
    const id = base.salonboardFields.posting_routes[type][audience].page_profile_id;
    const profile = id === null ? undefined : base.salonboardFields.pages[id];
    return checkRouteUrl(url, allowed, { policy: opts.policy, profile: id === null || profile === undefined ? null : { id, profile } });
  };
  const usable = live.map((d) => checkItems(d, check, issues));
  const active = usable.filter((u) => periodState(u.doc.period, now) === 'active');
  const activeDocs = active.map((u) => u.doc);
  const globalDocs = active.filter((u) => u.global).map((u) => u.doc);

  // Business hours, per weekday (全曜日 was expanded inside each document by the parser).
  const hours: Partial<Record<WeekdayKey, TimeRange[]>> = {};
  for (const day of WEEKDAY_KEYS) {
    const claims: Claim<TimeRange[]>[] = [];
    for (const doc of globalDocs) {
      const value = doc.business_hours[day];
      if (value !== undefined) claims.push({ doc, value: value.ranges, key: JSON.stringify(value.ranges), line: value.line });
    }
    const winners = resolveOverride(claims, `business_hours.${day}`, `${WEEKDAY_JA[day]}の営業時間`, describeRanges, issues);
    if (winners === null) continue;
    hours[day] = winners[0]!.value.map((r) => ({ ...r }));
    for (const w of winners) mark(w.doc, `business_hours.${day}`);
  }

  const closed = new Set<string>();
  for (const doc of globalDocs) {
    if (doc.closed_dates.length === 0) continue;
    for (const d of doc.closed_dates) closed.add(d.date);
    mark(doc, 'closed_dates');
  }

  const windowClaims: Claim<{ start: string; end: string }>[] = [];
  for (const doc of globalDocs) {
    const w = doc.post_window;
    if (w !== null) windowClaims.push({ doc, value: { start: w.start, end: w.end }, key: `${w.start}-${w.end}`, line: w.line });
  }
  const windowWinners = resolveOverride(windowClaims, 'post_window', '投稿時間', (v) => `${v.start}-${v.end}`, issues);
  for (const w of windowWinners ?? []) mark(w.doc, 'post_window');

  const excluded: string[] = [];
  const excludedKeys = new Set<string>();
  for (const doc of globalDocs) {
    if (doc.excluded_keywords.length === 0) continue;
    for (const { word } of doc.excluded_keywords) {
      const key = wordKey(word);
      if (excludedKeys.has(key)) continue;
      excludedKeys.add(key);
      excluded.push(word);
    }
    mark(doc, 'excluded_keywords');
  }

  // Keywords per post type × audience.
  const baseWords = dedupeWords(base.keywords.priority_keywords);
  const keywords = {} as ByCell<string[]>;
  const pairConflicts = new Map<string, PairConflict>();
  for (const cell of CELLS) {
    let current = [...baseWords];
    const claims: KeywordClaim[] = [];
    for (const doc of activeDocs) {
      if (doc.keywords === null || !covers(doc.scope, cell)) continue;
      claims.push({ doc, op: doc.keywords.op, words: doc.keywords.words, keys: new Set(doc.keywords.words.map(wordKey)), line: doc.keywords.line });
    }
    for (const layer of groupBy(claims, (c) => `${c.doc.priority}:${dims(c.doc.scope)}`)) {
      const blocked = new Set<KeywordClaim>();
      for (let i = 0; i < layer.length; i++) {
        for (let j = i + 1; j < layer.length; j++) {
          const [a, b] = [layer[i]!, layer[j]!].sort((x, y) => compareText(x.doc.file, y.doc.file)) as [KeywordClaim, KeywordClaim];
          const reason = keywordConflict(a, b);
          if (reason === null) continue;
          blocked.add(a).add(b);
          const id = `${a.doc.file}\u0000${b.doc.file}\u0000${reason}`;
          const known = pairConflicts.get(id);
          if (known === undefined) pairConflicts.set(id, { a, b, reason, cells: [cell] });
          else known.cells.push(cell);
        }
      }
      const ok = layer.filter((c) => !blocked.has(c));
      const replace = ok.find((c) => c.op === 'replace');
      if (replace !== undefined) {
        current = [...replace.words];
      } else {
        const have = new Set(current.map(wordKey));
        for (const c of ok) {
          if (c.op !== 'add') continue;
          for (const w of c.words) {
            if (have.has(wordKey(w))) continue;
            have.add(wordKey(w));
            current.push(w);
          }
        }
        const removed = new Set(ok.filter((c) => c.op === 'delete').flatMap((c) => [...c.keys]));
        current = current.filter((w) => !removed.has(wordKey(w)));
      }
      for (const c of ok) mark(c.doc, `keywords.${cellId(cell)}`);
    }
    (keywords[cell.type] ??= {} as Record<AudienceCategory, string[]>)[cell.audience] = current.filter((w) => !excludedKeys.has(wordKey(w)));
  }
  for (const { a, b, reason, cells } of pairConflicts.values()) {
    const scope = cells.map(cellJa).join('、');
    issues.push({
      code: 'INSTRUCTION_CONFLICT',
      file: a.doc.file,
      line: a.line,
      item: cells.length === 1 ? `keywords.${cellId(cells[0]!)}` : 'keywords',
      message: `${at(a.doc.file, a.line)}（${OP_JA[a.op]}）と ${at(b.doc.file, b.line)}（${OP_JA[b.op]}）は優先度 ${a.doc.priority} が同じで、${scope} の検索ワードが食い違っています: ${reason}。指示をそろえるか、優先したい指示書の優先度を上げてください`,
      note: NONE_APPLIED,
      related_files: [b.doc.file],
    });
  }

  // Writing policies: concatenated, capped per cell; the lowest layers give way first.
  const policies = {} as ByCell<string[]>;
  const dropped = new Map<string, { doc: ParsedInstruction; line: number; reason: 'count' | 'chars'; cells: Cell[] }>();
  for (const cell of CELLS) {
    const all: { doc: ParsedInstruction; text: string; line: number }[] = [];
    for (const doc of activeDocs) {
      if (!covers(doc.scope, cell)) continue;
      for (const p of doc.writing_policies) all.push({ doc, text: p.text, line: p.line });
    }
    const seen = new Set<string>();
    const unique = all.reverse().filter((p) => {
      const key = wordKey(p.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }); // highest layer first
    const kept: typeof unique = [];
    let chars = 0;
    for (const p of unique) {
      const len = [...p.text].length;
      if (kept.length < MAX_POLICY_BULLETS && chars + len <= MAX_POLICY_CHARS) {
        kept.push(p);
        chars += len;
        continue;
      }
      const reason = kept.length >= MAX_POLICY_BULLETS ? 'count' : 'chars';
      const id = `${p.doc.file}\u0000${p.line}\u0000${reason}`;
      const known = dropped.get(id);
      if (known === undefined) dropped.set(id, { doc: p.doc, line: p.line, reason, cells: [cell] });
      else known.cells.push(cell);
    }
    kept.reverse();
    (policies[cell.type] ??= {} as Record<AudienceCategory, string[]>)[cell.audience] = kept.map((p) => p.text);
    for (const p of kept) mark(p.doc, `writing_policies.${cellId(cell)}`);
  }
  for (const d of dropped.values()) {
    const limit = d.reason === 'count' ? `項目数の上限（${MAX_POLICY_BULLETS}項目）` : `文字数の上限（合計${MAX_POLICY_CHARS}文字）`;
    ignored.push({
      code: IGNORED_CONTENT_CODE,
      file: d.doc.file,
      line: d.line,
      item: 'writing_policies',
      message: `${at(d.doc.file, d.line)}: 文章方針が1つの範囲の${limit}を超えるため、この方針は ${d.cells.map(cellJa).join('、')} では使いません（優先度の低いものから外しています）。方針を短くまとめるか、数を減らしてください`,
      note: null,
      related_files: [],
    });
  }

  const routes: Partial<Record<RouteKey, string>> = {};
  for (const key of ROUTE_KEYS) {
    const claims: Claim<string>[] = [];
    for (const u of active) {
      const route = u.routes[key];
      if (route !== undefined) claims.push({ doc: u.doc, value: route.url, key: route.url, line: route.line });
    }
    const winners = resolveOverride(claims, `routes.${key}`, `投稿先URL「${ROUTE_LABELS[key]}」`, null, issues);
    if (winners === null) continue;
    routes[key] = winners[0]!.value;
    for (const w of winners) mark(w.doc, `routes.${key}`);
  }

  const effective: EffectiveOverlay = { closed_dates_add: [...closed].sort(), keywords, excluded_keywords: excluded, writing_policies: policies, routes };
  if (Object.keys(hours).length > 0) {
    const baseHours = base.schedule.business_hours;
    effective.business_hours = Object.fromEntries(
      WEEKDAY_KEYS.map((day) => [day, (hours[day] ?? baseHours?.[day] ?? [UNRESTRICTED]).map((r) => ({ start: r.start, end: r.end }))]),
    ) as BusinessHours;
  }
  const window = windowWinners?.[0]?.value;
  if (window !== undefined) effective.post_window = { ...window };

  const applied: AppliedRef[] = [...items.entries()]
    .map(([doc, set]) => ({
      file: doc.file,
      sha256: doc.sha256,
      priority: doc.priority,
      scope: { ...doc.scope },
      period: { ...doc.period },
      items: sortItems(set),
    }))
    .sort((a, b) => compareText(a.file, b.file));

  return { effective, issues: issues.sort(byFileLine), applied, ignored: ignored.sort(byFileLine) };
}

function byFileLine(a: InstructionIssue, b: InstructionIssue): number {
  return compareText(a.file, b.file) || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
}
