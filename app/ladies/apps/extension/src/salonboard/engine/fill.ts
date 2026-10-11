import type { Field, OptionRef } from '../../../../../src/shared/protocol/index.js';
import { labelTexts } from './locate.js';
import { nfkcTrim } from './text.js';

// Setting values the way a page's framework notices them: the prototype's native setter (so a value tracker defined on the
// element itself still sees a change) followed by the profile's events; checkboxes, radios and tabs are clicked once.
// A failure is `{ ok: false, detail }` with a fixed token; the adapter reports it as SALON_BOARD_PAGE_CHANGED (§5.6 row 9),
// except setFile, whose failure is UPLOAD_UNSUPPORTED.

export type Filled = { ok: true } | { ok: false; detail: string };
type Events = readonly Field['events'][number][];

const OK: Filled = { ok: true };
const fail = (detail: string): Filled => ({ ok: false, detail });

function fire(el: Element, events: Events): void {
  for (const name of events) el.dispatchEvent(new Event(name, { bubbles: true }));
}

function nativeSet(el: Element, prop: string, value: unknown): void {
  for (let p: object | null = Object.getPrototypeOf(el) as object | null; p !== null; p = Object.getPrototypeOf(p) as object | null) {
    const setter = Object.getOwnPropertyDescriptor(p, prop)?.set;
    if (setter !== undefined) {
      setter.call(el, value);
      return;
    }
  }
  throw new TypeError(`no setter for ${prop}`);
}

const NOT_TEXT = new Set(['file', 'checkbox', 'radio', 'hidden', 'submit', 'button', 'image', 'reset']);
const isTextControl = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.has((el as HTMLInputElement).type));

export function setText(el: Element, text: string, events: Events): Filled {
  if (!isTextControl(el)) return fail('not_text');
  nativeSet(el, 'value', text);
  fire(el, events);
  return OK;
}

/**
 * Lines become text nodes separated by <br> (never HTML). Images the page's own uploader put into the editor (the blog
 * body) are kept, on their own line before the text; a block at the start adds no line break to the read-back text.
 */
export function setContentEditable(el: Element, text: string, events: Events): Filled {
  if (!(el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== 'true') return fail('not_contenteditable');
  const doc = el.ownerDocument;
  const images = [...el.querySelectorAll('img')];
  const kept: Node[] = [];
  if (images.length > 0) {
    const box = doc.createElement('div');
    box.append(...images);
    kept.push(box);
  }
  const nodes = text.split('\n').flatMap((line, i): Node[] => (i === 0 ? [doc.createTextNode(line)] : [doc.createElement('br'), doc.createTextNode(line)]));
  el.replaceChildren(...kept, ...nodes);
  fire(el, events);
  return OK;
}

/**
 * The editor's HTML copied into the control the page actually sends (nicEdit's hidden textarea), as the editor itself does
 * when the form is submitted: the body is sent even if the page's own submit skips that step.
 */
export function mirrorHtml(editor: Element, target: Element, events: Events): Filled {
  if (!isTextControl(target)) return fail('mirror_not_text');
  nativeSet(target, 'value', editor.innerHTML);
  fire(target, events);
  return OK;
}

const refMatches = (ref: OptionRef, value: string | null, texts: readonly string[]): boolean =>
  (ref.value === undefined || value === ref.value) && (ref.text === undefined || texts.includes(nfkcTrim(ref.text)));

/** Exactly one option of a select, radio group or tab container matches the ref. */
export function findOption(el: Element, kind: Field['kind'], ref: OptionRef): Element | 'none' | 'multiple' | 'kind' {
  let found: Element[];
  if (kind === 'select' && el.tagName === 'SELECT') {
    found = [...(el as HTMLSelectElement).options].filter((o) => refMatches(ref, o.value, [nfkcTrim(o.textContent ?? '')]));
  } else if (kind === 'radio_group') {
    found = [...el.querySelectorAll('input[type="radio"]')].filter((r) => refMatches(ref, (r as HTMLInputElement).value, labelTexts(r)));
  } else if (kind === 'tab') {
    found = [...el.querySelectorAll('[role="tab"], button, a')].filter((t) => refMatches(ref, t.getAttribute('data-value'), [nfkcTrim(t.textContent ?? '')]));
  } else {
    return 'kind';
  }
  if (found.length > 1) return 'multiple';
  return found[0] ?? 'none';
}

export function selectOption(el: Element, ref: OptionRef, events: Events): Filled {
  const option = findOption(el, 'select', ref);
  if (typeof option === 'string') return fail(`option:${option}`);
  (option as HTMLOptionElement).selected = true;
  fire(el, events);
  return OK;
}

export function setRadio(el: Element, ref: OptionRef): Filled {
  const radio = findOption(el, 'radio_group', ref);
  if (typeof radio === 'string') return fail(`option:${radio}`);
  if (!(radio as HTMLInputElement).checked) (radio as HTMLInputElement).click();
  return (radio as HTMLInputElement).checked ? OK : fail('radio_not_set');
}

export function clickTab(el: Element, ref: OptionRef): Filled {
  const tab = findOption(el, 'tab', ref);
  if (typeof tab === 'string') return fail(`option:${tab}`);
  (tab as HTMLElement).click();
  return OK;
}

/** A select, radio group or tab set to `ref` (fixed policies, the audience, mapped and logical options). */
export function setOption(el: Element, field: Pick<Field, 'kind' | 'events'>, ref: OptionRef): Filled {
  switch (field.kind) {
    case 'select':
      return selectOption(el, ref, field.events);
    case 'radio_group':
      return setRadio(el, ref);
    case 'tab':
      return clickTab(el, ref);
    default:
      return fail('option:kind');
  }
}

export function setChecked(el: Element, checked: boolean): Filled {
  const box = el as HTMLInputElement;
  if (el.tagName !== 'INPUT' || box.type !== 'checkbox') return fail('not_checkbox');
  if (box.checked !== checked) box.click();
  return box.checked === checked ? OK : fail('checkbox_not_set');
}

const boxesOf = (el: Element): HTMLInputElement[] =>
  el.matches('input[type="checkbox"]') ? [el as HTMLInputElement] : [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

/** Every checkbox in the group unchecked (coupon: none). */
export function setCheckboxGroupNone(el: Element): Filled {
  for (const box of boxesOf(el)) if (box.checked) box.click();
  return boxesOf(el).some((b) => b.checked) ? fail('checkbox_group_not_cleared') : OK;
}

/** `fixed.*`: the owner-approved constant. */
export const fillFixed = (el: Element, field: Field): Filled => (field.fixed_option === undefined ? fail('fixed:missing') : setOption(el, field, field.fixed_option));

/** `mapped.*`: the option Node chose from the approved map. */
export const fillMapped = (el: Element, field: Field, option: OptionRef): Filled => setOption(el, field, option);

/**
 * The file through DataTransfer and the input's own setter, then the events; the input must keep exactly that file.
 * A `change` the browser itself fires on the assignment is not fired a second time (the page would upload twice).
 */
export function setFile(input: Element, file: File, events: Events = ['input', 'change']): Filled {
  const el = input as HTMLInputElement;
  if (el.tagName !== 'INPUT' || el.type !== 'file') return fail('not_file_input');
  let nativeChange = false;
  const probe = (): void => void (nativeChange = true);
  el.addEventListener('change', probe);
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
  } catch {
    return fail('upload_unsupported');
  } finally {
    el.removeEventListener('change', probe);
  }
  const got = el.files?.[0];
  if (el.files?.length !== 1 || got === undefined || got.name !== file.name || got.size !== file.size) return fail('upload_unsupported');
  fire(el, nativeChange ? events.filter((e) => e !== 'change') : events);
  return OK;
}
