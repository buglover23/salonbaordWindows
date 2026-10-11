import { SwMessageSchema, type Carry, type LocatorSet, type PostCommand } from '../../../../src/shared/protocol/index.js';
import { pageMatches, salonLabelEquals } from '../salonboard/engine/identify.js';
import { resolveOne } from '../salonboard/engine/locate.js';
import { detectFailures, readCount } from '../salonboard/engine/signals.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { fillForm, type FormResult } from './adapter.js';
import { evidence, identifyWait, Post, report, Silent, startKeepalive, Stop, type CsEnv } from './common.js';
import { CLICK_MARGIN_MS, clickGate, elapsed, onLeave, state, type Permit } from './guard.js';
import { runPreflight } from './preflight.js';
import { answerSurveyMessage } from './probe.js';
import { runPublish } from './publish.js';
import { rejectionOf, verifyCompletion, verifyDetail, verifyList } from './verify.js';

// The commands of the posting tab (§5.2): post (identify → fill → read back → one permission → one click → watch),
// completion, list and detail verification, preflight; plus the survey and the probe (Task 5a). Inert otherwise.

export function installPageListeners(): void {
  addEventListener('pagehide', onLeave);
  addEventListener('beforeunload', onLeave);
}

/** A message from the SW: answered at once; the command then reports with its own messages. */
export async function handleSwMessage(env: CsEnv, raw: unknown): Promise<unknown> {
  const parsed = SwMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  switch (m.type) {
    case 'run_post':
      void runPost(env, m.command, m.carry);
      return true;
    case 'verify_completion':
      void verifyCompletion(env, { command_id: m.command_id, profile: m.profile, expectedLabel: m.match.expected_salon_label, sameDocument: m.same_document });
      return true;
    case 'verify_list':
      void verifyList(env, m);
      return true;
    case 'verify_detail':
      void verifyDetail(env, m);
      return true;
    case 'run_preflight':
      void runPreflight(env, m);
      return true;
    case 'run_publish':
      void runPublish(env, m);
      return true;
    case 'ping':
      return { type: 'cs.pong', command_id: m.command_id };
    case 'abort':
      state.aborted.add(m.command_id);
      return true;
    case 'read_salon': {
      // Only the store name element's text (nothing else of the page); null on a login page or another layout.
      const r = resolveOne(env.doc, m.locators);
      return { label: r.ok ? (r.el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 100) || null : null };
    }
    default:
      return answerSurveyMessage(raw, env.doc);
  }
}

/** One post command in this document; a failure is reported as a post step (the SW decides what it means). */
export async function runPost(env: CsEnv, cmd: PostCommand, carry?: Carry): Promise<void> {
  const id = cmd.command_id;
  if (state.leaving || state.running.has(id) || state.submitted.has(id)) return;
  state.running.add(id);
  const post = new Post(env, cmd);
  state.active = post;
  const stopKeepalive = startKeepalive(env.send, id, () => post.phase, env.timing.keepalive);
  try {
    await steps(post, carry);
  } catch (e) {
    if (!(e instanceof Silent)) {
      const s = e instanceof Stop ? e : new Stop('SALON_BOARD_PAGE_CHANGED', 'content_script_error');
      await report(env, id, 'post_step', false, s.code, evidence(env.doc, { notes: [s.note] }), {
        flags: { mutated: post.mutated, unexpected_navigation: s.unexpectedNavigation, inferred_click: false },
      });
    }
  } finally {
    stopKeepalive();
  }
}

async function steps(post: Post, carry: Carry | undefined): Promise<void> {
  const { env, cmd } = post;
  const p = cmd.profile;
  const confirm = p.submit.confirm;
  const onConfirmPage = (): boolean =>
    confirm.kind === 'confirm_page' && pageMatches(env.doc, { url_match: confirm.url_match ?? p.url_match, page_identification: confirm.page_identification });
  // 1–4, 7 (and 5 for by_page): the §5.6 rows before any input.
  const id = await identifyWait(env, p, { expectedLabel: cmd.salon.expected_account_label, otherRoutes: cmd.other_routes, audience: cmd.audience }, onConfirmPage);
  post.check();
  if (id === 'other') {
    // The blog's confirmation page: only after this command's own 確認する (the input page's read-back comes with it).
    if (carry === undefined) throw new Stop('SALON_BOARD_PAGE_CHANGED', 'confirm_page_unexpected', true);
    return confirmStep(post, carry);
  }
  // After 確認する anything but the confirmation page may have been a send (P3-R40).
  if (carry !== undefined) throw id.ok ? new Stop('SALON_BOARD_PAGE_CHANGED', 'confirm_page_not_shown', true) : new Stop(id.code, id.detail ?? `row_${id.row}`, true);
  if (!id.ok) throw new Stop(id.code, id.detail ?? `row_${id.row}`);
  const form = await fillForm(post);
  if (confirm.kind === 'confirm_page') return toConfirmPage(post, form);
  return submitAndClick(post, form, p.submit.locators);
}

/** The register (or confirm) button: exactly one, and enabled. */
function button(doc: Document, set: LocatorSet): HTMLElement | 'not_unique' | 'disabled' {
  const r = resolveOne(doc, set);
  if (!r.ok) return 'not_unique';
  const el = r.el as HTMLButtonElement;
  return el.disabled === true || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : el;
}

/** 確認する is not the irreversible action: announce the page change with the read-back, click it, and expect to leave. */
async function toConfirmPage(post: Post, form: FormResult): Promise<void> {
  const { env, cmd } = post;
  const next = button(env.doc, cmd.profile.submit.locators);
  if (typeof next === 'string') throw new Stop('SALON_BOARD_PAGE_CHANGED', `submit:${next}`);
  await env.send({ type: 'cs.progress', command_id: post.command_id, phase: 'navigating', carry: { readback: form.readback, observed_count: form.observed } });
  post.check();
  next.click();
  await waitFor(() => state.leaving, { timeoutMs: env.timing.field, root: env.doc });
  post.check();
  throw new Stop('SALON_BOARD_PAGE_CHANGED', 'confirm_page_not_shown');
}

/** The confirmation page: rows 2–6 again, then the one permission and the final button. */
async function confirmStep(post: Post, carry: Carry): Promise<void> {
  const { env, cmd } = post;
  const p = cmd.profile;
  if (p.submit.confirm.kind !== 'confirm_page') return;
  const failure = detectFailures(p, env.doc);
  if (failure !== null) throw new Stop(failure.code, failure.detail ?? `row_${failure.row}`);
  const salon = resolveOne(env.doc, p.salon_identification.locators);
  if (!salon.ok) throw new Stop('SALON_BOARD_PAGE_CHANGED', `salon:${salon.reason}`);
  if (!salonLabelEquals(salon.el.textContent ?? '', cmd.salon.expected_account_label)) throw new Stop('WRONG_SALON', 'confirm_page');
  const observed = { at_start: carry.observed_count.at_start, before_submit: readCount(p, env.doc) ?? carry.observed_count.before_submit };
  return submitAndClick(post, { readback: carry.readback, observed }, p.submit.confirm.locators);
}

/**
 * Steps 16–18: the submitted flag is set BEFORE the one submit request; on a permission the button must still be unique
 * and enabled, the SW must acknowledge `cs.clicking`, and the click gate must hold; then exactly one click (and the
 * in-page confirmation within the same TTL), `cs.clicked`, and the 5 s watch.
 */
async function submitAndClick(post: Post, form: FormResult, locators: LocatorSet): Promise<void> {
  const { env, cmd } = post;
  const id = post.command_id;
  post.check();
  if (state.submitted.has(id)) return;
  state.submitted.add(id);
  post.phase = 'awaiting_permission';
  const reply = SwMessageSchema.safeParse(await env.send({ type: 'cs.submit_request', command_id: id, readback: form.readback, observed_count: form.observed }));
  if (!reply.success || reply.data.type !== 'permission' || !reply.data.granted) return; // the SW has settled the command
  const permit: Permit = { ttl: reply.data.ttl_ms_remaining, mono: performance.now(), wall: Date.now() };
  post.phase = 'authorized';
  const aborted = async (reason: 'ttl' | 'submit_not_unique' | 'submit_disabled' | 'runtime_gone' | 'navigated'): Promise<void> =>
    void (await env.send({ type: 'cs.click_aborted', command_id: id, reason }));

  const target = button(env.doc, locators);
  if (typeof target === 'string') return aborted(target === 'disabled' ? 'submit_disabled' : 'submit_not_unique');
  const ack = await env.send({ type: 'cs.clicking', command_id: id });
  const gate = clickGate(env, permit, ack, id);
  if (gate !== null) return aborted(gate);
  target.click();
  post.phase = 'clicking';
  const confirm = cmd.profile.submit.confirm;
  if (confirm.kind === 'in_page') {
    const left = permit.ttl - CLICK_MARGIN_MS - elapsed(permit);
    const ok = await waitFor(
      () => {
        const b = button(env.doc, confirm.locators);
        return typeof b === 'string' ? null : b;
      },
      { timeoutMs: Math.max(0, left), root: env.doc },
    );
    const again = ok === null ? 'ttl' : clickGate(env, permit, ack, id);
    if (ok === null || again !== null) return aborted(again ?? 'ttl');
    ok.click();
  }
  await env.send({ type: 'cs.clicked', command_id: id });
  post.phase = 'clicked';
  await watch(post);
}

/**
 * Step 18: 5 s in this document. A page change → the SW verifies on the new document. A rejection signal → reported
 * with navigated:false. Neither → completion in this same document.
 */
async function watch(post: Post): Promise<void> {
  const { env, cmd } = post;
  const doc = env.doc;
  const seen = await waitFor(() => (state.leaving ? 'left' : rejectionOf(cmd.profile, doc, false)), { timeoutMs: env.timing.watch, root: doc });
  if (state.leaving || !env.runtimeAlive()) return;
  post.phase = 'verifying_completion';
  if (seen !== null && seen !== 'left') {
    const ev = evidence(doc, { completion: { matched: false, same_document: true, signal_index: null, excerpt: null }, rejection: seen.rejection });
    return void (await report(env, post.command_id, 'completion', false, seen.code, ev));
  }
  await verifyCompletion(env, { command_id: post.command_id, profile: cmd.profile, expectedLabel: cmd.salon.expected_account_label, sameDocument: true });
}
