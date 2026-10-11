import { z } from 'zod';

/** ISO 8601 UTC, as Date#toISOString emits it; offsets are rejected on purpose. */
export const isoUtc = z.iso.datetime();

/** First few Zod issues as `path: message` strings; never includes the offending values. */
export function issueSummary(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(全体)'}: ${i.message}`);
}
