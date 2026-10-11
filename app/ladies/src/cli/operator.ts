import { join } from 'node:path';
import { aiEnvKey } from '../ai/ai-config.js';
import { providerKindFor } from '../ai/ai-service.js';
import { loadAiSetup, stageWithoutKey } from '../ai/ai-setup.js';
import { UsageMeter } from '../ai/usage-meter.js';
import { loadConfig, type ConfigSnapshot } from '../config/loader.js';
import { ScheduleStore } from '../execution/schedule-store.js';
import { Scheduler } from '../execution/scheduler.js';
import { createFileLogger, type AppLogger } from '../logger.js';
import { pause, resume } from '../posting/control-service.js';
import { oursPostedFrom, remainingQuota, unresolvedFrom } from '../posting/quota.js';
import { applyOperatorReconcile, type OpsDeps } from '../posting/reconcile.js';
import { redraft, retryEligible, retryOne, type RedraftResult, type Restart } from '../posting/retry-service.js';
import { StopRegistry } from '../posting/stops.js';
import { ApiError } from '../server/errors.js';
import { ApiCallError, LocalApiClient } from '../server/client.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { POST_TYPE_JA } from '../shared/labels.js';
import { RedraftResponseSchema, ResumeResponseSchema, RetryResponseSchema } from '../shared/protocol/api.js';
import { StatusDtoSchema, type StopDto } from '../shared/protocol/status.js';
import { JstMinuteSchema } from '../shared/protocol/version.js';
import { POST_TYPES, type PostType } from '../shared/types.js';
import { BundleMover } from '../storage/bundles.js';
import { withCommandLock, type CommandLockOptions } from '../storage/command-lock.js';
import { ControlStore } from '../storage/control-store.js';
import { DedupeStore } from '../storage/dedupe-store.js';
import { HistoryStore, historyFullTextDays } from '../storage/history-store.js';
import { JobStore } from '../storage/job-store.js';
import { envDirOf, resolveDataPaths, type DataPaths } from '../storage/paths.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { preflightLines } from '../status.js';
import { CHECKING_JA, NOT_FINISHED_JA, NOT_VERIFIED_JA, waitPreflight, type Poll } from './preflight.js';

// `pause`, `resume`, `retry` and `reconcile` (plan Task 2c). While the tool runs they go through its local API (signed,
// the answer verified); otherwise they hold app.lock and change the same files themselves (§1-1: one writer at a time).

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

export interface OperatorCliOptions {
  lock?: CommandLockOptions;
  /** The environment .env is merged under (retry's AI check; default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  logger?: AppLogger;
  /** resume: how long to wait for the screen check, and how often to look (tests). */
  poll?: Poll;
}

/** npm keeps a script's own flags typed without `--` (npm 10 sets npm_config_<flag> instead): say so. */
export function missingDashHint(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const flags = ['once', 'at', 'id', 'reason', 'confirm_checked', 'registered', 'basis', 'route', 'job', 'type', 'dry'];
  const swallowed = flags.some((k) => env[`npm_config_${k}`] !== undefined);
  return swallowed ? 'npm.cmd run の後ろの -- が抜けているようです（例: npm.cmd run dry-run -- --once、npm.cmd run retry -- --id job_id）。' : null;
}

function usage(io: Io, message: string, how: string): number {
  io.stderr(message);
  const hint = missingDashHint();
  if (hint !== null) io.stderr(hint);
  io.stderr(`使い方: ${how}`);
  return 1;
}

/** Flags with a value (`--id x`) and switches (`--yes`); anything else is an error message. */
function parseFlags(args: readonly string[], valued: readonly string[], switches: readonly string[]): { values: Record<string, string>; on: Set<string> } | string {
  const values: Record<string, string> = {};
  const on = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.trim() === '') return `${a} の後に値を指定してください。`;
      values[a] = v.trim();
    } else if (switches.includes(a)) on.add(a);
    else return `指定できない引数です: ${a}`;
  }
  return { values, on };
}

// ---------------------------------------------------------------- online / offline

async function offline<T>(projectRoot: string, command: string, clock: Clock, o: OperatorCliOptions, fn: (d: OpsDeps, snapshot: ConfigSnapshot) => Promise<T>): Promise<T> {
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) throw new AppFailure(appError('CONFIG_INVALID', 'cli', clock, { details: { issues: loaded.issues } }));
  const snapshot = loaded.snapshot;
  const { settings } = snapshot;
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(
    paths,
    command,
    async () => {
      const mode = settings.mode;
      const logger = o.logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('cmd'), mode, clock });
      const queue = new SerialQueue();
      const store = await JobStore.open(paths, queue, clock);
      const control = await ControlStore.load(paths, queue, clock);
      const dedupe = await DedupeStore.load(paths, queue, clock);
      const history = await HistoryStore.load(paths, queue, clock, { mode, fullTextDays: historyFullTextDays(settings.retention), dedupe, logger });
      const schedules = new ScheduleStore(paths, queue, clock);
      // Only complete/release are used: slot bookkeeping of a verdict.
      const scheduler = new Scheduler({
        clock,
        schedules,
        jobs: store,
        control,
        getSchedule: () => snapshot.schedule,
        getSettings: () => settings,
        getConfigHash: () => snapshot.hash,
        isRouteAvailable: () => false,
        hasBlockingUnresolved: () => true,
        logger,
      });
      const bundles = new BundleMover({ paths, store, clock, logger });
      const d: OpsDeps = { mode, clock, logger, paths, store, bundles, control, stops: new StopRegistry(control, clock, logger), dedupe, history, scheduler, config: () => snapshot };
      return fn(d, snapshot);
    },
    o.lock,
  );
}

/**
 * The running tool answers through its API; otherwise the command runs offline under app.lock. A refusal (ApiError offline,
 * a verified 4xx online) prints its Japanese reason and exits 1; an answer that does not verify exits 2.
 */
export async function run(io: Io, projectRoot: string, online: (client: LocalApiClient) => Promise<number>, offlineRun: () => Promise<number>): Promise<number> {
  try {
    const client = await LocalApiClient.forProject(projectRoot);
    return client === null ? await offlineRun() : await online(client);
  } catch (err) {
    if (err instanceof ApiError || (err instanceof ApiCallError && err.kind === 'refused')) {
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

// ---------------------------------------------------------------- pause / resume

export async function pauseCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: OperatorCliOptions = {}): Promise<number> {
  const f = parseFlags(args, ['--reason'], []);
  const how = 'npm.cmd run pause -- --reason "理由"（--reason は省けます）';
  if (typeof f === 'string') return usage(io, f, how);
  const reason = f.values['--reason'];
  if (reason !== undefined && reason.length > 100) return usage(io, '理由は100文字以内にしてください。', how);
  const done = (note: string): number => {
    io.stdout(`一時停止しました。新しい投稿の送信を止めます（送信済みの投稿の照合は続けます）。${note}`);
    io.stdout('再開するときは npm.cmd run resume を実行してください。');
    return 0;
  };
  return run(
    io,
    projectRoot,
    async (client) => {
      await client.request('POST', '/v1/control/pause', reason === undefined ? {} : { reason });
      return done('');
    },
    () => offline(projectRoot, 'pause', clock, o, async (d) => (await pause(d, reason ?? '運用者が一時停止しました'), done('（ツールは止まっています。次に起動しても一時停止のままです）'))),
  );
}

/** The stops resume could not clear, then what else keeps posts from going out now (the running tool's view). */
function stopLines(stops: readonly StopDto[], others: readonly string[]): string[] {
  const lines = stops.length === 0 ? ['一時停止や停止はありません。'] : ['まだ送信を止めている理由:', ...stops.flatMap((s) => [`  - ${s.message}`, `    対処: ${s.remedy}`])];
  if (others.length > 0) lines.push('ほかの理由で、いまは送信しません（詳しくは npm.cmd run status）:', ...others.map((m) => `  - ${m}`));
  return lines;
}

export async function resumeCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: OperatorCliOptions = {}): Promise<number> {
  const f = parseFlags(args, [], ['--confirm-checked']);
  if (typeof f === 'string') return usage(io, f, 'npm.cmd run resume（二重登録の疑いで止まったときは、画面で確かめてから npm.cmd run resume -- --confirm-checked）');
  const confirm = f.on.has('--confirm-checked');
  const report = (r: { checking: boolean; pending_stops: readonly StopDto[]; notes: readonly string[] }, stops: readonly StopDto[], others: readonly string[] = []): number => {
    for (const n of r.notes) io.stdout(`【注意】${n}`);
    io.stdout(stopLines(stops, others).join('\n'));
    return stops.length === 0 ? 0 : 1;
  };
  return run(
    io,
    projectRoot,
    async (client) => {
      const r = ResumeResponseSchema.parse((await client.request('POST', '/v1/control/resume', { confirm_checked: confirm })).body);
      io.stdout('一時停止を解除しました。');
      if (r.checking) {
        io.stdout(CHECKING_JA);
        // The resume replaced any earlier result, so the first one that shows is this check's.
        const result = await waitPreflight(client, () => true, o.poll);
        io.stdout(result === null ? NOT_FINISHED_JA : preflightLines(result).join('\n'));
      }
      const dto = StatusDtoSchema.parse((await client.request('GET', '/v1/status')).body);
      const stops = r.checking ? dto.stops : r.pending_stops;
      // A salon stop's dispatch reason is its remedy, already listed with the stop.
      const others = dto.dispatch.post_allowed ? [] : dto.dispatch.reasons.map((x) => x.message_ja).filter((m) => !stops.some((s) => s.remedy === m));
      return report(r, stops, others);
    },
    () =>
      offline(projectRoot, 'resume', clock, o, async (d, snapshot) => {
        const now = clock.now();
        const r = await resume(d, {
          confirmChecked: confirm,
          effective: null,
          quota: (t) =>
            remainingQuota({
              limits: snapshot.deploymentChecks.posting_limits[t],
              now,
              oursPosted: oursPostedFrom(d.dedupe.records(), t),
              unresolved: unresolvedFrom(d.store.summaries(), t),
              excludeJobId: null,
              observed: null,
            }),
        });
        io.stdout('一時停止を解除しました（ツールは止まっています。起動すると投稿を再開します）。');
        return report(r, r.pending_stops);
      }),
  );
}

// ---------------------------------------------------------------- retry

/** Why AI work could not run now (so a retried job would only wait); null when it can (offline only, Plan 2). */
async function aiProblem(projectRoot: string, snapshot: ConfigSnapshot, paths: DataPaths, clock: Clock, base: OperatorCliOptions['env']): Promise<string | null> {
  const { settings } = snapshot;
  const { config } = await loadAiSetup(envDirOf(projectRoot, settings), settings.ai, base);
  const kind = providerKindFor(settings, settings.mode, config);
  if (kind === null) return 'AIの提供元が未設定です（.env の AI_<段階>_PROVIDER か settings.json の ai.provider に "gemini"（または "anthropic"・"openai"）を指定してください）。';
  if (kind === 'mock') return null;
  const first = config.issues[0];
  if (first !== undefined) return `AIの設定（${first.file} ${first.path}）に誤りがあります: ${first.message}`;
  const noKey = stageWithoutKey(config, settings.ai);
  if (noKey !== null) return `AIのAPIキーが見つかりません（.env に「${noKey.keyName ?? aiEnvKey(noKey.stage, 'API_KEY')}=キー」を書いてください）。`;
  const meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue: new SerialQueue(), getSettings: () => settings, clock });
  return (await meter.summary(clock.now())).blocked?.message ?? null;
}

const RESTART_JA: Record<Restart, string> = { analysis: '画像の解析から再開できるようにしました', generation: '文章の作成から再開できるようにしました', posting: '投稿待ちに戻しました（次の投稿枠で送信します）' };

export async function retryCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: OperatorCliOptions = {}): Promise<number> {
  const how = 'npm.cmd run retry -- --id job_id（job_id は status や images/failed のフォルダ名で確認できます）／ 引数なしの npm.cmd run retry は、送信前の一時的な失敗だけを投稿待ちに戻します';
  const f = parseFlags(args, ['--id'], []);
  if (typeof f === 'string') return usage(io, f.startsWith('--id') ? '--id の後に job_id を指定してください。' : `retry に${f}`, how);
  const id = f.values['--id'] ?? null;
  const print = (r: { requeued: readonly { job_id: string; reset_budget: boolean; restart: Restart }[]; excluded: readonly { reason_ja: string }[] }, running: boolean): number => {
    for (const q of r.requeued) {
      io.stdout(`${q.job_id} を${RESTART_JA[q.restart]}。`);
      if (q.reset_budget) io.stdout('  再試行の回数の上限に達していたため、回数を0に戻しました（記録に残します）。');
    }
    if (id === null) {
      io.stdout(`投稿待ちに戻した job: ${r.requeued.length}件`);
      const counts = new Map<string, number>();
      for (const e of r.excluded) counts.set(e.reason_ja, (counts.get(e.reason_ja) ?? 0) + 1);
      for (const [reason, n] of counts) io.stdout(`  対象外: ${reason} ${n}件`);
    }
    if (r.requeued.length > 0) io.stdout(running ? '動作中のツールが準備と投稿を進めます。' : 'ツールを起動すると（npm.cmd start）、この job の準備と投稿を進めます。');
    return 0;
  };
  return run(
    io,
    projectRoot,
    async (client) => print(RetryResponseSchema.parse((await client.request('POST', '/v1/retry', id === null ? {} : { job_id: id })).body), true),
    () =>
      offline(projectRoot, 'retry', clock, o, async (d, snapshot) => {
        const deps = { ...d, contentBlocked: () => aiProblem(projectRoot, snapshot, d.paths, clock, o.env) };
        return print(id === null ? await retryEligible(deps) : { requeued: [await retryOne(deps, id)], excluded: [] }, false);
      }),
  );
}

// ---------------------------------------------------------------- redraft

export async function redraftCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: OperatorCliOptions = {}): Promise<number> {
  const how = 'npm.cmd run redraft（投稿待ちの文章をすべて）／ -- --type style か blog（その種類だけ）／ -- --id job_id（1件だけ）／ -- --dry（対象の一覧だけ。何も変えません）';
  const f = parseFlags(args, ['--id', '--type'], ['--dry']);
  if (typeof f === 'string') return usage(io, f.startsWith('--') ? f : `redraft に${f}`, how);
  const type = f.values['--type'] ?? null;
  if (type !== null && !(POST_TYPES as readonly string[]).includes(type)) return usage(io, `--type は style か blog で指定してください: ${type}`, how);
  const req = { id: f.values['--id'] ?? null, type: type as PostType | null, dry: f.on.has('--dry') };
  const print = (r: RedraftResult, running: boolean): number => {
    const n = r.redrafted.length;
    const byType = POST_TYPES.map((t) => `${POST_TYPE_JA[t]} ${r.redrafted.filter((x) => x.post_type === t).length}件`).join(' / ');
    if (r.dry) {
      io.stdout(`作り直しの対象: ${n}件（${byType}）。--dry のため何も変えていません。`);
      for (const x of r.redrafted) io.stdout(`  ${x.job_id}（${POST_TYPE_JA[x.post_type]}）`);
      return 0;
    }
    io.stdout(`文章の作成に戻した job: ${n}件（${byType}）`);
    if (r.skipped.length > 0) io.stdout(`  直前に投稿に回されたなどで、そのままにした job: ${r.skipped.length}件`);
    if (n === 0) io.stdout('作り直せる投稿待ちの文章はありません（一度投稿に回されたもの・live:single に指定したものは作り直しません）。');
    else io.stdout(running ? '動作中のツールが、新しい文章の設定で裏で順に書き直します（AIの費用は1件につき文章の作成1回と検査1回です）。' : '次にツールを起動すると（npm.cmd start）、新しい文章の設定で書き直します（AIの費用は1件につき文章の作成1回と検査1回です）。');
    return 0;
  };
  return run(
    io,
    projectRoot,
    async (client) => {
      const body = { ...(req.id === null ? {} : { job_id: req.id }), ...(req.type === null ? {} : { post_type: req.type }), dry: req.dry };
      return print(RedraftResponseSchema.parse((await client.request('POST', '/v1/redraft', body)).body), true);
    },
    () => offline(projectRoot, 'redraft', clock, o, async (d, snapshot) => print(await redraft({ ...d, contentBlocked: () => aiProblem(projectRoot, snapshot, d.paths, clock, o.env) }, req), false)),
  );
}

// ---------------------------------------------------------------- reconcile

export async function reconcileCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: OperatorCliOptions = {}): Promise<number> {
  const how = [
    'npm.cmd run reconcile -- --id job_id --registered --basis "確認内容"',
    '  登録が無かったときは --registered の代わりに --not-registered。登録があったときは --at "YYYY-MM-DD HH:mm" と --url "投稿のURL" も足せます。',
    '  --registered も --not-registered も付けないと、自動照合を予約します。',
  ].join('\n');
  const f = parseFlags(args, ['--id', '--basis', '--at', '--url'], ['--registered', '--not-registered']);
  if (typeof f === 'string') return usage(io, f, how);
  const id = f.values['--id'];
  const verdict = f.on.has('--registered') ? 'registered' : f.on.has('--not-registered') ? 'not_registered' : undefined;
  const basis = f.values['--basis'];
  const at = f.values['--at'];
  const url = f.values['--url'];
  if (id === undefined) return usage(io, '--id で job_id を指定してください。', how);
  if (f.on.has('--registered') && f.on.has('--not-registered')) return usage(io, '--registered と --not-registered は一緒に指定できません。', how);
  if ((verdict === undefined) !== (basis === undefined)) return usage(io, verdict === undefined ? '--basis は --registered か --not-registered と一緒に指定してください。' : '画面で確認した内容を --basis "確認内容" で書いてください（200文字まで）。', how);
  if (basis !== undefined && basis.length > 200) return usage(io, '--basis は200文字以内にしてください。', how);
  if ((at !== undefined || url !== undefined) && verdict !== 'registered') return usage(io, '--at と --url は --registered と一緒に指定してください。', how);
  if (at !== undefined && !JstMinuteSchema.safeParse(at).success) return usage(io, `--at は "YYYY-MM-DD HH:mm"（日本時間）の形で指定してください: ${at}`, how);
  const req = { ...(verdict === undefined ? {} : { verdict, basis }), ...(at === undefined ? {} : { registered_at_jst: at }), ...(url === undefined ? {} : { remote_post_url: url }) };
  const print = (r: { status: number; body: unknown }, mode: string): number => {
    const dry = mode === 'dry_run' ? '（dry-run の擬似投稿についての記録です。SALON BOARD の確認は不要です）' : '';
    if (r.status === 202) io.stdout(`自動照合を予約しました（拡張機能が接続されていると数分で実行されます）。結果は npm.cmd run status で確認できます。`);
    else if (verdict === 'registered') io.stdout(`${id} を「登録あり」として記録しました（投稿済み）。${dry}`);
    else io.stdout(`${id} を「登録なし」として記録しました（失敗として保存し、本日の投稿数には数えません）。${dry}もう一度投稿するときは npm.cmd run retry -- --id ${id} を実行してください。`);
    return 0;
  };
  return run(
    io,
    projectRoot,
    async (client) => {
      const r = await client.request('POST', `/v1/jobs/${encodeURIComponent(id)}/reconcile`, req);
      const s = StatusDtoSchema.parse((await client.request('GET', '/v1/status')).body);
      return print(r, s.mode);
    },
    () =>
      offline(projectRoot, 'reconcile', clock, o, async (d) => {
        const r = await applyOperatorReconcile(d, id, req as Parameters<typeof applyOperatorReconcile>[2], false);
        if (r.status === 202) {
          io.stdout('自動照合を予約しました。ツールを起動して拡張機能が接続されると実行されます。');
          return 0;
        }
        return print(r, d.mode);
      }),
  );
}
