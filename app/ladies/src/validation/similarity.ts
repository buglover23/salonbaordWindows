import { comparisonHash } from '../shared/hash.js';
import { normalizeForCompare } from '../shared/text-normalize.js';

// Comparison helpers of spec 10.3 / 9.9. Only comparison strings are normalised (NFKC, lower case, symbols removed,
// whitespace collapsed); the original text is never changed.

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** Spec 10.3 comparison text. */
export const comparisonText = (s: string): string => normalizeForCompare(s);

/** The comparison text as graphemes, without spaces (n-grams and edit distances). */
export function comparisonChars(s: string): string[] {
  return [...segmenter.segment(normalizeForCompare(s).replace(/\s+/gu, ''))].map((x) => x.segment);
}

/** Hash of a title or primary text for exact-duplicate checks (the value dedupe.json and history.json store). */
export const textHash = comparisonHash;

/** Character n-grams; a text shorter than n gives itself as its only gram (empty text: no grams). */
export function ngrams(chars: readonly string[], n: number): Set<string> {
  if (chars.length === 0) return new Set();
  if (chars.length < n) return new Set([chars.join('')]);
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(''));
  return out;
}

/** |A ∩ B| / |A ∪ B|; two empty sets count as identical (1). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Edit distance (insert, delete, substitute) between two grapheme lists. */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Edit distance divided by the longer length (0 = equal, 1 = nothing in common). */
export function normalizedLevenshtein(a: readonly string[], b: readonly string[]): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 0 : levenshtein(a, b) / longer;
}

/** Spec 10.3 / Plan 2 decision 12: texts shorter than this (graphemes, comparison form) use exact + edit distance. */
export const SHORT_TEXT_GRAPHEMES = 15;
export const SHORT_TEXT_MAX_EDITS = 2;

export type SimilarityKind = 'title' | 'body';

export interface SimilarityResult {
  /** Jaccard similarity (character bigrams for titles, trigrams for bodies), or 1 - normalised edit distance for short texts. */
  similarity: number;
  method: 'jaccard' | 'edit_distance';
  /** Edit distance; only for short texts. */
  edits: number | null;
  near: boolean;
}

/**
 * Near-duplicate test of spec 10.3: when the shorter text has fewer than SHORT_TEXT_GRAPHEMES graphemes, exact match or
 * at most SHORT_TEXT_MAX_EDITS edits; otherwise Jaccard ≥ threshold (titles: bigrams, bodies: trigrams). A value
 * exactly at the threshold is a near-duplicate.
 */
export function compareTexts(a: string, b: string, kind: SimilarityKind, threshold: number): SimilarityResult {
  const x = comparisonChars(a);
  const y = comparisonChars(b);
  if (Math.min(x.length, y.length) < SHORT_TEXT_GRAPHEMES) {
    const edits = levenshtein(x, y);
    return { similarity: 1 - normalizedLevenshtein(x, y), method: 'edit_distance', edits, near: edits <= SHORT_TEXT_MAX_EDITS && Math.max(x.length, y.length) > 0 };
  }
  const n = kind === 'title' ? 2 : 3;
  const similarity = jaccard(ngrams(x, n), ngrams(y, n));
  return { similarity, method: 'jaccard', edits: null, near: similarity >= threshold };
}

// ---------------------------------------------------------------- sentences (spec 9.9)

/** Two sentences whose normalised edit distance is at most this are the same sentence reworded slightly. */
export const SENTENCE_NEAR_RATIO = 0.2;

/** Variant → canonical word, applied longest first, for the synonym-only rewrite check. */
const SYNONYMS: readonly (readonly [string, readonly string[]])[] = [
  ['カウンセリング', ['ヘアコンサルティング', 'コンサルティング']],
  ['相談', ['ご相談']],
  ['気軽', ['お気軽']],
  ['ください', ['下さい']],
  ['おすすめ', ['オススメ', 'お勧め', 'お薦め', 'お奨め']],
  ['スタイル', ['ヘアスタイル', '髪型', 'ヘア']],
  ['かわいい', ['可愛い', 'カワイイ']],
  ['きれい', ['綺麗', 'キレイ']],
  ['すてき', ['素敵', 'ステキ']],
  ['提案', ['ご提案']],
  ['来店', ['ご来店']],
  ['待ちしています', ['待ちしております']],
  ['簡単', ['手軽', 'ラク']],
  ['印象', ['雰囲気']],
  ['仕上がり', ['仕上げ']],
  ['扱いやすい', ['まとまりやすい', 'セットしやすい', '再現しやすい']],
  ['ぜひ', ['是非']],
  ['画像', ['写真']],
  ['ブックマーク', ['保存']],
];

// The canonical word maps to itself too, so it is protected from particle removal like a replaced variant.
const SYNONYM_PAIRS: readonly (readonly [string, string])[] = SYNONYMS.flatMap(([canonical, variants]) =>
  [canonical, ...variants].map((v) => [normalizeForCompare(v), normalizeForCompare(canonical)] as const),
).sort((a, b) => b[0].length - a[0].length);

/** Particles dropped by the rewrite key (one character each). */
const PARTICLES = /[はがをにでとのへもやねよ]/gu;

/** The comparison text with synonyms made canonical and particles removed: equal keys = a synonym-only rewrite. */
export function rewriteKey(s: string): string {
  let k = normalizeForCompare(s).replace(/\s+/gu, '');
  // Placeholders (# never survives normalisation), so a canonical word is never rewritten again by a shorter variant.
  const found: string[] = [];
  for (const [variant, canonical] of SYNONYM_PAIRS) {
    if (!k.includes(variant)) continue;
    k = k.split(variant).join(`#${found.length}#`);
    found.push(canonical);
  }
  k = k.replace(PARTICLES, '');
  return k.replace(/#(\d+)#/gu, (_, i: string) => found[Number(i)] ?? '');
}

export interface SentenceRepeat {
  /** The earlier sentence it repeats. */
  match: string;
  /** near: the same sentence or a slight rewording; synonym: only particles, symbols or synonyms changed. */
  kind: 'near' | 'synonym';
}

const graphemes = (s: string): string[] => [...segmenter.segment(s)].map((x) => x.segment);

/** At most SENTENCE_NEAR_RATIO edits apart (skipping the distance when the lengths alone rule it out). */
function near(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const longer = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) / longer > SENTENCE_NEAR_RATIO) return false;
  return levenshtein(a, b) / longer <= SENTENCE_NEAR_RATIO;
}

/**
 * A reusable test for repeats of `earlier` (spec 9.9): equal after comparison normalisation or at most
 * SENTENCE_NEAR_RATIO edits apart; with `synonyms`, also when only particles, symbols or listed synonyms differ.
 * The earlier sentences are normalised once.
 */
export function repeatFinder(earlier: readonly string[], o: { synonyms: boolean }): (sentence: string) => SentenceRepeat | null {
  const prepared = earlier.map((text) => ({ text, chars: comparisonChars(text), rewrite: o.synonyms ? graphemes(rewriteKey(text)) : [] }));
  return (sentence) => {
    const own = comparisonChars(sentence);
    if (own.length === 0) return null;
    for (const p of prepared) if (near(own, p.chars)) return { match: p.text, kind: 'near' };
    if (!o.synonyms) return null;
    const ownRewrite = graphemes(rewriteKey(sentence));
    for (const p of prepared) if (near(ownRewrite, p.rewrite)) return { match: p.text, kind: 'synonym' };
    return null;
  };
}

/** Whether `sentence` repeats one of `earlier` (repeatFinder for a single sentence). */
export function findRepeatedSentence(sentence: string, earlier: readonly string[], o: { synonyms: boolean }): SentenceRepeat | null {
  return repeatFinder(earlier, o)(sentence);
}
