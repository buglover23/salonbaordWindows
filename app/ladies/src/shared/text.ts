// Text measurement shared by generation, validation and the posters. Post text is never shortened with these helpers:
// graphemeSlice is for excerpts in logs and prompts only (spec 10.2: no mechanical truncation of post text).

/** How a page counts characters (spec 5.8). Plan 2 default limits use 'grapheme'. */
export const COUNT_UNITS = ['grapheme', 'codepoint', 'utf16', 'bytes'] as const;
export type CountUnit = (typeof COUNT_UNITS)[number];

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** User-perceived characters (extended grapheme clusters): a base letter with combining marks or a joined emoji is 1. */
export function graphemeLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

/** The length of `text` in `unit` (bytes = UTF-8). */
export function measureLength(text: string, unit: CountUnit): number {
  switch (unit) {
    case 'grapheme':
      return graphemeLength(text);
    case 'codepoint':
      return [...text].length;
    case 'utf16':
      return text.length;
    case 'bytes':
      return Buffer.byteLength(text, 'utf8');
  }
}

/** The first `max` graphemes of `text`, never splitting a visible character. For excerpts only. */
export function graphemeSlice(text: string, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (n >= max) break;
    out += segment;
    n++;
  }
  return out;
}

const SENTENCE_END = /[。．！？!?]/u;
const CLOSERS = /[」』）)】〕"'’”]/u;

/**
 * Sentences of a Japanese text, each with its end mark (and closing brackets right after it); a line break also ends
 * a sentence. Whitespace around sentences is dropped and empty sentences are left out.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const chars = [...text.replace(/\r\n?/g, '\n')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch === '\n') {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (SENTENCE_END.test(ch)) {
      while (i + 1 < chars.length && (CLOSERS.test(chars[i + 1] as string) || SENTENCE_END.test(chars[i + 1] as string))) current += chars[++i];
      if (current.trim() !== '') out.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}
