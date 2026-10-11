import { sha256Hex } from '../shared/hash.js';
import { graphemeLength } from '../shared/text.js';
import { normalizeForCompare } from '../shared/text-normalize.js';
import type { HairLength } from './analysis-schema.js';
import {
  CONTENT_ANGLES,
  TITLE_PATTERNS,
  renderHashtags,
  type BlogDraftOutput,
  type ContentAngle,
  type CtaPattern,
  type StyleDraftOutput,
  type TitlePattern,
} from './draft-schemas.js';
import { repeatFinder } from '../validation/similarity.js';
import type { GenerationRequestMeta } from './generator.js';
import { FACE_SHAPE_TERMS, cleanTagWord, findSalonFact, findUnverifiedTreatment, findWord } from './word-rules.js';

// A realistic, deterministic dry-run draft built only from the request meta (Plan 2 decision 2): the context's category,
// verified menus, hashtag candidates and limits, varied by the seed (job id + attempt) and steering clear of the recent
// titles, openings, calls to action and title/angle pairs, so a default dry-run produces drafts a reasonable Validator
// accepts.

/** Titles at least this similar (character-bigram Jaccard) to a recent title are not used (Task 8 rejects ≥ 0.85). */
const MAX_TITLE_SIMILARITY = 0.8;
/** The text is chosen so that the title and text use at least this many search keywords (the prompt asks for 3-8). */
const MIN_KEYWORDS = 3;

type Meta = GenerationRequestMeta;

const LENGTH_JA: Record<HairLength, string> = {
  very_short: 'ベリーショート',
  short: 'ショート',
  bob: 'ボブ',
  medium: 'ミディアム',
  long: 'ロング',
  very_long: 'ロング',
  unknown: '',
};

/** Spec 9.3 positive expressions in adnominal form (they describe how the style looks). */
const MODIFIERS = {
  ladies: ['ふんわり', '軽やかな', '上品な', '大人可愛い', 'こなれ感のある', 'ナチュラルな', '柔らかな', 'ツヤ感のある', '抜け感のある', '立体感のある', 'すっきり', 'まとまりやすい'],
  mens: ['さわやかな', '清潔感のある', 'こなれ感のある', 'ナチュラルな', '大人っぽい', '軽やかな', '立体感のある', 'すっきり', 'セットしやすい', 'ラフな', '洗練された', '束感のある'],
} as const;

const OPENING_LABEL: Record<ContentAngle, string> = {
  concern: '悩みへの共感から',
  finish: '仕上がりの特徴から',
  season: '季節の話題から',
  care: 'お手入れの楽さから',
  consult: '似合わせの提案から',
};

class Picker {
  readonly #seed: string;

  constructor(seed: string) {
    this.#seed = seed;
  }

  /** A number in [0, 1) fixed by the seed and the label. */
  random(label: string): number {
    return Number.parseInt(sha256Hex(`${this.#seed}\u0000${label}`).slice(0, 8), 16) / 0x1_0000_0000;
  }

  /** The list in an order fixed by the seed and the label. */
  order<T>(list: readonly T[], label: string): T[] {
    return list
      .map((item, i) => ({ item, key: this.random(`${label}\u0000${i}`) }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item);
  }
}

/** Adnominal form of an analysis impression (柔らかい → 柔らかい, 清潔感 → 清潔感のある, 上品 → 上品な). */
function adnominal(word: string): string {
  if (/い$/u.test(word)) return word;
  if (/感$/u.test(word)) return `${word}のある`;
  if (/な/u.test(word)) return `${word}の`;
  return `${word}な`;
}

interface Slots {
  cat: string;
  features: string[];
  length: string;
  color: string;
  season: string;
  modifiers: string[];
  consulting: string;
}

/** The context words a draft may build on; a colour word that is an unverified treatment (ハイトーン) is left out. */
function slotsOf(m: Meta, bad: (t: string) => boolean): Slots {
  const cat = m.category.label;
  const key = (s: string): string => s.normalize('NFKC');
  const features = m.analysis.style_features.filter((f) => !key(cat).includes(key(f)) && !key(f).includes(key(cat)));
  const stem = m.analysis.observed_color === 'unknown' || m.analysis.observed_color === 'その他' ? '' : m.analysis.observed_color.replace(/系$/u, '');
  const color = stem !== '' && bad(stem) ? '' : stem;
  const useSeason = m.use_season && m.season.words.length > 0;
  return {
    cat,
    features: features.length > 0 ? features : [LENGTH_JA[m.analysis.hair_length] || cat],
    length: LENGTH_JA[m.analysis.hair_length],
    color,
    season: useSeason ? (m.season.words[0] ?? '') : '',
    modifiers: [...m.analysis.impressions.map(adnominal), ...MODIFIERS[m.audience_category]],
    consulting: m.include_hair_consulting ? 'ヘアコンサルティング' : 'カウンセリング',
  };
}

/** A forbidden word, or an unverified treatment outside a verified phrase (メンズパーマ is fine when verified). */
const forbiddenIn =
  (m: Meta) =>
  (text: string): boolean =>
    findWord(text, m.forbidden_words) !== null || findUnverifiedTreatment(text, m.unverified_treatments, m.verified_treatments) !== null;

function bigrams(s: string): Set<string> {
  const chars = [...normalizeForCompare(s).replace(/\s+/gu, '')];
  return new Set(chars.slice(0, -1).map((c, i) => `${c}${chars[i + 1] ?? ''}`));
}

function similarity(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : [...a].filter((g) => b.has(g)).length / union;
}

type Template = (s: Slots, mod: string, feature: string) => string | null;

const TITLES: Record<TitlePattern, Template[]> = {
  style_name: [
    (s, mod, f) => `${mod}${f}×${s.cat}`,
    (s, mod, f) => `${f}が映える${mod}${s.cat}`,
    (s, mod) => (s.length === '' ? null : `${mod}${s.length}の${s.cat}`),
    (s, mod, f) => `${s.cat}×${f}の${mod}スタイル`,
  ],
  concern: [
    (s, mod, f) => `朝のセットが楽な${mod}${f}${s.cat}`,
    (s, mod) => (s.length === '' ? null : `広がりにくい${mod}${s.length}${s.cat}`),
    (s, mod, f) => `顔周りすっきり${mod}${f}${s.cat}`,
    (s, mod, f) => `扱いやすさ重視の${mod}${f}${s.cat}`,
    (s, mod) => `まとまりにくい髪にも${mod}${s.cat}`,
  ],
  finish: [
    (s, mod) => `${mod}印象の${s.color}${s.cat}`,
    (s, mod, f) => `抜け感が出る${mod}${f}${s.cat}`,
    (s, mod) => (s.color === '' ? null : `${s.color}が引き立つ${mod}${s.cat}`),
    (s, mod, f) => `${mod}質感の${f}${s.cat}`,
  ],
  season: [
    (s, mod) => (s.season === '' ? null : `${s.season}に似合う${mod}${s.cat}`),
    (s, mod, f) => (s.season === '' ? null : `${s.season}の${mod}${f}${s.cat}`),
    (s, mod) => (s.season === '' ? null : `${s.season}におすすめ${mod}${s.color}${s.cat}`),
    (s, mod, f) => (s.season === '' ? null : `${s.season}らしい${mod}${f}スタイル`),
  ],
  age_target: [
    (s, mod) => `20代30代にも◎${mod}${s.cat}`,
    (s, mod, f) => `大人に似合う${mod}${f}${s.cat}`,
    (s, mod, f) => `30代40代にも◎${mod}${f}${s.cat}`,
    (s, mod) => `大人世代の${mod}${s.cat}`,
  ],
};

const OPENINGS: Record<ContentAngle, Template[]> = {
  concern: [
    (s) => `朝のセットに時間をかけたくない方にも扱いやすい${s.cat}です。`,
    (s, _mod, f) => `広がりやすさが気になる方に、${f}でまとまりを出した${s.cat}です。`,
    (s, _mod, f) => `顔周りの印象を変えたい方に、${f}を取り入れた${s.cat}です。`,
  ],
  finish: [
    (s, mod, f) => `${f}で${mod}印象に仕上げた${s.cat}です。`,
    (s, mod, f) => (s.color === '' ? null : `${s.color}の色味と${f}で${mod}雰囲気にまとめました。`),
    (s, mod) => (s.length === '' ? null : `${mod}質感が引き立つ${s.length}の${s.cat}です。`),
  ],
  season: [
    (s, mod) => (s.season === '' ? null : `${s.season}の装いにもなじむ${mod}${s.cat}です。`),
    (s, _mod, f) => (s.season === '' ? null : `${s.season}に向けて${f}で軽さを出した${s.cat}です。`),
    (s, mod) => (s.season === '' ? null : `${s.season}らしい${mod}雰囲気の${s.cat}です。`),
  ],
  care: [
    (s, _mod, f) => `乾かすだけでまとまりやすい${f}の${s.cat}です。`,
    (s) => (s.length === '' ? null : `毎日のお手入れがしやすい${s.length}の${s.cat}です。`),
    (_s, _mod, f) => `ブローが簡単で再現しやすい${f}が魅力です。`,
  ],
  consult: [
    (s) => `似合わせを大切にしたい方におすすめの${s.cat}です。`,
    (_s, _mod, f) => `${f}の入れ方はご希望に合わせて調整できます。`,
    (s) => `骨格や髪質に合わせて調整しやすい${s.cat}です。`,
  ],
};

const BENEFITS: Template[] = [
  (_s, mod) => `顔周りに動きが出て${mod}印象に見えます。`,
  (s) => (s.length === '' ? null : `${s.length}の長さで重く見えにくいのも魅力です。`),
  () => '毎朝のスタイリングも手軽に再現できます。',
  () => 'オンにもオフにも合わせやすいスタイルです。',
  () => '立体感が出て頭の形をきれいに見せてくれます。',
];

const CTAS: Record<CtaPattern, ((s: Slots) => string)[]> = {
  style_consult: [
    (s) => `${s.consulting}でなりたい雰囲気をお聞かせください。`,
    (s) => `${s.consulting}で似合わせをご提案します。`,
    (s) => `ご希望は${s.consulting}で一緒に整理しましょう。`,
  ],
  show_image: [
    (s) => `この画像を見せていただければ${s.consulting}で調整します。`,
    (s) => `画像をお見せいただくと${s.consulting}で希望を共有しやすくなります。`,
    (s) => `気になる方はこの写真を見せて${s.consulting}でご相談ください。`,
  ],
  bookmark: [
    (s) => `ブックマークして${s.consulting}の参考にどうぞ。`,
    (s) => `気になったらブックマークして次回の${s.consulting}でお見せください。`,
    (s) => `ブックマークしておくと${s.consulting}の際に便利です。`,
  ],
  visit_consult: [
    (s) => `ご来店時の${s.consulting}で髪質に合わせてご提案します。`,
    (s) => `来店時に${s.consulting}で長さや色味を一緒に決めましょう。`,
    (s) => `ご来店の際は${s.consulting}でお悩みもお聞かせください。`,
  ],
  reservation_guidance: [],
};

const BLOG_INTROS: ((s: Slots) => string | null)[] = [
  (s) => (s.season === '' ? null : `${s.season}は髪の印象を変えたくなる季節です。`),
  () => '毎日のスタイリングを少しでも楽にしたいと感じている方は多いのではないでしょうか。',
  () => '髪型を変えたいけれど、何が似合うか迷うことはありませんか。',
  () => '同じスタイルでも、長さや動きの出し方で印象は大きく変わります。',
];

const BLOG_CARE: ((s: Slots, mod: string) => string)[] = [
  (_s, mod) => `乾かすときは根元から風を当てると、${mod}シルエットが続きやすくなります。仕上げに少量のオイルをなじませると、まとまりが出ます。`,
  () => '朝は軽く濡らしてから乾かし直すと、寝ぐせが落ち着きやすくなります。毛先を軽くつまむようにスタイリング剤をつけると、自然な動きが出ます。',
  () => 'お風呂上がりはできるだけ早く乾かすのがきれいに保つコツです。ドライヤーは上から下に向けて当てると、ツヤが出やすくなります。',
];

const BLOG_FIT: ((s: Slots, f: string) => string)[] = [
  (_s, f) => `顔周りの長さを調整することで、丸顔さんにも面長さんにもバランスよく見せやすいスタイルです。骨格や髪質に合わせて${f}の入り方を変えられます。`,
  (s) => `${s.cat}は、顔周りの見せ方を少し変えるだけで印象が変わります。髪質やクセに合わせて重さを調整すると、扱いやすさも上がります。`,
  () => '似合わせのポイントは、顔周りと全体のバランスです。普段のスタイリングの仕方も伺いながら、無理なく続けられる形をご提案します。',
];

interface Pair {
  title_pattern: TitlePattern;
  content_angle: ContentAngle;
}

function choosePair(m: Meta, p: Picker, s: Slots): Pair {
  const recent = new Set(m.recent.pairs.map((x) => `${x.title_pattern}/${x.content_angle}`));
  const pairs = TITLE_PATTERNS.flatMap((title_pattern) => CONTENT_ANGLES.map((content_angle) => ({ title_pattern, content_angle })));
  const usable = pairs.filter((x) => (s.season !== '' || (x.title_pattern !== 'season' && x.content_angle !== 'season')) && !recent.has(`${x.title_pattern}/${x.content_angle}`));
  return p.order(usable.length > 0 ? usable : pairs, 'pair')[0] as Pair;
}

function chooseCta(m: Meta, p: Picker, s: Slots, bad: (t: string) => boolean): CtaPattern {
  const allowed = m.allowed_cta_patterns.filter((c) => CTAS[c].some((f) => !bad(f(s))));
  const fresh = allowed.filter((c) => !m.recent.cta_patterns.includes(c));
  return p.order(fresh.length > 0 ? fresh : allowed.length > 0 ? allowed : (['style_consult'] as CtaPattern[]), 'cta')[0] as CtaPattern;
}

function chooseTitle(m: Meta, p: Picker, s: Slots, pattern: TitlePattern, bad: (t: string) => boolean): string {
  const options: string[] = [];
  for (const template of p.order(TITLES[pattern], 'title-template')) {
    for (const mod of p.order(s.modifiers, 'title-mod')) {
      for (const f of p.order(s.features, 'title-feature')) {
        const t = template(s, mod, f);
        // Skip a modifier that repeats a word of the template (抜け感が出る抜け感のある…).
        const stem = mod.replace(/(のある|な)$/u, '');
        if (t !== null && !bad(t) && t.split(stem).length <= 2) options.push(t);
      }
    }
  }
  // Not like a recent title (spec 10.3 compares titles with recent posts), unless nothing else is left.
  const recent = m.recent.titles.map(bigrams);
  const fresh = options.filter((t) => {
    const grams = bigrams(t);
    return recent.every((r) => similarity(grams, r) < MAX_TITLE_SIMILARITY);
  });
  const pick = (list: readonly string[]): string | undefined =>
    list.find((t) => graphemeLength(t) <= m.limits.title_target) ?? list.find((t) => graphemeLength(t) <= m.limits.title);
  return pick(fresh) ?? pick(options) ?? s.cat;
}

interface TagChoice {
  /** Up to the wanted count: the most relevant candidates first, then a seeded mix. */
  tags: string[];
  /** Other usable words, to swap in for a long tag when text and tags do not fit. */
  spare: string[];
}

/**
 * Hashtags from the candidates, padded with other context words (the generator keeps only tags related to the post,
 * never a face shape or a salon fact).
 */
function chooseTags(m: Meta, p: Picker, count: number, bad: (t: string) => boolean): TagChoice {
  const excluded = new Set(m.excluded_keywords.map((w) => w.normalize('NFKC').trim()));
  const ok = (t: string): boolean =>
    !bad(t) && !excluded.has(t.normalize('NFKC').trim()) && findWord(t, FACE_SHAPE_TERMS) === null && findSalonFact(t) === null;
  const cands = m.hashtags.candidates.filter(ok);
  const head = cands.slice(0, 3);
  const tail = p.order(cands.slice(3, 16), 'tags');
  const padding = [...m.category.keywords, ...m.analysis.style_features, ...(m.use_season ? m.season.words : []), ...m.keywords, ...cands.slice(16)]
    .flatMap((t) => cleanTagWord(t) ?? [])
    .filter((t) => ok(t) && (m.include_hair_consulting || t !== 'ヘアコンサルティング'));
  const seen = new Set<string>();
  const all: string[] = [];
  for (const t of [...head, ...tail, ...padding]) {
    const k = t.normalize('NFKC');
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(t);
  }
  return { tags: all.slice(0, count), spare: all.slice(count) };
}

const fits = (text: string, tags: readonly string[], max: number): boolean => graphemeLength(tags.length === 0 ? text : `${text}\n${renderHashtags(tags)}`) <= max;

/**
 * Makes text + tags fit: drops the longest tag after the first three down to min, then swaps the longest for a shorter
 * spare word; null when even that does not fit.
 */
function fitTags(text: string, choice: TagChoice, m: Meta): string[] | null {
  const list = [...choice.tags];
  const spare = [...choice.spare].sort((a, b) => graphemeLength(a) - graphemeLength(b));
  while (!fits(text, list, m.limits.primary)) {
    let longest = -1;
    for (let i = 3; i < list.length; i++) if (longest === -1 || graphemeLength(list[i] as string) >= graphemeLength(list[longest] as string)) longest = i;
    if (longest === -1) return null;
    if (list.length > m.hashtags.min) {
      list.splice(longest, 1);
      continue;
    }
    const length = graphemeLength(list[longest] as string);
    const shorter = spare.findIndex((t) => graphemeLength(t) < length);
    if (shorter === -1) return null;
    list[longest] = spare[shorter] as string;
    spare.splice(shorter, 1);
  }
  return list;
}

function sentenceOptions(templates: readonly Template[], s: Slots, p: Picker, label: string, bad: (t: string) => boolean, repeats: (t: string) => boolean): string[] {
  const out: string[] = [];
  for (const template of p.order(templates, `${label}-template`)) {
    for (const mod of p.order(s.modifiers, `${label}-mod`).slice(0, 4)) {
      for (const f of p.order(s.features, `${label}-feature`)) {
        const t = template(s, mod, f);
        if (t !== null && !bad(t) && !repeats(t) && !out.includes(t)) out.push(t);
      }
    }
  }
  return out;
}

/** A sentence the Validator would call a repeat of a recent one (near-equal or a synonym-only rewrite, spec 9.9). */
function repeatsOf(recent: readonly string[]): (t: string) => boolean {
  const find = repeatFinder(recent, { synonyms: true });
  return (t) => find(t) !== null;
}

function usedKeywords(m: Meta, s: Slots, text: string, tags: readonly string[]): string[] {
  const pool = [s.cat, ...m.category.keywords, ...s.features, s.consulting, s.season, ...m.keywords, s.length, s.color, '似合わせ', ...tags].filter((w) => w !== '');
  const seen = new Set<string>();
  return pool.filter((w) => {
    if (seen.has(w) || !text.includes(w)) return false;
    seen.add(w);
    return true;
  }).slice(0, 8);
}

function evidenceFor(m: Meta, menuItems: readonly string[], usedSeason: boolean): string[] {
  const wanted = [
    'analysis.hair_length',
    'analysis.observed_color',
    'analysis.style_features',
    'analysis.impressions',
    `category:${m.category.id}`,
    ...(usedSeason ? [`season:${m.season.key}`] : []),
    // menu:<index> numbers salon.verified_menus (m.menus.registered), not the photo's possibly shorter allowed list.
    ...menuItems.map((item) => `menu:${m.menus.registered.indexOf(item)}`),
    ...(m.menus.mode === 'sidecar' ? ['sidecar.verified_menu_ids'] : []),
    ...(m.include_hair_consulting ? ['salon.hair_consulting'] : []),
  ];
  return wanted.filter((id) => m.evidence_ids.includes(id));
}

/** Menu items for a style post: the sidecar's when fixed, else the best 1-2 verified entries that fit the limit. */
function chooseMenus(m: Meta, p: Picker, bad: (t: string) => boolean): string[] {
  if (m.menus.mode === 'sidecar') return [...m.menus.fixed];
  const colorish = /カラー/u.test(m.category.label) || m.category.keywords.some((k) => /カラー/u.test(k));
  const score = (entry: string): number =>
    (bad(entry) ? -100 : 0) +
    (/メンズ/u.test(entry) ? (m.audience_category === 'mens' ? 3 : -50) : 0) +
    (/カット/u.test(entry) ? 1 : 0) +
    (colorish && /カラー/u.test(entry) ? 2 : 0);
  const ranked = p
    .order(m.menus.allowed, 'menu')
    .map((entry) => ({ entry, s: score(entry) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.entry);
  const first = ranked[0];
  if (first === undefined) return [];
  const limit = m.limits.menu_text ?? Number.POSITIVE_INFINITY;
  const second = ranked[1];
  // Never two entries sharing a part (e.g. カット＋カラー and カット): the pair would repeat itself.
  const parts = (e: string): string[] => e.split(/[＋+]/u).map((x) => x.trim());
  const overlaps = second !== undefined && parts(second).some((x) => parts(first).includes(x));
  if (second !== undefined && !overlaps && p.random('menu-count') < 0.3 && score(second) > 0 && graphemeLength(`${first}／${second}`) <= limit) return [first, second];
  return [first];
}

/** The mock's raw output for one generation request (checked against the output schema by the mock provider). */
export function mockDraftOutput(m: Meta, seed: string): StyleDraftOutput | BlogDraftOutput {
  const p = new Picker(seed);
  const bad = forbiddenIn(m);
  const s = slotsOf(m, bad);
  const pair = choosePair(m, p, s);
  const ctaPattern = chooseCta(m, p, s, bad);
  const title = chooseTitle(m, p, s, pair.title_pattern, bad);
  const repeatsOpening = repeatsOf(m.recent.openings);
  const repeatsCta = repeatsOf(m.recent.ctas);
  const openings = sentenceOptions(OPENINGS[pair.content_angle], s, p, 'opening', bad, repeatsOpening);
  const fallbackOpenings = sentenceOptions(Object.values(OPENINGS).flat(), s, p, 'opening-any', bad, repeatsOpening);
  const ctas = p.order(CTAS[ctaPattern].map((f) => f(s)), 'cta-text').filter((t) => !bad(t) && !repeatsCta(t));
  const ctaList = ctas.length > 0 ? ctas : CTAS[ctaPattern].map((f) => f(s)).filter((t) => !bad(t));
  const tags = chooseTags(m, p, Math.min(Math.max(m.hashtags.suggested, m.hashtags.min), m.hashtags.max), bad);
  const meta = { content_angle: pair.content_angle, title_pattern: pair.title_pattern, opening_pattern: OPENING_LABEL[pair.content_angle], cta_pattern: ctaPattern };

  if (m.post_type === 'style') {
    const benefits = sentenceOptions(BENEFITS, s, p, 'benefit', bad, () => false);
    // The first text that fits with its tags, names the category in the title or text and uses MIN_KEYWORDS search
    // keywords with the title; otherwise the best of those that fit.
    let best: { text: string; tags: string[]; score: number } | null = null;
    search: for (const opening of [...openings, ...fallbackOpenings]) {
      for (const cta of ctaList) {
        for (const middle of [...benefits.slice(0, 3), '']) {
          const candidate = `${opening}${middle}${cta}`;
          if (graphemeLength(candidate) > m.limits.primary_text_target + 25) continue;
          const fitted = fitTags(candidate, tags, m);
          if (fitted === null) continue;
          const used = Math.min(usedKeywords(m, s, `${title}${candidate}`, fitted).length, MIN_KEYWORDS);
          const score = used + (`${title}${candidate}`.includes(s.cat) ? 1 : 0);
          if (best === null || score > best.score) best = { text: candidate, tags: fitted, score };
          if (score > MIN_KEYWORDS) break search;
        }
      }
    }
    const text = best?.text ?? `${openings[0] ?? fallbackOpenings[0] ?? `${s.cat}です。`}${ctaList[0] ?? ''}`;
    const finalTags = best?.tags ?? fitTags(text, tags, m) ?? tags.tags.slice(0, m.hashtags.min);
    const menuItems = chooseMenus(m, p, bad);
    return {
      post_type: 'style',
      title,
      menu_items: menuItems,
      stylist_comment: text,
      category_id: m.category.id,
      keywords: usedKeywords(m, s, `${title}${text}`, finalTags),
      hashtags: finalTags,
      evidence_refs: evidenceFor(m, menuItems, (text + title).includes(s.season) && s.season !== ''),
      meta,
    };
  }

  const mod = p.order(s.modifiers, 'blog-mod')[0] ?? '';
  const f = p.order(s.features, 'blog-feature')[0] ?? s.cat;
  const intro = p.order(BLOG_INTROS, 'blog-intro').map((x) => x(s)).find((t): t is string => t !== null && !bad(t)) ?? '';
  const opening = [...openings, ...fallbackOpenings][0] ?? `${s.cat}のスタイルです。`;
  // Each section takes its first wording without a forbidden word (a section is left out only when none is usable).
  const section = (heading: string, variants: readonly string[]): string | null => {
    const text = variants.find((v) => !bad(v));
    return text === undefined ? null : `${heading}\n${text}`;
  };
  const styled = `${s.length === '' ? '' : `${s.length}の長さに`}${f}を合わせた${s.cat}です。`;
  const tint = s.color === '' ? '' : `${s.color}の色味で`;
  const body = [
    [`${opening}${intro}`].find((x) => !bad(x)) ?? null,
    section('【スタイルのポイント】', [`${styled}${tint}${mod}印象にまとめています。`, `${styled}${tint}${mod}雰囲気に仕上げています。`, styled]),
    section('【似合わせのポイント】', p.order(BLOG_FIT, 'blog-fit').map((x) => x(s, f))),
    section('【お手入れ】', p.order(BLOG_CARE, 'blog-care').map((x) => x(s, mod))),
    section('【ご相談について】', [`髪質やライフスタイルに合わせて、無理なく続けられるスタイルをご提案します。${ctaList[0] ?? ''}`]),
  ]
    .filter((x): x is string => x !== null)
    .join('\n\n');
  const fitted = fitTags(body, tags, m) ?? tags.tags.slice(0, m.hashtags.min);
  return {
    post_type: 'blog',
    title,
    body,
    category_id: m.category.id,
    keywords: usedKeywords(m, s, `${title}${body}`, fitted),
    hashtags: fitted,
    evidence_refs: evidenceFor(m, [], (body + title).includes(s.season) && s.season !== ''),
    meta,
  };
}
