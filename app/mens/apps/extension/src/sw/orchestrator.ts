import {
  ADAPTER_VERSION,
  AppliedResponseSchema,
  ClaimResponseSchema,
  CsMessageSchema,
  EvidenceSchema,
  HeartbeatResponseSchema,
  HelloResponseSchema,
  ReconcileResponseSchema,
  ResultResponseSchema,
  SubmitIntentResponseSchema,
  SurveyResponseSchema,
} from '../../../../src/shared/protocol/index.js';
import type {
  ApiErrorCode,
  AutoReconcileRequest,
  Carry,
  Command,
  CsMessage,
  Evidence,
  HelloRequest,
  HelloResponse,
  Phase,
  PostCommand,
  PreflightResult,
  ResultFlags,
  ResultRequest,
  SwMessage,
  UrlMatch,
} from '../../../../src/shared/protocol/index.js';
import type { ErrorCode } from '../../../../src/shared/errors.js';
import { salonLabelEquals } from '../salonboard/engine/identify.js';
import { ApiClient, TIMEOUT_MS } from './api-client.js';
import { assetChunk, dropAsset } from './asset-cache.js';
import { loadClientKey } from './key-store.js';
import { guardMessage } from './message-guard.js';
import { navigationAllowed } from './nav-guard.js';
import { pair } from './pairing.js';
import { handlePopup } from './popup-bridge.js';
import { clearRecord, loadRecord, makeLock, PRE_INTENT, saveRecord, type CommandRecord } from './record.js';
import type { SurveyDeps } from './survey-bridge.js';

// The service worker's command state machines (post, reconcile, preflight; §5.2, D12). One command at a time; every
// record change runs under one lock. Safety rules (Task 4a): intent_requested_attempt_id is persisted before
// submit-intent and never re-sent; `authorized` is persisted before the CS hears "granted"; `clicking` is persisted
// before the ack; after an intent nothing is concluded but "unknown" unless the screen proves otherwise.
// The popup's survey and probe are in survey-bridge.ts.

const HEARTBEAT_MS = 10_000;
/** A navigated document must announce itself (cs.ready) within this time (§5.4 page identified 20 s). */
const PAGE_DEADLINE_MS = 20_000;
/** The CS keepalive comes at least every 20 s during any wait; longer silence means the page or the CS is gone. */
const SILENCE_MS = 45_000;
const CLICK_MARGIN_MS = 500;
const PING_TIMEOUT_MS = 2_000;
/** A strict outline capture of the page shown (live_single); the lock is held meanwhile. */
const OUTLINE_TIMEOUT_MS = 5_000;
/** Result retries: after 5 consecutive failures the SW gives up and Node's own timeouts settle the job. */
const RESULT_BACKOFF_S = [10, 30, 60, 120];
const RESULT_GIVE_UP = 5;
export const RESULT_WARNING = 'ツールへの結果の送信に失敗しました。npm.cmd run status で確認してください';

/** What a new posting document gets for the current step of the command. */
type Step = 'run_post' | 'verify_completion' | 'verify_list' | 'verify_detail' | 'publish' | 'run_preflight';

interface Live {
  command: Command;
  step: Step;
  /** Pre-intent: the CS announced a document change (a reloads_page field, or the blog's 確認する step). */
  expectNav: boolean;
  /** The blog's 確認する: the input page's read-back, handed to the confirmation page with run_post. */
  carry: Carry | null;
  pageIndex: number;
  evidence: Evidence | null;
  completionOk: boolean;
  clientSideRejection: boolean;
  preflight: PreflightResult['targets'];
  heartbeat: ReturnType<typeof setInterval>;
  watchdog: ReturnType<typeof setTimeout> | null;
}

export interface SwEnv {
  apiBase: string;
  /** Build-time SALON BOARD origins (__SALONBOARD_ORIGINS__); intersected with Node's hello origins. */
  origins: readonly string[];
  e2e: boolean;
}

type SalonSeen = { label: HelloResponse['salon_label']; locators: HelloResponse['salon_locators']; origins: string[] };

const EMPTY_EVIDENCE: Evidence = { page_url_path: '', completion: null, salon: [], list: null, rejection: null, notes: [] };
const q = encodeURIComponent;

export function createSw(env: SwEnv) {
  const lock = makeLock();
  const api = new ApiClient(env.apiBase, loadClientKey);
  /** E2E-only fault switches (set through e2e-hooks.ts, never in production). */
  const hooks = { dropNextResult: false, duplicateNextResult: false, duplicateNextCommand: false };
  let hello: HelloResponse | null = null;
  let live: Live | null = null;

  const origins = (): string[] => env.origins.filter((o) => hello?.allowed_origins.includes(o) === true);
  // The popup's survey and probe run under the same lock as commands, so no command starts during a probe.
  const survey: SurveyDeps = { api, hello: () => freshHello(), buildOrigins: env.origins, busy: async () => live !== null || (await loadRecord()) !== null };
  const safely = (fn: () => Promise<void>): Promise<void> => lock(fn).catch((e: unknown) => console.error('service worker:', e));
  const beforeIntent = (r: CommandRecord): boolean => r.intent_requested_attempt_id === null && PRE_INTENT.has(r.phase);

  // ---------------------------------------------------------------- claim loop

  async function kick(): Promise<void> {
    if ((await chrome.alarms.get('claim')) === undefined) await chrome.alarms.create('claim', { periodInMinutes: 0.5 });
    await safely(async () => {
      const rec = await loadRecord();
      if (rec !== null) {
        if (live === null) await recover(rec);
        return;
      }
      if ((await freshHello()) === null) return;
      // tab_ready: the SW opens its own posting tab on demand.
      const c = await api.signed('POST', '/v1/jobs/claim', { extension_version: version(), adapter_version: ADAPTER_VERSION, tab_ready: true }, ClaimResponseSchema, TIMEOUT_MS.claim);
      if (c.kind !== 'ok' || c.body === null) return;
      await start(c.body.command, c.body.instance_id);
      if (hooks.duplicateNextCommand) {
        hooks.duplicateNextCommand = false;
        await start(c.body.command, c.body.instance_id);
      }
    });
  }

  /** A signed hello (paired, Node answering and verified), remembered for the origins; null otherwise. */
  async function freshHello(): Promise<HelloResponse | null> {
    if ((await loadClientKey()) === null || (await api.health()) === null) return null;
    const h = await api.signed('POST', '/v1/extension/hello', await helloBody(), HelloResponseSchema);
    if (h.kind !== 'ok' || h.body === null) return null;
    hello = h.body;
    // Kept across SW restarts so the first hello after one already carries the store check.
    await chrome.storage.local.set({ salon: { label: h.body.salon_label, locators: h.body.salon_locators, origins: h.body.allowed_origins } });
    return h.body;
  }

  async function helloBody(): Promise<Omit<HelloRequest, 'protocol_version' | 'request_id'>> {
    const granted = env.origins.length > 0 && (await chrome.permissions.contains({ origins: env.origins.map((o) => `${o}/*`) }).catch(() => false));
    return {
      extension_id: chrome.runtime.id,
      extension_version: version(),
      adapter_version: ADAPTER_VERSION,
      build: env.e2e ? 'e2e' : 'production',
      instance_seen: hello?.instance_id ?? null,
      tab: await tabState(),
      page: null,
      permissions: { salonboard_origins_granted: granted, loopback_ok: api.loopbackOk },
      salon_shown: await shownSalon(),
    };
  }

  /**
   * The store name an open SALON BOARD tab shows when it is not this tool's store (the extension is in the wrong Chrome);
   * null when it is the right one or nothing tells. A DOM read of tabs already open: no page is loaded for it.
   */
  async function shownSalon(): Promise<string | null> {
    const known = hello !== null ? { label: hello.salon_label, locators: hello.salon_locators, origins: hello.allowed_origins } : ((await chrome.storage.local.get('salon')).salon as SalonSeen | undefined);
    const label = known?.label ?? null;
    const locators = known?.locators ?? null;
    const url = env.origins.filter((o) => known?.origins.includes(o) === true).map((o) => `${o}/*`);
    if (label === null || locators === null || url.length === 0) return null;
    const tabs = await chrome.tabs.query({ url }).catch(() => []);
    for (const t of tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))) {
      if (t.id === undefined) continue;
      const r: unknown = await chrome.tabs.sendMessage(t.id, { type: 'read_salon', locators } satisfies SwMessage, { frameId: 0 }).catch(() => null);
      const shown = (r as { label?: unknown } | null)?.label;
      if (typeof shown === 'string') return salonLabelEquals(shown, label) ? null : shown;
    }
    return null;
  }

  /** One command at a time: a command arriving while a record exists (the same command_id again included) is ignored (A22). */
  async function start(cmd: Command, instanceId: string): Promise<void> {
    const key = await loadClientKey();
    if (live !== null || (await loadRecord()) !== null || key === null) return;
    const rec: CommandRecord = {
      schema: 1,
      instance_id: instanceId,
      client_id: key.client_id,
      command:
        cmd.kind === 'post'
          ? { kind: 'post', command_id: cmd.command_id, job_id: cmd.job_id, attempt_id: cmd.attempt_id }
          : cmd.kind === 'reconcile'
            ? { kind: 'reconcile', command_id: cmd.command_id, job_id: cmd.job_id, attempt_id: cmd.attempt_id, reconcile_id: cmd.reconcile_id }
            : { kind: 'preflight', command_id: cmd.command_id, job_id: null, attempt_id: null, preflight_id: cmd.preflight_id },
      window_id: null,
      tab_id: null,
      document_id: null,
      mutated: false,
      intent_requested_attempt_id: null,
      phase: 'claimed',
      permission: null,
      match: cmd.kind === 'reconcile' ? cmd.match : null,
      pending_result: null,
      result_5xx_count: 0,
      updated_at: 0,
    };
    await saveRecord(rec);
    const step: Step = cmd.kind === 'post' ? 'run_post' : cmd.kind === 'reconcile' ? 'verify_list' : 'run_preflight';
    live = { command: cmd, step, expectNav: false, carry: null, pageIndex: 0, evidence: null, completionOk: false, clientSideRejection: false, preflight: [], heartbeat: setInterval(() => void safely(beat), HEARTBEAT_MS), watchdog: null };
    try {
      const tab = await postingTab();
      rec.window_id = tab.windowId;
      rec.tab_id = tab.tabId;
    } catch {
      return fail(rec, 'EXTENSION_DISCONNECTED', 'no_posting_tab');
    }
    rec.phase = cmd.kind === 'post' ? 'navigating' : cmd.kind === 'reconcile' ? 'reconciling' : 'preflight';
    if (cmd.kind === 'post') return navigate(rec, cmd.route.entry_url, cmd.profile.url_match, step);
    if (cmd.kind === 'reconcile') return navigate(rec, cmd.profile.success_signals.list?.url, cmd.profile.success_signals.list?.url_match, step);
    return navigate(rec, cmd.targets[0]?.entry_url, cmd.targets[0]?.profile.url_match, step);
  }

  // ---------------------------------------------------------------- posting window, navigation, CS port

  async function savedTab(): Promise<{ window_id: number; tab_id: number } | null> {
    return ((await chrome.storage.local.get('posting_tab')).posting_tab as { window_id: number; tab_id: number } | undefined) ?? null;
  }

  /** The saved posting tab while it is still in the saved window: ids restart with Chrome, so a same-id tab elsewhere is not ours. */
  async function ownPostingTab(): Promise<chrome.tabs.Tab | undefined> {
    const saved = await savedTab();
    const tab = saved === null ? undefined : await chrome.tabs.get(saved.tab_id).catch(() => undefined);
    return tab !== undefined && tab.windowId === saved?.window_id ? tab : undefined;
  }

  /** The only tab of a dedicated, unfocused window (P3-R31), reused while it exists. */
  async function postingTab(): Promise<{ windowId: number; tabId: number }> {
    const tab = await ownPostingTab();
    if (tab?.id !== undefined) return { windowId: tab.windowId, tabId: tab.id };
    const w = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal' });
    const tabId = w?.tabs?.[0]?.id;
    if (w?.id === undefined || tabId === undefined) throw new Error('投稿用のウィンドウを開けませんでした');
    await chrome.tabs.update(tabId, { autoDiscardable: false });
    await chrome.storage.local.set({ posting_tab: { window_id: w.id, tab_id: tabId } });
    return { windowId: w.id, tabId };
  }

  /**
   * Closes the posting tab this extension opened; its window goes with its only tab. tabs.remove, not windows.remove, so
   * an owner's tab dragged into that window survives. Failures are ignored; the next command opens a new window.
   */
  async function closePostingTab(): Promise<void> {
    if ((await savedTab()) === null) return;
    const tab = await ownPostingTab();
    if (tab?.id !== undefined) {
      // Closing Chrome's last window quits Chrome and this extension with it: keep it for the next command instead.
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
      if (windows.every((w) => w.id === tab.windowId)) return;
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        console.debug('posting tab not closed:', e);
      }
    }
    await chrome.storage.local.remove('posting_tab');
  }

  async function tabState(): Promise<HelloRequest['tab']> {
    const tab = await ownPostingTab();
    if (tab === undefined) return { state: 'none', url_origin: null, url_path: null };
    const u = tab.url === undefined ? null : URL.parse(tab.url);
    return { state: tab.status === 'complete' ? 'ready' : 'loading', url_origin: u?.origin.slice(0, 200) ?? null, url_path: u?.pathname.slice(0, 500) ?? null };
  }

  /** Every SW navigation passes the guard first; a refusal never navigates (nav_refused). */
  async function navigate(rec: CommandRecord, url: string | undefined, match: UrlMatch | undefined, step: Step): Promise<void> {
    if (live === null || rec.tab_id === null) return;
    if (url === undefined || !navigationAllowed(url, match, origins())) return fail(rec, 'SALON_BOARD_PAGE_CHANGED', 'nav_refused');
    live.step = step;
    await saveRecord(rec);
    arm(PAGE_DEADLINE_MS);
    const navigated = await chrome.tabs.update(rec.tab_id, { url }).then(() => true, () => false);
    if (!navigated) return fail(rec, 'EXTENSION_DISCONNECTED', 'posting_tab_closed');
  }

  /** Fire and forget: the CS acknowledges at once and reports later with its own messages. */
  function toCs(rec: CommandRecord, msg: SwMessage): void {
    if (rec.tab_id === null || rec.document_id === null) return;
    chrome.tabs.sendMessage(rec.tab_id, msg, { documentId: rec.document_id }).catch(() => undefined);
  }

  async function ping(rec: CommandRecord): Promise<boolean> {
    if (rec.tab_id === null || rec.document_id === null) return false;
    const pong = chrome.tabs.sendMessage(rec.tab_id, { type: 'ping', command_id: rec.command.command_id }, { documentId: rec.document_id }).catch(() => null);
    const got: unknown = await Promise.race([pong, new Promise<null>((r) => setTimeout(() => r(null), PING_TIMEOUT_MS))]);
    return typeof got === 'object' && got !== null && 'type' in got && got.type === 'cs.pong';
  }

  function sendStep(rec: CommandRecord, mayClick = false): void {
    if (live === null) return;
    const c = live.command;
    const command_id = c.command_id;
    arm(SILENCE_MS);
    if (live.step === 'run_post' && c.kind === 'post') toCs(rec, { type: 'run_post', command: c, ...(live.carry === null ? {} : { carry: live.carry }) });
    else if (live.step === 'run_preflight' && c.kind === 'preflight') {
      const target = c.targets[live.preflight.length];
      if (target !== undefined) toCs(rec, { type: 'run_preflight', command_id, target, salon: c.salon });
    } else if (live.step === 'publish' && c.kind === 'post') {
      toCs(rec, { type: 'run_publish', command_id, profile: c.profile, salon_label: c.salon.expected_account_label, may_click: mayClick });
    } else if (c.kind !== 'preflight' && rec.match !== null) {
      const base = { command_id, profile: c.profile, match: rec.match };
      if (live.step === 'verify_completion') toCs(rec, { type: 'verify_completion', ...base, same_document: false });
      else if (live.step === 'verify_list') toCs(rec, { type: 'verify_list', ...base, page_index: live.pageIndex });
      else if (live.step === 'verify_detail') toCs(rec, { type: 'verify_detail', ...base });
    }
  }

  function arm(ms: number): void {
    if (live === null) return;
    if (live.watchdog !== null) clearTimeout(live.watchdog);
    const mine = live;
    live.watchdog = setTimeout(() => void safely(async () => (live === mine ? timedOut() : undefined)), ms);
  }

  async function timedOut(): Promise<void> {
    const rec = await loadRecord();
    if (rec === null || rec.tab_id === null || rec.phase === 'done') return;
    const tab = await chrome.tabs.get(rec.tab_id).catch(() => undefined);
    if (tab === undefined) return fail(rec, 'EXTENSION_DISCONNECTED', 'posting_tab_closed');
    // No tabs permission: the URL is visible only on the allowed origins.
    const origin = tab.url === undefined ? undefined : URL.parse(tab.url)?.origin;
    if (origin === undefined || !origins().includes(origin)) return fail(rec, 'AUTH_REQUIRED', 'left_allowed_origins');
    return fail(rec, beforeIntent(rec) ? 'PAGE_TIMEOUT' : 'VERIFY_TIMEOUT', 'timeout');
  }

  async function beat(): Promise<void> {
    const rec = await loadRecord();
    if (rec === null || live === null || rec.command.job_id === null || rec.phase === 'done') return;
    const phase: Phase = rec.phase === 'claimed' ? 'navigating' : rec.phase === 'intent_unknown' ? 'awaiting_permission' : rec.phase === 'publishing' ? 'verifying_list' : rec.phase;
    const r = await api.signed('POST', `/v1/jobs/${q(rec.command.job_id)}/heartbeat`, { attempt_id: rec.command.attempt_id, command_id: rec.command.command_id, phase }, HeartbeatResponseSchema);
    const stop = (r.kind === 'ok' && r.body?.continue === false) || (r.kind === 'refused' && r.status === 409);
    // continue:false (pause, stop) only matters before the intent: after it, nothing may be abandoned.
    if (stop && rec.command.kind === 'post' && beforeIntent(rec)) {
      toCs(rec, { type: 'abort', command_id: rec.command.command_id });
      await finishPost(rec, 'not_registered', null, 'stopped_by_node');
    }
  }

  // ---------------------------------------------------------------- messages

  function onMessage(raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean {
    let replied = false;
    const reply = (r: unknown): void => {
      if (!replied) sendResponse(r);
      replied = true;
    };
    void safely(async () => {
      let rec = await loadRecord();
      if (rec !== null && live === null) {
        await recover(rec);
        rec = await loadRecord();
      }
      const g = guardMessage(raw, sender, origins(), rec);
      if (g === null) return reply(null);
      if (g.from === 'popup') return reply(await handlePopup(g.msg, api, () => void kick(), survey));
      reply(await onCs(rec, g.msg, g.tabId, g.documentId));
    }).finally(() => reply(null));
    return true;
  }

  async function onCs(rec: CommandRecord | null, msg: CsMessage, tabId: number, documentId: string): Promise<unknown> {
    if (rec === null || live === null || rec.phase === 'done') return null;
    if (msg.type === 'cs.ready') return tabId === rec.tab_id ? onReady(rec, documentId) : null;
    arm(live.expectNav ? PAGE_DEADLINE_MS : SILENCE_MS);
    switch (msg.type) {
      case 'cs.progress':
        return onProgress(rec, msg);
      case 'cs.chunk_request':
        return live.command.kind === 'post' && beforeIntent(rec) ? assetChunk(api, live.command, msg.index) : null;
      case 'cs.submit_request':
        return submitRequest(rec, msg);
      case 'cs.clicking':
        return clicking(rec);
      case 'cs.clicked':
        return rec.phase === 'clicking' ? submitted(rec, false) : null;
      case 'cs.click_aborted':
        // After a permission every outcome is "unknown" (P3-R14).
        return rec.phase === 'authorized' || rec.phase === 'clicking' ? finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', `click_aborted:${msg.reason}`) : null;
      case 'cs.report':
        return onReport(rec, msg);
      default:
        return null; // cs.pong, and the survey and probe results, come back as replies to tabs.sendMessage
    }
  }

  async function onReady(rec: CommandRecord, documentId: string): Promise<void> {
    if (live === null || documentId === rec.document_id) return;
    const first = rec.document_id === null;
    rec.document_id = documentId;
    if (rec.command.kind === 'post') {
      if (beforeIntent(rec)) {
        // A document change after the first form input and before the intent may have been a send (P3-R40).
        if (!first && rec.mutated && !live.expectNav) return fail(rec, 'SALON_BOARD_PAGE_CHANGED', 'navigated_during_input', { unexpected_navigation: true });
        live.expectNav = false;
        if (rec.phase === 'navigating') rec.phase = 'checking_page';
      } else if (rec.phase === 'authorized') {
        return finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', 'click_not_confirmed');
      } else if (rec.phase === 'clicking' || rec.phase === 'clicked') {
        await submitted(rec, true);
      } else if (rec.phase !== 'verifying_completion' && rec.phase !== 'verifying_list' && rec.phase !== 'publishing') {
        return finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', 'navigated_awaiting_permission', { unexpected_navigation: rec.mutated });
      }
    }
    // The publish step's one click goes to its first document only; persisted before the CS hears it.
    const mayClick = rec.phase === 'publishing' && rec.publish_click === true;
    if (mayClick) rec.publish_click = false;
    await saveRecord(rec);
    sendStep(rec, mayClick);
  }

  async function onProgress(rec: CommandRecord, m: Extract<CsMessage, { type: 'cs.progress' }>): Promise<void> {
    if (live === null) return;
    if (m.mutated === true) rec.mutated = true;
    if (rec.command.kind === 'post' && beforeIntent(rec)) {
      if (m.phase === 'navigating') {
        live.expectNav = true;
        live.carry = m.carry ?? null;
        arm(PAGE_DEADLINE_MS);
      } else if (PRE_INTENT.has(m.phase)) rec.phase = m.phase;
    }
    await saveRecord(rec);
    await beat();
  }

  async function submitRequest(rec: CommandRecord, m: Extract<CsMessage, { type: 'cs.submit_request' }>): Promise<SwMessage> {
    const deny = (code: ApiErrorCode): SwMessage => ({ type: 'permission', granted: false, code });
    const c = live?.command;
    if (c?.kind !== 'post' || rec.document_id === null) return deny('STALE_COMMAND');
    // Rule 1: one intent request per attempt, ever.
    if (rec.intent_requested_attempt_id !== null || !PRE_INTENT.has(rec.phase)) return deny('POST_RESULT_UNKNOWN');
    rec.intent_requested_attempt_id = c.attempt_id;
    rec.phase = 'awaiting_permission';
    await saveRecord(rec);
    const r = await api.signed(
      'POST',
      `/v1/jobs/${q(c.job_id)}/submit-intent`,
      { attempt_id: c.attempt_id, command_id: c.command_id, document_ref: rec.document_id, readback: m.readback, observed_count: m.observed_count },
      SubmitIntentResponseSchema,
      TIMEOUT_MS.intent,
    );
    const p = r.kind === 'ok' ? r.body?.permission : undefined;
    if (r.kind === 'ok' && r.body !== null && p !== undefined && p.attempt_id === c.attempt_id && p.command_id === c.command_id && p.document_ref === rec.document_id) {
      rec.phase = 'authorized';
      rec.permission = { permission_id: p.permission_id, ttl_ms: p.ttl_ms, received_mono: performance.now(), received_wall: Date.now() };
      rec.match = r.body.match;
      await saveRecord(rec); // Rule 2: persisted before the CS hears "granted"
      return { type: 'permission', granted: true, permission_id: p.permission_id, ttl_ms_remaining: ttlLeft(rec.permission) };
    }
    if (r.kind === 'refused') {
      // Node refused before recording an intent (or reports one already recorded) and has settled the job itself.
      await endCommand();
      return deny(r.error.code);
    }
    // Network error, timeout, 5xx or a bad signature: the intent may or may not be recorded (rule 8).
    rec.phase = 'intent_unknown';
    await saveRecord(rec);
    await finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', 'intent_unknown');
    return deny('POST_RESULT_UNKNOWN');
  }

  /** Rule 3: `clicking` is persisted before the ack; the CS clicks only after the ack. */
  async function clicking(rec: CommandRecord): Promise<SwMessage> {
    const command_id = rec.command.command_id;
    if (rec.phase !== 'authorized' || rec.permission === null || ttlLeft(rec.permission) <= CLICK_MARGIN_MS) return { type: 'abort', command_id };
    rec.phase = 'clicking';
    await saveRecord(rec);
    return { type: 'clicking_ack', command_id };
  }

  /** The click happened (reported, or inferred from a new document while clicking): POSTING → VERIFYING. */
  async function submitted(rec: CommandRecord, inferred: boolean): Promise<void> {
    const { attempt_id, command_id } = rec.command;
    if (live === null || attempt_id === null) return;
    rec.phase = 'verifying_completion';
    live.step = 'verify_completion';
    const flags = { mutated: rec.mutated, unexpected_navigation: false, inferred_click: inferred };
    await sendResult(rec, { attempt_id, command_id, outcome: 'submitted', code: null, stage: inferred ? 'inferred_click' : 'clicked', evidence: null, observed: null, flags }, false);
  }

  async function onReport(rec: CommandRecord, m: Extract<CsMessage, { type: 'cs.report' }>): Promise<void> {
    if (live === null) return;
    const c = live.command;
    live.evidence = mergeEvidence(live.evidence, m.evidence);
    // Whatever the publish step found (its notes say), the post is proved: posted.
    if (m.kind === 'publish') return rec.phase === 'publishing' ? finishPost(rec, 'posted', null, null) : undefined;
    if (m.kind === 'post_step') {
      if (c.kind !== 'post' || m.ok || rec.phase === 'publishing') return;
      const outcome = beforeIntent(rec) && !m.flags.unexpected_navigation ? 'not_registered' : 'unknown';
      return finishPost(rec, outcome, m.code ?? 'SALON_BOARD_PAGE_CHANGED', null, m.flags);
    }
    if (m.kind === 'completion') {
      if (c.kind !== 'post' || (rec.phase !== 'clicking' && rec.phase !== 'clicked' && rec.phase !== 'verifying_completion')) return;
      if (rec.phase !== 'verifying_completion') await submitted(rec, true);
      await outline(rec, c);
      live.completionOk = m.ok;
      // P3-R14's only way to "not registered" after a click: an owner-confirmed client-side rejection, same document,
      // and then no candidate on any list page.
      const r = m.evidence?.rejection;
      live.clientSideRejection = !m.ok && m.code === 'SUBMIT_FAILED' && r?.client_side_only === true && !r.navigated;
      if (!m.ok && !live.clientSideRejection) return finishPost(rec, 'unknown', m.code ?? 'POST_RESULT_UNKNOWN', null);
      if (c.profile.success_signals.completion_only === true) {
        // Owner-confirmed: the completion page with the own salon identified on it is the proof; no list to visit.
        const proved = m.ok && live.evidence?.salon.some((s) => s.page === 'completion' && s.identified) === true;
        return proved ? provedPost(rec) : finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', null);
      }
      rec.phase = 'verifying_list';
      return navigate(rec, c.profile.success_signals.list?.url, c.profile.success_signals.list?.url_match, 'verify_list');
    }
    if (m.kind === 'list' || m.kind === 'detail') {
      if (c.kind === 'preflight' || (c.kind === 'post' && rec.phase !== 'verifying_list')) return;
      if (c.kind === 'post') await outline(rec, c);
      const list = c.profile.success_signals.list;
      if (m.kind === 'list' && m.next_url !== undefined) {
        const toDetail = m.evidence?.list?.matched != null;
        if (!toDetail) {
          live.pageIndex += 1;
          if (live.pageIndex >= (list?.max_pages ?? 1)) return listDone(rec, false, m.code);
        }
        return navigate(rec, m.next_url, toDetail ? c.profile.success_signals.detail?.url_match : list?.url_match, toDetail ? 'verify_detail' : 'verify_list');
      }
      return listDone(rec, m.ok, m.code);
    }
    if (m.kind === 'preflight' && c.kind === 'preflight') return preflightStep(rec, m.ok, m.code, m.page_state, m.evidence?.notes.join(' ') ?? null);
  }

  /**
   * live_single (P3-R4): a strict outline of each page shown after the click (completion or the same document, list,
   * detail), whatever the outcome, saved through /v1/survey and linked to the attempt. Best effort: never changes a result.
   */
  async function outline(rec: CommandRecord, c: PostCommand): Promise<void> {
    if (!c.live_single || rec.tab_id === null || rec.document_id === null) return;
    const run: SwMessage = { type: 'run_survey', kind: 'page', known_title: c.inputs.title.slice(0, 100), salon_label: c.salon.expected_account_label, poster_name: null, strict: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer: unknown = await Promise.race([
      chrome.tabs.sendMessage(rec.tab_id, run, { documentId: rec.document_id }).catch(() => null),
      new Promise<null>((r) => (timer = setTimeout(() => r(null), OUTLINE_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    const m = CsMessageSchema.safeParse(answer);
    if (!m.success || m.data.type !== 'cs.survey_result') return;
    const link = { job_id: c.job_id, attempt_id: c.attempt_id, kind: 'live-single-outline' as const };
    await api.signed('POST', '/v1/survey', { capture: m.data.capture, link }, SurveyResponseSchema);
  }

  async function listDone(rec: CommandRecord, ok: boolean, code: ErrorCode | null): Promise<void> {
    const list = live?.evidence?.list ?? null;
    if (rec.command.kind === 'reconcile') {
      const none = list !== null && list.all_pages && list.candidates === 0;
      return finishReconcile(rec, ok ? 'found' : (list?.candidates ?? 0) > 1 ? 'ambiguous' : none ? 'not_found' : 'error', null);
    }
    if (ok && live?.completionOk === true) return provedPost(rec);
    if (!ok && live?.clientSideRejection === true && list !== null && list.all_pages && list.candidates === 0) return finishPost(rec, 'not_registered', 'SUBMIT_FAILED', null);
    return finishPost(rec, 'unknown', code ?? 'POST_RESULT_UNKNOWN', null);
  }

  /** The post is proved: press 反映申請 (profile.publish) when the profile has one, else finish. */
  async function provedPost(rec: CommandRecord): Promise<void> {
    const c = live?.command;
    const publish = c?.kind === 'post' ? c.profile.publish : undefined;
    if (live === null || publish === undefined) return finishPost(rec, 'posted', null, null);
    rec.phase = 'publishing';
    rec.proof = live.evidence;
    rec.publish_click = true;
    return navigate(rec, publish.url, publish.url_match, 'publish');
  }

  async function preflightStep(rec: CommandRecord, ok: boolean, code: ErrorCode | null, page: PreflightResult['targets'][number]['page'], note: string | null): Promise<void> {
    const c = live?.command;
    if (live === null || c?.kind !== 'preflight') return finishPreflight(rec, []);
    const target = c.targets[live.preflight.length];
    if (target === undefined) return;
    const detail = `確認できませんでした（${[code, note].filter((x) => x !== null && x !== '').join(': ') || '不明'}）`.slice(0, 200);
    live.preflight.push({ route_key: target.route_key, page, checks: [ok ? { check: 'page', ok, detail_ja: '画面を確認しました' } : { check: checkOf(code), ok, detail_ja: detail }] });
    const next = c.targets[live.preflight.length];
    if (next !== undefined) return navigate(rec, next.entry_url, next.profile.url_match, 'run_preflight');
    return finishPreflight(rec, live.preflight);
  }

  // ---------------------------------------------------------------- results

  /** Ends the command with a failure: before the intent a post is definitely not submitted; after it, unknown. */
  async function fail(rec: CommandRecord, code: ErrorCode, note: string, flags: Partial<ResultFlags> = {}): Promise<void> {
    // Proved already: a failed 反映申請 is only a note (the next post publishes again), never unknown.
    if (rec.phase === 'publishing') return finishPost(rec, 'posted', null, `publish_failed:${note}`);
    if (rec.command.kind === 'post') return finishPost(rec, beforeIntent(rec) && flags.unexpected_navigation !== true ? 'not_registered' : 'unknown', code, note, flags);
    if (rec.command.kind === 'reconcile') return finishReconcile(rec, 'error', note);
    return preflightStep(rec, false, code, null, note);
  }

  async function finishPost(rec: CommandRecord, outcome: ResultRequest['outcome'], code: ErrorCode | null, note: string | null, flags: Partial<ResultFlags> = {}): Promise<void> {
    const { attempt_id, command_id } = rec.command;
    if (attempt_id === null) return endCommand();
    const evidence = withNote(live?.evidence ?? rec.proof ?? null, note);
    const matched = evidence?.list?.matched ?? null;
    await sendResult(rec, {
      attempt_id,
      command_id,
      outcome,
      code,
      stage: rec.phase,
      evidence,
      observed: matched === null ? null : { registered_at_text: matched.date_text },
      flags: { mutated: rec.mutated, unexpected_navigation: flags.unexpected_navigation ?? false, inferred_click: flags.inferred_click ?? false },
    } satisfies Omit<ResultRequest, 'protocol_version' | 'request_id'>);
  }

  async function finishReconcile(rec: CommandRecord, outcome: AutoReconcileRequest['outcome'], note: string | null): Promise<void> {
    const { reconcile_id, command_id } = rec.command;
    if (reconcile_id === undefined) return endCommand();
    const evidence = withNote(live?.evidence ?? null, note) ?? EMPTY_EVIDENCE;
    const matched = evidence.list?.matched ?? null;
    await sendResult(rec, { reconcile_id, command_id, outcome, evidence, observed: matched === null ? null : { registered_at_text: matched.date_text } });
  }

  async function finishPreflight(rec: CommandRecord, targets: PreflightResult['targets']): Promise<void> {
    const { preflight_id, command_id } = rec.command;
    if (preflight_id === undefined) return endCommand();
    const outcome = targets.length > 0 && targets.every((t) => t.checks.every((x) => x.ok)) ? 'passed' : 'failed';
    await sendResult(rec, { preflight_id, command_id, result: { preflight_id, finished_at: new Date().toISOString(), outcome, targets } });
  }

  /** Persists the result as pending, then delivers it. A final result ends the command once Node acknowledges it. */
  async function sendResult(rec: CommandRecord, body: Record<string, unknown>, final = true): Promise<void> {
    rec.pending_result = body;
    rec.result_5xx_count = 0;
    if (final) {
      rec.phase = 'done';
      stopTimers();
    }
    await saveRecord(rec);
    await deliver(rec);
  }

  /** Rule 9: retried with backoff until Node answers a verified 200 or 409; after 5 failures the SW gives up. */
  async function deliver(rec: CommandRecord): Promise<void> {
    const body = rec.pending_result;
    if (body === null) return;
    const path =
      rec.command.kind === 'preflight'
        ? `/v1/control/preflight/${q(rec.command.preflight_id ?? '')}/result`
        : `/v1/jobs/${q(rec.command.job_id ?? '')}/${rec.command.kind === 'post' ? 'result' : 'reconcile'}`;
    const schema = rec.command.kind === 'post' ? ResultResponseSchema : rec.command.kind === 'reconcile' ? ReconcileResponseSchema : AppliedResponseSchema;
    let r: Awaited<ReturnType<typeof api.signed>> | null = null;
    if (hooks.dropNextResult) hooks.dropNextResult = false;
    else for (let n = hooks.duplicateNextResult ? 2 : 1; n > 0; n--) r = await api.signed('POST', path, body, schema);
    hooks.duplicateNextResult = false;
    // A verified 2xx, 409 or other 4xx is final (retrying cannot change it); 503 and anything unverifiable is retried.
    if (r !== null && (r.kind === 'ok' || (r.kind === 'refused' && r.status !== 503))) {
      rec.pending_result = null;
      if (rec.phase !== 'done') return saveRecord(rec);
      await chrome.storage.local.remove('warning');
      return endCommand();
    }
    rec.result_5xx_count += 1;
    if (rec.result_5xx_count >= RESULT_GIVE_UP) {
      await chrome.storage.local.set({ warning: RESULT_WARNING });
      return endCommand();
    }
    await saveRecord(rec);
    const retry = async (): Promise<void> => {
      const again = await loadRecord();
      if (again?.pending_result != null && again.command.command_id === rec.command.command_id) await deliver(again);
    };
    setTimeout(() => void safely(retry), (RESULT_BACKOFF_S[rec.result_5xx_count - 1] ?? 120) * 1000);
  }

  function stopTimers(): void {
    if (live === null) return;
    clearInterval(live.heartbeat);
    if (live.watchdog !== null) clearTimeout(live.watchdog);
    live.watchdog = null;
  }

  async function endCommand(): Promise<void> {
    stopTimers();
    live = null;
    dropAsset();
    // Before the record goes: a restart in between re-delivers the result and closes again.
    await closePostingTab();
    await clearRecord();
    setTimeout(() => void kick(), 0); // next claim right away
  }

  /**
   * After an SW restart (record without in-memory state). Never asks for a permission or clicks again (rule 6).
   * Pre-intent (rule 7): ping the bound document; alive → abort + not_registered; gone and mutated → unknown with
   * unexpected_navigation; gone untouched → not_registered. From the intent request on → unknown.
   */
  async function recover(rec: CommandRecord): Promise<void> {
    if (rec.phase === 'done') return deliver(rec);
    if (rec.phase === 'publishing') return finishPost(rec, 'posted', null, 'publish_failed:sw_restart');
    const { kind, command_id } = rec.command;
    if (kind === 'reconcile') return finishReconcile(rec, 'error', 'sw_restart');
    if (kind === 'preflight') return finishPreflight(rec, []);
    if (beforeIntent(rec)) {
      const alive = await ping(rec);
      if (alive) toCs(rec, { type: 'abort', command_id });
      if (alive || !rec.mutated) return finishPost(rec, 'not_registered', 'EXTENSION_DISCONNECTED', 'sw_restart');
      return finishPost(rec, 'unknown', 'SALON_BOARD_PAGE_CHANGED', 'sw_restart', { unexpected_navigation: true });
    }
    toCs(rec, { type: 'abort', command_id });
    return finishPost(rec, 'unknown', 'POST_RESULT_UNKNOWN', 'sw_restart');
  }

  return { kick, onMessage, pair: (code: string) => pair(api, code, chrome.runtime.id), hooks };
}

export type Sw = ReturnType<typeof createSw>;

const version = (): string => chrome.runtime.getManifest().version;

/** The permission's remaining TTL by both clocks (the larger elapsed time wins). */
function ttlLeft(p: { ttl_ms: number; received_mono: number; received_wall: number }): number {
  return Math.max(0, Math.floor(p.ttl_ms - Math.max(performance.now() - p.received_mono, Date.now() - p.received_wall)));
}

function checkOf(code: ErrorCode | null): 'url' | 'login' | 'page' | 'salon' | 'audience' | 'count' {
  if (code === 'AUTH_REQUIRED' || code === 'LOGIN_FAILED' || code === 'MFA_REQUIRED' || code === 'CAPTCHA' || code === 'ACCOUNT_ERROR') return 'login';
  if (code === 'WRONG_SALON') return 'salon';
  if (code === 'POST_TARGET_MISMATCH') return 'audience';
  if (code === 'LIMIT_REACHED') return 'count';
  return code === 'PAGE_TIMEOUT' ? 'url' : 'page';
}

/** Evidence gathered across documents (completion, list pages, detail); candidates add up over list pages. */
export function mergeEvidence(a: Evidence | null, b: Evidence | null): Evidence | null {
  if (a === null || b === null) return a ?? b;
  const list = a.list === null || b.list === null ? (b.list ?? a.list) : { ...b.list, candidates: a.list.candidates + b.list.candidates, matched: b.list.matched ?? a.list.matched };
  return {
    page_url_path: b.page_url_path,
    completion: b.completion ?? a.completion,
    salon: [...a.salon, ...b.salon].slice(-10),
    list,
    rejection: b.rejection ?? a.rejection,
    notes: [...a.notes, ...b.notes].slice(-20),
  };
}

function withNote(e: Evidence | null, note: string | null): Evidence | null {
  const out = note === null ? e : { ...(e ?? EMPTY_EVIDENCE), notes: [...(e?.notes ?? []), note].slice(-20) };
  // Over 4 KiB (many documents): keep a valid minimum; Node then treats the outcome as unproven.
  return out === null || EvidenceSchema.safeParse(out).success ? out : { ...EMPTY_EVIDENCE, notes: ['evidence_trimmed'] };
}
