import { OPERATOR_PAUSE_JA, pause as pauseOperator } from '../../posting/control-service.js';
import type { Mode } from '../../shared/types.js';
import type { ApiErrorCode } from '../../shared/protocol/version.js';
import type { HelloRequest } from '../../shared/protocol/api.js';
import { ApiError } from '../errors.js';
import type { LocalApiDeps } from '../http-server.js';
import { PAIRING_TTL_MS } from '../pairing.js';
import type { HandlerResult } from '../router.js';
import { probeAllowed } from './probe.js';

// health, hello, operator pause/resume and pairing (Plan 3 Task 1b; the coordinator's part of hello from Task 2b; resume
// with stops from Task 2c). The status body is built by src/status.ts (Task 7).

export const APP_VERSION = '0.3.0';
const TTL_SECONDS = PAIRING_TTL_MS / 1000;

export const pairingCodeLine = (code: string): string =>
  `拡張機能の接続コード: ${code}（5分以内に拡張機能の画面へ入力してください。このコードは他人に教えないでください）`;

export function health(d: LocalApiDeps): Record<string, unknown> {
  return { instance_id: d.instanceId, server_nonce: d.serverNonce, state: d.state() === 'stopping' ? 'stopping' : 'running', mode: d.mode, app_version: APP_VERSION, paired: d.pairedClient() !== null };
}

function dispatchClosed(mode: Mode): { post_allowed: false; reasons: { code: ApiErrorCode; message_ja: string }[] } {
  const message_ja = mode === 'dry_run' ? 'dry-run のため SALON BOARD には投稿しません。' : 'SALON BOARD への投稿の機能はまだ準備中です。';
  return { post_allowed: false, reasons: [{ code: 'NOT_IMPLEMENTED', message_ja }] };
}

/**
 * The coordinator's state (step 0, dispatch, stops) plus the configured origins, survey/probe permission and the salon
 * labels for the owner's survey (Task 5a).
 */
export async function hello(d: LocalApiDeps, clientId: string, req: HelloRequest, now: Date): Promise<Record<string, unknown>> {
  const c = d.config();
  const live = d.coordinator.hello === undefined ? null : await d.coordinator.hello(clientId, req);
  return {
    instance_id: d.instanceId,
    mode: d.mode,
    paused: d.control.get().paused,
    heartbeat_seconds: 10,
    allowed_origins: c.salonboardFields.allowed_origins,
    dispatch: live?.dispatch ?? dispatchClosed(d.mode),
    probe_allowed: probeAllowed(d, now) && (live?.probe_gate ?? true),
    survey_allowed: d.state() === 'running' && c.deploymentChecks.automation.status !== 'prohibited' && (live?.survey_gate ?? true),
    client_fingerprint: d.pairedClient()?.fingerprint ?? '----',
    stops: live?.stops ?? [],
    salon_label: c.salon.expected_account_label?.slice(0, 100) ?? null,
    poster_name: c.salon.poster_name.slice(0, 100),
    salon_locators: Object.values(c.salonboardFields.pages).find((p) => p.verified_at !== null)?.salon_identification.locators ?? null,
  };
}

export async function pause(d: LocalApiDeps, by: 'ext' | 'cli' | 'pair', reason: string | undefined): Promise<HandlerResult> {
  await pauseOperator(d, reason?.trim() || (by === 'ext' ? '拡張機能から一時停止しました' : OPERATOR_PAUSE_JA));
  return { status: 200, body: { paused: true } };
}

/** The operator pause is cleared; stops are cleared as far as their rules allow (Task 2c). */
export async function resume(d: LocalApiDeps, confirmChecked: boolean): Promise<HandlerResult> {
  return { status: 200, body: await d.coordinator.resume(confirmChecked) };
}

/** The popup's 「接続」: only while nothing is paired; the code goes to the Node console only. */
export function pairStart(d: LocalApiDeps, now: Date): HandlerResult {
  if (d.pairedClient() !== null) throw new ApiError(409, 'PAIRING_NOT_OPEN', 'すでに接続済みです。接続し直すときは、別の PowerShell で npm.cmd run pair を実行してください。');
  const w = d.pairing.open(now, 'popup');
  if (w === 'rate_limited') throw new ApiError(429, 'RATE_LIMITED', '接続の受付が続いたため、少し待ってからもう一度押してください。', true);
  d.echo(pairingCodeLine(w.code));
  d.logger.info('PAIRING_OPENED', '拡張機能の接続を受け付けています（5分間）。接続コードはこの画面に表示しています。', { by: 'popup' });
  return { status: 202, body: { expires_in_seconds: TTL_SECONDS } };
}

export function pairBegin(d: LocalApiDeps, body: { client_nonce: string; extension_id: string }, now: Date): HandlerResult {
  if (!d.allowedExtensionIds().includes(body.extension_id)) throw new ApiError(403, 'FORBIDDEN', 'この拡張機能は settings.json の allowed_extension_ids にありません。');
  const r = d.pairing.begin(body, now);
  if (r === 'not_open') throw new ApiError(409, 'PAIRING_NOT_OPEN', '接続を受け付けていません。拡張機能の「接続」を押すか、別の PowerShell で npm.cmd run pair を実行してください。');
  if (r === 'locked') throw new ApiError(409, 'PAIRING_LOCKED', '接続コードの入力に5回失敗したため、受付を止めました。もう一度「接続」からやり直してください。');
  return { status: 200, body: r };
}

export async function pairFinish(d: LocalApiDeps, body: { pairing_id: string; client_proof: string }, now: Date): Promise<HandlerResult> {
  const r = await d.pairing.finish(body, now);
  if (r === 'locked') throw new ApiError(409, 'PAIRING_LOCKED', '接続コードの入力に5回失敗したため、受付を止めました。もう一度「接続」からやり直してください。');
  if (r === 'wrong' || r === 'expired') throw new ApiError(401, 'PAIRING_FAILED', '接続コードが違うか、期限（5分）が切れています。');
  await d.setPairedClient({ client_id: r.client_id, extension_id: r.extension_id, paired_at: now.toISOString(), fingerprint: r.fingerprint });
  d.logger.info('EXTENSION_PAIRED', `拡張機能と接続しました（確認記号: ${r.fingerprint}）。拡張機能の画面にも同じ記号が出ていることを確認してください。`);
  return { status: 200, body: { client_id: r.client_id, sealed_key: r.sealed_key, server_proof: r.server_proof, fingerprint: r.fingerprint } };
}

/** `npm.cmd run pair`: allowed at any time; the code is printed by the CLI itself. The old client is revoked on success. */
export function controlPair(d: LocalApiDeps, now: Date): HandlerResult {
  const w = d.pairing.open(now, 'cli');
  if (w === 'rate_limited') throw new ApiError(429, 'RATE_LIMITED', '少し待ってからもう一度実行してください。', true);
  d.logger.info('PAIRING_OPENED', '拡張機能の接続を受け付けています（5分間）。接続コードは npm.cmd run pair の画面に表示しています。', { by: 'cli' });
  return { status: 200, body: { code: w.code, expires_in_seconds: TTL_SECONDS } };
}
