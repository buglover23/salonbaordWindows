// `remote_id_pattern` is restricted: literal text plus exactly one `(\d+)` or `([A-Za-z0-9_-]+)` group. The literals are
// escaped, so the compiled expression has a single quantifier and runs in linear time; anything else is rejected.

const GROUPS = ['(\\d+)', '([A-Za-z0-9_-]+)'] as const;

/** A function extracting the id from a URL path (and query), or null when the pattern is not in the restricted form. */
export function compileRemoteId(pattern: string): ((text: string) => string | null) | null {
  const hits = GROUPS.filter((g) => pattern.includes(g));
  const group = hits[0];
  if (hits.length !== 1 || group === undefined) return null;
  const parts = pattern.split(group);
  if (parts.length !== 2 || parts.some((p) => /[()\\[\]{}*+?|^$]/.test(p))) return null;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  const re = new RegExp(`${escape(parts[0] ?? '')}${group}${escape(parts[1] ?? '')}`);
  return (text) => re.exec(text)?.[1] ?? null;
}
