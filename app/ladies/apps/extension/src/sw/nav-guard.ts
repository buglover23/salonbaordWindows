import { matchProfileUrl, type UrlMatch } from '../../../../src/shared/protocol/index.js';

/**
 * Every navigation the SW makes (entry_url, list.url, next-page and detail links reported by the CS) passes here:
 * the origin must be in (build origins ∩ hello origins) and the URL must match the profile's url_match.
 * false = refuse, with no navigation (SALON_BOARD_PAGE_CHANGED, nav_refused).
 */
export function navigationAllowed(url: string, match: UrlMatch | undefined, origins: readonly string[]): boolean {
  const origin = URL.parse(url)?.origin;
  return match !== undefined && origin !== undefined && origins.includes(origin) && matchProfileUrl(url, match).ok;
}
