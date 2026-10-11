import type { Phase } from '../../../../src/shared/protocol/index.js';
import type { CsEnv } from './common.js';

// The once-only submit, per document (every page load gets a fresh content script, so this module state is the
// document's): a command asks for permission at most once here, and the click needs the gate below (§5.2, P3-R10).

/** The command running in this document, for the pagehide report. */
export interface Active {
  readonly env: CsEnv;
  readonly command_id: string;
  phase: Phase;
  mutated: boolean;
}

export const state = {
  /** Set BEFORE cs.submit_request is sent; a command in it never asks again from this document. */
  submitted: new Set<string>(),
  running: new Set<string>(),
  /** The SW said abort (pause before the intent, or its restart): no more input, no click. */
  aborted: new Set<string>(),
  /** pagehide or beforeunload was seen: nothing more is typed or clicked in this document. */
  leaving: false,
  active: null as Active | null,
};

export const CLICK_MARGIN_MS = 500;
/** The permission as it arrived: its remaining TTL and both clocks at arrival. */
export interface Permit {
  ttl: number;
  mono: number;
  wall: number;
}
export type ClickAbort = 'ttl' | 'runtime_gone' | 'navigated';

/** Milliseconds since the permission arrived, by the clock that moved more. */
export const elapsed = (p: Permit): number => Math.max(performance.now() - p.mono, Date.now() - p.wall);

/**
 * The click gate: the extension context is alive, the document is not leaving, the SW acknowledged `cs.clicking` for this
 * command, and BOTH the performance.now() and Date.now() deltas since the permission arrived are below ttl − 500 ms.
 */
export function clickGate(env: CsEnv, p: Permit, ack: unknown, commandId: string): ClickAbort | null {
  if (!env.runtimeAlive()) return 'runtime_gone';
  if (state.leaving) return 'navigated';
  const a = ack as { type?: unknown; command_id?: unknown } | null;
  if (a === null) return 'runtime_gone';
  if (a.type !== 'clicking_ack' || a.command_id !== commandId || state.aborted.has(commandId)) return 'ttl';
  const limit = p.ttl - CLICK_MARGIN_MS;
  return performance.now() - p.mono < limit && Date.now() - p.wall < limit ? null : 'ttl';
}

/** pagehide / beforeunload: during a command, a best-effort cs.progress {phase, mutated}; this document never acts again. */
export function onLeave(): void {
  if (state.leaving) return;
  state.leaving = true;
  const a = state.active;
  if (a !== null) void a.env.send({ type: 'cs.progress', command_id: a.command_id, phase: a.phase, ...(a.mutated ? { mutated: true as const } : {}) });
}
