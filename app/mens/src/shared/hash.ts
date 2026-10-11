import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { normalizeForCompare } from './text-normalize.js';

/** Strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of a title or primary text for exact-duplicate checks (spec 10.3 / 16.5): SHA-256 of normalizeForCompare. The one
 * definition dedupe.json, history.json and the Validator share.
 */
export const comparisonHash = (s: string): string => sha256Hex(normalizeForCompare(s));

/** Streams the file so large images are never held in memory as a whole. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
