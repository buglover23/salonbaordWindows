import type { CountUnit } from '../../shared/text.js';
import type { FieldLimit } from '../context.js';

const UNIT_EN: Record<CountUnit, string> = {
  grapheme: 'graphemes',
  codepoint: 'Unicode code points',
  utf16: 'UTF-16 code units',
  bytes: 'UTF-8 bytes',
};

/** "at most 120 graphemes" (several constraints joined with "and"). */
export function describeLimit(list: readonly FieldLimit[]): string {
  if (list.length === 0) return 'reasonably short';
  return `at most ${list.map((l) => `${l.max} ${UNIT_EN[l.unit]}`).join(' and ')}`;
}
