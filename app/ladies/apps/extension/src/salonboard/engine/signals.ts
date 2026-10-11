import type { AllOf, ObservedCount, PageProfile, Signal } from '../../../../../src/shared/protocol/index.js';
import { resolveOne, type Root } from './locate.js';
import { nfkcTrim } from './text.js';

/**
 * One signal. `absent` holds only when no candidate finds the element (or it lacks the text/attribute); a locator that
 * is ambiguous or broken never counts as absent.
 */
export function evalSignal(root: Root, s: Signal): boolean {
  const r = resolveOne(root, s.locators);
  if (!r.ok) return s.state === 'absent' && r.reason === 'none';
  const el = r.el;
  const matches =
    (s.text_includes === undefined || nfkcTrim(el.textContent ?? '').includes(nfkcTrim(s.text_includes))) &&
    (s.attr === undefined || el.getAttribute(s.attr.name) === s.attr.equals);
  switch (s.state) {
    case 'absent':
      return !matches;
    case 'checked':
      return matches && (el as HTMLInputElement).checked === true;
    case 'selected':
      return matches && ((el as HTMLOptionElement).selected === true || el.getAttribute('aria-selected') === 'true');
    case 'present':
      return matches;
  }
}

export const allOf = (root: Root, a: AllOf): boolean => a.all_of.every((s) => evalSignal(root, s));
export const anyOf = (root: Root, a: { any_of: Signal[] } | undefined): boolean => a !== undefined && a.any_of.some((s) => evalSignal(root, s));

/** No `hidden`, `display: none` or `visibility: hidden` on the element or an ancestor (no layout needed). */
export function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    if (e.hasAttribute('hidden')) return false;
    const style = view?.getComputedStyle(e);
    if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) return false;
  }
  return true;
}

// Built-in detectors (P3-R6); they only ever stop: a visible password input means a login page, a known CAPTCHA widget a CAPTCHA.
const CAPTCHA_WIDGETS = 'iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"]';
const genericLogin = (doc: Document): boolean => [...doc.querySelectorAll('input[type="password" i]')].some(isVisible);
const genericCaptcha = (doc: Document): boolean => doc.querySelector(CAPTCHA_WIDGETS) !== null;

/** The profile's count display as a number (and its limit for `a_of_b`), full-width digits included. */
export function readCount(profile: PageProfile, doc: Document): ObservedCount | null {
  const c = profile.count_display;
  if (c === undefined) return null;
  const r = resolveOne(doc, c.locators);
  if (!r.ok) return null;
  const [a, b] = (nfkcTrim(r.el.textContent ?? '').replace(/,/g, '').match(/\d+/g) ?? []).map(Number);
  if (a === undefined) return null;
  if (c.pattern === 'first_integer') return { kind: c.kind, value: a, limit: null };
  return b === undefined ? null : { kind: c.kind, value: a, limit: b };
}

export type FailureCode = 'AUTH_REQUIRED' | 'MFA_REQUIRED' | 'CAPTCHA' | 'ACCOUNT_ERROR' | 'LIMIT_REACHED';
export interface PageFailure {
  code: FailureCode;
  /** §5.6 row. */
  row: 2 | 3 | 4 | 5 | '5a';
  /** Fixed token, e.g. 'limit_period:daily'. */
  detail: string | null;
}

/** §5.6 rows 2–5a in order; the first that applies. */
export function detectFailures(profile: PageProfile, doc: Document): PageFailure | null {
  const f = profile.failure_signals;
  if (anyOf(doc, f.login) || genericLogin(doc)) return { code: 'AUTH_REQUIRED', row: 2, detail: null };
  if (anyOf(doc, f.mfa)) return { code: 'MFA_REQUIRED', row: 3, detail: null };
  if (anyOf(doc, f.captcha) || genericCaptcha(doc)) return { code: 'CAPTCHA', row: 4, detail: null };
  if (anyOf(doc, f.account_error)) return { code: 'ACCOUNT_ERROR', row: 5, detail: null };
  if (f.limit_reached !== undefined && anyOf(doc, f.limit_reached)) return { code: 'LIMIT_REACHED', row: '5a', detail: `limit_period:${f.limit_reached.limit_period}` };
  const count = readCount(profile, doc);
  if (count !== null && count.limit !== null && count.value >= count.limit) return { code: 'LIMIT_REACHED', row: '5a', detail: `limit_period:${count.kind}` };
  return null;
}
