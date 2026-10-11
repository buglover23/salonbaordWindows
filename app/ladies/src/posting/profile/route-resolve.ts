import type { ConfigSnapshot } from '../../config/loader.js';
import type { ReadinessItem } from '../../config/readiness.js';
import type { SalonboardFields } from '../../config/schemas.js';
import type { EffectiveConfig } from '../../content/effective-config.js';
import { sha256Hex } from '../../shared/hash.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../../shared/labels.js';
import type { OtherRoute, RouteSnapshot } from '../../shared/protocol/commands.js';
import type { PageProfile } from '../../shared/protocol/profile.js';
import { matchProfileUrl } from '../../shared/protocol/url-match.js';
import type { RouteKey } from '../../shared/protocol/version.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type PostType } from '../../shared/types.js';
import { PRODUCTION_URL_POLICY, type UrlPolicy } from '../../shared/url-policy.js';
import { profileHash } from '../profile-hash.js';

// Which page a route posts to, and whether that is verified (spec 5.11, P3-R37): readiness lists every problem,
// resolveRoute (claim) takes the route only when there is none.

type Routes = SalonboardFields['posting_routes'];
type RouteView = Pick<EffectiveConfig, 'base' | 'routes' | 'routeSources'>;

/** What checks:record route stores for the entry URL: SHA-256 of the effective URL exactly as configured. */
export const entryUrlSha256 = (url: string): string => sha256Hex(url);

export const PROFILE_CHANGED = '画面設定が確認後に変更されています（profile:check と checks:record profile をやり直してください）';

/** The profile when the owner's verification still holds for its current content (verified_at and verified_hash). */
export function verifiedProfile(s: ConfigSnapshot, id: string | null): PageProfile | null {
  const p = id === null ? undefined : s.salonboardFields.pages[id];
  return p !== undefined && p.verified_at !== null && p.verified_hash === profileHash(p) ? p : null;
}

/** The verified page profile of a route (for limits, hashtag placement and encoding), or null. */
export const routeProfile = (v: Pick<EffectiveConfig, 'base' | 'routes'>, type: PostType, audience: AudienceCategory): PageProfile | null =>
  verifiedProfile(v.base, v.routes[type][audience].page_profile_id);

/**
 * The route's page profile for laying out text (limits, hashtag placement), verified or not: a draft written for the real
 * page's layout before the owner's verification is still checked again at dispatch. Posting itself uses routeProfile.
 */
export function layoutProfile(v: Pick<EffectiveConfig, 'base' | 'routes'>, type: PostType, audience: AudienceCategory): PageProfile | null {
  const id = v.routes[type][audience].page_profile_id;
  return verifiedProfile(v.base, id) ?? (id === null ? null : (v.base.salonboardFields.pages[id] ?? null));
}

/** Problems with a route's target: URL, adapter, page profile and the owner's verification of both. */
export function routeTargetItems(s: ConfigSnapshot, type: PostType, audience: AudienceCategory, routes: Routes, policy: UrlPolicy = PRODUCTION_URL_POLICY): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const label = `${POST_TYPE_JA[type]}・${AUDIENCE_JA[audience]}`;
  const unverified = (detail: string): void => {
    items.push({ code: 'POST_TARGET_UNVERIFIED', detail: `${label}${detail}` });
  };
  const target = routes[type][audience];
  const where = `posting_routes.${type}.${audience}`;

  if (target.entry_url === null) {
    items.push({ code: 'POST_TARGET_UNCONFIGURED', detail: `${label}の投稿先URLが未設定です（salonboard_fields.json の ${where}.entry_url、または投稿先URL設定の指示書）` });
  } else {
    const origin = URL.parse(target.entry_url)?.origin ?? null;
    const reason = origin === null ? 'URLとして読み取れません' : policy.checkOrigin(origin);
    if (reason !== null) unverified(`の投稿先URLは使えません: ${reason}`);
  }
  if (target.adapter_id === null) unverified('に対応する画面の処理（adapter_id）が未設定です');
  let profile: PageProfile | undefined;
  if (target.page_profile_id === null) unverified('の画面profile（page_profile_id）が未設定です');
  else {
    const id = target.page_profile_id;
    profile = s.salonboardFields.pages[id];
    if (profile === undefined) unverified(`の画面profile「${id}」が salonboard_fields.json の pages にありません`);
    else {
      // Spec 5.11: a profile only counts for the post type and audience it was verified for.
      if (profile.post_type !== type) unverified(`の画面profile「${id}」は投稿種別が一致しません（この投稿先は${POST_TYPE_JA[type]}、profileは${POST_TYPE_JA[profile.post_type]}用）`);
      if (target.adapter_id !== null && target.adapter_id !== profile.post_type) unverified(`の画面の処理（adapter_id: ${target.adapter_id}）が画面profile「${id}」の投稿種別（${profile.post_type}）と一致しません`);
      if (!profile.audiences.includes(audience)) {
        unverified(`の画面profile「${id}」は${AUDIENCE_JA[audience]}に対応していません（profileの対象: ${profile.audiences.map((a) => AUDIENCE_JA[a]).join('・')}）`);
      }
      if (target.entry_url !== null && !matchProfileUrl(target.entry_url, profile.url_match).ok) {
        unverified(`の投稿先URLが画面profile「${id}」の画面のURL（url_match）に当てはまりません。投稿先URLか画面profileを確認してください`);
      }
      if (profile.verified_at === null) unverified(`の画面profile「${id}」は正規画面での確認が済んでいません（verified_at が未記録）`);
      else if (profile.verified_hash !== profileHash(profile)) unverified(`の画面profile「${id}」: ${PROFILE_CHANGED}`);
    }
  }

  const record = s.deploymentChecks.page_routes_verified[type][audience];
  const recordPath = `deployment_checks.json の page_routes_verified.${type}.${audience}`;
  if (record === false) unverified(`の投稿画面を確認済みと記録されていません（${recordPath}）`);
  else if (record === true) unverified(`の投稿画面の確認は、確認時の画面設定が記録されていません（${recordPath}。checks:record route で記録し直してください）`);
  else {
    if (profile !== undefined && (record.profile_id !== target.page_profile_id || record.profile_hash !== profileHash(profile))) {
      unverified(`の投稿画面の確認は、今と違う画面設定で記録されています（${PROFILE_CHANGED}）`);
    }
    if (target.entry_url !== null && record.entry_url_sha256 !== entryUrlSha256(target.entry_url)) {
      unverified('の投稿先URLが確認したときから変わっています（checks:record route で確認し直してください）');
    }
  }
  return items;
}

/**
 * The route as claim freezes it (RouteSnapshot), or the first problem. `effective.routes` holds the instruction URLs.
 */
export function resolveRoute(
  effective: RouteView,
  type: PostType,
  audience: AudienceCategory,
  policy: UrlPolicy = PRODUCTION_URL_POLICY,
): { ok: true; snapshot: RouteSnapshot; profile: PageProfile } | { ok: false; item: ReadinessItem } {
  const [item] = routeTargetItems(effective.base, type, audience, effective.routes, policy);
  if (item !== undefined) return { ok: false, item };
  const target = effective.routes[type][audience];
  const profile = target.page_profile_id === null ? undefined : effective.base.salonboardFields.pages[target.page_profile_id];
  // routeTargetItems found nothing missing, so these hold; the check keeps the types honest.
  if (target.entry_url === null || target.adapter_id === null || target.page_profile_id === null || profile === undefined || profile.verified_at === null) {
    return { ok: false, item: { code: 'POST_TARGET_UNVERIFIED', detail: `${POST_TYPE_JA[type]}・${AUDIENCE_JA[audience]}の投稿先が確定できません` } };
  }
  const key: RouteKey = `${type}.${audience}`;
  return {
    ok: true,
    profile,
    snapshot: {
      route_key: key,
      entry_url: target.entry_url,
      adapter_id: target.adapter_id,
      adapter_version: profile.adapter_version,
      page_profile_id: target.page_profile_id,
      profile_hash: profileHash(profile),
      profile_verified_at: profile.verified_at,
      source: effective.routeSources[key] === 'instructions' ? 'instruction' : 'config',
    },
  };
}

/** The pages of the other routes (any profile, verified or not), for §5.6 rows 7–9. */
export function otherRoutesFor(effective: Pick<EffectiveConfig, 'base' | 'routes'>, routeKey: RouteKey): OtherRoute[] {
  const out: OtherRoute[] = [];
  for (const type of POST_TYPES) {
    for (const audience of AUDIENCE_CATEGORIES) {
      const key: RouteKey = `${type}.${audience}`;
      const id = effective.routes[type][audience].page_profile_id;
      const p = id === null ? undefined : effective.base.salonboardFields.pages[id];
      if (key !== routeKey && p !== undefined) out.push({ route_key: key, url_match: p.url_match, page_identification: p.page_identification });
    }
  }
  return out;
}

