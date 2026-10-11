import { AUTOSUBMIT_ATTR, INLINE_CONFIRM_ATTR, maskAttrValue, maskPath, maskSensitiveText } from '../../../../../src/shared/protocol/index.js';
import { nfkcTrim } from '../../salonboard/engine/text.js';

// Default-deny sanitizing for survey captures (P3-R45). Input, textarea and contenteditable values are never read;
// a text is shown only when a rule below keeps it, and then masked.

export interface Rules {
  /** strict: the automatic outlines and the probe (only the salon label, the job's own title and dates). */
  mode: 'owner' | 'strict';
  salonLabel: string | null;
  posterName: string | null;
  knownTitle: string | null;
  /** Form texts (label, legend, button, option, link) are kept for the posting form survey only. */
  formTexts: boolean;
}

export type TextKind = 'date_like' | 'number' | 'text' | 'empty';

const DATE_LIKE = /^(?:\d{4}[/.\-年]\d{1,2}[/.\-月]\d{1,2}日?|\d{1,2}[/月]\d{1,2}日?)(?:\s*\(.{1,3}\))?(?:\s*\d{1,2}[:時]\d{2}分?(?::\d{2})?)?$/;
export const isDateLike = (t: string): boolean => DATE_LIKE.test(nfkcTrim(t));

export function textKind(raw: string): TextKind {
  const t = nfkcTrim(raw);
  if (t === '') return 'empty';
  if (DATE_LIKE.test(t)) return 'date_like';
  return /^[\d\s,./:%+-]+$/.test(t) ? 'number' : 'text';
}

/** 「2026/10/06 10:01」 → 'YYYY/MM/DD HH:mm' (the profile's date_format syntax), else null. */
export function dateFormatGuess(raw: string): string | null {
  const t = nfkcTrim(raw).replace(/\s*\(.{1,3}\)\s*/, ' ').trim();
  if (!DATE_LIKE.test(t)) return null;
  const names = /^\d{4}/.test(t) ? ['YYYY', 'MM', 'DD', 'HH', 'mm'] : ['MM', 'DD', 'HH', 'mm'];
  let i = 0;
  const out = t.replace(/\d+/g, (d) => {
    const n = names[i++] ?? '?';
    return n.length === 2 && d.length === 1 ? n.charAt(0) : n;
  });
  return /^[YMDHm年月日時分:/\- .]+$/.test(out) && out.length <= 30 ? out : null;
}

export type TextContext = 'form' | 'header' | 'heading' | 'other' | 'never';

/** Where a text sits, for the keep rules. Inside textarea or contenteditable nothing is ever kept. */
export function contextOf(el: Element, r: Rules): TextContext {
  if (el.closest('textarea, [contenteditable]:not([contenteditable="false"])') !== null) return 'never';
  if (el.closest('h1, h2, h3') !== null) return 'heading';
  if (el.closest('th') !== null) return 'header';
  if (r.formTexts && el.closest('form') !== null && el.closest('label, legend, button, option, a') !== null) return 'form';
  return 'other';
}

/** The masked text when a rule keeps it, '' for an empty text, else null (shown as a text kind or █). */
export function keptText(raw: string, r: Rules, ctx: TextContext): string | null {
  const t = nfkcTrim(raw);
  if (t === '') return '';
  if (ctx === 'never') return null;
  const same = (x: string | null): boolean => x !== null && t === nfkcTrim(x);
  if (same(r.salonLabel) || same(r.knownTitle) || isDateLike(t)) return maskSensitiveText(t).slice(0, 200);
  if (r.salonLabel !== null && nfkcTrim(r.salonLabel) !== '' && t.includes(nfkcTrim(r.salonLabel))) return '[salon?]';
  if (r.mode === 'strict') return null;
  if (same(r.posterName)) return maskSensitiveText(t).slice(0, 200);
  if (ctx === 'other') return null;
  return maskSensitiveText(t).slice(0, ctx === 'heading' ? 40 : 200);
}

/** keptText, or █ for a text no rule keeps. */
export const shownText = (raw: string, r: Rules, ctx: TextContext): string => keptText(raw, r, ctx) ?? '█';

const HANDLER = /^on/i;

/** Inline handlers (and javascript: links) that call confirm( or submit( (P3-R40). */
export function hintsOf(el: Element): { inline_confirm_hint: boolean; autosubmit_hint: boolean } {
  const code = [...el.attributes]
    .filter((a) => HANDLER.test(a.name) || (a.name === 'href' && /^\s*javascript:/i.test(a.value)))
    .map((a) => a.value)
    .join('\n');
  return { inline_confirm_hint: /\bconfirm\s*\(/.test(code), autosubmit_hint: /\b(?:requestSubmit|submit)\s*\(/.test(code) };
}

/** A URL as masked path and query keys (http and https only). */
export function urlParts(href: string, base: string): { origin: string; path: string; query_keys: string[] } | null {
  const u = URL.parse(href, base);
  if (u === null || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return {
    origin: `${u.protocol}//${maskAttrValue(u.host)}`,
    path: maskPath(u.pathname).slice(0, 200),
    query_keys: [...new Set(u.searchParams.keys())].slice(0, 50).map((k) => maskAttrValue(k).slice(0, 100)),
  };
}

const KEPT_ATTRS = new Set(['id', 'name', 'class', 'type', 'for', 'role', 'required', 'aria-required', 'maxlength', 'multiple', 'accept', 'disabled', 'checked', 'selected']);
const keepsValue = (el: Element): boolean => el.localName === 'option' || (el.localName === 'input' && /^(checkbox|radio)$/i.test(el.getAttribute('type') ?? ''));

/** Keeps only the listed attributes (masked), `value` on options, checkboxes and radios, and href as a masked path. */
export function sanitizeAttributes(el: Element, pageUrl: string): void {
  const hints = hintsOf(el);
  const pageOrigin = URL.parse(pageUrl)?.origin;
  for (const a of [...el.attributes]) {
    const name = a.name.toLowerCase();
    const href = name === 'href' ? urlParts(a.value, pageUrl) : null;
    if (href !== null) {
      const keys = href.query_keys.length > 0 ? `?${href.query_keys.map((k) => `${k}=`).join('&')}` : '';
      el.setAttribute(a.name, `${href.origin === pageOrigin ? '' : href.origin}${href.path}${keys}`);
    } else if (KEPT_ATTRS.has(name) || (name === 'value' && keepsValue(el))) {
      el.setAttribute(a.name, maskAttrValue(a.value));
    } else {
      el.removeAttribute(a.name);
    }
  }
  if (hints.inline_confirm_hint) el.setAttribute(INLINE_CONFIRM_ATTR, '1');
  if (hints.autosubmit_hint) el.setAttribute(AUTOSUBMIT_ATTR, '1');
}

const SAFE_ID = /^[A-Za-z][\w-]{0,99}$/;
const SAFE_NAME = /^[\w.:[\]-]{1,100}$/;

function unique(doc: Document, css: string): boolean {
  try {
    return doc.querySelectorAll(css).length === 1;
  } catch {
    return false;
  }
}

/** Element path from body by tag and position only (no page data); the skeleton keeps the same structure. */
export function pathSelector(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e !== null && e.localName !== 'body' && e.localName !== 'html'; e = e.parentElement) {
    let n = 1;
    for (let s = e.previousElementSibling; s !== null; s = s.previousElementSibling) if (s.localName === e.localName) n++;
    parts.unshift(`${e.localName}:nth-of-type(${n})`);
  }
  return ['body', ...parts].join(' > ');
}

/** Candidate selectors for profile authoring: a unique id, a unique name, and the structural path (≤ 300 characters each). */
export function selectorsOf(el: Element): string[] {
  const doc = el.ownerDocument;
  const out: string[] = [];
  const id = el.getAttribute('id');
  if (id !== null && SAFE_ID.test(id) && maskAttrValue(id) === id && unique(doc, `#${id}`)) out.push(`#${id}`);
  const name = el.getAttribute('name');
  const byName = `${el.localName}[name="${name ?? ''}"]`;
  if (name !== null && SAFE_NAME.test(name) && maskAttrValue(name) === name && unique(doc, byName)) out.push(byName);
  const path = pathSelector(el);
  if (path.length <= 300) out.push(path);
  return out;
}
