import type { FieldLimit, LimitField } from '../../ai/context.js';
import { primaryFieldOf, primaryTextOf, renderHashtags, renderPrimaryText, type Draft } from '../../ai/draft-schemas.js';
import { limitLength, unencodable } from '../../posting/profile/limits.js';
import { hashtagEntries } from '../../posting/profile/placement.js';
import { graphemeLength, type CountUnit } from '../../shared/text.js';
import { fieldJa, violation, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 3 / 9.8: lengths after the hashtags are appended (or in the page's own hashtag field), the hashtag
// count, characters the page's encoding cannot carry, and the case where the hashtag count and the page limit cannot
// both hold (held for the owner instead of cutting text or tags, P3-R8).

const UNIT_JA: Record<CountUnit, string> = { grapheme: '文字', codepoint: '文字（コードポイント）', utf16: '文字（UTF-16）', bytes: 'バイト' };

/**
 * The primary text must keep at least this share of its limit when the minimum number of hashtags is appended; below
 * that, the hashtag count and the limit cannot both hold (spec 9.8).
 */
export const MIN_TEXT_SHARE = 0.4;
/** Length assumed for a tag word when fewer than min_count words are known (the shortest plausible word). */
const SHORTEST_TAG = 2;
/** P3-R8: the start of every hold finding (the job waits for a config change; nothing is regenerated or cut). */
export const TAGS_DO_NOT_FIT = 'ハッシュタグが画面の文字数に収まりません。';

/** Every constraint on a field: the generation context's (defaults + verified profile) and the current defaults. */
function constraints(ctx: ValidationContext, field: LimitField): FieldLimit[] {
  const d = ctx.snapshot.writingRules.default_limits;
  const current: Partial<Record<LimitField, number>> =
    ctx.job.post_type === 'style' ? { title: d.style.title, stylist_comment: d.style.stylist_comment, menu_text: d.style.menu_text } : { title: d.blog.title, body: d.blog.body };
  const list = [...(ctx.generation.limits.fields[field] ?? [])];
  const max = current[field];
  if (max !== undefined) list.push({ max, unit: d.count_unit });
  return list;
}

/** A limit in graphemes, conservatively (UTF-8 Japanese takes 3 bytes per character). */
const asGraphemes = (l: FieldLimit): number => (l.unit === 'bytes' ? Math.floor(l.max / 3) : l.max);

/** Graphemes of the line break and `n` tags of the given lengths, each with '#', separated by spaces. */
const blockLength = (lengths: readonly number[]): number => (lengths.length === 0 ? 0 : 1 + lengths.reduce((a, n) => a + n + 1, 0) + (lengths.length - 1));

function overLimit(text: string, list: readonly FieldLimit[]): { limit: FieldLimit; length: number } | null {
  let worst: { limit: FieldLimit; length: number; excess: number } | null = null;
  for (const limit of list) {
    const length = limitLength(text, limit);
    const excess = (length - limit.max) / limit.max;
    if (length > limit.max && (worst === null || excess > worst.excess)) worst = { limit, length, excess };
  }
  return worst === null ? null : { limit: worst.limit, length: worst.length };
}

/** The `min` shortest tag lengths among this post's tags and the context's candidates (padded with the shortest word). */
function shortestTags(draft: Draft, ctx: ValidationContext, min: number): number[] {
  const lengths = [...new Set([...draft.hashtags, ...ctx.generation.hashtags.candidates])].map(graphemeLength).sort((a, b) => a - b).slice(0, min);
  while (lengths.length < min) lengths.push(SHORTEST_TAG);
  return lengths;
}

/** Group 3: max_length, max_newlines, hashtag_count, hashtag_length, unencodable_char, hashtag_limit_conflict. All hard. */
export function checkLimits(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const { placement, encoding, profile_hashtag: tagField } = ctx.generation.limits;
  const appended = placement === 'append_to_primary_text';
  const singles: LimitField[] = draft.post_type === 'style' ? ['title', 'menu_text'] : ['title'];
  for (const field of singles) {
    const text = field === 'title' ? draft.title : draft.post_type === 'style' ? draft.menu_text : '';
    const over = overLimit(text, constraints(ctx, field));
    if (over === null) continue;
    const u = UNIT_JA[over.limit.unit];
    out.push(
      violation(field, 'max_length', 'hard', `${fieldJa(field)}が長すぎます（${over.length}${u}、上限${over.limit.max}${u}）。内容を絞って短く書き直してください（末尾を切らないこと）。`, {
        actual: over.length,
        limit: over.limit.max,
        ...(field === 'title' ? { offending_text: text } : {}),
      }),
    );
  }

  const min = ctx.snapshot.hashtags.min_count;
  const max = Math.min(ctx.snapshot.hashtags.max_count, tagField?.max_count ?? Infinity);
  const n = draft.hashtags.length;
  const primaryField = primaryFieldOf(draft.post_type);
  const primaryLimits = constraints(ctx, primaryField);
  const rendered = renderPrimaryText(draft, placement);
  const over = overLimit(rendered, primaryLimits);
  const hold = (field: string, detail: string, extra: { actual?: number; limit?: number } = {}): Violation[] => {
    out.push(violation(field, 'hashtag_limit_conflict', 'hard', `${TAGS_DO_NOT_FIT}${detail}文章やタグを自動で切り詰めずに保留します。`, extra));
    return out;
  };

  // P3-R8: the screen takes fewer tags than the writing rules ask for; no rewrite can satisfy both.
  if (max < min) return hold('hashtags', `画面のハッシュタグ上限（${max}個）が文章ルールの最低数（${min}個）より少なく、両方を守れません。仕様の調整が必要です。`);

  // Spec 9.8: does even the shortest block of min_count tags (this post's tags and the context's candidates) leave too
  // little room for the text under the strictest limit? Then no rewrite can satisfy both: hold, never cut.
  const strictest = [...primaryLimits].sort((a, b) => asGraphemes(a) - asGraphemes(b))[0];
  if (appended && strictest !== undefined && (over !== null || n < min)) {
    const limitG = asGraphemes(strictest);
    const room = limitG - blockLength(shortestTags(draft, ctx, min));
    if (room < Math.ceil(limitG * MIN_TEXT_SHARE)) {
      const u = UNIT_JA[strictest.unit];
      return hold(
        primaryField,
        `ハッシュタグを最低${min}個付けると、${fieldJa(primaryField)}の上限（${strictest.max}${u}）のうち文章に使えるのが約${Math.max(0, room)}文字しか残らず、ハッシュタグの個数と文字数の上限を両立できません。hashtags.json の min_count / target_count を減らすか、文字数の上限を確認してください。`,
        { actual: over?.length ?? limitLength(rendered, strictest), limit: strictest.max },
      );
    }
  }

  if (over !== null) {
    const u = UNIT_JA[over.limit.unit];
    const textLength = graphemeLength(primaryTextOf(draft));
    const tagLength = !appended || n === 0 ? 0 : graphemeLength(`\n${renderHashtags(draft.hashtags)}`);
    const what = appended ? `ハッシュタグを付けた${fieldJa(primaryField)}` : fieldJa(primaryField);
    out.push(
      violation(primaryField, 'max_length', 'hard', `${what}が長すぎます（${over.length}${u}、上限${over.limit.max}${u}。うち文章${textLength}文字・ハッシュタグ${tagLength}文字）。文章を短く書き直してください（末尾を切らないこと）。`, {
        actual: over.length,
        limit: over.limit.max,
      }),
    );
  }

  // Line-break caps (the blog page: 改行80回以下), counted in the final string with the break before appended tags.
  const caps = [ctx.generation.limits.max_newlines, draft.post_type === 'blog' ? ctx.snapshot.writingRules.default_limits.blog.body_max_newlines : null].filter((c) => c !== null);
  if (caps.length > 0) {
    const limit = Math.min(...caps);
    const breaks = rendered.split('\n').length - 1;
    if (breaks > limit) {
      const what = appended ? `ハッシュタグを付けた${fieldJa(primaryField)}` : fieldJa(primaryField);
      out.push(violation(primaryField, 'max_newlines', 'hard', `${what}の改行が多すぎます（${breaks}回、上限${limit}回）。段落をまとめて改行を減らしてください。`, { actual: breaks, limit }));
    }
  }

  // The page's own hashtag field: each tag within the per-tag counter, each entry within the field's limits.
  if (!appended && tagField !== null) {
    for (const tag of draft.hashtags) {
      const shown = tagField.with_hash_sign ? `#${tag}` : tag;
      const length = graphemeLength(shown);
      if (tagField.max_tag_length !== null && length > tagField.max_tag_length) {
        out.push(
          violation('hashtags', 'hashtag_length', 'hard', `ハッシュタグ「${tag}」が長すぎます（${length}文字、画面の上限${tagField.max_tag_length}文字）。短いタグにしてください。`, {
            actual: length,
            limit: tagField.max_tag_length,
            offending_text: tag,
          }),
        );
      }
    }
    for (const entry of hashtagEntries(draft.hashtags, tagField)) {
      const tooLong = overLimit(entry, tagField.limits);
      if (tooLong === null) continue;
      const u = UNIT_JA[tooLong.limit.unit];
      if (tagField.add_button === undefined && blockLength(shortestTags(draft, ctx, min)) - 1 > asGraphemes(tooLong.limit)) {
        return hold('hashtags', `ハッシュタグを最低${min}個並べると、画面のハッシュタグ欄の上限（${tooLong.limit.max}${u}）を超えます。仕様の調整が必要です。`, { actual: tooLong.length, limit: tooLong.limit.max });
      }
      out.push(
        violation('hashtags', 'max_length', 'hard', `ハッシュタグ欄の内容が長すぎます（${tooLong.length}${u}、上限${tooLong.limit.max}${u}）。短いタグにしてください。`, {
          actual: tooLong.length,
          limit: tooLong.limit.max,
        }),
      );
    }
  }

  if (n < min || n > max) {
    const where = max < ctx.snapshot.hashtags.max_count ? 'hashtags.json と画面の上限' : 'hashtags.json';
    out.push(violation('hashtags', 'hashtag_count', 'hard', `ハッシュタグが${n}個です。${min}〜${max}個にしてください（${where}）。`, { actual: n, limit: n < min ? min : max }));
  }

  // A page in Shift_JIS cannot carry every character (emoji, some symbols): the form would send something else.
  if (encoding !== 'utf-8') {
    const texts: [string, string][] = [
      ['title', draft.title],
      ...(draft.post_type === 'style' ? ([['menu_text', draft.menu_text]] as [string, string][]) : []),
      [primaryField, rendered],
      ...(appended || tagField === null ? [] : hashtagEntries(draft.hashtags, tagField).map((e): [string, string] => ['hashtags', e])),
    ];
    for (const [field, text] of texts) {
      const bad = unencodable(text, encoding);
      if (bad.length === 0) continue;
      out.push(violation(field, 'unencodable_char', 'hard', `この文字は投稿画面で使えません: ${bad.map((c) => `「${c}」`).join('')}。別の文字に書き換えてください。`, { offending_text: bad.join('') }));
    }
  }
  return out;
}
