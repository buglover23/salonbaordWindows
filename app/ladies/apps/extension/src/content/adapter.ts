import type { Field, FormInputs, LocatorSet, OptionRef, PageProfile, SubmitIntentRequest } from '../../../../src/shared/protocol/index.js';
import { uncoveredInvalidControls } from '../salonboard/engine/constraints.js';
import { findOption, mirrorHtml, setCheckboxGroupNone, setChecked, setContentEditable, setOption, setText, type Filled } from '../salonboard/engine/fill.js';
import { audienceMatches } from '../salonboard/engine/identify.js';
import { queryOne, resolveAll, resolveOne } from '../salonboard/engine/locate.js';
import { groupNone, isChecked, optionMatches, readPoster, readText, textMatches } from '../salonboard/engine/readback.js';
import { anyOf, readCount } from '../salonboard/engine/signals.js';
import { nfkcTrim } from '../salonboard/engine/text.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { Stop, token, type Post } from './common.js';
import { state } from './guard.js';
import { upload } from './upload.js';

// The style and blog adapters (Task 4b) as one sequence: the profile says which fields the page has and FormInputs what
// goes in them. Style pages also carry the fixed style policies (staff, feature none, apply_image off, model_info from the
// analysis or none, coupon none, fixed.*, mapped.*, treatment.*; A03); a blog profile simply has none of those fields (A04). Every value
// is decided before the first input, every field is read back, and nothing is asked of Node unless all of it holds.

type Want = { kind: 'text'; text: string } | { kind: 'option'; ref: OptionRef } | { kind: 'checked'; value: boolean } | { kind: 'none_group' } | { kind: 'tags'; entries: string[] };
interface Planned {
  key: string;
  field: Field;
  want: Want;
}

export interface FormResult {
  readback: SubmitIntentRequest['readback'];
  observed: SubmitIntentRequest['observed_count'];
}

const TEXT_KEYS = new Set(['title', 'menu_text', 'stylist_comment', 'body', 'hashtags']);
/** Step order (plan steps 9–12): texts and tags, category, staff, then the fixed and mapped policies. */
const rank = (key: string): number => (TEXT_KEYS.has(key) ? 0 : key === 'category' ? 1 : key === 'staff' ? 2 : 3);
const changed = (key: string): Stop => new Stop('SALON_BOARD_PAGE_CHANGED', token(key));

/** What the field must hold for this command; CONFIG_INCOMPLETE when Node left a needed value out. */
function want(key: string, field: Field, inputs: FormInputs): Want {
  const incomplete = (what: string): never => {
    throw new Stop('CONFIG_INCOMPLETE', token(`inputs:${what}`));
  };
  const option = (ref: OptionRef | null | undefined, what: string): Want => (ref === null || ref === undefined ? incomplete(what) : { kind: 'option', ref });
  switch (key) {
    case 'title':
      return { kind: 'text', text: inputs.title };
    case 'menu_text':
      return inputs.menu_text === null ? incomplete(key) : { kind: 'text', text: inputs.menu_text };
    case 'stylist_comment':
    case 'body':
      return { kind: 'text', text: inputs.primary_text };
    case 'hashtags':
      return { kind: 'tags', entries: inputs.hashtags ?? [] };
    case 'category':
      return option(inputs.category_option, key);
    case 'staff':
      return option(inputs.staff_option, key);
    case 'audience':
      return option(field.options?.[inputs.audience_option], `audience.${inputs.audience_option}`);
    case 'apply_image':
      return { kind: 'checked', value: false };
    case 'coupon':
      return field.kind === 'checkbox_group' || field.kind === 'checkbox' ? { kind: 'none_group' } : option(field.options?.none, 'coupon.none');
    case 'feature':
      return option(field.options?.none, 'feature.none');
  }
  if (key.startsWith('model_info.')) return option(inputs.model_info[key] ?? field.options?.none, `${key}.none`);
  if (key.startsWith('fixed.')) return option(field.fixed_option, key);
  if (key.startsWith('mapped.')) return option(inputs.mapped[key], key);
  if (key.startsWith('treatment.')) return { kind: 'checked', value: inputs.treatments[key] === true };
  throw changed(`field_unknown:${key}`);
}

/** Whether the element already holds what we want (also the read-back; `length` for text, UTF-16 units held). */
function holds(post: Post, el: Element, field: Field, w: Want): { ok: boolean; length?: number } {
  switch (w.kind) {
    case 'text':
      return textMatches(el, w.text);
    case 'option':
      return { ok: optionMatches(el, field.kind, w.ref) };
    case 'checked':
      return { ok: el.matches('input[type="checkbox"]') && isChecked(el) === w.value };
    case 'none_group':
      return { ok: groupNone(el) };
    case 'tags': {
      const spec = post.cmd.profile.hashtag;
      if (spec.added_items === undefined) return { ok: readText(el) === w.entries.join(spec.separator) };
      const items = resolveAll(post.env.doc, spec.added_items);
      const shown = items.ok ? items.els.map((e) => nfkcTrim(e.textContent ?? '')) : null;
      return { ok: shown !== null && shown.length === w.entries.length && shown.every((t, i) => t === nfkcTrim(w.entries[i] ?? '')) };
    }
  }
}

/** Tags typed one at a time and added with the page's button (the style page's 「ハッシュタグを追加」). */
async function addTags(post: Post, el: Element, field: Field, entries: readonly string[]): Promise<Filled> {
  const spec = post.cmd.profile.hashtag;
  const doc = post.env.doc;
  if (spec.add_button === undefined || spec.added_items === undefined) return setText(el, entries.join(spec.separator), field.events);
  const listed = spec.added_items;
  const count = (): number => {
    const r = resolveAll(doc, listed);
    return r.ok ? r.els.length : -1;
  };
  if (count() !== 0) return { ok: false, detail: 'tags_not_empty' };
  for (const [i, tag] of entries.entries()) {
    const typed = setText(el, tag, field.events);
    if (!typed.ok) return typed;
    const button = resolveOne(doc, spec.add_button);
    if (!button.ok) return { ok: false, detail: `add_button:${button.reason}` };
    (button.el as HTMLElement).click();
    post.check();
    if ((await waitFor(() => count() === i + 1, { timeoutMs: post.env.timing.field, root: doc })) === null) return { ok: false, detail: 'tag_not_added' };
  }
  return { ok: true };
}

/**
 * The style page's coupon dialog (profile.coupon): the one entry whose name equals `name` (NFKC, whitespace removed, never
 * a substring) is chosen and set. Returns what the read-back checks (the hidden input holds the choice), or null when no
 * single entry matches (a renamed coupon): the dialog is closed and the post goes on without a coupon.
 */
async function setCoupon(post: Post, c: NonNullable<PageProfile['coupon']>, name: string): Promise<(() => boolean) | null> {
  const doc = post.env.doc;
  const timeoutMs = post.env.timing.field;
  const click = (set: LocatorSet, what: string): void => {
    const r = resolveOne(doc, set);
    if (!r.ok) throw changed(`field:coupon_${what}:${r.reason}`);
    (r.el as HTMLElement).click();
    post.check();
  };
  const items = (): Element[] => {
    const r = resolveAll(doc, [{ css: c.items }]);
    return r.ok ? r.els : [];
  };
  await post.mutate();
  click(c.open, 'open');
  if ((await waitFor(() => items().length > 0 || null, { timeoutMs, root: doc })) === null) throw changed('field:coupon:not_opened');
  const key = (s: string): string => nfkcTrim(s).replaceAll(' ', '');
  const hits = items().filter((li) => {
    const n = queryOne(li, c.name);
    return typeof n !== 'string' && key(n.textContent ?? '') === key(name);
  });
  const [hit] = hits;
  if (hit === undefined || hits.length > 1) {
    const close = c.close === undefined ? null : resolveOne(doc, c.close);
    if (close?.ok === true) (close.el as HTMLElement).click();
    return null;
  }
  // A radio carries the id the page then holds (style); without one (blog) the item is clicked and the page's shown
  // name plus a non-empty id prove the choice.
  const radio = c.radio === undefined ? null : queryOne(hit, c.radio);
  if (typeof radio === 'string') throw changed(`field:coupon_radio:${radio}`);
  const part = c.pick === undefined ? radio : queryOne(hit, c.pick);
  if (part === null || typeof part === 'string') throw changed(`field:coupon_pick:${part ?? 'none'}`);
  const id = radio === null ? null : (radio as HTMLInputElement).value;
  (part as HTMLElement).click();
  post.check();
  click(c.submit, 'submit');
  const held = (): boolean => {
    const r = resolveOne(doc, c.value);
    if (!r.ok) return false;
    const value = (r.el as HTMLInputElement).value;
    if (id !== null) return value === id;
    const shown = c.chosen === undefined ? null : resolveOne(doc, c.chosen);
    return value !== '' && shown?.ok === true && key(shown.el.textContent ?? '') === key(name);
  };
  if ((await waitFor(() => held() || null, { timeoutMs, root: doc })) === null) throw changed('field:coupon:not_set');
  return held;
}

async function apply(post: Post, el: Element, field: Field, w: Want): Promise<Filled> {
  switch (w.kind) {
    case 'text': {
      if (field.kind !== 'contenteditable') return setText(el, w.text, field.events);
      const done = setContentEditable(el, w.text, field.events);
      if (!done.ok || field.mirror === undefined) return done;
      const target = resolveOne(post.env.doc, field.mirror);
      return target.ok ? mirrorHtml(el, target.el, field.events) : { ok: false, detail: `mirror:${target.reason}` };
    }
    case 'option':
      if (field.wait_options_ms > 0) await waitFor(() => findOption(el, field.kind, w.ref) !== 'none', { timeoutMs: field.wait_options_ms, root: post.env.doc });
      return setOption(el, field, w.ref);
    case 'checked':
      return setChecked(el, w.value);
    case 'none_group':
      return setCheckboxGroupNone(el);
    case 'tags':
      return addTags(post, el, field, w.entries);
  }
}

/**
 * One field: skipped when it already holds the value (no events), else announced (reloads_page), marked as the first
 * input if it is one, set, and checked. A reloads_page field must take the page away; the new document starts over.
 */
async function setField(post: Post, s: Planned): Promise<void> {
  const r = resolveOne(post.env.doc, s.field.locators);
  if (!r.ok) {
    if (r.reason === 'none' && !s.field.required) return;
    throw changed(`field:${s.key}:${r.reason}`);
  }
  if (holds(post, r.el, s.field, s.want).ok) return;
  if (s.field.reloads_page) await post.announceNavigation();
  await post.mutate();
  const done = await apply(post, r.el, s.field, s.want);
  post.check();
  if (!done.ok) throw changed(`fill:${s.key}:${done.detail}`);
  if (s.field.reloads_page) {
    await waitFor(() => state.leaving, { timeoutMs: post.env.timing.field, root: post.env.doc });
    post.check();
    throw changed(`reload_expected:${s.key}`);
  }
}

/** Plan steps 5–15 on the input page, after identification. Returns what the submit request carries. */
export async function fillForm(post: Post): Promise<FormResult> {
  const { env, cmd } = post;
  const p: PageProfile = cmd.profile;
  const doc = env.doc;
  const plan: Planned[] = Object.entries(p.fields)
    .filter(([key]) => key !== 'image')
    .map(([key, field]) => ({ key, field, want: want(key, field, cmd.inputs) }));
  post.phase = 'filling';

  // 5. A by_field page: choose the audience, then the page must show it (and not the other one).
  const audience = plan.find((s) => s.key === 'audience');
  if (audience !== undefined && p.audience_mode === 'by_field') {
    await setField(post, audience);
    if ((await waitFor(() => audienceMatches(p, doc, cmd.audience), { timeoutMs: env.timing.field, root: doc })) === null) throw new Stop('POST_TARGET_MISMATCH', 'audience');
    post.check();
  }
  // 6. The count display as the page opened.
  const at_start = readCount(p, doc);
  const rest = plan.filter((s) => s.key !== 'audience');
  // A field that reloads the page goes first, so the reload cannot undo other inputs.
  for (const s of rest.filter((x) => x.field.reloads_page)) await setField(post, s);
  // 8. The image (through the page's uploader dialog when the profile has one).
  const modal = p.image.modal;
  const findImage = () => (p.fields.image === undefined ? null : resolveOne(doc, p.fields.image.locators));
  // After the uploader reloaded the page, the new document already shows the image: go on with the other fields.
  const placed = modal !== undefined && anyOf(doc, p.image.preview);
  if (modal !== undefined && !placed) {
    const open = resolveOne(doc, modal.open);
    if (!open.ok) throw changed(`field:image_open:${open.reason}`);
    (open.el as HTMLElement).click();
    post.check();
    if ((await waitFor(() => findImage()?.ok === true || null, { timeoutMs: post.env.timing.field, root: doc })) === null) throw changed('field:image:modal_not_opened');
  }
  const image = placed ? null : findImage();
  if (!placed && (image === null || !image.ok)) throw changed(`field:image:${image?.ok === false ? image.reason : 'none'}`);
  if (image !== null && image.ok) await upload(post, image.el);
  if (modal !== undefined && !placed) {
    const submit = resolveOne(doc, modal.submit);
    if (!submit.ok) throw changed(`field:image_submit:${submit.reason}`);
    if (modal.reloads_page) await post.announceNavigation();
    (submit.el as HTMLElement).click();
    post.check();
    const seen = await waitFor(() => (state.leaving ? 'left' : anyOf(doc, p.image.preview) ? 'shown' : null), { timeoutMs: p.image.preview_timeout_ms, root: doc });
    post.check();
    if (seen === null) throw new Stop('UPLOAD_TIMEOUT', 'modal_preview_timeout');
    if (modal.reloads_page) throw changed('reload_expected:image');
  }
  post.phase = 'filling';
  // 9–12. Texts and tags, category, staff, fixed and mapped policies.
  for (const s of rest.filter((x) => !x.field.reloads_page).sort((a, b) => rank(a.key) - rank(b.key))) await setField(post, s);
  // 12b. The coupon, chosen in the page's dialog (style only; the choice lands in a hidden input).
  const coupon = p.coupon !== undefined && cmd.inputs.coupon_name !== null ? await setCoupon(post, p.coupon, cmd.inputs.coupon_name) : null;

  // 13. Read back everything, the image preview, the audience and the poster.
  post.phase = 'reading_back';
  const fields: FormResult['readback']['fields'] = {};
  const own: Element[] = image !== null && image.ok && image.el.isConnected ? [image.el] : [];
  for (const s of plan) {
    const r = resolveOne(doc, s.field.locators);
    if (!r.ok) {
      if (r.reason === 'none' && !s.field.required) continue;
      throw changed(`readback_mismatch:${s.key}`);
    }
    own.push(r.el);
    const h = holds(post, r.el, s.field, s.want);
    if (!h.ok) throw changed(`readback_mismatch:${s.key}`);
    fields[s.key] = h.length === undefined ? { ok: true } : { ok: true, length: h.length };
  }
  if (coupon !== null) {
    if (!coupon()) throw changed('readback_mismatch:coupon_choice');
    fields.coupon_choice = { ok: true };
  }
  if (!anyOf(doc, p.image.preview)) throw changed('readback_mismatch:image');
  if (!audienceMatches(p, doc, cmd.audience)) throw changed('readback_mismatch:audience');
  if (!readPoster(p, doc, cmd.inputs.poster_name)) throw changed('readback_mismatch:poster');

  // 14. No required control we do not know may be left invalid (P3-R46).
  const submit = resolveOne(doc, p.submit.locators);
  const uncovered = uncoveredInvalidControls((submit.ok ? submit.el.closest('form') : null) ?? doc.body, own);
  if (uncovered[0] !== undefined) throw changed(`uncovered_required:${uncovered[0]}`);
  post.check();

  // 15. The count display right before the request.
  return {
    readback: { fields, image_preview: true, poster_ok: true, constraint_check_ok: true, salon_identified: true, page_identified: true, audience_identified: true },
    observed: { at_start, before_submit: readCount(p, doc) },
  };
}
