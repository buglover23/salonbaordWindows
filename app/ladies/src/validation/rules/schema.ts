import { DraftSchema } from '../../ai/draft-schemas.js';
import { graphemeSlice } from '../../shared/text.js';
import { POST_TYPE_JA } from '../../shared/labels.js';
import { violation, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 1: the draft re-parsed with the stored draft schema (types, required keys, unknown keys, enums) and its
// post type against the job's.

const MAX_SCHEMA_ISSUES = 10;
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

const ISSUE_JA: Record<string, string> = {
  invalid_type: '値の種類が違うか、必須の項目がありません',
  invalid_value: '決められた値ではありません',
  too_big: '多すぎるか長すぎます',
  too_small: '空か少なすぎます',
  invalid_union: '形式が違います',
};

/** Group 1: schema_invalid / unknown_key (one per issue, at most 10) and post_type_mismatch. All hard. */
export function checkSchema(draft: unknown, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, MAX_SCHEMA_ISSUES)) {
      const path = issue.path.map(String).join('.') || '(全体)';
      if (issue.code === 'unrecognized_keys') {
        const keys = issue.keys.map((k) => graphemeSlice(k, 40));
        out.push(violation(path, 'unknown_key', 'hard', `下書きに知らない項目があります: ${keys.join(', ')}`, { offending_text: keys.join(', ') }));
        continue;
      }
      const what = issue.code === 'custom' && JAPANESE.test(issue.message) ? issue.message : (ISSUE_JA[issue.code] ?? '形式が正しくありません');
      out.push(violation(path, 'schema_invalid', 'hard', `下書きの ${path} が決められた形式ではありません（${what}）。`));
    }
  }
  const postType = typeof draft === 'object' && draft !== null ? (draft as { post_type?: unknown }).post_type : undefined;
  if (typeof postType === 'string' && postType !== ctx.job.post_type) {
    const shown = postType === 'style' || postType === 'blog' ? `${POST_TYPE_JA[postType]}投稿` : graphemeSlice(postType, 20);
    out.push(
      violation('post_type', 'post_type_mismatch', 'hard', `下書きの投稿種別（${shown}）が、jobの投稿種別（${POST_TYPE_JA[ctx.job.post_type]}投稿）と違います。`, {
        actual: graphemeSlice(postType, 20),
        limit: ctx.job.post_type,
      }),
    );
  }
  return out;
}
