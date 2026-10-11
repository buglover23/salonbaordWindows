import type { WritingRules } from '../../config/schemas.js';
import type { PageProfile } from '../../shared/protocol/profile.js';

export type Placement = 'append_to_primary_text' | 'dedicated_field';

/**
 * P3-R8: where the hashtags go. A verified profile decides for its route; before that (null), writing_rules does.
 * `unsupported` is a readiness item, so such a route never posts; generation falls back to writing_rules meanwhile.
 */
export function effectivePlacement(profile: PageProfile | null, fallback: WritingRules['hashtag_placement']): Placement {
  const p = profile?.hashtag.placement;
  return p === 'dedicated_field' || p === 'append_to_primary_text' ? p : fallback;
}

/** What is typed into a dedicated hashtag field: one entry per tag when tags are added one at a time, else one string. */
export function hashtagEntries(tags: readonly string[], spec: PageProfile['hashtag']): string[] {
  const rendered = tags.map((t) => (spec.with_hash_sign ? `#${t}` : t));
  if (spec.add_button !== undefined) return rendered;
  return rendered.length === 0 ? [] : [rendered.join(spec.separator)];
}
