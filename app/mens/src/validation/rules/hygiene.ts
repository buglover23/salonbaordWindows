import { primaryFieldOf, type Draft } from '../../ai/draft-schemas.js';
import { fieldJa, quoted, textFields, violation, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 2: whitespace-only text, invisible or control characters, HTML, URLs that are not allowed, phone numbers
// and e-mail addresses. Checked on the NFKC form, so full-width variants (＜ｂ＞, ｈｔｔｐ, ０３－…) are caught too.

/** Control (except a line break in the primary text), format (zero-width, bidi), private-use and line/paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/gu;
const HTML_TAG = /<\s*\/?\s*[a-z!][^<>]*>/iu;
const HTML_ENTITY = /&(?:[a-z][a-z0-9]{1,30}|#\d{1,7}|#x[0-9a-f]{1,6});/iu;
const URL_LIKE = /\bhttps?:\/\/[^\s<>"'「」『』（）()、。]+|\bwww\.[^\s<>"'「」『』（）()、。]+/giu;
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|jp|info|biz|io|me|co|app|page|link|ly|to|tv|shop|salon|beauty|xyz)\b(?:\/[^\s<>"'「」『』（）()、。]*)?/giu;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/iu;
/** Digits with the separators a phone number is written with; checked for 10-11 digits afterwards. */
const PHONE_LIKE = /\+?\d[\d\-‐－―ー−()（）\s]{7,}\d/gu;

const codePoint = (c: string): string => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
const trimTrailing = (u: string): string => u.replace(/[.,!?:;]+$/u, '');

function hostOf(u: string): string | null {
  const parsed = URL.parse(/^[a-z]+:\/\//iu.test(u) ? u : `https://${u}`);
  return parsed === null ? null : parsed.hostname.toLowerCase();
}

/** A URL is allowed when it is an allowed_urls entry, or lies under one (path, query or fragment after it). */
function allowedUrl(u: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => u === a || u.startsWith(a.endsWith('/') ? a : `${a}/`) || u.startsWith(`${a}?`) || u.startsWith(`${a}#`));
}

function phoneNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_LIKE)) {
    const digits = m[0].replace(/\D/gu, '');
    const domestic = digits.startsWith('0') && digits.length >= 10 && digits.length <= 11;
    const international = m[0].startsWith('+81') && digits.length >= 11 && digits.length <= 12;
    if (domestic || international) out.push(m[0].trim());
  }
  return out;
}

interface Checked {
  field: string;
  text: string;
  allowNewline: boolean;
}

/** Group 2: empty_text, invisible_char, html, url, phone_number, email. All hard. */
export function checkHygiene(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const primary = primaryFieldOf(draft.post_type);
  const allowed = ctx.snapshot.writingRules.allowed_urls;
  const allowedHosts = new Set(allowed.flatMap((a) => hostOf(a) ?? []));
  const checked: Checked[] = [
    ...textFields(draft).map((f) => ({ ...f, allowNewline: f.field === primary })),
    ...draft.hashtags.map((t) => ({ field: 'hashtags', text: t, allowNewline: false })),
  ];

  for (const f of textFields(draft)) {
    // An empty menu text is the menu rule's finding (group 4), not a whitespace problem.
    if (f.field === 'menu_text' && f.text === '') continue;
    if (f.text.trim() === '') out.push(violation(f.field, 'empty_text', 'hard', `${fieldJa(f.field)}が空か、空白だけです。`));
  }

  const invisible = new Map<string, Set<string>>();
  for (const f of checked) {
    for (const m of f.text.matchAll(INVISIBLE)) {
      if (f.allowNewline && m[0] === '\n') continue;
      const set = invisible.get(f.field) ?? new Set<string>();
      set.add(codePoint(m[0]));
      invisible.set(f.field, set);
    }
  }
  for (const [field, codes] of invisible) {
    const list = [...codes].slice(0, 10).join(', ');
    out.push(
      violation(field, 'invisible_char', 'hard', `${fieldJa(field)}に、見えない文字や制御文字（${list}）が含まれています。通常の文字だけで書いてください。`, {
        offending_text: list,
      }),
    );
  }

  const report = (field: string, rule: string, found: string[], what: string): void => {
    const unique = [...new Set(found)].slice(0, 5);
    if (unique.length === 0) return;
    out.push(violation(field, rule, 'hard', `${fieldJa(field)}に${what}が含まれています: ${quoted(unique)}。投稿文には書けません。`, { offending_text: unique.join(' ') }));
  };
  const byField = new Map<string, string[]>();
  for (const f of checked) byField.set(f.field, [...(byField.get(f.field) ?? []), f.text.normalize('NFKC')]);
  for (const [field, texts] of byField) {
    const html = texts.flatMap((t) => [HTML_TAG.exec(t)?.[0], HTML_ENTITY.exec(t)?.[0]].filter((x): x is string => x !== undefined));
    report(field, 'html', html, 'HTMLのタグや文字参照');
    const urls = texts.flatMap((t) => [...t.matchAll(URL_LIKE)].map((m) => trimTrailing(m[0]))).filter((u) => !allowedUrl(u, allowed));
    const bare = texts
      .flatMap((t) => [...t.replace(URL_LIKE, ' ').matchAll(BARE_DOMAIN)].map((m) => trimTrailing(m[0])))
      .filter((d) => !allowedHosts.has(hostOf(d) ?? ''));
    report(field, 'url', [...urls, ...bare], '許可されていないURL（writing_rules.json の allowed_urls に無いもの）');
    report(field, 'phone_number', texts.flatMap(phoneNumbers), '電話番号');
    report(field, 'email', texts.flatMap((t) => EMAIL.exec(t)?.[0] ?? []), 'メールアドレス');
  }
  return out;
}
