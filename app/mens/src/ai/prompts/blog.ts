import type { GenerationContext } from '../context.js';
import { describeLimit } from './limits.js';

/** The blog-post part of the stable system prompt (spec 9.2, 9.7). Constant: no job or config data. */
export const BLOG_RULES = `Blog post (ブログ投稿)
- title: a natural article title a customer would search for and click, built on the title_pattern you chose. Do not always use the 年代＋季節＋髪型＋色 shape.
- body: a readable plain-text article without hashtags. Paragraphs are separated by a blank line; short headings in 【】 are allowed. No Markdown and no '#' anywhere in the body (a '#' would look like a hashtag).
- Base flow: the sections listed in the request. Change the angle between posts (seasonal concerns, choosing a colour, care by length, consultation ...), and the order and emphasis of the sections.
- The body is an article of its own: it must not copy or lightly rephrase a style post's stylist comment, an Excel example comment or a recent post.`;

/** Request lines for a blog post (trusted: numbers and config only, never reference data). */
export function blogRequestLines(ctx: GenerationContext): string[] {
  const { limits } = ctx;
  const body = limits.fields.body ?? [];
  return [
    `- body: the final string (the body, a line break, then the hashtags) must be ${describeLimit(body)}. Aim for about ${limits.primary_text_target} for the body itself (about ${limits.targets.body ?? 0} in total with ${ctx.hashtags.suggested} hashtags).`,
    ...(limits.max_newlines === null ? [] : [`- body: at most ${limits.max_newlines} line breaks in that final string (a blank line between paragraphs counts as 2).`]),
    `- Article flow: ${ctx.writing.sections.join(' → ')}.`,
  ];
}
