import type { GenerationContext } from '../context.js';
import { MENU_SEPARATOR } from '../draft-schemas.js';
import { describeLimit } from './limits.js';

/** The style-post part of the stable system prompt (spec 9.2, 9.6). Constant: no job or config data. */
export const STYLE_RULES = `Style post (スタイル投稿)
- title: a natural title a customer would search for and click, built on the title_pattern you chose. Do not always use the 年代＋季節＋髪型＋色 shape; add an age range or the season only when it fits. Readable first, keywords second.
- menu_items: entries copied character for character from reference_data menu_choices (verified salon menus usable for this photo). When the request says the sidecar fixes the menus, return exactly those entries; otherwise choose 1 to 3 entries consistent with the photo. Never invent, edit, abbreviate or combine a menu, and never choose a menu that names a treatment in unverified_treatments. The app joins the entries with ${MENU_SEPARATOR}.
- stylist_comment: the stylist's comment without hashtags. Base flow: the sections listed in the request. When space is short, merge points instead of repeating information. Say concretely how the style can be worn day to day and which wishes it suits, within what the photo supports. A bookmark or show-the-image line may close it, with wording rotated (cta_examples are wording references, not lines to copy every time).`;

/** Request lines for a style post (trusted: numbers and config only, never reference data). */
export function styleRequestLines(ctx: GenerationContext): string[] {
  const { limits, menus } = ctx;
  const lines: string[] = [];
  const menuLimit = limits.fields.menu_text ?? [];
  if (menus !== null && menus.mode === 'sidecar') {
    lines.push(
      `- menu_items: return exactly the entries in reference_data sidecar.verified_menus (the salon verified them for this photo), in that order; add nothing else. Joined with ${MENU_SEPARATOR} they must be ${describeLimit(menuLimit)}.`,
    );
  } else {
    lines.push(
      `- menu_items: choose 1 to ${menus?.max_items ?? 3} entries of reference_data menu_choices that fit the photo, copied exactly (no other menu may be used for this photo). Joined with ${MENU_SEPARATOR} they must be ${describeLimit(menuLimit)}.`,
    );
  }
  const comment = limits.fields.stylist_comment ?? [];
  lines.push(
    limits.placement === 'append_to_primary_text'
      ? `- stylist_comment: the final string (the comment, a line break, then the hashtags) must be ${describeLimit(comment)}. Aim for about ${limits.primary_text_target} for the comment itself (about ${limits.targets.stylist_comment ?? 0} in total with ${ctx.hashtags.suggested} hashtags).`
      : `- stylist_comment: the comment alone (the hashtags go to the page's own tag field, not into this text) must be ${describeLimit(comment)}. Aim for about ${limits.primary_text_target} and never go over the limit (the app never cuts it): about three or four short sentences.`,
    `- Comment flow: ${ctx.writing.sections.join(' → ')} (merge points when short; do not repeat information).`,
  );
  return lines;
}
