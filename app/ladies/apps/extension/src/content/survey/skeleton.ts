import { contextOf, sanitizeAttributes, shownText, type Rules } from './sanitize.js';

// The text-masked DOM skeleton of a survey: a clone of <body> (never assigned back into the page), without scripts,
// styles, comments or resource URLs, attributes sanitized, texts kept only by the rules, serialized with XMLSerializer.

const REMOVED = 'script, style, noscript, svg, template, link, meta, object, embed';
const SHOW_ELEMENT_TEXT_COMMENT_PI = 0x1 | 0x4 | 0x40 | 0x80;

export function skeletonHtml(doc: Document, r: Rules): string {
  const body = doc.body.cloneNode(true) as Element;
  for (const e of [...body.querySelectorAll(REMOVED)]) e.remove();
  const walker = doc.createTreeWalker(body, SHOW_ELEMENT_TEXT_COMMENT_PI);
  const nodes: Node[] = [];
  for (let n: Node | null = walker.currentNode; n !== null; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    if (n.nodeType === 1) {
      sanitizeAttributes(n as Element, doc.URL);
    } else if (n.nodeType === 3) {
      const text = n as Text;
      const parent = text.parentElement;
      if (text.data.trim() === '') continue;
      // Strict: every text node is hidden; owner: the keep rules.
      text.data = r.mode === 'strict' || parent === null ? '█' : shownText(text.data, r, contextOf(parent, r));
    } else {
      n.parentNode?.removeChild(n); // comments and processing instructions
    }
  }
  const view = doc.defaultView;
  if (view === null) throw new Error('no window');
  return new view.XMLSerializer().serializeToString(body);
}
