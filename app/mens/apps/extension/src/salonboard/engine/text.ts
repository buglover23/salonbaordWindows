export { normalizeForCompare } from '../../../../../src/shared/protocol/index.js';

/** NFKC, whitespace collapsed, trimmed: how page labels and option texts are compared (exact equality, never a substring). */
export const nfkcTrim = (s: string): string => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();

/** CRLF and CR as LF. */
export const lf = (s: string): string => s.replace(/\r\n?/g, '\n');
