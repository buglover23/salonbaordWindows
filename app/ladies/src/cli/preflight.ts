import { ROUTE_LABELS } from '../content/instructions/parse.js';
import { ApiCallError, LocalApiClient } from '../server/client.js';
import { PreflightResponseSchema } from '../shared/protocol/api.js';
import type { PreflightResult } from '../shared/protocol/results.js';
import { StatusDtoSchema } from '../shared/protocol/status.js';
import { ROUTE_KEYS, type RouteKey } from '../shared/protocol/version.js';
import { preflightLines } from '../status.js';
import { missingDashHint } from './operator.js';
import { NOT_RUNNING_JA } from './pair.js';

// `npm.cmd run preflight -- --route <key>|configured` (P3-R35): the running tool asks the extension to open the posting
// pages and check them (login, salon, page, fields, register button). Nothing is input, uploaded or registered.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };
export type Poll = { timeoutMs: number; intervalMs: number };

export const WAIT_MS: Poll = { timeoutMs: 90_000, intervalMs: 1000 };
export const NOT_VERIFIED_JA = 'ツールの応答を確認できませんでした。ツールを起動し直してから、もう一度実行してください。';
export const CHECKING_JA = 'SALON BOARD の画面を確認しています（入力も登録もしません。最大90秒）…';
export const NOT_FINISHED_JA = '画面の確認がまだ終わっていません。Chrome と投稿用のウィンドウが開いているか確認し、しばらくしてから npm.cmd run status で結果を確認してください。';
/** The --route values in words: an `a|b` placeholder pipes when the owner pastes it into PowerShell. */
export const ROUTE_VALUES_JA = `--route の値: ${ROUTE_KEYS.map((k) => `${k}（${ROUTE_LABELS[k]}）`).join('、')}`;
const HOW = `npm.cmd run preflight -- --route style.mens\n  ${ROUTE_VALUES_JA}。設定済みの投稿先すべてを確認するときは --route configured`;

/** Polls the running tool's status until a preflight result `match`es, or null after `poll.timeoutMs` (real time). */
export async function waitPreflight(client: LocalApiClient, match: (r: PreflightResult) => boolean, poll: Poll = WAIT_MS): Promise<PreflightResult | null> {
  const end = Date.now() + poll.timeoutMs;
  for (;;) {
    const s = StatusDtoSchema.parse((await client.request('GET', '/v1/status')).body);
    if (s.preflight !== null && match(s.preflight)) return s.preflight;
    if (Date.now() >= end) return null;
    await new Promise((done) => setTimeout(done, poll.intervalMs));
  }
}

/** Exit 0 when every page passed, 1 when a problem was found (or the request was refused), 2 when no answer came. */
export async function preflightCommand(projectRoot: string, args: readonly string[], io: Io, poll: Poll = WAIT_MS): Promise<number> {
  const route = args[0] === '--route' && args.length === 2 ? args[1]! : null;
  if (route === null || (route !== 'configured' && !(ROUTE_KEYS as readonly string[]).includes(route))) {
    io.stderr(route === null ? '--route で確認する投稿先を指定してください。' : `--route に指定できない値です: ${route}`);
    const hint = missingDashHint();
    if (hint !== null) io.stderr(hint);
    io.stderr(`使い方: ${HOW}`);
    return 1;
  }
  const client = await LocalApiClient.forProject(projectRoot);
  if (client === null) {
    io.stderr(NOT_RUNNING_JA);
    return 2;
  }
  try {
    const { preflight_id } = PreflightResponseSchema.parse((await client.request('POST', '/v1/control/preflight', { route_key: route as RouteKey | 'configured' })).body);
    io.stdout(CHECKING_JA);
    const result = await waitPreflight(client, (r) => r.preflight_id === preflight_id, poll);
    if (result === null || result.outcome === 'timeout') {
      io.stdout(NOT_FINISHED_JA);
      return 2;
    }
    io.stdout(preflightLines(result).join('\n'));
    return result.outcome === 'passed' ? 0 : 1;
  } catch (err) {
    if (err instanceof ApiCallError && err.kind === 'refused') {
      io.stderr(err.message);
      return 1;
    }
    if (err instanceof ApiCallError) {
      io.stderr(NOT_VERIFIED_JA);
      return 2;
    }
    throw err;
  }
}
