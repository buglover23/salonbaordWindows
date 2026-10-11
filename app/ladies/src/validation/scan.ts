import { looseKey, wordOccurrences } from '../ai/word-rules.js';
import { normalizeForCompare } from '../shared/text-normalize.js';

// Word matching for the Validator. Two keys:
// - looseKey (NFKC, lower case, no whitespace): forbidden words and claims, so 必ず also matches 必 ず and 必ず！;
// - compactKey (also without punctuation and symbols): dictionary words, so ショート・ボブ is the word ショートボブ.

export type KeyFn = (s: string) => string;

export { looseKey };

export const compactKey: KeyFn = (s) => normalizeForCompare(s).replace(/\s+/gu, '');

interface Span {
  start: number;
  end: number;
}

/** Where the word `needle` occurs in `hay`: the generator's wordOccurrences (ブリーチレスキュー holds no ブリーチレス). */
function spans(hay: string, needle: string): Span[] {
  return needle === '' ? [] : wordOccurrences(hay, needle).map((start) => ({ start, end: start + needle.length }));
}

const inside = (a: Span, b: Span): boolean => b.start <= a.start && a.end <= b.end;

/**
 * The terms `text` contains, compared on `key` (default looseKey). An occurrence does not count when it lies inside an
 * occurrence of a longer term of the same list (アッシュ inside アッシュグレージュ: only the longer word is found) or inside
 * an occurrence of a `covers` phrase (必ず inside 必ずしも; ブリーチ inside a verified ブリーチなしカラー). Terms and covers are
 * matched as words, like findUnverifiedTreatment (ruling P2-R12): the ブリーチレス of ブリーチレスキュー neither counts nor
 * covers its ブリーチ. Each term once, in the order first found; terms with the same key are one term (the first spelling).
 */
export function scanTerms(text: string, terms: readonly string[], o: { covers?: readonly string[]; key?: KeyFn } = {}): string[] {
  const key = o.key ?? looseKey;
  const k = key(text);
  if (k === '') return [];
  const byKey = new Map<string, string>();
  for (const t of terms) {
    const tk = key(t);
    if (tk !== '' && !byKey.has(tk)) byKey.set(tk, t);
  }
  const found = [...byKey].flatMap(([tk, term]) => spans(k, tk).map((s) => ({ ...s, term, len: tk.length })));
  const covers = (o.covers ?? []).map(key).flatMap((c) => spans(k, c));
  const kept = found.filter((f) => !found.some((g) => g.len > f.len && inside(f, g)) && !covers.some((c) => inside(f, c)));
  kept.sort((a, b) => a.start - b.start || b.len - a.len);
  return [...new Set(kept.map((f) => f.term))];
}

/** Whether `text` contains `term` anywhere (looseKey containment). */
export const containsTerm = (text: string, term: string): boolean => {
  const t = looseKey(term);
  return t !== '' && looseKey(text).includes(t);
};
