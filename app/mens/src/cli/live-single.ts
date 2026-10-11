import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { ROUTE_LABELS } from '../content/instructions/parse.js';
import { ApiCallError, LocalApiClient } from '../server/client.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { LiveSingleArmedResponseSchema, LiveSinglePreviewResponseSchema, LiveSinglePreviewSchema } from '../shared/protocol/api.js';
import { StatusDtoSchema } from '../shared/protocol/status.js';
import { ROUTE_KEYS, type RouteKey } from '../shared/protocol/version.js';
import { resolveDataPaths } from '../storage/paths.js';
import { missingDashHint } from './operator.js';
import { NOT_RUNNING_JA } from './pair.js';
import { NOT_VERIFIED_JA, ROUTE_VALUES_JA } from './preflight.js';

// `npm.cmd run live:single -- --route <key> [--job <id>] [--yes]` (P3-R4; the owner runs it, never an agent). Without
// --yes it shows the one job the route's first live post would send and keeps what was shown in
// data/live-single-preview.json; the same command with --yes arms exactly that job: its id and hashes are sent again and
// the tool refuses when the content changed since. Each preview is used for one --yes only.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

const HOW = [
  'npm.cmd run live:single -- --route style.mens',
  `  ${ROUTE_VALUES_JA}`,
  '  まず --yes なしで内容を表示し、よければ同じコマンドに --yes を足します。job を選ぶときは --job job_id を足します。',
  '  投稿枠の時刻を待たずに今すぐ送るときは、--yes と一緒に --now を足します（その日の次の枠を前倒しで使います）。',
].join('\n');
const Shown = LiveSinglePreviewSchema.pick({ route_key: true, job_id: true, content_hash: true, image_sha256: true });
export const PREVIEW_JA = 'この内容で1件だけ本番投稿します。';
export const CONFIRM_JA = 'よければ同じコマンドに --yes を付けて実行してください。';

function usage(io: Io, message: string): number {
  io.stderr(message);
  const hint = missingDashHint();
  if (hint !== null) io.stderr(hint);
  io.stderr(`使い方: ${HOW}`);
  return 1;
}

export async function liveSingleCommand(projectRoot: string, args: readonly string[], io: Io): Promise<number> {
  let route: string | undefined;
  let job: string | undefined;
  let yes = false;
  let now = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes') yes = true;
    else if (a === '--now') now = true;
    else if ((a === '--route' || a === '--job') && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
      if (a === '--route') route = args[++i];
      else job = args[++i];
    } else return usage(io, a === '--route' || a === '--job' ? `${a} の後に値を指定してください。` : `live:single に指定できない引数です: ${a}`);
  }
  if (route === undefined) return usage(io, '--route で投稿先を指定してください。');
  if (now && !yes) return usage(io, '--now は --yes と一緒に指定します（まず --yes なしで内容を確認してください）。');
  if (!(ROUTE_KEYS as readonly string[]).includes(route)) return usage(io, `--route に指定できない値です: ${route}`);
  const key = route as RouteKey;

  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) throw new AppFailure(appError('CONFIG_INVALID', 'cli', systemClock, { details: { issues: config.issues } }));
  const { settings } = config.snapshot;
  const shownFile = join(resolveDataPaths(projectRoot, settings).modeRoot, 'data', 'live-single-preview.json');
  const client = await LocalApiClient.discover(resolve(projectRoot, settings.data_root));
  if (client === null) {
    io.stderr(NOT_RUNNING_JA);
    return 2;
  }
  try {
    if (!yes) {
      const { preview: p } = LiveSinglePreviewResponseSchema.parse((await client.request('POST', '/v1/control/live-single', { route_key: key, confirm: false, ...(job === undefined ? {} : { job_id: job }) })).body);
      await writeFile(shownFile, JSON.stringify({ route_key: p.route_key, job_id: p.job_id, content_hash: p.content_hash, image_sha256: p.image_sha256 }));
      io.stdout(
        [
          PREVIEW_JA,
          `  投稿先: ${ROUTE_LABELS[p.route_key]}（${p.route_key}）`,
          `  job: ${p.job_id}`,
          `  タイトル: ${p.title}`,
          `  文章の始め: ${p.text_head}`,
          `  カテゴリー: ${p.category_label}`,
          `  画像: ${p.image_name}`,
          `  投稿先のURL: ${p.route_url_display}`,
          `${CONFIRM_JA}（npm.cmd run live:single -- --route ${key}${job === undefined ? '' : ` --job ${job}`} --yes）`,
        ].join('\n'),
      );
      return 0;
    }
    // Used once: whatever the answer, the next --yes needs a new preview.
    const shown = Shown.safeParse(await readFile(shownFile, 'utf8').then(JSON.parse, () => null));
    await rm(shownFile, { force: true });
    if (!shown.success || shown.data.route_key !== key || (job !== undefined && shown.data.job_id !== job)) {
      io.stderr(`先に --yes を付けずに実行して、本番投稿する内容を確認してください（npm.cmd run live:single -- --route ${key}）。`);
      return 1;
    }
    const s = shown.data;
    const armed = LiveSingleArmedResponseSchema.parse(
      (await client.request('POST', '/v1/control/live-single', { route_key: key, confirm: true, job_id: s.job_id, content_hash: s.content_hash, image_sha256: s.image_sha256, ...(now ? { now: true } : {}) })).body,
    );
    const when = now ? '今すぐ（1分ほどで）' : armed.next_slot_at_jst === null ? '次の投稿枠' : `次の投稿枠（${armed.next_slot_at_jst.slice(11)}）`;
    io.stdout(`${when}で、表示した1件だけ（${armed.job_id}）を本番投稿し、その後は自動で一時停止します。SALON BOARD の画面で結果を確認してください。`);
    if (StatusDtoSchema.parse((await client.request('GET', '/v1/status')).body).paused) {
      io.stdout('いまは一時停止中です。npm.cmd run resume を実行すると、この1件だけを送信します（ほかの投稿先の初回の投稿は、それぞれ live:single が必要です）。');
    }
    return 0;
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
