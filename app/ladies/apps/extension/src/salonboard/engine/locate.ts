import type { LocatorSet } from '../../../../../src/shared/protocol/index.js';
import { nfkcTrim } from './text.js';

// "Agreement" semantics (plan Task 3, A28): every candidate is evaluated; one that finds several elements is `multiple`,
// candidates that find exactly one must all find the same one (`disagree` otherwise). The first match is never taken, and
// visibility is never guessed (a hidden duplicate still counts). Profile strings are data: selectors only ever reach
// querySelectorAll, and one the browser rejects is `invalid`.

type Locator = LocatorSet[number];
export type Root = Document | Element;
export type LocateFailure = 'none' | 'multiple' | 'disagree' | 'frame' | 'invalid';
export type Located = { ok: true; el: Element } | { ok: false; reason: LocateFailure };

function query(base: ParentNode, css: string): Element[] | 'invalid' {
  try {
    return [...base.querySelectorAll(css)];
  } catch {
    return 'invalid';
  }
}

/** The one element `css` finds under `base` (list item parts, frames, `within`). */
export function queryOne(base: ParentNode, css: string): Element | LocateFailure {
  const els = query(base, css);
  if (els === 'invalid') return 'invalid';
  if (els.length > 1) return 'multiple';
  return els[0] ?? 'none';
}

/** The labels of a form control (its <label>s, else aria-label), normalized. */
export function labelTexts(el: Element): string[] {
  const labels = (el as Partial<HTMLInputElement>).labels ?? [];
  const texts = [...labels].map((l) => nfkcTrim(l.textContent ?? ''));
  const aria = el.getAttribute('aria-label');
  if (aria !== null) texts.push(nfkcTrim(aria));
  return texts;
}

function contentDocumentOf(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

// `frame` (a same-origin iframe) and `within` must themselves resolve to exactly one element.
function scope(root: Root, loc: Locator): ParentNode | LocateFailure {
  let base: ParentNode = root;
  if (loc.frame !== undefined) {
    const frame = queryOne(base, loc.frame);
    if (typeof frame === 'string') return frame;
    if (frame.tagName !== 'IFRAME' && frame.tagName !== 'FRAME') return 'frame';
    const doc = contentDocumentOf(frame);
    if (doc === null) return 'frame';
    base = doc;
  }
  if (loc.within !== undefined) {
    const within = queryOne(base, loc.within);
    if (typeof within === 'string') return within;
    base = within;
  }
  return base;
}

function candidates(root: Root, loc: Locator): Element[] | LocateFailure {
  const base = scope(root, loc);
  if (typeof base === 'string') return base;
  const els = query(base, loc.css);
  if (els === 'invalid') return 'invalid';
  const text = loc.text_equals === undefined ? null : nfkcTrim(loc.text_equals);
  const label = loc.label_equals === undefined ? null : nfkcTrim(loc.label_equals);
  return els.filter((el) => (text === null || nfkcTrim(el.textContent ?? '') === text) && (label === null || labelTexts(el).includes(label)));
}

/** The one element every resolving candidate agrees on. */
export function resolveOne(root: Root, set: LocatorSet): Located {
  const found = new Set<Element>();
  for (const loc of set) {
    const r = candidates(root, loc);
    if (r === 'none') continue;
    if (typeof r === 'string') return { ok: false, reason: r };
    if (r.length > 1) return { ok: false, reason: 'multiple' };
    if (r[0] !== undefined) found.add(r[0]);
  }
  const [el] = found;
  if (el === undefined) return { ok: false, reason: 'none' };
  return found.size > 1 ? { ok: false, reason: 'disagree' } : { ok: true, el };
}

/** List containers only (many by design): every candidate that finds any must find the same elements. */
export function resolveAll(root: Root, set: LocatorSet): { ok: true; els: Element[] } | { ok: false; reason: LocateFailure } {
  let agreed: Element[] | null = null;
  for (const loc of set) {
    const r = candidates(root, loc);
    if (r === 'none') continue;
    if (typeof r === 'string') return { ok: false, reason: r };
    if (r.length === 0) continue;
    if (agreed === null) agreed = r;
    else if (agreed.length !== r.length || agreed.some((el, i) => el !== r[i])) return { ok: false, reason: 'disagree' };
  }
  return { ok: true, els: agreed ?? [] };
}
