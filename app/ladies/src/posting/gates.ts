import type { ReadinessItem } from '../config/readiness.js';
import type { DeploymentChecks } from '../config/schemas.js';
import { ERROR_MESSAGES_JA } from '../shared/errors.js';
import type { ApiErrorCode, RouteKey } from '../shared/protocol/version.js';
import { DRY_RUN_JA, type Mode } from '../shared/types.js';
import type { ControlState, Stop } from '../storage/control-store.js';
import type { JobSummary } from '../storage/job-store.js';
import { RECONCILE_BLOCKING } from './stops.js';
import { CLAIM_MIN_WINDOW_MS } from './timing.js';

// Plan §5.5 (P3-R39): which command kind may be served under which condition, as data. The rows are evaluated top to
// bottom; the first row that applies and does not allow the kind refuses it.

export type CommandKind = 'post' | 'intent' | 'reconcile' | 'preflight' | 'probe' | 'survey';
export type Pressure = 'RESOURCE_MEMORY_HIGH' | 'RESOURCE_DISK_LOW' | 'DISK_FULL';

export interface GateContext {
  stopping: boolean;
  mode: Mode;
  automation: DeploymentChecks['automation'];
  pressure: Pressure | null;
  refreshFailed: boolean;
  configRejected: boolean;
  halted: boolean;
  paused: boolean;
  pauseReason: string | null;
  stops: readonly Stop[];
  /** Global live-readiness items (the automation items are reported by their own rows first). */
  readiness: readonly ReadinessItem[];
  blockingUnresolved: boolean;
  /** The extension sees another store logged in in its Chrome: the owner's message (absent / null: not seen). */
  wrongLogin?: string | null;
}

export interface GateRefusal {
  ok: false;
  code: ApiErrorCode;
  reason_ja: string;
  /** For an intent (a refused post claim is always 204, except while stopping). */
  http: 403 | 409 | 503;
}

interface Row {
  applies: (c: GateContext) => boolean;
  allow: readonly CommandKind[];
  refuse: (c: GateContext, kind: CommandKind) => Omit<GateRefusal, 'ok'>;
}

const ALL_BUT_POSTING: readonly CommandKind[] = ['reconcile', 'preflight', 'probe', 'survey'];
const AUTOMATION_JA = '自動操作の許可が確認できていないため、SALON BOARD の画面を自動で開くことはしません。';
export { DRY_RUN_JA };
export const REFRESH_FAILED_JA = '設定ファイルや作業指示書を読み直せないため、新しい投稿を止めています（照合は続けます）。';
export const CONFIG_REJECTED_JA = '設定ファイルの変更に誤りがあるため、新しい投稿を止めています（前の正しい設定のまま照合は続けます）。status で修正箇所を確認してください。';
export const HALTED_JA = '復旧できないjobがあるため、新しい投稿を止めています（照合は続けます）。status で確認してください。';
export const BLOCKING_UNRESOLVED_JA = '前日以前の結果不明の投稿（または未解決の結果不明が2件以上）があるため、照合が終わるまで新しい投稿を止めています。';

const salonStop = (c: GateContext, auth: boolean): Stop | undefined => c.stops.find((s) => s.scope === 'salon' && RECONCILE_BLOCKING.has(s.code) === auth);
const unverified = (a: DeploymentChecks['automation']): boolean => a.status === 'unknown' || (a.status === 'permitted' && (a.evidence === null || a.checked_at === null));

const ROWS: readonly Row[] = [
  { applies: (c) => c.stopping, allow: [], refuse: () => ({ code: 'BUSY', reason_ja: 'ツールを停止しているところです。', http: 503 }) },
  {
    applies: (c) => c.automation.status === 'prohibited',
    allow: [],
    refuse: (_c, kind) => ({ code: 'AUTOMATION_NOT_PERMITTED', reason_ja: '自動操作は禁止と記録されているため、SALON BOARD の画面を自動で開くことはしません。', http: kind === 'survey' ? 403 : 409 }),
  },
  { applies: (c) => unverified(c.automation), allow: ['survey'], refuse: () => ({ code: 'EXTERNAL_REQUIREMENT_UNVERIFIED', reason_ja: AUTOMATION_JA, http: 409 }) },
  { applies: (c) => c.mode === 'dry_run', allow: ['preflight', 'probe', 'survey'], refuse: () => ({ code: 'STALE_COMMAND', reason_ja: DRY_RUN_JA, http: 409 }) },
  { applies: (c) => c.pressure === 'DISK_FULL', allow: [], refuse: () => ({ code: 'DISK_FULL', reason_ja: ERROR_MESSAGES_JA.DISK_FULL, http: 503 }) },
  {
    applies: (c) => c.pressure === 'RESOURCE_MEMORY_HIGH' || c.pressure === 'RESOURCE_DISK_LOW',
    allow: ['reconcile', 'preflight'],
    refuse: (c) => {
      const code = c.pressure === 'RESOURCE_DISK_LOW' ? 'RESOURCE_DISK_LOW' : 'RESOURCE_MEMORY_HIGH';
      return { code, reason_ja: ERROR_MESSAGES_JA[code], http: 503 };
    },
  },
  { applies: (c) => c.refreshFailed, allow: ['reconcile', 'survey'], refuse: () => ({ code: 'BUSY', reason_ja: REFRESH_FAILED_JA, http: 503 }) },
  { applies: (c) => c.configRejected, allow: ['reconcile', 'survey'], refuse: () => ({ code: 'CONFIG_INVALID', reason_ja: CONFIG_REJECTED_JA, http: 409 }) },
  { applies: (c) => c.halted, allow: ALL_BUT_POSTING, refuse: () => ({ code: 'STATE_CORRUPT', reason_ja: HALTED_JA, http: 409 }) },
  {
    applies: (c) => c.paused,
    allow: ALL_BUT_POSTING,
    refuse: (c) => ({ code: 'PAUSED', reason_ja: `一時停止中のため送信しません（${c.pauseReason ?? '理由の記録なし'}）。再開は npm.cmd run resume です。`, http: 503 }),
  },
  {
    applies: (c) => salonStop(c, true) !== undefined,
    allow: ['preflight', 'survey'],
    refuse: (c) => {
      const s = salonStop(c, true)!;
      return { code: s.code, reason_ja: s.remedy, http: 409 };
    },
  },
  {
    applies: (c) => salonStop(c, false) !== undefined,
    allow: ALL_BUT_POSTING,
    refuse: (c) => {
      const s = salonStop(c, false)!;
      return { code: s.code, reason_ja: s.remedy, http: 409 };
    },
  },
  { applies: (c) => (c.wrongLogin ?? null) !== null, allow: ALL_BUT_POSTING, refuse: (c) => ({ code: 'WRONG_SALON', reason_ja: c.wrongLogin!, http: 409 }) },
  {
    applies: (c) => c.readiness.length > 0,
    allow: ALL_BUT_POSTING,
    refuse: (c) => ({ code: c.readiness[0]!.code, reason_ja: c.readiness[0]!.detail, http: 409 }),
  },
  { applies: (c) => c.blockingUnresolved, allow: ALL_BUT_POSTING, refuse: () => ({ code: 'POST_RESULT_UNKNOWN', reason_ja: BLOCKING_UNRESOLVED_JA, http: 409 }) },
];

/** Every §5.5 row that currently refuses `kind` (status and hello show them all). */
export function gateRefusals(kind: CommandKind, c: GateContext): GateRefusal[] {
  return ROWS.filter((r) => r.applies(c) && !r.allow.includes(kind)).map((r) => ({ ok: false, ...r.refuse(c, kind) }));
}

/** The first refusing row, or ok. */
export function gate(kind: CommandKind, c: GateContext): { ok: true } | GateRefusal {
  return gateRefusals(kind, c)[0] ?? { ok: true };
}

/** P3-R47: a route's first live post is done while its record names the route's current verified profile hash. */
export function firstPostState(route: RouteKey, control: Pick<ControlState, 'first_posts' | 'live_single'>, verifiedHash: string | null): 'done' | 'armed' | 'needs_live_single' {
  if (verifiedHash !== null && control.first_posts[route]?.profile_hash === verifiedHash) return 'done';
  return control.live_single?.route_key === route ? 'armed' : 'needs_live_single';
}

export interface DispatchContext {
  now: Date;
  /** End of the posting window holding `now` (null: outside every window). */
  windowEnd: Date | null;
  control: Pick<ControlState, 'first_posts' | 'live_single'>;
  /** No route readiness item, no type or route stop. */
  routeOk: (route: RouteKey) => boolean;
  /** The route's verified profile hash, and the constraints hash its upload must have been prepared for. */
  verifiedHash: (route: RouteKey) => string | null;
  uploadHash: (route: RouteKey) => string | null;
}

/**
 * P3-R39: the per-job predicates shared by scheduled slots and due retries: the route usable, the upload prepared for the
 * route's current image constraints, the live_single binding (only the bound job while armed), the first-post gate, and
 * at least 180 s of the posting window left.
 */
export function isDispatchable(s: Pick<JobSummary, 'id' | 'route_key' | 'upload_constraints_hash' | 'has_operation'>, c: DispatchContext): boolean {
  if (s.has_operation || c.windowEnd === null || c.windowEnd.getTime() - c.now.getTime() < CLAIM_MIN_WINDOW_MS) return false;
  if (!c.routeOk(s.route_key)) return false;
  const want = c.uploadHash(s.route_key);
  if (want === null || s.upload_constraints_hash !== want) return false;
  const bound = c.control.live_single;
  if (bound !== null) return bound.job_id === s.id && bound.route_key === s.route_key;
  return firstPostState(s.route_key, c.control, c.verifiedHash(s.route_key)) === 'done';
}
