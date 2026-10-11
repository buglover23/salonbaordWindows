import { graphemeLength } from '../shared/text.js';

// Word rules shared by the generation context, the generator's normalisation, the dry-run mock and the Validator
// (Plan 2 Task 8), so that every step judges a word the same way.

/** Exact-match key (spec 5.10 / decision 9): NFKC, whitespace collapsed, trimmed. */
export const wordKey = (s: string): string => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();

/** Containment key: NFKC, lower-case, without whitespace. */
export const looseKey = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

export const MAX_TAG_GRAPHEMES = 30;

/** Letters (ー and 々 are letters), marks, digits and '_' only: no space, '#', punctuation, symbol, emoji or control. */
const TAG_CHARS = /^[\p{L}\p{M}\p{N}_]+$/u;
/** Marks and letters that still render invisibly or as pictures (keycaps, variation selectors, fillers). */
const TAG_HIDDEN = /[\p{Me}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/**
 * One hashtag word without its leading '#': letters, marks, digits and '_' only (・／、。, symbols, emoji, angle
 * brackets, zero-width, bidi and private-use characters would break the tag or hide text in the posted comment), at
 * most MAX_TAG_GRAPHEMES; null when unusable.
 */
export function cleanTagWord(raw: string): string | null {
  const s = raw.trim().replace(/^[#＃]+/u, '').trim();
  if (s === '' || !TAG_CHARS.test(s) || TAG_HIDDEN.test(s) || graphemeLength(s) > MAX_TAG_GRAPHEMES) return null;
  return s;
}

/** Keeps the longest of the matched words (by looseKey length); the earlier one on a tie. */
function longer(best: { word: string; len: number } | null, word: string, len: number): { word: string; len: number } {
  return best !== null && best.len >= len ? best : { word, len };
}

/**
 * The longest of `words` that `text` contains (looseKey containment; the earlier word on a tie), or null. Reporting
 * the longest names the whole phrase (デジタルパーマ, not the パーマ inside it).
 */
export function findWord(text: string, words: readonly string[]): string | null {
  const k = looseKey(text);
  let best: { word: string; len: number } | null = null;
  for (const w of words) {
    const wk = looseKey(w);
    if (wk !== '' && k.includes(wk)) best = longer(best, w, wk.length);
  }
  return best?.word ?? null;
}

/** Every start index of `needle` (non-empty) in `hay`, overlaps included. */
export function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/**
 * Every start index of the word `word` in `hay` (both on looseKey; overlaps included): occurrences, except that a word
 * ending in レス (-less: ブリーチレス) does not count where キュ follows, because レスキュー (rescue: ブリーチレスキュー, a
 * care for bleached hair) is another word. Treatment checks (findUnverifiedTreatment) match with this.
 */
export function wordOccurrences(hay: string, word: string): number[] {
  const at = occurrences(hay, word);
  return word.endsWith('レス') ? at.filter((i) => !hay.startsWith('キュ', i + word.length)) : at;
}

/**
 * The longest unverified treatment term that `text` states (ruling P2-R5, spec 6.2 / 9.8; the earlier term on a tie,
 * so ツイストパーマ is reported as itself, not as the ストパー inside it), or null. An occurrence of a
 * term does not count when it lies inside an occurrence of a phrase verified for this photo: with メンズパーマ verified,
 * the パーマ inside メンズパーマ is fine while a bare パーマ or デジタルパーマ is still a claim. A shorter verified phrase
 * never covers a longer term (ツイスト does not cover ツイストスパイラル). Compared by looseKey; words are matched with
 * wordOccurrences (the ブリーチレス of ブリーチレスキュー neither covers its ブリーチ nor counts as ブリーチレス).
 */
export function findUnverifiedTreatment(text: string, unverified: readonly string[], verified: readonly string[]): string | null {
  const k = looseKey(text);
  if (k === '') return null;
  const covers = verified
    .map(looseKey)
    .filter((v) => v !== '')
    .flatMap((v) => wordOccurrences(k, v).map((start) => ({ start, end: start + v.length })));
  let best: { word: string; len: number } | null = null;
  for (const term of unverified) {
    const t = looseKey(term);
    if (t === '') continue;
    if (wordOccurrences(k, t).some((start) => !covers.some((c) => c.start <= start && start + t.length <= c.end))) best = longer(best, term, t.length);
  }
  return best?.word ?? null;
}

/**
 * Every unverified treatment term that `text` states, in text order (for the owner's messages): findUnverifiedTreatment
 * repeatedly, each found term then covering its own occurrences, so a term inside a longer one already found is not
 * listed again (ブリーチなしカラー, not also the ブリーチ inside it) while one written elsewhere still is.
 */
export function findUnverifiedTreatments(text: string, unverified: readonly string[], verified: readonly string[]): string[] {
  const k = looseKey(text);
  const covering = [...verified];
  const found: { word: string; at: number }[] = [];
  for (let word = findUnverifiedTreatment(text, unverified, covering); word !== null; word = findUnverifiedTreatment(text, unverified, covering)) {
    const covered = covering.map(looseKey).filter((v) => v !== '');
    const w = looseKey(word);
    const at = wordOccurrences(k, w).find((start) => !covered.some((v) => wordOccurrences(k, v).some((c) => c <= start && start + w.length <= c + v.length))) ?? 0;
    found.push({ word, at });
    covering.push(word);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.word);
}

/**
 * Salon facts and claims a generated hashtag must never state, and the Validator (Task 8) rejects anywhere in a post
 * unless the salon's config states them (spec 9.1, 9.8, 9.9): prices and discounts, campaigns, popularity, rankings,
 * reviews, results, reservations and availability, opening hours, and access. Matched on looseKey (NFKC, lower-case).
 */
export const SALON_FACT_PATTERNS: readonly RegExp[] = [
  /[\d千万]円/u,
  /[¥$]\d/u,
  /\d(?:%|パーセント)/u,
  /\doff/u,
  /半額|割引|値引|クーポン|キャンペーン|特典|無料|限定/u,
  // Every バズ (バズった, バズ中, 大バズ, バズヘア) except the men's style name バズカット (matched after NFKC: ﾊﾞｽﾞｶｯﾄ too).
  /人気|no\.?1|ナンバーワン|\d位|ランキング|話題|急上昇|最新|バズ(?!カット)/u,
  /口コミ|クチコミ|レビュー|高評価|実績|\dpv/u,
  /予約|空席|空き枠/u,
  /営業時間|定休|年中無休|\d時(?!間)/u,
  /駅|徒歩|駐車場/u,
];

/**
 * The first salon-fact wording in `text` (SALON_FACT_PATTERNS), or null. Phrases in `verifiedFacts` (e.g.
 * salon.location_keywords, salon.strengths) are taken out first: the config states them.
 */
export function findSalonFact(text: string, verifiedFacts: readonly string[] = []): string | null {
  return findSalonFacts(text, verifiedFacts)[0] ?? null;
}

/** Every distinct salon-fact wording in `text` (in SALON_FACT_PATTERNS order), after taking out `verifiedFacts`. */
export function findSalonFacts(text: string, verifiedFacts: readonly string[] = []): string[] {
  let k = looseKey(text);
  for (const fact of verifiedFacts.map(looseKey).filter((f) => f !== '').sort((a, b) => b.length - a.length)) k = k.split(fact).join(' ');
  const found: string[] = [];
  for (const re of SALON_FACT_PATTERNS) {
    for (const m of k.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

/**
 * Face shapes (spec 9.4, 6.2): only general suggestions in a sentence (丸顔さんにも合わせやすい). A bare tag such as
 * #面長 under the photo reads as a statement about the person, so these never become hashtags.
 */
export const FACE_SHAPE_TERMS: readonly string[] = ['丸顔', '面長', '卵型', 'たまご型', '逆三角形', 'ベース型', 'ベース顔', '四角顔', '三角顔'];

/** Spec 9.4: the salon's hair consulting; never written when salon.service_claims.hair_consulting is false. */
export const HAIR_CONSULTING = 'ヘアコンサルティング';
