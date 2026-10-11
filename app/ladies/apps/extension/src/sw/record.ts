import type { Evidence, MatchKeys, Phase } from '../../../../src/shared/protocol/index.js';

// The SW command record (D12): the persisted state of the single current command, cleared at command end.
// It is not a journal. chrome.storage.local is restricted to trusted contexts before the first read (index.ts).

/** 'publishing': the post is proved and its 反映申請 (profile.publish) is being pressed; every path from here ends as posted. */
export type RecordPhase = Phase | 'claimed' | 'intent_unknown' | 'publishing' | 'done';

export interface CommandRecord {
  schema: 1;
  instance_id: string;
  client_id: string;
  command: { kind: 'post' | 'reconcile' | 'preflight'; command_id: string; job_id: string | null; attempt_id: string | null; reconcile_id?: string; preflight_id?: string };
  window_id: number | null;
  tab_id: number | null;
  document_id: string | null;
  mutated: boolean;
  /** Persisted BEFORE submit-intent is called; once set, no second submit_request is ever forwarded. */
  intent_requested_attempt_id: string | null;
  phase: RecordPhase;
  permission: { permission_id: string; ttl_ms: number; received_mono: number; received_wall: number } | null;
  match: MatchKeys | null;
  /** The proved post's evidence while publishing (live is gone after an SW restart). */
  proof?: Evidence | null;
  /** While publishing: the one click has not been handed to a document yet (cleared before the CS hears it). */
  publish_click?: boolean;
  /** The unacknowledged result (post result, auto reconcile or preflight result body). */
  pending_result: Record<string, unknown> | null;
  result_5xx_count: number;
  updated_at: number;
}

/** Phases before any permission was asked for. */
export const PRE_INTENT: ReadonlySet<RecordPhase> = new Set(['claimed', 'navigating', 'checking_page', 'uploading', 'filling', 'reading_back', 'awaiting_permission']);

export async function loadRecord(): Promise<CommandRecord | null> {
  const got = await chrome.storage.local.get('record');
  return (got.record as CommandRecord | undefined) ?? null;
}

export async function saveRecord(r: CommandRecord): Promise<void> {
  r.updated_at = Date.now();
  await chrome.storage.local.set({ record: r });
}

export const clearRecord = (): Promise<void> => chrome.storage.local.remove('record');

/** Serializes every record mutation (kick, CS messages, timers). */
export function makeLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
