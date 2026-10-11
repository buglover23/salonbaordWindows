import { z } from 'zod';
import type { WritingRules } from '../config/schemas.js';
import { graphemeLength } from '../shared/text.js';

// Spec 9.6 / 9.7 drafts plus the rotation meta of spec 9.9. Two shapes per post type:
// - *OutputSchema: what the model is asked for. Every key is required and there are no unions, so it stays within
//   structured-output limits; list lengths and string lengths are not bounded here (the API cannot enforce them).
// - *DraftSchema: what the generator returns and a job stores, after the deterministic normalisation in generator.ts.
//   Lengths of post text are never bounded here: limits are the Validator's call (Task 8), and post text is never cut.

/** Spec 9.9 切り口: 悩み起点 / 仕上がり起点 / 季節起点 / お手入れ起点 / 相談起点. */
export const CONTENT_ANGLES = ['concern', 'finish', 'season', 'care', 'consult'] as const;
export type ContentAngle = (typeof CONTENT_ANGLES)[number];

/** Spec 9.2 / 9.9 タイトル型: スタイル名中心 / 悩みへの提案 / 仕上がりの印象 / 季節 / 年代のターゲット提案. */
export const TITLE_PATTERNS = ['style_name', 'concern', 'finish', 'season', 'age_target'] as const;
export type TitlePattern = (typeof TITLE_PATTERNS)[number];

/** Spec 9.6 / 9.9 相談への案内: スタイル相談 / 画像提示 / ブックマーク / 来店時の相談 / 予約の案内 (verified route only). */
export const CTA_PATTERNS = ['style_consult', 'show_image', 'bookmark', 'visit_consult', 'reservation_guidance'] as const;
export type CtaPattern = (typeof CTA_PATTERNS)[number];

export const CONTENT_ANGLE_JA: Record<ContentAngle, string> = {
  concern: '悩み起点',
  finish: '仕上がり起点',
  season: '季節起点',
  care: 'お手入れ起点',
  consult: '相談起点',
};
export const TITLE_PATTERN_JA: Record<TitlePattern, string> = {
  style_name: 'スタイル名中心',
  concern: '悩みへの提案',
  finish: '仕上がりの印象',
  season: '季節',
  age_target: '年代のターゲット提案',
};
export const CTA_PATTERN_JA: Record<CtaPattern, string> = {
  style_consult: 'スタイル相談',
  show_image: '画像を見せて相談',
  bookmark: 'ブックマーク',
  visit_consult: '来店時の相談',
  reservation_guidance: '予約の案内',
};

export const OPENING_PATTERN_MAX = 30;
export const MAX_DRAFT_KEYWORDS = 10;
export const MAX_EVIDENCE_REFS = 30;
/** Style menu text: verified_menus entries joined with this (ruling P2-R9). */
export const MENU_SEPARATOR = '／';
export const MAX_MENU_ITEMS = 3;

const metaFields = {
  content_angle: z.enum(CONTENT_ANGLES).describe('Internal: the angle of this post (concern, finish, season, care, consult).'),
  title_pattern: z.enum(TITLE_PATTERNS).describe('Internal: the title type (style_name, concern, finish, season, age_target).'),
  cta_pattern: z.enum(CTA_PATTERNS).describe('Internal: the call to action used (only an allowed one).'),
};

const DraftMetaOutputSchema = z
  .strictObject({
    content_angle: metaFields.content_angle,
    title_pattern: metaFields.title_pattern,
    opening_pattern: z.string().describe(`Internal: a short Japanese label (at most ${OPENING_PATTERN_MAX} characters) of how the text opens.`),
    cta_pattern: metaFields.cta_pattern,
  })
  .describe('Internal rotation data; never written into the post.');

/** Spec 9.9 rotation data saved with the draft; never part of the posted text. */
export const DraftMetaSchema = z.strictObject({
  content_angle: z.enum(CONTENT_ANGLES),
  title_pattern: z.enum(TITLE_PATTERNS),
  opening_pattern: z.string().refine((s) => graphemeLength(s) <= OPENING_PATTERN_MAX, { error: `opening_pattern は${OPENING_PATTERN_MAX}文字以内です` }),
  cta_pattern: z.enum(CTA_PATTERNS),
});
export type DraftMeta = z.infer<typeof DraftMetaSchema>;

const outputCommon = {
  title: z.string().describe('The post title in Japanese, within the title limit in the request.'),
  category_id: z.string().describe('Exactly the category id given in the request.'),
  keywords: z.array(z.string()).describe('3 to 8 search keywords actually used in the title or text.'),
  hashtags: z.array(z.string()).describe("Hashtag words without '#' and without spaces; about the suggested count."),
  evidence_refs: z.array(z.string()).describe('Ids from reference_data.evidence_ids of every fact relied on.'),
  meta: DraftMetaOutputSchema,
};

export const StyleDraftOutputSchema = z.strictObject({
  post_type: z.literal('style'),
  title: outputCommon.title,
  menu_items: z
    .array(z.string())
    .describe(`Entries copied exactly from salon.verified_menus (1 to ${MAX_MENU_ITEMS}, or exactly the sidecar menus when the request says so).`),
  stylist_comment: z.string().describe('The stylist comment in Japanese, without hashtags (they are appended by the app).'),
  category_id: outputCommon.category_id,
  keywords: outputCommon.keywords,
  hashtags: outputCommon.hashtags,
  evidence_refs: outputCommon.evidence_refs,
  meta: outputCommon.meta,
});
export type StyleDraftOutput = z.infer<typeof StyleDraftOutputSchema>;

export const BlogDraftOutputSchema = z.strictObject({
  post_type: z.literal('blog'),
  title: outputCommon.title,
  body: z.string().describe('The blog article in Japanese, plain text, without hashtags (they are appended by the app).'),
  category_id: outputCommon.category_id,
  keywords: outputCommon.keywords,
  hashtags: outputCommon.hashtags,
  evidence_refs: outputCommon.evidence_refs,
  meta: outputCommon.meta,
});
export type BlogDraftOutput = z.infer<typeof BlogDraftOutputSchema>;

export type DraftOutput = StyleDraftOutput | BlogDraftOutput;

// \s covers the ideographic space and line breaks.
const hasSpace = /\s/u;
/** One stored hashtag: the word only (no leading '#'), without spaces or line breaks (spec 5.5 / 9.8). */
const hashtagWord = z
  .string()
  .min(1)
  .refine((s) => !hasSpace.test(s) && !/^[#＃]/u.test(s), { error: 'ハッシュタグは # を付けず、空白・改行を含めずに保存します' });

const storedCommon = {
  title: z.string(),
  category_id: z.string().min(1),
  keywords: z.array(z.string().min(1)).max(MAX_DRAFT_KEYWORDS),
  hashtags: z.array(hashtagWord),
  evidence_refs: z.array(z.string().min(1)).max(MAX_EVIDENCE_REFS),
  meta: DraftMetaSchema,
};

/** Spec 9.6. menu_text is composed by the generator from salon.verified_menus entries (ruling P2-R9); '' = none usable. */
export const StyleDraftSchema = z.strictObject({
  post_type: z.literal('style'),
  title: storedCommon.title,
  menu_text: z.string(),
  stylist_comment: z.string(),
  category_id: storedCommon.category_id,
  keywords: storedCommon.keywords,
  hashtags: storedCommon.hashtags,
  evidence_refs: storedCommon.evidence_refs,
  meta: storedCommon.meta,
});
export type StyleDraft = z.infer<typeof StyleDraftSchema>;

/** Spec 9.7. */
export const BlogDraftSchema = z.strictObject({
  post_type: z.literal('blog'),
  title: storedCommon.title,
  body: z.string(),
  category_id: storedCommon.category_id,
  keywords: storedCommon.keywords,
  hashtags: storedCommon.hashtags,
  evidence_refs: storedCommon.evidence_refs,
  meta: storedCommon.meta,
});
export type BlogDraft = z.infer<typeof BlogDraftSchema>;

export const DraftSchema = z.discriminatedUnion('post_type', [StyleDraftSchema, BlogDraftSchema]);
export type Draft = z.infer<typeof DraftSchema>;

/**
 * One field-level finding about a draft (spec 10.2): fed back into regeneration, so `offending_text` is the model's own
 * text (data in the next prompt, never an instruction) and `message` is the Japanese reason for the operator.
 */
export interface DraftViolation {
  /** Draft field, e.g. 'title', 'stylist_comment', 'body', 'menu_text', 'hashtags', 'meta.cta_pattern'. */
  field: string;
  /** Machine id of the rule, e.g. 'max_length', 'unverified_menu', 'cta_not_allowed'. */
  rule: string;
  actual: number | string | null;
  limit: number | string | null;
  offending_text: string | null;
  message: string;
}

/** The text the hashtags are appended to: the stylist comment of a style post, the body of a blog post. */
export const primaryFieldOf = (postType: Draft['post_type']): 'stylist_comment' | 'body' => (postType === 'style' ? 'stylist_comment' : 'body');

export const primaryTextOf = (draft: Draft): string => (draft.post_type === 'style' ? draft.stylist_comment : draft.body);

/** The hashtags as posted: each once with '#', separated by single spaces. */
export const renderHashtags = (tags: readonly string[]): string => tags.map((t) => `#${t}`).join(' ');

/**
 * The final primary text as it is posted and measured (spec 9.8): with `append_to_primary_text`, the text, a line break
 * and the hashtags; the text alone when there are none or the page has its own hashtag field (`dedicated_field`, P3-R8).
 * Limits apply to this string.
 */
export function renderPrimaryText(draft: Draft, placement: WritingRules['hashtag_placement'] | 'dedicated_field'): string {
  const text = primaryTextOf(draft);
  if (draft.hashtags.length === 0) return text;
  switch (placement) {
    case 'append_to_primary_text':
      return `${text}\n${renderHashtags(draft.hashtags)}`;
    case 'dedicated_field':
      return text;
  }
}

/** Style menu text from verified entries (ruling P2-R9). */
export const composeMenuText = (items: readonly string[]): string => items.join(MENU_SEPARATOR);

/**
 * The verified_menus entries `menuText` is made of (joined with ／), or null when it cannot be written that way
 * (an unverified or edited menu). Works even when an entry itself contains ／. '' → [].
 */
export function splitMenuText(menuText: string, verifiedMenus: readonly string[]): string[] | null {
  if (menuText === '') return [];
  const entries = [...new Set(verifiedMenus.filter((m) => m !== ''))].sort((a, b) => b.length - a.length);
  const memo = new Map<number, string[] | null>();
  const from = (pos: number): string[] | null => {
    if (pos === menuText.length) return [];
    const known = memo.get(pos);
    if (known !== undefined) return known;
    let found: string[] | null = null;
    for (const entry of entries) {
      if (!menuText.startsWith(entry, pos)) continue;
      const end = pos + entry.length;
      if (end === menuText.length) {
        found = [entry];
        break;
      }
      if (!menuText.startsWith(MENU_SEPARATOR, end)) continue;
      const rest = from(end + MENU_SEPARATOR.length);
      if (rest !== null && rest.length > 0) {
        found = [entry, ...rest];
        break;
      }
    }
    memo.set(pos, found);
    return found;
  };
  return from(0);
}
