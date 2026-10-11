// P3-R46 runtime check: a required control the profile does not cover, still invalid right before asking for permission,
// means the screen asks for something we do not know (SALON_BOARD_PAGE_CHANGED, `uncovered_required:<name>`).
// `validity` is read, never checkValidity(), so the page sees no `invalid` events.

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function empty(c: Control): boolean {
  if (c.type === 'checkbox') return !(c as HTMLInputElement).checked;
  if (c.type === 'radio') return ![...c.ownerDocument.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.name === c.name && r.checked);
  return c.value.trim() === '';
}

/** Names (name, else id, else tag) of required controls in `form`, outside `ownElements`, that are not valid now. */
export function uncoveredInvalidControls(form: ParentNode, ownElements: Iterable<Element>): string[] {
  const own = [...ownElements];
  const out = new Set<string>();
  for (const c of form.querySelectorAll<Control>('input, select, textarea')) {
    if (own.some((o) => o === c || o.contains(c))) continue;
    if (c.disabled || (c as HTMLInputElement).type === 'hidden') continue;
    const invalid = c.required ? c.willValidate && !c.validity.valid : c.getAttribute('aria-required') === 'true' && empty(c);
    if (invalid) out.add(c.name || c.id || c.tagName.toLowerCase());
  }
  return [...out];
}
