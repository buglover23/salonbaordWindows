import type { ZodType } from 'zod';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { extractJsonText } from './openai-schema.js';

const MAX_ISSUES = 10;

export interface OutputIssue {
  /** Dotted path inside the output ('' = the whole value). */
  path: string;
  /** The Zod issue code (e.g. too_big, invalid_type); never the offending value. */
  code: string;
}

/**
 * AI_OUTPUT_INVALID (spec 15.1: regenerate with the errors attached, FAILED after the limit). `details` must hold no
 * output text and no request content, only reasons, paths and counts.
 */
export function outputInvalid(clock: Clock, message: string, details: Record<string, unknown>, retryable?: boolean): AppFailure {
  return new AppFailure(appError('AI_OUTPUT_INVALID', 'ai', clock, { message, details, ...(retryable === undefined ? {} : { retryable }) }));
}

/** Deletes the unrecognized keys at their paths; false when a path cannot be followed (nothing to trust then). */
function dropUnrecognizedKeys(value: unknown, issues: readonly { path: PropertyKey[]; keys?: string[] }[]): boolean {
  for (const issue of issues) {
    let node = value;
    for (const step of issue.path) node = node != null && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[step] : undefined;
    if (node == null || typeof node !== 'object' || !issue.keys) return false;
    for (const key of issue.keys) delete (node as Record<string, unknown>)[key];
  }
  return true;
}

/** Parses an output value with the request's schema; a mismatch is AI_OUTPUT_INVALID naming the paths only. */
export function validateOutput<T>(schema: ZodType<T>, value: unknown, clock: Clock, details: Record<string, unknown> = {}): T {
  let parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // A model that adds keys the schema does not know (strict objects) is still right about every key we asked for:
  // drop only those keys, and accept only when nothing else was wrong.
  if (parsed.error.issues.every((i) => i.code === 'unrecognized_keys') && dropUnrecognizedKeys(value, parsed.error.issues)) {
    const retry = schema.safeParse(value);
    if (retry.success) return retry.data;
    parsed = retry;
  }
  const issues: OutputIssue[] = parsed.error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
  const where = [...new Set(issues.map((i) => i.path || '(全体)'))].join('、');
  throw outputInvalid(clock, `AIの出力が規定の項目・形式に合いませんでした（${where}）。`, {
    ...details,
    reason: 'schema',
    issue_count: parsed.error.issues.length,
    issues,
  });
}

/** Up to 10 distinct web pages a web-search answer used, as origin + path (no query string or fragment: they may carry tracking ids). */
export function sourcePages(urls: readonly unknown[]): string[] {
  const pages = urls.flatMap((raw) => {
    const u = typeof raw === 'string' ? URL.parse(raw) : null;
    return u !== null && (u.protocol === 'https:' || u.protocol === 'http:') ? [`${u.origin}${u.pathname}`] : [];
  });
  return [...new Set(pages)].slice(0, 10);
}

/** The text of a structured-output response: JSON first, then the schema. */
export function parseJsonOutput<T>(schema: ZodType<T>, text: string, clock: Clock, details: Record<string, unknown> = {}): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Only after the direct parse failed: a BOM, a Markdown code fence or a lead-in/trailing sentence around the object.
    try {
      const extracted = extractJsonText(text);
      if (extracted === null) throw new Error('no object');
      json = JSON.parse(extracted);
    } catch {
      throw outputInvalid(clock, 'AIの出力をJSONとして読み取れませんでした。', { ...details, reason: 'invalid_json', text_length: text.length });
    }
  }
  return validateOutput(schema, json, clock, details);
}
