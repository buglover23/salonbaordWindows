import { matchProfileUrl, type AllOf, type OtherRoute, type PageProfile, type UrlMatch } from '../../../../../src/shared/protocol/index.js';
import type { AudienceCategory } from '../../../../../src/shared/types.js';
import { resolveOne } from './locate.js';
import { allOf, detectFailures } from './signals.js';
import { nfkcTrim } from './text.js';

// The §5.6 page outcome table: rows are evaluated in order and the first that applies wins. Row 10 (a document change
// after the first input) belongs to the adapter, which watches the document.

export type PageCode =
  | 'PAGE_TIMEOUT'
  | 'AUTH_REQUIRED'
  | 'MFA_REQUIRED'
  | 'CAPTCHA'
  | 'ACCOUNT_ERROR'
  | 'LIMIT_REACHED'
  | 'WRONG_SALON'
  | 'POST_TARGET_MISMATCH'
  | 'SALON_BOARD_PAGE_CHANGED';
export type Row = 1 | 2 | 3 | 4 | 5 | '5a' | 6 | 7 | 8 | 9 | 10;
/** `detail` is a fixed English token (evidence notes), never page text. */
export type Identified = { ok: true } | { ok: false; code: PageCode; row: Row; detail: string | null };

export interface IdentifyContext {
  /** salon.expected_account_label. */
  expectedLabel: string;
  otherRoutes: readonly OtherRoute[];
  /** The command's audience. */
  audience: AudienceCategory;
}

/** NFKC, collapsed whitespace, then exact equality: 「サロン 2号店」 is not 「サロン」. */
export const salonLabelEquals = (a: string, b: string): boolean => nfkcTrim(a) === nfkcTrim(b);

/** The document is the page a profile (or another route) describes: its URL and its identification signals. */
export const pageMatches = (doc: Document, m: { url_match: UrlMatch; page_identification: AllOf }): boolean =>
  matchProfileUrl(doc.URL, m.url_match).ok && allOf(doc, m.page_identification);

/**
 * The page shows the audience: its identification holds and the other audience's does not. For by_field profiles the
 * adapter calls this after setting fields.audience; `none` profiles have no audience on the screen.
 */
export function audienceMatches(profile: PageProfile, doc: Document, audience: AudienceCategory): boolean {
  if (!profile.audiences.includes(audience)) return false;
  if (profile.audience_mode === 'none') return true;
  const want = profile.audience_identification[audience];
  const other = profile.audience_identification[audience === 'mens' ? 'ladies' : 'mens'];
  return want !== undefined && allOf(doc, want) && (other === undefined || !allOf(doc, other));
}

/** §5.6 rows 1–9 for the posting page, before any input. */
export function identifyPage(profile: PageProfile, doc: Document, ctx: IdentifyContext): Identified {
  const fail = (code: PageCode, row: Row, detail: string | null = null): Identified => ({ ok: false, code, row, detail });
  if (doc.readyState !== 'complete') return fail('PAGE_TIMEOUT', 1, 'document_not_complete');
  const origin = URL.parse(doc.URL)?.origin;
  const origins = new Set([profile.url_match.origin, ...ctx.otherRoutes.map((r) => r.url_match.origin)]);
  if (origin === undefined || !origins.has(origin)) return fail('AUTH_REQUIRED', 2, 'left_allowed_origins');
  const failure = detectFailures(profile, doc);
  if (failure !== null) return fail(failure.code, failure.row, failure.detail);

  const salon = resolveOne(doc, profile.salon_identification.locators);
  if (salon.ok && !salonLabelEquals(salon.el.textContent ?? '', ctx.expectedLabel)) return fail('WRONG_SALON', 6);
  if (!pageMatches(doc, profile)) {
    const other = ctx.otherRoutes.find((r) => pageMatches(doc, r));
    return other === undefined ? fail('SALON_BOARD_PAGE_CHANGED', 9, 'no_route_profile') : fail('POST_TARGET_MISMATCH', 7, `route:${other.route_key}`);
  }
  if (!profile.audiences.includes(ctx.audience) || (profile.audience_mode === 'by_page' && !audienceMatches(profile, doc, ctx.audience))) {
    return fail('POST_TARGET_MISMATCH', 8, 'audience');
  }
  if (!salon.ok) return fail('SALON_BOARD_PAGE_CHANGED', 9, `salon:${salon.reason}`);
  for (const [key, field] of Object.entries(profile.fields)) {
    if (!field.required) continue;
    const r = resolveOne(doc, field.locators);
    if (!r.ok) return fail('SALON_BOARD_PAGE_CHANGED', 9, `field:${key}:${r.reason}`);
  }
  const submit = resolveOne(doc, profile.submit.locators);
  if (!submit.ok) return fail('SALON_BOARD_PAGE_CHANGED', 9, `submit:${submit.reason}`);
  return { ok: true };
}
