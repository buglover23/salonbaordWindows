// Pure (no node:* imports): the extension's page-profile engine shares it through src/shared/protocol.

/**
 * Comparison-only normalisation (spec 10.3): the original text is never replaced by this.
 * NFKC, lower-case, drop punctuation/symbols, collapse whitespace. The long-vowel mark (U+30FC) is category Lm, so it stays.
 */
export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
