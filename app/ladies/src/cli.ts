import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envUnreadableFailure, usesRealAi, type AiFactoryDeps } from './ai/factory.js';
import { loadAiSetup } from './ai/ai-setup.js';
import { aiSmokeCommand } from './ai/smoke-cli.js';
import { aiTestCommand } from './ai/ai-test-cli.js';
import { checksRecordCommand } from './cli/checks-record.js';
import { cleanupCommand, cleanupPreviewCommand } from './cli/cleanup.js';
import { pairCommand } from './cli/pair.js';
import { probeCommand } from './cli/probe.js';
import { surveyListCommand } from './cli/survey-list.js';
import { surveyShowCommand } from './cli/survey-show.js';
import { ApiCallError, LocalApiClient } from './server/client.js';
import { StatusDtoSchema } from './shared/protocol/status.js';
import { liveSingleCommand } from './cli/live-single.js';
import { preflightCommand, ROUTE_VALUES_JA } from './cli/preflight.js';
import { loadConfig, type ConfigIssue } from './config/loader.js';
import { CONFIG_FILES } from './config/schemas.js';
import { templatesImportCommand } from './content/templates-cli.js';
import { trendsRefreshCommand, trendsWebCommand } from './content/trends-cli.js';
import { missingDashHint, pauseCommand, reconcileCommand, redraftCommand, resumeCommand, retryCommand } from './cli/operator.js';
import { runOnce, startRuntime } from './runtime.js';
import type { CommandLockOptions } from './storage/command-lock.js';
import { historyRebuildCommand } from './storage/history-cli.js';
import { systemClock, type Clock } from './shared/clock.js';
import { AppFailure, errorText, type ErrorCode } from './shared/errors.js';
import { awakeNoteJa, keepAwake } from './keep-awake.js';
import { forPlatform } from './shared/platform-text.js';
import { formatJst } from './shared/time.js';
import { formatConfigIssue, formatStatusJa, readStatus, type ReadStatusResult } from './status.js';
import { envDirOf } from './storage/paths.js';

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface CliOptions {
  projectRoot?: string;
  clock?: Clock;
  /** `start` runs until this settles instead of until Ctrl+C / SIGTERM (tests). */
  untilStop?: Promise<unknown>;
  /** Replaces startRuntime for `start` (tests inject a runtime that fails after it has started). */
  startRuntime?: typeof startRuntime;
  /** `status`: whether the process a running record names still exists (tests); default: only ESRCH means gone. */
  isPidAlive?: (pid: number) => boolean;
  /** Maintenance commands: how app.lock is probed (tests). */
  lock?: CommandLockOptions;
  /** AI seams (tests): the environment .env is merged under, and a stubbed SDK client (no network). */
  ai?: { env?: Readonly<Record<string, string | undefined>>; createClient?: AiFactoryDeps['createClient'] };
}

/** Exit codes: 0 ok, 1 invalid config or input, 2 a startup prerequisite is missing (lock, damaged state), 3 unexpected. */
const EXIT = { ok: 0, input: 1, prerequisite: 2, unexpected: 3 } as const;
// Exit 2 is never a reason to start again by itself (spec 16.7: no restart loop for broken state or missing resources).
const PREREQUISITE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['LOCK_CONFLICT', 'STATE_CORRUPT', 'FILE_IO_ERROR', 'DISK_FULL', 'PORT_IN_USE', 'RESOURCE_MEMORY_HIGH', 'RESOURCE_DISK_LOW']);
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ALREADY_RUNNING_JA = 'ツールはすでに動作中です（起動.bat などの黒い画面）。2つ目は起動しません。いまの状態は npm.cmd run status で確認できます。';
const NOT_RUNNING_REASON_JA = 'ツールが起動していません（npm.cmd start で起動すると、投稿枠の時刻に送信します）。';

const USAGE = [
  '使い方（コマンドプロンプトでは npm.cmd の代わりに npm でも動きます）:',
  '  npm.cmd run config:validate                    設定ファイル（config フォルダ）を検査します',
  '  npm.cmd run dry-run -- --once                  dry-run を1回だけ実行します（時刻を決めるときは --at 2026-10-05T10:00:00+09:00 のように足します）',
  '  npm.cmd run status                             いまの状態を表示します（読み取りだけで、何も変更しません）',
  '  npm.cmd run templates:import                   テンプレートのExcelを読み取り、取込結果を表示します（Excelは変更しません）',
  '  npm.cmd run trends:refresh                     Google トレンドから書き出したCSV（references\\trends）を読み取り、取込結果を表示します（CSVは変更しません）',
  '  npm.cmd run trends:web                         投稿先URLのある方（メンズ・レディース）のトレンド語をAIのWeb検索で今すぐ調べます（動作中は毎週日曜に自動。1つにつきAIを1回使います）',
  '  npm.cmd run retry -- --id job_id               失敗した job を、失敗したところ（画像の解析・文章の作成・投稿）から再開できるようにします（job_id は status で確認できます）',
  '  npm.cmd run retry                              送信前の一時的な失敗（画像の添付・通信・画面の読み込み）の job をまとめて投稿待ちに戻します',
  '  npm.cmd run redraft                            投稿待ちの文章（まだ投稿に回していないもの）を、いまの文章の設定で書き直します（画像の解析はそのまま使います。--type style・--id job_id で絞り込み、--dry で対象の一覧だけ）',
  '  npm.cmd run pause -- --reason "理由"           新しい投稿の送信を一時停止します（照合は続けます。--reason は省けます）',
  '  npm.cmd run resume                             一時停止を解除し、送信を止めている理由を確認して解除します（必要なら画面を確認します。二重登録の疑いで止まったときは、画面で確かめてから -- --confirm-checked を足します）',
  '  npm.cmd run reconcile -- --id job_id --registered --basis "確認内容"  結果不明の投稿を、SALON BOARD の画面で確認した結果で記録します（登録が無かったときは --registered の代わりに --not-registered）',
  '  npm.cmd run history:rebuild                    投稿履歴（data/history.json）を投稿済みの job から作り直します',
  '  npm.cmd run cleanup:preview                    30日を過ぎた投稿済みデータの整理予定（件数・容量・整理しない理由）を表示します',
  '  npm.cmd run cleanup                            30日を過ぎた投稿済みデータ（このPCの画像・証跡・文章）を今すぐ整理します（動作中は24時間ごとに自動）',
  '  npm.cmd run ai:smoke -- "画像のパス"           本物のAIで1枚だけ解析・文章作成・検査を試します（数セントかかります。投稿はしません）',
  '  npm.cmd run ai:test                            .env のAIの設定で、各段階に小さな依頼を1回ずつ送って試します',
  '  npm.cmd start                                  常駐して画像の取込・準備・投稿枠の処理を続けます（Ctrl+C で停止）',
  '  npm.cmd run pair                               動作中のツールと拡張機能を接続し直すための接続コードを表示します',
  '  npm.cmd run survey:list                        拡張機能の「画面を調査」で保存した調査結果の一覧を表示します',
  '  npm.cmd run survey:show -- --file ファイル名   調査結果の中身を表示します（--approve を足すと開発担当が読めるようにします）',
  '  npm.cmd run probe -- --arm --yes               画像添付の確認（登録はしません）を10分間だけ受け付けます（ツールの動作中に、店舗の方が実行）',
  '  npm.cmd run checks:record -- show              本番投稿の前提（自動操作の可否・投稿数の上限・ログイン条件・接続先・画面の確認）の記録を表示します（記録はオーナーが行います）',
  '  npm.cmd run preflight -- --route style.mens    SALON BOARD の投稿画面を開いて確認だけします（入力も登録もしません。ツールの動作中に実行。設定済みの投稿先すべては --route configured）',
  '  npm.cmd run live:single -- --route style.mens  投稿先ごとの初回の本番投稿を1件だけ行います（まず --yes なしで内容を表示し、よければ --yes を付けて実行。job を選ぶときは --job job_id）',
  `    ${ROUTE_VALUES_JA}`,
  '  ※ templates:import・trends:refresh・trends:web・history:rebuild・ai:smoke・ai:test は、ツールを止めてから実行してください（動作中は実行しません）。',
  '  ※ pause・resume・retry・redraft・reconcile・cleanup:preview・cleanup は、ツールの動作中は動作中のツールに頼み、止まっていればそのまま実行します。',
].join('\n');

function usageError(io: CliIo, message: string): number {
  io.stderr(message);
  const hint = missingDashHint();
  if (hint !== null) io.stderr(hint);
  io.stderr(USAGE);
  return EXIT.input;
}

function printIssues(io: CliIo, heading: string, issues: readonly ConfigIssue[]): void {
  io.stderr(heading);
  for (const issue of issues) io.stderr(formatConfigIssue(issue));
}

function isConfigIssueList(value: unknown): value is ConfigIssue[] {
  return Array.isArray(value) && value.every((i) => typeof i === 'object' && i !== null && 'file' in i && 'path' in i && 'message' in i);
}

/** Maps a failure to its exit code and prints a Japanese explanation; `cannot` says what could not be done. */
function reportFailure(err: unknown, io: CliIo, cannot = '開始できません'): number {
  if (err instanceof AppFailure) {
    const { code, message, details_redacted } = err.error;
    if (code === 'CONFIG_INVALID' || code === 'CONFIG_INCOMPLETE') {
      const issues = details_redacted.issues;
      printIssues(io, `設定に誤りがあるため${cannot}（${code}）。次の箇所を直して保存してください:`, isConfigIssueList(issues) ? issues : [{ file: '設定', path: '', message }]);
      return EXIT.input;
    }
    if (PREREQUISITE_CODES.has(code)) {
      io.stderr(`${cannot}（${code}）: ${message}`);
      return EXIT.prerequisite;
    }
    io.stderr(`想定外のエラーで停止しました（${code}）: ${message} 詳しくは logs フォルダのログを確認してください。`);
    return EXIT.unexpected;
  }
  io.stderr(`想定外のエラーで停止しました: ${errorText(err)} 詳しくは logs フォルダのログを確認してください。`);
  return EXIT.unexpected;
}

async function validateCommand(projectRoot: string, io: CliIo, env: CliOptions['ai'] = {}): Promise<number> {
  const r = await loadConfig(join(projectRoot, 'config'));
  if (!r.ok) {
    printIssues(io, `設定ファイルに${r.issues.length}件の問題があります（1行に1件: ファイル 項目: 内容）:`, r.issues);
    return EXIT.input;
  }
  const { settings } = r.snapshot;
  const mode = settings.mode === 'dry_run' ? 'dry-run' : '本番（live）';
  // The .env AI lines too: the ones a real AI needs block the start, as they do at startup.
  const ai = await loadAiSetup(envDirOf(projectRoot, settings), settings.ai, env.env);
  const real = usesRealAi(settings, settings.mode, ai.config);
  if (real && ai.config.issues.length > 0) {
    printIssues(io, `.env のAIの設定に${ai.config.issues.length}件の誤りがあります（直すまで起動しません）:`, ai.config.issues);
    return EXIT.input;
  }
  if (real && ai.envFile === 'unreadable') {
    io.stderr(envUnreadableFailure().error.message);
    return EXIT.input;
  }
  io.stdout(`設定ファイル（${Object.keys(CONFIG_FILES).length}個）に問題はありません。モード: ${mode}`);
  const notes = [...(real ? [] : ai.config.issues), ...ai.config.warnings];
  for (const i of notes) io.stdout(`【注意】${formatConfigIssue(i)}`);
  if (!real && ai.config.issues.length > 0) io.stdout('（いまは本物のAIを呼ばない設定のため起動はできますが、本番や npm.cmd run ai:test の前に直してください）');
  if (!real && ai.envFile === 'unreadable') io.stdout('【注意】.env を読み取れませんでした（ほかのソフトで開いたままなどの可能性があります）。');
  return EXIT.ok;
}

async function statusCommand(projectRoot: string, io: CliIo, clock: Clock, isPidAlive: CliOptions['isPidAlive']): Promise<number> {
  let r: ReadStatusResult;
  try {
    r = await readStatus(projectRoot, clock, isPidAlive === undefined ? {} : { isPidAlive });
  } catch (err) {
    return reportFailure(err, io, '状態を表示できません');
  }
  if (!r.ok) {
    printIssues(io, '設定ファイルに誤りがあるため、状態を表示できません。次の箇所を直して保存してください:', r.issues);
    return EXIT.input;
  }
  // While the tool runs, its own view (gates, the extension now, warnings) replaces the one read from the files.
  let dto = r.status.dto;
  let note: string | null = null;
  try {
    const client = await LocalApiClient.forProject(projectRoot);
    if (client === null) dto = { ...dto, dispatch: { post_allowed: false, reasons: [{ code: 'NOT_RUNNING', message_ja: NOT_RUNNING_REASON_JA }, ...dto.dispatch.reasons] } };
    else dto = StatusDtoSchema.parse((await client.request('GET', '/v1/status')).body);
  } catch (err) {
    note = `動作中のツールから状態を受け取れませんでした（ファイルの記録から表示しています）: ${err instanceof ApiCallError ? err.message : errorText(err)}`;
  }
  io.stdout(formatStatusJa({ ...r.status, dto }));
  if (note !== null) io.stdout(note);
  return EXIT.ok;
}

async function dryRunCommand(projectRoot: string, args: string[], io: CliIo, clock: Clock): Promise<number> {
  let once = false;
  let at: Date | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once') {
      once = true;
    } else if (arg === '--at') {
      const value = args[++i];
      if (value === undefined || !ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
        return usageError(io, `--at には時差付きの日時を指定してください（例: 2026-10-05T10:00:00+09:00）: ${value ?? '(なし)'}`);
      }
      at = new Date(value);
    } else {
      return usageError(io, `dry-run に指定できない引数です: ${arg}`);
    }
  }
  if (!once) return usageError(io, 'dry-run は --once を付けて実行してください（常駐させる場合は npm.cmd start）。');
  const when = at ?? clock.now();
  const status = await runOnce({ projectRoot, at: when, echo: io.stdout });
  io.stdout(`dry-run を1回実行しました（基準時刻: ${formatJst(when)} 日本時間）。SALON BOARD には何も送信していません。`);
  io.stdout(formatStatusJa(status));
  return EXIT.ok;
}

function stopSignal(): { promise: Promise<unknown>; dispose: () => void } {
  let handler: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    handler = () => resolve();
  });
  // Kept installed until the stop has finished, so a second Ctrl+C does not cut the last item short.
  for (const s of STOP_SIGNALS) process.on(s, handler);
  return { promise, dispose: () => STOP_SIGNALS.forEach((s) => process.off(s, handler)) };
}

async function startCommand(projectRoot: string, io: CliIo, opts: CliOptions): Promise<number> {
  // Listening before the startup means a Ctrl+C during the startup recovery stops right after it, not in the middle.
  const signal = opts.untilStop === undefined ? stopSignal() : { promise: opts.untilStop, dispose: () => undefined };
  try {
    const handle = await (opts.startRuntime ?? startRuntime)({ projectRoot, clock: opts.clock ?? systemClock, echo: io.stdout });
    // Windows must not sleep by itself while the tool runs (a sleeping PC posts nothing); tests inject startRuntime.
    const awake = opts.startRuntime === undefined ? keepAwake() : { release: () => undefined };
    try {
      io.stdout(formatStatusJa(await handle.status()));
      // The code was printed before the status; repeated here so it is on screen (the popup's 「接続」 shows a new one).
      if (handle.pairingLine !== null) io.stdout(handle.pairingLine);
      io.stdout(`動作中です（${awakeNoteJa()}）。止めるには Ctrl+C を押すか、このウィンドウを×で閉じます。`);
      const crashed = handle.closed.then(
        () => null,
        (error: unknown) => ({ error }),
      );
      const outcome = await Promise.race([signal.promise.then(() => null), crashed]);
      if (outcome === null) io.stdout('停止しています。処理中の1件を終えるまでお待ちください…');
      await handle.stop();
      if (outcome !== null) return reportFailure(outcome.error, io, '動作を続けられません');
      io.stdout('停止しました。');
      return EXIT.ok;
    } catch (err) {
      // Never return with the loop still running and app.lock held; stop() may be called again.
      await handle.stop();
      throw err;
    } finally {
      awake.release();
    }
  } finally {
    signal.dispose();
  }
}

/** Runs one CLI command and returns its exit code; never calls process.exit. */
export async function main(argv: string[], io: CliIo, opts: CliOptions = {}): Promise<number> {
  const [command, ...args] = argv;
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const clock = opts.clock ?? systemClock;
  try {
    switch (command) {
      case 'config:validate':
      case 'status':
      case 'start':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        if (command === 'config:validate') return await validateCommand(projectRoot, io, opts.ai);
        if (command === 'status') return await statusCommand(projectRoot, io, clock, opts.isPidAlive);
        return await startCommand(projectRoot, io, opts);
      case 'templates:import':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await templatesImportCommand(projectRoot, io, clock, undefined, opts.lock);
      case 'trends:refresh':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await trendsRefreshCommand(projectRoot, io, clock, undefined, opts.lock);
      case 'trends:web':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await trendsWebCommand(projectRoot, io, clock, opts.lock);
      case 'history:rebuild':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await historyRebuildCommand(projectRoot, io, clock, opts.lock === undefined ? {} : { lock: opts.lock });
      case 'retry':
      case 'redraft':
      case 'pause':
      case 'resume':
      case 'reconcile': {
        const o = { ...(opts.lock === undefined ? {} : { lock: opts.lock }), ...(opts.ai?.env === undefined ? {} : { env: opts.ai.env }) };
        const run = { retry: retryCommand, redraft: redraftCommand, pause: pauseCommand, resume: resumeCommand, reconcile: reconcileCommand }[command];
        return await run(projectRoot, args, io, clock, o);
      }
      case 'cleanup:preview':
        return await cleanupPreviewCommand(projectRoot, args, io, clock, opts.lock === undefined ? {} : { lock: opts.lock });
      case 'cleanup':
        return await cleanupCommand(projectRoot, args, io, clock, opts.lock === undefined ? {} : { lock: opts.lock });
      case 'ai:smoke':
        return await aiSmokeCommand(projectRoot, args, io, clock, {
          ...(opts.lock === undefined ? {} : { lock: opts.lock }),
          ...(opts.ai?.env === undefined ? {} : { env: opts.ai.env }),
          ...(opts.ai?.createClient === undefined ? {} : { createClient: opts.ai.createClient }),
        });
      case 'ai:test':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await aiTestCommand(projectRoot, io, clock, {
          ...(opts.ai?.env === undefined ? {} : { env: opts.ai.env }),
          ...(opts.ai?.createClient === undefined ? {} : { createClient: opts.ai.createClient }),
        });
      case 'dry-run':
        return await dryRunCommand(projectRoot, args, io, clock);
      case 'pair':
        if (args.length > 0) return usageError(io, `${command} に指定できない引数です: ${args.join(' ')}`);
        return await pairCommand(projectRoot, io);
      case 'survey:list':
        return await surveyListCommand(projectRoot, args, io);
      case 'survey:show':
        return await surveyShowCommand(projectRoot, args, io, clock);
      case 'probe':
        return await probeCommand(projectRoot, args, io);
      case 'checks:record':
        return await checksRecordCommand(projectRoot, args, io, clock);
      case 'preflight':
        return await preflightCommand(projectRoot, args, io);
      case 'live:single':
        return await liveSingleCommand(projectRoot, args, io);
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return EXIT.ok;
      default:
        return usageError(io, command === undefined ? 'コマンドを指定してください。' : `不明なコマンドです: ${command}`);
    }
  } catch (err) {
    const starting = command === 'start' || command === 'dry-run';
    // The lock is the running tool itself (起動.bat or another start): no lock-file advice for the owner then.
    if (starting && err instanceof AppFailure && err.error.code === 'LOCK_CONFLICT' && (await LocalApiClient.forProject(projectRoot).catch(() => null)) !== null) {
      if (command === 'start') {
        io.stdout(ALREADY_RUNNING_JA);
        return EXIT.ok;
      }
      io.stderr('ツールが動作中のため、dry-run は実行しませんでした。動作中のツールを止めてから（黒い画面で Ctrl+C）、もう一度実行してください。');
      return EXIT.prerequisite;
    }
    return reportFailure(err, io, starting ? undefined : '実行できません');
  }
}

/** The folder holding package.json and config/, found upward from this file (src/ or dist/src/); else the cwd. */
export function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'config'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Whether the module at `moduleUrl` is the script node was started with. */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  // Node exits 1 on a crash, which the launcher would read as a config error; a crash is unexpected (3) and restarted.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`想定外のエラーで停止しました: ${errorText(err)} 詳しくは logs フォルダのログを確認してください。\n`);
    process.exit(EXIT.unexpected);
  });
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(`${forPlatform(s)}\n`),
    stderr: (s) => process.stderr.write(`${forPlatform(s)}\n`),
  });
}
