import type { ErrorCode } from '../../../../src/shared/errors.js';
import type { CsMessage, Evidence, PageProfile, PageStateReport, Phase, PostCommand, ResultFlags } from '../../../../src/shared/protocol/index.js';
import type { Filled } from '../salonboard/engine/fill.js';
import { identifyPage, salonLabelEquals, type IdentifyContext, type Identified, type Row } from '../salonboard/engine/identify.js';
import { resolveOne } from '../salonboard/engine/locate.js';
import { detectFailures, readCount } from '../salonboard/engine/signals.js';
import { nfkcTrim } from '../salonboard/engine/text.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { state } from './guard.js';

// What the content script's command handlers share: the environment (injected, so jsdom tests can run them), the
// deadlines, reports to the SW and the keepalive. Reports carry fixed English note tokens, never page text, except the
// matched element excerpts that evidence allows (≤ 60 characters).

export interface Timing {
  page: number;
  field: number;
  watch: number;
  completion: number;
  keepalive: number;
}
/** §5.4: page identified 20 s, field 10 s, post-click watch 5 s, completion 30 s; keepalive well under the SW's 20 s. */
export const TIMING: Timing = { page: 20_000, field: 10_000, watch: 5_000, completion: 30_000, keepalive: 15_000 };

export interface CsEnv {
  doc: Document;
  /** chrome.runtime.sendMessage; null when the SW does not answer or the extension context is gone. */
  send: (m: CsMessage) => Promise<unknown>;
  /** chrome.runtime.id is still there (an orphaned script never clicks). */
  runtimeAlive: () => boolean;
  /** engine setFile in Chrome; injected in jsdom tests, which have no DataTransfer. */
  setFile: (input: Element, file: File) => Filled;
  timing: Timing;
}

/** A step that cannot go on; reported with its code and note (a fixed token). */
export class Stop extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly note: string,
    readonly unexpectedNavigation = false,
  ) {
    super(note);
  }
}
/** This document must not act any more (leaving, aborted, extension context gone): stop without a report. */
export class Silent extends Error {}

/** One post command in this document: the phase for keepalives and pagehide, and whether the form was touched. */
export class Post {
  phase: Phase = 'checking_page';
  mutated = false;
  readonly command_id: string;
  constructor(
    readonly env: CsEnv,
    readonly cmd: PostCommand,
  ) {
    this.command_id = cmd.command_id;
  }

  check(): void {
    if (state.leaving || state.aborted.has(this.command_id) || !this.env.runtimeAlive()) throw new Silent();
  }

  /** Before the first input of this document: the SW must know the form was touched before a page change (P3-R40). */
  async mutate(): Promise<void> {
    if (!this.mutated) {
      this.mutated = true;
      await this.env.send({ type: 'cs.progress', command_id: this.command_id, phase: this.phase, mutated: true });
    }
    this.check();
  }

  /** A page change this script is about to cause (a reloads_page field); the SW then expects the new document. */
  async announceNavigation(): Promise<void> {
    await this.env.send({ type: 'cs.progress', command_id: this.command_id, phase: 'navigating' });
    this.check();
  }
}

export const NO_FLAGS: ResultFlags = { mutated: false, unexpected_navigation: false, inferred_click: false };

/** An evidence note: lower case, [a-z0-9_.:-] only, at most 60 characters (a control name from the page included). */
export const token = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 60);

/** A matched element's text for evidence: collapsed, at most 60 characters. */
export const excerpt = (el: Element | null): string | null => (el === null ? null : nfkcTrim(el.textContent ?? '').slice(0, 60));

export function evidence(doc: Document, over: Partial<Evidence> = {}): Evidence {
  return { page_url_path: (URL.parse(doc.URL)?.pathname ?? '').slice(0, 500), completion: null, salon: [], list: null, rejection: null, notes: [], ...over };
}

export function report(
  env: CsEnv,
  command_id: string,
  kind: Extract<CsMessage, { type: 'cs.report' }>['kind'],
  ok: boolean,
  code: ErrorCode | null,
  ev: Evidence | null,
  extra: { flags?: ResultFlags; page_state?: PageStateReport; next_url?: string } = {},
): Promise<unknown> {
  return env.send({
    type: 'cs.report',
    command_id,
    kind,
    ok,
    code,
    evidence: ev,
    page_state: extra.page_state ?? null,
    flags: extra.flags ?? NO_FLAGS,
    ...(extra.next_url === undefined ? {} : { next_url: extra.next_url }),
  });
}

/** cs.progress at a fixed cadence for the whole command, so every wait keeps the SW (and its watchdog) alive. */
export function startKeepalive(send: CsEnv['send'], command_id: string, phase: () => Phase, everyMs = TIMING.keepalive): () => void {
  const timer = setInterval(() => void send({ type: 'cs.progress', command_id, phase: phase() }), everyMs);
  return () => clearInterval(timer);
}

/** document.readyState is 'complete' within the page deadline (§5.6 row 1). */
export const pageReady = async (env: CsEnv): Promise<boolean> => (await waitFor(() => env.doc.readyState === 'complete', { timeoutMs: env.timing.page, root: env.doc })) === true;

/** §5.6 rows that a later render cannot change (failure signals, the wrong salon): reported at once. */
const SETTLED = new Set<Row>([2, 3, 4, 5, '5a', 6]);

/**
 * §5.6 rows 1–9 within the page deadline. Rows 7–9 may still change while the page renders, so they are waited out;
 * `other` names another page this command accepts (the blog's confirmation page), which ends the wait at once.
 */
export async function identifyWait(env: CsEnv, profile: PageProfile, ctx: IdentifyContext, other: () => boolean = () => false): Promise<Identified | 'other'> {
  if (!(await pageReady(env))) return { ok: false, code: 'PAGE_TIMEOUT', row: 1, detail: 'document_not_complete' };
  let last: Identified = { ok: false, code: 'PAGE_TIMEOUT', row: 1, detail: 'document_not_complete' };
  const seen = await waitFor(
    () => {
      if (other()) return 'other' as const;
      last = identifyPage(profile, env.doc, ctx);
      return last.ok || SETTLED.has(last.row) ? last : null;
    },
    { timeoutMs: env.timing.page, root: env.doc },
  );
  return seen ?? last;
}

/** What the extension may tell Node about a page: no page text except whether the own salon label matched. */
export function pageState(doc: Document, profile: PageProfile, expectedLabel: string, identified: boolean): PageStateReport {
  const u = URL.parse(doc.URL);
  const failure = detectFailures(profile, doc)?.code ?? null;
  const salon = resolveOne(doc, profile.salon_identification.locators);
  return {
    url_origin: u?.origin.slice(0, 200) ?? null,
    url_path: u?.pathname.slice(0, 500) ?? null,
    query_keys: u === null ? [] : [...new Set(u.searchParams.keys())].slice(0, 50).map((k) => k.slice(0, 100)),
    signals: {
      login: failure === 'AUTH_REQUIRED',
      mfa: failure === 'MFA_REQUIRED',
      captcha: failure === 'CAPTCHA',
      account_error: failure === 'ACCOUNT_ERROR',
      limit_reached: failure === 'LIMIT_REACHED',
    },
    salon_identified: salon.ok ? salonLabelEquals(salon.el.textContent ?? '', expectedLabel) : null,
    page_identified: identified,
    profile_id: null,
    observed_count: readCount(profile, doc),
  };
}
