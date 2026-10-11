import { z } from 'zod';

// Path templates are a restricted syntax matched segment by segment, never compiled into a regular expression.
// Linear-time check: segments are separated by '/', and the two segment forms differ in their first character.
// At least one segment; '*' only as a whole final segment ("/*"); at least one literal (non-:param) segment.
const PATH_TEMPLATE = /^\/(?:[A-Za-z0-9._~%-]+|:[a-z_]+)(?:\/(?:[A-Za-z0-9._~%-]+|:[a-z_]+))*(?:\/\*|\/)?$/;
const hasLiteralSegment = (t: string): boolean => t.split('/').some((s) => s !== '' && s !== '*' && !s.startsWith(':'));

export const PathTemplateSchema = z
  .string()
  .max(200)
  .regex(PATH_TEMPLATE, 'パスは / で区切った英数字か :名前 で書いてください（* は最後の /* だけに使えます）')
  .refine(hasLiteralSegment, 'パスに固定の部分が必要です（/* だけは使えません）');

export const UrlMatchSchema = z.strictObject({
  /** Equal to one allowed origin (loader cross-check). */
  origin: z.string(),
  paths: z.array(PathTemplateSchema).min(1).max(5),
  allowed_query_keys: z.array(z.string().min(1).max(40)).max(10).default([]),
  required_query: z.record(z.string().max(40), z.string().max(100)).default({}),
});
export type UrlMatch = z.infer<typeof UrlMatchSchema>;

export type UrlMatchFailure = 'origin' | 'path' | 'query_key' | 'required_query' | 'syntax';

/** Segment-wise: `:name` matches one non-empty segment, a final `/*` one or more further segments, anything else exactly. */
export function pathTemplateMatches(template: string, pathname: string): boolean {
  const t = template.split('/');
  const p = pathname.split('/');
  const wildcard = t.at(-1) === '*';
  if (wildcard) t.pop();
  if (wildcard ? p.length <= t.length : p.length !== t.length) return false;
  return t.every((seg, i) => (seg.startsWith(':') ? p[i] !== '' : seg === p[i]));
}

/** Pure (WHATWG URL); runs in Node and in the extension. Required query keys count as allowed keys. */
export function matchProfileUrl(url: string, m: UrlMatch): { ok: true } | { ok: false; reason: UrlMatchFailure } {
  const u = URL.parse(url);
  const authority = url.split('//')[1]?.split(/[/?#\\]/)[0] ?? '';
  if (u === null || u.username !== '' || u.password !== '' || authority.includes('@')) return { ok: false, reason: 'syntax' };
  if (u.origin !== m.origin) return { ok: false, reason: 'origin' };
  if (!m.paths.some((t) => pathTemplateMatches(t, u.pathname))) return { ok: false, reason: 'path' };
  const allowed = new Set([...m.allowed_query_keys, ...Object.keys(m.required_query)]);
  for (const key of u.searchParams.keys()) {
    if (!allowed.has(key)) return { ok: false, reason: 'query_key' };
  }
  for (const [key, value] of Object.entries(m.required_query)) {
    const values = u.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== value) return { ok: false, reason: 'required_query' };
  }
  return { ok: true };
}
