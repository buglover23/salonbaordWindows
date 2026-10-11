import { ctaSentence, hashtagPool, isRelatedTag, postSentences } from '../../ai/context.js';
import { CONTENT_ANGLE_JA, TITLE_PATTERN_JA, primaryFieldOf, primaryTextOf, type Draft } from '../../ai/draft-schemas.js';
import { FACE_SHAPE_TERMS, HAIR_CONSULTING, cleanTagWord, wordKey } from '../../ai/word-rules.js';
import { graphemeLength } from '../../shared/text.js';
import { looseKey, scanTerms } from '../scan.js';
import { findRepeatedSentence } from '../similarity.js';
import { fieldJa, quoted, violation, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 7 / 9.4 / 9.8 / 9.9: hair consulting, the season, hashtags (count is group 3), calls to action, variety
// against recent posts, and pushy or stuffed wording.

/** Spec 9.4: ヘアコンサルティング or one of its related terms in the primary text. */
export const CONSULTING_TERMS: readonly string[] = [HAIR_CONSULTING, '似合わせ提案', '顔型に合わせた提案', '髪質に合わせた提案', 'カウンセリング', 'スタイル相談'];

/** Spec 9.9: 押し売り・煽り. */
export const PUSHY_TERMS: readonly string[] = [
  '今すぐ',
  'お早めに',
  'お急ぎ',
  '急いで',
  '残りわずか',
  '残り僅か',
  '見逃さない',
  '見逃せない',
  '見逃し厳禁',
  '損しない',
  '損する',
  'ラストチャンス',
  '先着',
  '早い者勝ち',
  '今だけ',
  '今しかない',
  '必見',
  '間違いなし',
  '後悔させません',
];

/** Spec 9.9: openings and closings that must not be used in a row. */
const STOCK_OPENINGS: readonly string[] = ['今回は', 'こんにちは', '透明感のある'];
const STOCK_CLOSINGS: readonly string[] = ['お気軽にご相談ください', 'お待ちしております', 'お待ちしています'];

/**
 * Keyword stuffing (spec 5.7 avoid_keyword_stuffing): one search keyword at least STUFFING_COUNT times in the title and
 * text, and more often than once per STUFFING_SPAN graphemes plus one (a long blog may name its subject more often).
 */
export const STUFFING_COUNT = 4;
export const STUFFING_SPAN = 100;

/** Season spans that are natural in the season they contain (秋冬 in autumn). */
const SEASON_SPANS: readonly string[] = ['春夏', '夏秋', '秋冬', '冬春', '初春', '早春', '晩春', '初夏', '晩夏', '初秋', '晩秋', '初冬', '晩冬'];
const SEASON_JA: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

const count = (hay: string, needle: string): number => (needle === '' ? 0 : hay.split(needle).length - 1);

/**
 * Group 7. hard: hashtag_duplicate, hashtag_format, hashtag_unrelated, hashtag_face_shape, excluded_keyword,
 * cta_not_allowed, pushy_wording. regenerate: hair_consulting_missing, season_mismatch, repeated_opening, repeated_cta,
 * synonym_only_rewrite, repeated_pattern, repeated_stock_phrase, keyword_stuffing.
 */
export function checkQuality(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const { generation, snapshot } = ctx;
  const primaryField = primaryFieldOf(draft.post_type);
  const primary = primaryTextOf(draft);
  const postText = `${draft.title}\n${primary}`;

  // Hair consulting (spec 9.4).
  if (generation.writing.include_hair_consulting && scanTerms(primary, CONSULTING_TERMS).length === 0) {
    out.push(
      violation(
        primaryField,
        'hair_consulting_missing',
        'regenerate',
        `${fieldJa(primaryField)}にヘアコンサルティング（または似合わせ提案・カウンセリング・スタイル相談など）の案内がありません。髪質・骨格・顔型・生活習慣に合わせた相談として自然に入れてください。`,
        { limit: HAIR_CONSULTING },
      ),
    );
  }

  // Season words of another season than the planned date's (spec 9.1, 10.1 step 7).
  const current = generation.season.key;
  const currentWords = snapshot.keywords.season_words[current] ?? generation.season.words;
  const otherWords = Object.entries(snapshot.keywords.season_words)
    .filter(([key]) => key !== current)
    .flatMap(([, words]) => words);
  const spans = SEASON_SPANS.filter((s) => currentWords.some((w) => [...w].length === 1 && s.includes(w)));
  const seasonHits = [...new Set([draft.title, primary, ...draft.hashtags].flatMap((t) => scanTerms(t, otherWords, { covers: [...currentWords, ...spans] })))];
  if (seasonHits.length > 0) {
    out.push(
      violation(
        primaryField,
        'season_mismatch',
        'regenerate',
        `投稿予定日（${generation.season.date}）の季節（${SEASON_JA[current] ?? current}）と違う季節の言葉があります: ${quoted(seasonHits)}。季節の言葉は予定日の季節に合わせてください。`,
        { actual: seasonHits.join('、'), limit: current, offending_text: seasonHits.join(' ') },
      ),
    );
  }

  // Hashtags (spec 9.8): once each, usable characters only, related to the post, never a face shape or an excluded word.
  const seen = new Set<string>();
  const dup: string[] = [];
  const badFormat: string[] = [];
  const unrelated: string[] = [];
  const faceShape: string[] = [];
  const pool = hashtagPool(generation);
  for (const tag of draft.hashtags) {
    const k = looseKey(tag);
    if (seen.has(k)) dup.push(tag);
    seen.add(k);
    if (cleanTagWord(tag) !== tag) badFormat.push(tag);
    else if (scanTerms(tag, FACE_SHAPE_TERMS).length > 0) faceShape.push(tag);
    else if (!isRelatedTag(tag, pool, postText)) unrelated.push(tag);
  }
  const tags = (list: string[]): string => list.map((t) => `#${t}`).join(' ');
  if (dup.length > 0) out.push(violation('hashtags', 'hashtag_duplicate', 'hard', `同じハッシュタグが重複しています: ${tags(dup)}。`, { offending_text: tags(dup) }));
  if (badFormat.length > 0) {
    out.push(
      violation('hashtags', 'hashtag_format', 'hard', `ハッシュタグに使えない文字（空白・改行・#・記号・絵文字など）があるか、長すぎます（30文字まで）: ${quoted(badFormat)}。`, {
        offending_text: badFormat.join(' '),
      }),
    );
  }
  if (faceShape.length > 0) {
    out.push(
      violation('hashtags', 'hashtag_face_shape', 'hard', `顔型のハッシュタグは写真の人物についての断定に見えるため使えません: ${tags(faceShape)}。`, { offending_text: tags(faceShape) }),
    );
  }
  if (unrelated.length > 0) {
    out.push(
      violation('hashtags', 'hashtag_unrelated', 'hard', `投稿内容に関係のないハッシュタグがあります: ${tags(unrelated)}。写真・カテゴリー・本文に関係する語にしてください。`, {
        offending_text: tags(unrelated),
      }),
    );
  }
  const excluded = new Set([...generation.excluded_keywords, ...snapshot.keywords.excluded_topics].map(wordKey));
  for (const [field, list] of [
    ['hashtags', draft.hashtags],
    ['keywords', draft.keywords],
  ] as const) {
    const hit = list.filter((w) => excluded.has(wordKey(w)));
    if (hit.length > 0) {
      out.push(violation(field, 'excluded_keyword', 'hard', `${fieldJa(field)}に除外する検索ワード（作業指示書・keywords.json）があります: ${quoted(hit)}。`, { offending_text: hit.join(' ') }));
    }
  }

  // Call to action (spec 9.9): only an allowed one (予約の案内 needs a verified reservation route).
  if (!generation.writing.allowed_cta_patterns.includes(draft.meta.cta_pattern)) {
    out.push(
      violation(
        'meta.cta_pattern',
        'cta_not_allowed',
        'hard',
        draft.meta.cta_pattern === 'reservation_guidance' ? '確認済みの予約導線が設定されていないため、予約の案内は使えません。' : `この案内（${draft.meta.cta_pattern}）は設定で使わないことになっています。`,
        { actual: draft.meta.cta_pattern, limit: generation.writing.allowed_cta_patterns.join(',') },
      ),
    );
  }

  // Pushy wording (spec 9.9).
  const pushy = [...new Set([draft.title, primary, ...draft.hashtags].flatMap((t) => scanTerms(t, PUSHY_TERMS)))];
  if (pushy.length > 0) {
    out.push(violation(primaryField, 'pushy_wording', 'hard', `押し売りや煽りに聞こえる言葉があります: ${quoted(pushy)}。自然な相談の案内にしてください。`, { offending_text: pushy.join(' ') }));
  }

  // Keyword stuffing (spec 5.7 / 9.9).
  if (generation.writing.avoid_keyword_stuffing) {
    const text = looseKey(postText);
    const threshold = Math.max(STUFFING_COUNT, Math.ceil(graphemeLength(postText) / STUFFING_SPAN) + 1);
    const stuffed = [...new Set([...draft.keywords, ...generation.keywords])].filter((k) => graphemeLength(k) >= 2 && count(text, looseKey(k)) >= threshold);
    if (stuffed.length > 0) {
      out.push(
        violation(primaryField, 'keyword_stuffing', 'regenerate', `同じ検索キーワードを何度も入れています: ${quoted(stuffed)}（${threshold}回以上）。読みやすさを優先し、自然な回数にしてください。`, {
          offending_text: stuffed.join(' '),
          limit: threshold,
        }),
      );
    }
  }

  // Variety against the recent posts and waiting drafts of the same type (spec 9.9).
  const { sentence_lookback, pattern_lookback, avoid_synonym_only_rewrites } = snapshot.writingRules.diversity;
  const recent = ctx.recent.filter((r) => r.post_type === draft.post_type && r.job_id !== ctx.job.id);
  const sentenceRecent = recent.slice(0, sentence_lookback);
  const sentences = postSentences(primary);
  const opening = sentences[0] ?? '';
  const cta = ctaSentence(sentences, draft.meta.cta_pattern);
  const repeats: [string, string, readonly string[]][] = [
    ['opening', opening, sentenceRecent.map((r) => r.opening)],
    ['cta', cta, sentenceRecent.map((r) => r.cta)],
  ];
  for (const [which, sentence, earlier] of repeats) {
    if (sentence === '') continue;
    const hit = findRepeatedSentence(sentence, earlier, { synonyms: avoid_synonym_only_rewrites });
    if (hit === null) continue;
    const where = which === 'opening' ? '書き出し' : '相談への案内の文';
    out.push(
      hit.kind === 'near'
        ? violation(primaryField, `repeated_${which}`, 'regenerate', `${where}が、直近の投稿の「${hit.match}」と同じかほぼ同じです。違う書き出し・言い回しにしてください。`, {
            offending_text: sentence,
          })
        : violation(primaryField, 'synonym_only_rewrite', 'regenerate', `${where}が、直近の投稿の「${hit.match}」の助詞・記号・同義語を入れ替えただけです。内容や構成から変えてください。`, {
            offending_text: sentence,
          }),
    );
  }
  const pairHit = recent.slice(0, pattern_lookback).find((r) => r.title_pattern === draft.meta.title_pattern && r.content_angle === draft.meta.content_angle);
  if (pairHit !== undefined) {
    out.push(
      violation(
        'meta.title_pattern',
        'repeated_pattern',
        'regenerate',
        `タイトルの型（${TITLE_PATTERN_JA[draft.meta.title_pattern]}）と切り口（${CONTENT_ANGLE_JA[draft.meta.content_angle]}）の組み合わせが、直近${pattern_lookback}件の投稿と同じです。別の組み合わせにしてください。`,
        { actual: `${draft.meta.title_pattern}/${draft.meta.content_angle}`, limit: pattern_lookback },
      ),
    );
  }
  const stock: string[] = [];
  const startsWith = (s: string, w: string): boolean => looseKey(s).startsWith(looseKey(w));
  for (const w of STOCK_OPENINGS) if (startsWith(opening, w) && sentenceRecent.some((r) => startsWith(r.opening, w))) stock.push(w);
  for (const w of STOCK_CLOSINGS) if (scanTerms(cta, [w]).length > 0 && sentenceRecent.some((r) => scanTerms(r.cta, [w]).length > 0)) stock.push(w);
  if (stock.length > 0) {
    out.push(
      violation(primaryField, 'repeated_stock_phrase', 'regenerate', `直近の投稿と同じ決まり文句を続けて使っています: ${quoted(stock)}。別の書き出し・結びにしてください。`, {
        offending_text: stock.join(' '),
      }),
    );
  }
  return out;
}
