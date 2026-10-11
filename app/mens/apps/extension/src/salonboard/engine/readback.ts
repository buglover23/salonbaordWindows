import type { Field, OptionRef, PageProfile } from '../../../../../src/shared/protocol/index.js';
import { findOption } from './fill.js';
import { resolveOne } from './locate.js';
import { salonLabelEquals } from './identify.js';
import { lf } from './text.js';

// Reading back what the page now holds (before asking for permission). Text compares after CRLF → LF only: a page that
// trimmed or truncated the value (maxlength, its own counter) is a mismatch, never "close enough".

const BLOCKS = new Set(['DIV', 'P', 'LI']);

function editableText(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === child.TEXT_NODE) out += child.textContent ?? '';
    else if ((child as Element).tagName === 'BR') out += '\n';
    else {
      if (BLOCKS.has((child as Element).tagName) && out !== '' && !out.endsWith('\n')) out += '\n';
      out += editableText(child);
    }
  });
  return out;
}

/** The value of a text control, or the text of a contenteditable element (<br> and blocks as line breaks), LF only. */
export function readText(el: Element): string {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return lf((el as HTMLInputElement).value);
  return lf(editableText(el));
}

/** `length` is in UTF-16 units of what the page holds. */
export function textMatches(el: Element, expected: string): { ok: boolean; length: number } {
  const text = readText(el);
  return { ok: text === lf(expected), length: text.length };
}

/** The select's chosen option, the checked radio, or the selected tab is the one `ref` names (and only one is chosen). */
export function optionMatches(el: Element, kind: Field['kind'], ref: OptionRef): boolean {
  const want = findOption(el, kind, ref);
  if (typeof want === 'string') return false;
  switch (kind) {
    case 'select': {
      const chosen = [...(el as HTMLSelectElement).options].filter((o) => o.selected);
      return chosen.length === 1 && chosen[0] === want;
    }
    case 'radio_group': {
      const checked = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => r.checked);
      return checked.length === 1 && checked[0] === want;
    }
    case 'tab':
      return want.getAttribute('aria-selected') === 'true';
    default:
      return false;
  }
}

export const isChecked = (el: Element): boolean => (el as HTMLInputElement).checked === true;

/** No checkbox in the group is checked. */
export const groupNone = (el: Element): boolean =>
  !(el.matches('input[type="checkbox"]') ? [el] : [...el.querySelectorAll('input[type="checkbox"]')]).some((b) => (b as HTMLInputElement).checked);

/**
 * The poster per profile.poster (P3-R15): `display` reads the shown name back (NFKC, exact); `staff_field` is read back as
 * the staff field; `absent_on_screen` needs the owner's attestation (readiness). A style profile without `poster` fails.
 */
export function readPoster(profile: PageProfile, doc: Document, posterName: string): boolean {
  const poster = profile.poster;
  if (poster === null) return profile.post_type !== 'style';
  if (poster.mode !== 'display') return true;
  const r = resolveOne(doc, poster.locators);
  return r.ok && salonLabelEquals(r.el.textContent ?? '', posterName);
}
