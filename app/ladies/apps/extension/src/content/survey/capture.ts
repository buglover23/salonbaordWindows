import { MAX_SENSITIVE_HITS, maskAttrValue, maskPath, maskSensitiveText, sensitiveHits, SurveyCaptureSchema } from '../../../../../src/shared/protocol/index.js';
import type { SurveyCapture } from '../../../../../src/shared/protocol/index.js';
import { isVisible } from '../../salonboard/engine/signals.js';
import { nfkcTrim } from '../../salonboard/engine/text.js';
import { contextOf, dateFormatGuess, hintsOf, keptText, pathSelector, selectorsOf, shownText, textKind, urlParts, type Rules } from './sanitize.js';
import { skeletonHtml } from './skeleton.js';

// 「画面を調査」 (D9, P3-R45): an outline plus the skeleton of the page already open. It never navigates, never clicks and
// never reads what anyone typed. Login pages and pages that seem to show customers are refused.

export type Probe = NonNullable<SurveyCapture['probe']>;
export type Refusal = 'login_page' | 'customer_data' | 'too_large' | 'invalid' | 'probe_image';
export type Captured = { ok: true; capture: SurveyCapture } | { ok: false; reason: Refusal; detail: string | null };

export interface CaptureOptions {
  kind: SurveyCapture['kind'];
  mode: Rules['mode'];
  salonLabel: string | null;
  posterName: string | null;
  knownTitle: string | null;
  probe?: Probe | null;
}

const SKELETON_MAX = 600 * 1024;
const TEXT_SKIP = 'script, style, noscript, template, textarea';
const BUTTONS = 'button, input[type="submit" i], input[type="button" i], input[type="reset" i], input[type="image" i]';

const cut = (s: string, n: number): string => s.slice(0, n);
const intAttr = (el: Element, name: string): number | null => {
  const n = Number.parseInt(el.getAttribute(name) ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** The page's visible text (no scripts, no textarea defaults), for the customer-data count. */
function pageText(doc: Document): string {
  const parts: string[] = [];
  const walker = doc.createTreeWalker(doc.body, 0x4);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) if (n.parentElement?.closest(TEXT_SKIP) == null) parts.push((n as Text).data);
  return parts.join(' ');
}

/** A label's own text, without the text of controls inside it (a select's options, a textarea's default). */
function labelText(el: Element): string {
  const labels = (el as HTMLInputElement).labels ?? [];
  return [...labels]
    .map((l) => {
      const c = l.cloneNode(true) as Element;
      for (const x of [...c.querySelectorAll('select, textarea, [contenteditable]')]) x.remove();
      return nfkcTrim(c.textContent ?? '');
    })
    .filter((t) => t !== '')
    .join(' / ');
}

/** The deepest elements whose whole text equals `text` (NFKC, collapsed whitespace). */
function anchors(doc: Document, text: string | null): { selectors: string[] }[] {
  const t = text === null ? '' : nfkcTrim(text);
  if (t === '') return [];
  const same = (e: Element): boolean => (e.textContent ?? '').length <= t.length * 3 + 20 && nfkcTrim(e.textContent ?? '') === t;
  return [...doc.body.querySelectorAll('*')]
    .filter((e) => e.closest(TEXT_SKIP) === null && same(e) && ![...e.children].some(same))
    .slice(0, 20)
    .map((e) => ({ selectors: selectorsOf(e) }));
}

function frameKind(f: Element, origin: string): 'same' | 'cross' | 'about' {
  const src = f.getAttribute('src');
  if (src === null || src.trim() === '' || f.hasAttribute('srcdoc') || /^\s*(about|javascript):/i.test(src)) return 'about';
  return URL.parse(src, f.ownerDocument.URL)?.origin === origin ? 'same' : 'cross';
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function control(el: Control, r: Rules): SurveyCapture['forms'][number]['controls'][number] {
  const tag = el.localName;
  const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag === 'select' ? ((el as HTMLSelectElement).multiple ? 'select-multiple' : 'select-one') : 'textarea';
  const owner = r.mode === 'owner' && r.formTexts;
  return {
    tag: cut(tag, 20),
    type: cut(type, 30),
    name: cut(maskAttrValue(el.getAttribute('name') ?? ''), 200),
    id: cut(maskAttrValue(el.getAttribute('id') ?? ''), 200),
    classes: [...el.classList].slice(0, 3).map((c) => cut(maskAttrValue(c), 200)),
    label_text: owner ? cut(maskSensitiveText(labelText(el)), 200) : '',
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    maxlength: intAttr(el, 'maxlength'),
    disabled: el.disabled,
    hidden: type === 'hidden' || !isVisible(el),
    ...(type === 'file' ? { accept: cut(el.getAttribute('accept') ?? '', 100), multiple: el.hasAttribute('multiple') } : {}),
    ...(tag === 'select'
      ? {
          options: [...(el as HTMLSelectElement).options].slice(0, 100).map((o) => ({
            value: cut(maskAttrValue(o.getAttribute('value') ?? ''), 200),
            text: owner ? cut(maskSensitiveText(nfkcTrim(o.text)), 200) : '',
            selected: o.defaultSelected,
          })),
        }
      : {}),
    ...(type === 'checkbox' || type === 'radio' ? { default_checked: (el as HTMLInputElement).defaultChecked } : {}),
    ...hintsOf(el),
    selectors: selectorsOf(el),
  };
}

/** Up to 5 containers of 3 or more same-shaped children (lists, table bodies), outermost first, with the first item's leaves. */
function repeatedBlocks(doc: Document, r: Rules): SurveyCapture['repeated_blocks'] {
  const found: { container: Element; items: Element[] }[] = [];
  for (const c of doc.body.querySelectorAll('*')) {
    if (c.closest('select, datalist, optgroup, ' + TEXT_SKIP) !== null) continue;
    const groups = new Map<string, Element[]>();
    for (const child of c.children) {
      const key = `${child.localName}.${child.getAttribute('class') ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(child);
      groups.set(key, group);
    }
    const items = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    if (items.length >= 3) found.push({ container: c, items });
  }
  found.sort((a, b) => b.items.length - a.items.length);
  const chosen: typeof found = [];
  for (const f of found) if (chosen.length < 5 && !chosen.some((c) => c.container.contains(f.container))) chosen.push(f);
  return chosen.map(({ container, items }) => {
    const item = items[0]!;
    const cls = [...item.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && maskAttrValue(c) === c);
    const leaves = [item, ...item.querySelectorAll('*')].filter((e) => e.children.length === 0 && nfkcTrim(e.textContent ?? '') !== '').slice(0, 50);
    return {
      container_selector: cut(`${selectorsOf(container)[0] ?? pathSelector(container)} > ${item.localName}${cls.map((c) => `.${c}`).join('')}`, 300),
      count: items.length,
      sample: leaves.map((leaf) => {
        const text = leaf.textContent ?? '';
        const ctx = leaf.closest('th') !== null ? 'header' : 'other';
        return {
          selector: cut(leaf === item ? ':scope' : pathSelector(leaf).slice(pathSelector(item).length + 3), 300),
          tag: cut(leaf.localName, 20),
          text_kind: textKind(text),
          text_len: nfkcTrim(text).length,
          date_format_guess: dateFormatGuess(text),
          text: keptText(text, r, ctx),
        };
      }),
    };
  });
}

/** A login page or a page that seems to show customers is never captured (and never probed). */
export function refusalOf(doc: Document): Refusal | null {
  if ([...doc.querySelectorAll('input[type="password" i]')].some(isVisible)) return 'login_page';
  return sensitiveHits(pageText(doc)) > MAX_SENSITIVE_HITS ? 'customer_data' : null;
}

export function captureSurvey(doc: Document, o: CaptureOptions): Captured {
  const refuse = (reason: Refusal, detail: string | null = null): Captured => ({ ok: false, reason, detail });
  const refusal = refusalOf(doc);
  if (refusal !== null) return refuse(refusal);

  const strict = o.mode === 'strict' || o.kind === 'probe';
  const r: Rules = { mode: strict ? 'strict' : 'owner', salonLabel: o.salonLabel, posterName: o.posterName, knownTitle: o.knownTitle, formTexts: o.kind === 'form' };
  const url = URL.parse(doc.URL);
  if (url === null) return refuse('invalid', 'page.url');
  const inForm = (e: Element): boolean => e.closest('form') !== null;
  const skeleton = skeletonHtml(doc, r);
  if (skeleton.length > SKELETON_MAX) return refuse('too_large');

  const capture = {
    schema_version: 1,
    kind: o.kind,
    mode: r.mode,
    captured_local_at: new Date().toISOString(),
    known_title_used: o.knownTitle !== null,
    page: {
      origin: cut(url.origin, 200),
      path: cut(maskPath(url.pathname), 200),
      query_keys: urlParts(doc.URL, doc.URL)?.query_keys ?? [],
      title_text: r.mode === 'owner' ? cut(maskSensitiveText(nfkcTrim(doc.title)), 40) : '',
      character_set: cut(doc.characterSet, 40),
      has_password_input: false,
      iframes: [...doc.querySelectorAll('iframe, frame')].slice(0, 50).map((f) => ({ kind: frameKind(f, url.origin) })),
    },
    headings: [...doc.querySelectorAll('h1, h2, h3')].slice(0, 100).map((h) => ({
      level: Number(h.localName.charAt(1)) as 1 | 2 | 3,
      text: cut(keptText(h.textContent ?? '', r, 'heading') ?? '', 40),
      selectors: selectorsOf(h),
    })),
    forms: [...doc.querySelectorAll('form')].slice(0, 10).map((f) => ({
      selectors: selectorsOf(f),
      action_path: f.hasAttribute('action') ? (urlParts(f.getAttribute('action') ?? '', doc.URL)?.path ?? null) : null,
      method: cut((f.getAttribute('method') ?? 'get').toLowerCase(), 10),
      enctype: cut(f.getAttribute('enctype') ?? '', 40),
      accept_charset: cut(f.getAttribute('accept-charset') ?? '', 40),
      controls: [...f.querySelectorAll<Control>('input, select, textarea')].slice(0, 300).map((c) => control(c, r)),
    })),
    buttons: [...doc.querySelectorAll(BUTTONS)].slice(0, 100).map((b) => ({
      text: cut(shownText(b.localName === 'input' ? (b.getAttribute('value') ?? '') : (b.textContent ?? ''), r, inForm(b) ? contextOf(b, r) : 'other'), 200),
      type: cut((b.getAttribute('type') ?? (b.localName === 'button' ? 'submit' : '')).toLowerCase(), 20),
      selectors: selectorsOf(b),
      ...hintsOf(b),
    })),
    links: [...doc.querySelectorAll('a[href]')].slice(0, 100).map((a) => {
      const p = urlParts(a.getAttribute('href') ?? '', doc.URL);
      return {
        text_kind: textKind(a.textContent ?? ''),
        path: p?.path ?? '',
        query_keys: p?.query_keys ?? [],
        selectors: selectorsOf(a),
        in_form: inForm(a),
        text: inForm(a) ? keptText(a.textContent ?? '', r, contextOf(a, r)) : null,
      };
    }),
    salon_anchors: [
      ...anchors(doc, o.salonLabel).map((a) => ({ ...a, matched: 'expected_account_label' as const })),
      ...(strict ? [] : anchors(doc, o.posterName).map((a) => ({ ...a, matched: 'poster_name' as const }))),
    ].slice(0, 20),
    known_title_anchors: anchors(doc, o.knownTitle),
    repeated_blocks: repeatedBlocks(doc, r),
    counters: [...doc.body.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && e.closest(TEXT_SKIP) === null && /^\d+\s*\/\s*\d+$/.test(nfkcTrim(e.textContent ?? '')))
      .slice(0, 20)
      .map((e) => ({ selectors: selectorsOf(e), text: cut(nfkcTrim(e.textContent ?? '').replace(/\s/g, ''), 40) })),
    probe: o.probe ?? null,
    skeleton_html: skeleton,
  };
  const parsed = SurveyCaptureSchema.safeParse(capture);
  if (!parsed.success) return refuse('invalid', cut(parsed.error.issues[0]?.path.join('.') ?? '', 100));
  return { ok: true, capture: parsed.data };
}
