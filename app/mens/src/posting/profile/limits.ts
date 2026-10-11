import type { WritingRules } from '../../config/schemas.js';
import type { PageProfile } from '../../shared/protocol/profile.js';
import { measureLength, type CountUnit } from '../../shared/text.js';
import type { PostType } from '../../shared/types.js';

// Effective text limits (Plan 2 decision 10, Plan 3 Task 3): the writing-rules defaults and, once the route's page profile
// is verified, the profile's limits; a text must pass all of them (never only the looser one).

export type Encoding = PageProfile['encoding'];
export type LimitedField = 'title' | 'menu_text' | 'stylist_comment' | 'body' | 'hashtags';

export interface LimitSpec {
  max: number;
  unit: CountUnit;
  /** A line break counts as this many (the page's counter may count CRLF as 2); 1 when omitted. */
  newline_weight?: 1 | 2;
  /** For `bytes`: the page's encoding; UTF-8 when omitted. */
  encoding?: Encoding;
  /** A separate cap on line breaks (the blog body: 改行80回以下). */
  max_newlines?: number;
}

const isSingleByteSjis = (cp: number): boolean => cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f);

/** The length of `text` (CRLF counted as one line break) in `unit`; `bytes` are UTF-8, or Shift_JIS for those encodings. */
export function countLength(text: string, unit: CountUnit, newlineWeight: 1 | 2 = 1, encoding: Encoding = 'utf-8'): number {
  const t = text.replace(/\r\n?/g, '\n');
  const extra = (newlineWeight - 1) * (t.split('\n').length - 1);
  if (unit === 'bytes' && encoding !== 'utf-8') return [...t].reduce((n, ch) => n + (isSingleByteSjis(ch.codePointAt(0) ?? 0) ? 1 : 2), 0) + extra;
  return measureLength(t, unit) + extra;
}

/** `text` measured the way `limit` counts it. */
export const limitLength = (text: string, limit: LimitSpec): number => countLength(text, limit.unit, limit.newline_weight ?? 1, limit.encoding ?? 'utf-8');

let sjis: Set<string> | null = null;

// Every character the Shift_JIS (Windows-31J) form encoding can carry: ASCII, half-width katakana, and whatever the
// platform decoder yields for each double-byte code (built once).
function sjisCharacters(): Set<string> {
  if (sjis !== null) return sjis;
  const set = new Set<string>();
  const decoder = new TextDecoder('shift_jis');
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '�') set.add(ch);
    }
  }
  sjis = set;
  return set;
}

/** The characters of `text` the page's encoding cannot carry (each once, in order); empty for UTF-8. */
export function unencodable(text: string, encoding: Encoding): string[] {
  if (encoding === 'utf-8') return [];
  const set = sjisCharacters();
  const out = new Set<string>();
  for (const ch of text) {
    if (!isSingleByteSjis(ch.codePointAt(0) ?? 0) && !set.has(ch)) out.add(ch);
  }
  return [...out];
}

/** Every text can be carried by the page's encoding. */
export const encodable = (text: string, encoding: Encoding): boolean => unencodable(text, encoding).length === 0;

const FIELDS: Record<PostType, readonly LimitedField[]> = { style: ['title', 'menu_text', 'stylist_comment', 'hashtags'], blog: ['title', 'body', 'hashtags'] };

// Limits in the same unit (and, for bytes, encoding) merge into one at least as strict as both.
const countedAs = (l: LimitSpec): string => `${l.unit}|${l.unit === 'bytes' ? (l.encoding ?? 'utf-8') : ''}`;

/**
 * Per field, every limit a text must pass: the writing-rules default (as configured, a line break counted once) and the
 * verified profile's (null: the defaults alone). Limits in the same unit merge: the smaller maximum, the heavier line
 * break and the smaller line-break cap.
 */
export function effectiveLimits(profile: PageProfile | null, defaults: WritingRules['default_limits'], postType: PostType): Partial<Record<LimitedField, LimitSpec[]>> {
  const base: Partial<Record<LimitedField, LimitSpec>> =
    postType === 'style'
      ? { title: { max: defaults.style.title, unit: defaults.count_unit }, stylist_comment: { max: defaults.style.stylist_comment, unit: defaults.count_unit }, menu_text: { max: defaults.style.menu_text, unit: defaults.count_unit } }
      : { title: { max: defaults.blog.title, unit: defaults.count_unit }, body: { max: defaults.blog.body, unit: defaults.count_unit, max_newlines: defaults.blog.body_max_newlines } };
  const out: Partial<Record<LimitedField, LimitSpec[]>> = {};
  for (const field of FIELDS[postType]) {
    const list: LimitSpec[] = base[field] === undefined ? [] : [{ ...base[field] }];
    const p = profile?.limits[field];
    if (profile !== null && p !== undefined) {
      const spec: LimitSpec = { max: p.max_length, unit: p.count_unit, newline_weight: p.newline_weight };
      if (p.count_unit === 'bytes') spec.encoding = profile.encoding;
      if (p.max_newlines !== undefined) spec.max_newlines = p.max_newlines;
      const same = list.find((l) => countedAs(l) === countedAs(spec));
      if (same === undefined) list.push(spec);
      else {
        same.max = Math.min(same.max, spec.max);
        if (spec.newline_weight === 2) same.newline_weight = 2;
        if (spec.max_newlines !== undefined) same.max_newlines = Math.min(same.max_newlines ?? spec.max_newlines, spec.max_newlines);
      }
    }
    if (list.length > 0) out[field] = list;
  }
  return out;
}
