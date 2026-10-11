import type { ErrorCode } from '../../../../src/shared/errors.js';
import { matchProfileUrl, type Evidence, type MatchKeys, type PageProfile, type Signal } from '../../../../src/shared/protocol/index.js';
import { salonLabelEquals } from '../salonboard/engine/identify.js';
import { queryOne, resolveAll, resolveOne } from '../salonboard/engine/locate.js';
import { detailMatches, matchItems, parseItems, type ListItem } from '../salonboard/engine/list-match.js';
import { detectFailures, evalSignal } from '../salonboard/engine/signals.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { evidence, excerpt, pageReady, report, startKeepalive, token, type CsEnv } from './common.js';
import { state } from './guard.js';

// Verification after the click (D7, §14.2). POSTED needs, all from the screen: the completion signals, then exactly one
// matching item on the legitimate list (or its detail page) with the own salon identified there. This script only
// reports what it sees; the SW decides the outcome and Node accepts `posted` only with that evidence.

type Rejection = NonNullable<Evidence['rejection']>;

/** The text of the first signal that holds, for evidence (≤ 60 characters). */
function shownBy(doc: Document, signals: readonly Signal[]): string | null {
  for (const s of signals) {
    if (!evalSignal(doc, s)) continue;
    const r = resolveOne(doc, s.locators);
    return r.ok ? excerpt(r.el) : null;
  }
  return null;
}

/** A rejection shown on the page: the profile's submit_rejected or limit_reached signal. */
export function rejectionOf(p: PageProfile, doc: Document, navigated: boolean): { code: ErrorCode; rejection: Rejection } | null {
  const f = p.failure_signals;
  if (f.submit_rejected !== undefined && f.submit_rejected.any_of.some((s) => evalSignal(doc, s))) {
    return { code: 'SUBMIT_FAILED', rejection: { kind: 'submit_rejected', client_side_only: f.submit_rejected.client_side_only, excerpt: shownBy(doc, f.submit_rejected.any_of), navigated } };
  }
  if (f.limit_reached !== undefined && f.limit_reached.any_of.some((s) => evalSignal(doc, s))) {
    return { code: 'LIMIT_REACHED', rejection: { kind: 'limit_reached', client_side_only: false, excerpt: shownBy(doc, f.limit_reached.any_of), navigated } };
  }
  return null;
}

/** Rows 2–5 (login, MFA, CAPTCHA, account). A count at its limit is expected right after our own post, so not here. */
const blockingFailure = (p: PageProfile, doc: Document): { code: ErrorCode; detail: string } | null => {
  const f = detectFailures(p, doc);
  return f === null || f.code === 'LIMIT_REACHED' ? null : { code: f.code, detail: f.detail ?? `row_${f.row}` };
};

const salonLocators = (p: PageProfile) => p.success_signals.salon_identification?.locators ?? p.salon_identification.locators;

/** The own salon label on this page: null when its element never resolves within the page deadline. */
export async function salonOn(env: CsEnv, p: PageProfile, expected: string): Promise<boolean | null> {
  const el = await waitFor(
    () => {
      const r = resolveOne(env.doc, salonLocators(p));
      return r.ok ? r.el : null;
    },
    { timeoutMs: env.timing.page, root: env.doc },
  );
  return el === null ? null : salonLabelEquals(el.textContent ?? '', expected);
}

/**
 * Completion (new or same document): every completion signal within 30 s, the URL per completion_url_match, and the
 * salon label wherever its element resolves. A login page → AUTH_REQUIRED; a rejection → its code.
 */
export async function verifyCompletion(env: CsEnv, o: { command_id: string; profile: PageProfile; expectedLabel: string; sameDocument: boolean }): Promise<void> {
  const { doc } = env;
  const p = o.profile;
  const stop = startKeepalive(env.send, o.command_id, () => 'verifying_completion', env.timing.keepalive);
  try {
    await pageReady(env);
    const signals = p.success_signals.completion;
    const urlOk = (): boolean => p.success_signals.completion_url_match === undefined || matchProfileUrl(doc.URL, p.success_signals.completion_url_match).ok;
    const seen = await waitFor(
      () => {
        if (state.leaving) return 'left' as const;
        const failure = blockingFailure(p, doc);
        if (failure !== null) return { failure };
        const rejected = rejectionOf(p, doc, !o.sameDocument);
        if (rejected !== null) return { rejected };
        return signals.length > 0 && signals.every((s) => evalSignal(doc, s)) && urlOk() ? ('done' as const) : null;
      },
      { timeoutMs: env.timing.completion, root: doc },
    );
    if (seen === 'left' || state.leaving) return;
    const matched = seen === 'done';
    const salon = resolveOne(doc, salonLocators(p));
    const identified = salon.ok ? salonLabelEquals(salon.el.textContent ?? '', o.expectedLabel) : null;
    const ev = evidence(doc, {
      completion: { matched, same_document: o.sameDocument, signal_index: matched ? 0 : null, excerpt: matched ? shownBy(doc, signals) : null },
      salon: identified === null ? [] : [{ page: 'completion', identified }],
      rejection: seen !== null && typeof seen === 'object' && 'rejected' in seen ? seen.rejected.rejection : null,
    });
    let code: ErrorCode | null = null;
    if (seen === null) code = 'VERIFY_TIMEOUT';
    else if (typeof seen === 'object') code = 'failure' in seen ? seen.failure.code : seen.rejected.code;
    else if (identified === false) code = 'WRONG_SALON';
    await report(env, o.command_id, 'completion', code === null, code, ev);
  } finally {
    stop();
  }
}

/** A link's absolute URL (the SW guards it before any navigation). */
function hrefOf(el: Element | null, doc: Document): string | null {
  const href = el?.getAttribute('href') ?? el?.querySelector('a[href]')?.getAttribute('href') ?? null;
  return href === null ? null : (URL.parse(href, doc.URL)?.href ?? null);
}

const listed = (m: ListItem | null): NonNullable<Evidence['list']>['matched'] =>
  m === null
    ? null
    : { title_excerpt: m.title.slice(0, 60), date_text: m.date_text?.slice(0, 40) ?? null, remote_post_id: m.remote_post_id?.slice(0, 100) ?? null, detail_url_path: m.link_path?.slice(0, 500) ?? null };

/**
 * One list page: the URL, then the salon (a missing or different label is never a match), the items, the match. With no
 * candidate the next page (if any) is reported for the SW to guard; a day-only candidate is confirmed on its detail page.
 */
export async function verifyList(env: CsEnv, o: { command_id: string; profile: PageProfile; match: MatchKeys; page_index: number }): Promise<void> {
  const { doc } = env;
  const p = o.profile;
  const list = p.success_signals.list;
  const send = (ok: boolean, code: ErrorCode | null, ev: Evidence, next_url?: string): Promise<unknown> =>
    report(env, o.command_id, 'list', ok, code, ev, next_url === undefined ? {} : { next_url });
  const stop = startKeepalive(env.send, o.command_id, () => 'verifying_list', env.timing.keepalive);
  try {
    await pageReady(env);
    if (list === null) return void (await send(false, 'SALON_BOARD_PAGE_CHANGED', evidence(doc, { notes: ['no_list'] })));
    if (!matchProfileUrl(doc.URL, list.url_match).ok) return void (await send(false, 'SALON_BOARD_PAGE_CHANGED', evidence(doc, { notes: ['list_url'] })));
    const failure = blockingFailure(p, doc);
    if (failure !== null) return void (await send(false, failure.code, evidence(doc, { notes: [failure.detail] })));
    const identified = await salonOn(env, p, o.match.expected_salon_label);
    const salon: Evidence['salon'] = [{ page: 'list', identified: identified === true }];
    if (identified !== true) return void (await send(false, identified === null ? 'POST_RESULT_UNKNOWN' : 'WRONG_SALON', evidence(doc, { salon, notes: ['salon_not_identified'] })));
    const parsed = parseItems(doc, list.item, doc.URL);
    if (!parsed.ok) return void (await send(false, 'SALON_BOARD_PAGE_CHANGED', evidence(doc, { salon, notes: [token(parsed.detail)] })));
    const m = matchItems(parsed.items, o.match, list.item);
    const next = list.next_page === undefined ? null : resolveOne(doc, list.next_page);
    const allPages = next === null || (!next.ok && next.reason === 'none');
    const ev = (matched: ListItem | null, candidates: number, all: boolean, notes: string[] = []): Evidence =>
      evidence(doc, { salon, list: { pages_checked: o.page_index + 1, all_pages: all, candidates, matched: listed(matched) }, notes });

    if (m.candidates > 1) return void (await send(false, 'POST_RESULT_UNKNOWN', ev(null, m.candidates, allPages, ['ambiguous'])));
    if (m.matched !== null) return void (await send(true, null, ev(m.matched, 1, allPages)));
    const [weak] = m.needs_detail;
    if (weak !== undefined) {
      // A day-only (or undated) title match: its detail page must show the title and the start of the body.
      const container = resolveAll(doc, list.item.container);
      const link = container.ok && list.item.link !== undefined ? container.els[parsed.items.indexOf(weak)] : undefined;
      const linkEl = link === undefined || list.item.link === undefined ? null : queryOne(link, list.item.link);
      const url = p.success_signals.detail === undefined || linkEl === null || typeof linkEl === 'string' ? null : hrefOf(linkEl, doc);
      if (url === null) return void (await send(false, 'POST_RESULT_UNKNOWN', ev(null, 1, allPages, ['title_only'])));
      return void (await send(false, null, ev(weak, 1, allPages), url));
    }
    const nextUrl = next?.ok === true ? hrefOf(next.el, doc) : null;
    if (nextUrl !== null) return void (await send(false, null, ev(null, 0, false), nextUrl));
    await send(false, null, ev(null, 0, allPages, ['not_found']));
  } finally {
    stop();
  }
}

/** A detail page (reached from a day-only list item): the salon, then the title and the start of the body. */
export async function verifyDetail(env: CsEnv, o: { command_id: string; profile: PageProfile; match: MatchKeys }): Promise<void> {
  const { doc } = env;
  const detail = o.profile.success_signals.detail;
  const send = (ok: boolean, code: ErrorCode | null, ev: Evidence): Promise<unknown> => report(env, o.command_id, 'detail', ok, code, ev);
  const stop = startKeepalive(env.send, o.command_id, () => 'verifying_list', env.timing.keepalive);
  try {
    await pageReady(env);
    if (detail === undefined) return void (await send(false, 'SALON_BOARD_PAGE_CHANGED', evidence(doc, { notes: ['no_detail'] })));
    if (!matchProfileUrl(doc.URL, detail.url_match).ok) return void (await send(false, 'SALON_BOARD_PAGE_CHANGED', evidence(doc, { notes: ['detail_url'] })));
    const failure = blockingFailure(o.profile, doc);
    if (failure !== null) return void (await send(false, failure.code, evidence(doc, { notes: [failure.detail] })));
    const identified = await salonOn(env, o.profile, o.match.expected_salon_label);
    const salon: Evidence['salon'] = [{ page: 'detail', identified: identified === true }];
    if (identified !== true) return void (await send(false, identified === null ? 'POST_RESULT_UNKNOWN' : 'WRONG_SALON', evidence(doc, { salon, notes: ['salon_not_identified'] })));
    const ok = (await waitFor(() => detailMatches(doc, detail, o.match), { timeoutMs: env.timing.field, root: doc })) === true;
    await send(ok, ok ? null : 'POST_RESULT_UNKNOWN', evidence(doc, { salon, notes: ok ? [] : ['detail_mismatch'] }));
  } finally {
    stop();
  }
}
