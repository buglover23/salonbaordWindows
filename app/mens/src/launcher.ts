import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, posix, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { aiEnvKey } from './ai/ai-config.js';
import { loadAiSetup, stageWithoutKey } from './ai/ai-setup.js';
import { usesRealAi } from './ai/factory.js';
import { findProjectRoot, isEntryPoint, main as cli, type CliIo } from './cli.js';
import { loadConfig } from './config/loader.js';
import type { Settings } from './config/schemas.js';
import { createFileLogger } from './logger.js';
import { LocalApiClient } from './server/client.js';
import { portInUse } from './server/http-server.js';
import { systemClock } from './shared/clock.js';
import { AppFailure, errorText } from './shared/errors.js';
import { newId } from './shared/ids.js';
import { AUDIENCE_JA, extensionSide } from './shared/labels.js';
import { forPlatform } from './shared/platform-text.js';
import { StatusDtoSchema, type StatusBody } from './shared/protocol/status.js';
import { DRY_RUN_JA } from './posting/gates.js';
import { acquireAppLock, type AppLock } from './storage/app-lock.js';
import type { CommandLockOptions } from './storage/command-lock.js';
import type { AudienceCategory } from './shared/types.js';
import { envDirOf, resolveDataPaths, sharedRootOf } from './storage/paths.js';

// The 起動.bat launcher (spec 16.7, Plan 4 decision 2): prerequisite checks, one launcher and one tool at a time, the
// tool (`cli.js start`) run as a supervised child with bounded restarts, a short Japanese banner and an optional Chrome
// window. It never kills another process, never changes settings (mode stays as configured) and never prints secrets.

export const RESTART_DELAY_MS = 10_000;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** How long the banner waits for the tool's local API after a (re)start. */
const UP_TIMEOUT_MS = 180_000;
const PROFILE_DIRECTORY = /^[A-Za-z0-9 _-]{1,64}$/;
const RULE = '――――――――――――――――――――――――――――――――';

export interface LauncherOptions {
  projectRoot: string;
  io: CliIo;
  /** Default process.versions.node (tests). */
  nodeVersion?: string;
  /** The environment .env is merged under for the AI key check (tests; default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Starts the tool once; default `node dist/src/cli.js start` sharing this console. Resolves with its exit code. */
  runTool?: () => { exited: Promise<number | null> };
  /** Default: spawns Chrome detached, without a console. */
  openChrome?: (path: string, args: string[]) => Promise<void>;
  /** The wait before a restart (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Real time in ms for the restart window (tests). */
  now?: () => number;
  /** Settles on Ctrl+C (tests; default the process signals). */
  untilStop?: Promise<unknown>;
  lock?: CommandLockOptions;
  /** The port checked for PORT_IN_USE (tests; default settings.server.port, 3001 unless a second copy uses another). */
  port?: number;
  /** Interval of the local API check for the banner (tests). */
  pollMs?: number;
}

/** package.json engines: >=24.11.0 <25. */
export function nodeVersionOk(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major === 24 && (minor ?? 0) >= 11;
}

/** What `open_chrome: "auto"` needs besides the launcher settings. */
export interface ChromeAuto {
  /** settings.server.allowed_extension_ids[0]: the Chrome profile that has this extension is the one to open. */
  extensionId: string | null;
  /** SALON BOARD's top page (the first allowed origin), or null. */
  url: string | null;
  audiences: readonly AudienceCategory[] | null;
  /** ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA, or HOME on a Mac (tests; default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default process.platform (tests). */
  platform?: NodeJS.Platform;
}

/** Google Chrome.app for all users, then for this user (macOS), or null. */
export function findChromeApp(home: string | undefined, exists: (path: string) => boolean = existsSync): string | null {
  return ['/Applications', ...(home === undefined || home === '' ? [] : [posix.join(home, 'Applications')])].map((dir) => posix.join(dir, 'Google Chrome.app')).find((p) => exists(p)) ?? null;
}

/** chrome.exe in the usual install folders (for all users, then for this user), or null. */
export function findChromeExe(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): string | null {
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    const path = base === undefined || base === '' ? null : join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (path !== null && exists(path)) return path;
  }
  return null;
}

const jsonAt = (file: string, ...keys: string[]): unknown => {
  try {
    return keys.reduce<unknown>((v, k) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined), JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
};

/**
 * The Chrome profile folders under `userData` whose Preferences or Secure Preferences list the extension (read only),
 * each with its display name from Local State (never the account's e-mail address: the folder name instead).
 */
export function chromeProfilesWith(userData: string, extensionId: string): { dir: string; name: string }[] {
  let dirs: string[];
  try {
    dirs = readdirSync(userData, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return dirs
    .filter((dir) => ['Preferences', 'Secure Preferences'].some((f) => jsonAt(join(userData, dir, f), 'extensions', 'settings', extensionId) !== undefined))
    .map((dir) => {
      const name = jsonAt(join(userData, 'Local State'), 'profile', 'info_cache', dir, 'name');
      return { dir, name: typeof name === 'string' && name.trim() !== '' && !name.includes('@') ? name : dir };
    });
}

/** What the launcher does about Chrome: nothing (null), open it, or explain why it does not. */
export function chromeLaunch(
  l: Settings['launcher'],
  exists: (path: string) => boolean = existsSync,
  auto: ChromeAuto = { extensionId: null, url: null, audiences: null },
): { path: string; args: string[] } | { note: string } | null {
  if (l.open_chrome === false) return null;
  const how = 'Chrome はご自分で開いてください（自動で開くには、config\\settings.json の launcher.chrome_path に Chrome の場所を書きます。例: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）。';
  const isAuto = l.open_chrome === 'auto';
  const env = auto.env ?? process.env;
  // macOS ("auto" only): Google Chrome.app, opened through /usr/bin/open with the same profile choice.
  const mac = isAuto && l.chrome_path === null && (auto.platform ?? process.platform) === 'darwin';
  const path = l.chrome_path ?? (isAuto ? (mac ? findChromeApp(env.HOME, exists) : findChromeExe(env, exists)) : null);
  if (path === null && mac) return { note: 'Google Chrome が見つかりません（アプリケーション フォルダに入れてください）。Chrome はご自分で開いてください。' };
  if (path === null) return { note: isAuto ? `Chrome（chrome.exe）が見つかりません。${how}` : `Chrome を自動で開く設定（launcher.chrome_path）がまだ空です。${how}` };
  if (!mac && !isAbsolute(path)) return { note: `launcher.chrome_path は C:\\ などから始まる場所で書いてください。${how}` };
  if (!mac && basename(path).toLowerCase() !== 'chrome.exe') return { note: `launcher.chrome_path には chrome.exe の場所を書いてください（ほかのプログラムは開きません）。${how}` };
  if (!exists(path)) return { note: `launcher.chrome_path の場所に Chrome が見つかりません: ${path} ${how}` };
  const launch = (args: string[]): { path: string; args: string[] } => (mac ? { path: '/usr/bin/open', args: ['-na', path, '--args', ...args] } : { path, args });
  const profile = l.chrome_profile_directory;
  if (profile !== null && !PROFILE_DIRECTORY.test(profile)) {
    return { note: 'launcher.chrome_profile_directory には、Chrome のプロファイルのフォルダ名（例: Default、Profile 1）だけを書いてください。Chrome はご自分で開いてください。' };
  }
  const url = isAuto && auto.url !== null ? [auto.url] : [];
  if (!isAuto || profile !== null) return launch([...(profile === null ? [] : [`--profile-directory=${profile}`]), ...url]);
  // "auto": the one Chrome profile that has this copy's extension.
  const side = extensionSide(auto.audiences);
  const which = side === null ? '拡張機能（サロン投稿アシスタント）' : `（${AUDIENCE_JA[side]}）の拡張機能`;
  const base = mac ? env.HOME : env.LOCALAPPDATA;
  const userData = base === undefined || base === '' ? null : mac ? posix.join(base, 'Library', 'Application Support', 'Google', 'Chrome') : join(base, 'Google', 'Chrome', 'User Data');
  const found = auto.extensionId === null || userData === null ? [] : chromeProfilesWith(userData, auto.extensionId);
  if (found.length === 0) {
    return { note: `${which}が入った Chrome が見つかりません。${side === null ? 'SALON BOARD に' : `${AUDIENCE_JA[side]}で`}ログインした Chrome に入れてください（Chrome はご自分で開いてください）。` };
  }
  if (found.length > 1) {
    const names = found.map((f) => `「${f.name}」`).join('');
    return { note: `${which}が入った Chrome が${found.length}つあります（${names}）。どれを開くか決められないため、Chrome は開きません。1つの Chrome だけに入れてください（または launcher.chrome_profile_directory にフォルダ名を書きます）。` };
  }
  return launch([`--profile-directory=${found[0]!.dir}`, ...url]);
}

/** The short banner of spec 16.7-7: mode, next post, connection and stop reasons, how to stop. */
export function bannerLines(dto: StatusBody): string[] {
  const next = (t: 'style' | 'blog'): string => dto.per_type[t].next_at_jst ?? '本日の予定なし（投稿時間外は待機します）';
  const ext = dto.extension;
  const connection = ext.connected
    ? `接続中${ext.logged_in === false ? '（SALON BOARD にログインしてください）' : ''}`
    : ext.paired
      ? '未接続（Chrome と拡張機能が動いていれば、30秒ほどでつながります）'
      : '未接続（この画面に出た「拡張機能の接続コード」を、拡張機能のポップアップで「接続」を押して入力します。5分を過ぎたら「接続」を押すと、新しいコードがこの画面に出ます）';
  // dry-run pseudo-posts by itself: its reasons are those of real posting, to fix before going live.
  const head = dto.mode === 'live' ? '送信を止めている理由' : '本番にしたときに送信を止める理由';
  const listed = dto.dispatch.reasons.filter((r) => r.message_ja !== DRY_RUN_JA);
  const reasons = dto.dispatch.post_allowed || listed.length === 0 ? [`${head}: なし`] : [`${head}:`, ...listed.map((r) => `  ・${r.message_ja}`)];
  return [
    RULE,
    `稼働モード: ${dto.mode === 'live' ? '本番（SALON BOARD へ投稿します）' : 'dry-run（テスト運転。SALON BOARD には投稿しません）'}`,
    `次回投稿: スタイル ${next('style')} ／ ブログ ${next('blog')}`,
    `拡張機能: ${connection}`,
    ...reasons,
    '止めるには: このウィンドウで Ctrl+C を押すか、×で閉じます（投稿の途中だった1件は、次に起動したときに自動で確かめます）。',
    RULE,
  ];
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(true));
    s.listen(port, '127.0.0.1', () => s.close(() => done(false)));
  });
}

function stopSignal(): { promise: Promise<unknown>; dispose: () => void } {
  let handler: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (handler = () => resolve()));
  // The tool shares this console, so it gets the same Ctrl+C and stops itself; the launcher only waits for it.
  for (const s of STOP_SIGNALS) process.on(s, handler);
  return { promise, dispose: () => STOP_SIGNALS.forEach((s) => process.off(s, handler)) };
}

function defaultRunTool(projectRoot: string): () => { exited: Promise<number | null> } {
  return () => ({
    exited: new Promise((done) => {
      const child = spawn(process.execPath, [join(projectRoot, 'dist', 'src', 'cli.js'), 'start'], { cwd: projectRoot, stdio: 'inherit' });
      child.once('error', () => done(null));
      child.once('exit', (code) => done(code));
    }),
  });
}

const defaultOpenChrome = (path: string, args: string[]): Promise<void> =>
  new Promise((done, fail) => {
    // No debugging port, no copied profile or cookies: an ordinary Chrome window of the owner's own profile.
    const child = spawn(path, args, { detached: true, stdio: 'ignore' });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      done();
    });
  });

async function writable(dir: string): Promise<boolean> {
  const probe = join(dir, `.write-check-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

export async function runLauncher(o: LauncherOptions): Promise<number> {
  const { io, projectRoot } = o;
  io.stdout('SALON BOARD 自動投稿ツールを起動します。');
  const version = o.nodeVersion ?? process.versions.node;
  if (!nodeVersionOk(version)) {
    io.stderr(`Node.js のバージョンが合いません（いま: v${version}、必要: 24 系の 24.11 以上）。README の「必要なもの」を見て Node.js 24 LTS を入れてから、もう一度起動してください。`);
    return 2;
  }
  if (!existsSync(join(projectRoot, 'dist', 'src', 'cli.js'))) {
    io.stderr('プログラムが組み立てられていません。README の「初回の手順」の npm.cmd ci と npm.cmd run build を済ませてから、もう一度起動してください。');
    return 2;
  }
  // The config and the .env AI lines a real AI needs (key present; values are never printed).
  const valid = await cli(['config:validate'], io, { projectRoot, ...(o.env === undefined ? {} : { ai: { env: o.env } }) });
  if (valid !== 0) return valid;
  const r = await loadConfig(join(projectRoot, 'config'));
  if (!r.ok) return 1;
  const settings = r.snapshot.settings;
  const ai = await loadAiSetup(envDirOf(projectRoot, settings), settings.ai, o.env);
  const noKey = usesRealAi(settings, settings.mode, ai.config) ? stageWithoutKey(ai.config, settings.ai) : null;
  if (noKey !== null) {
    const keyEnv = noKey.keyName ?? aiEnvKey(noKey.stage, 'API_KEY');
    const shared = sharedRootOf(projectRoot, settings);
    const where = shared === null ? 'このツールのフォルダの .env' : `共通の .env（${join(shared, '.env')}）`;
    io.stderr(`AIのAPIキーが見つかりません。${where} に「${keyEnv}=」に続けてキーを書いてから、もう一度起動してください（README の「AI の設定」。キーは画面やログには表示しません）。`);
    return 1;
  }
  const dataDir = join(resolve(projectRoot, settings.data_root), 'data');
  if (!(await writable(dataDir))) {
    io.stderr(`データの保存先に書き込めません（${dataDir}）。フォルダが読み取り専用になっていないか、同期中（OneDrive など）でないかを確かめてから、もう一度起動してください。`);
    return 2;
  }

  let lock: AppLock;
  try {
    lock = await acquireAppLock({ lockFile: join(dataDir, 'launcher.lock'), instanceId: newId('launcher'), ...o.lock });
  } catch (err) {
    if (err instanceof AppFailure && err.error.code === 'LOCK_CONFLICT') {
      io.stdout('起動.bat はすでに別のウィンドウで動いています。そちらのウィンドウを見てください（このウィンドウは閉じてかまいません）。');
      return 0;
    }
    io.stderr(`起動できません: ${errorText(err)}`);
    return 2;
  }
  try {
    if ((await LocalApiClient.forProject(projectRoot).catch(() => null)) !== null) {
      io.stdout('ツールはすでに動作中です。2つ目は起動しません。いまの状態は次のとおりです。');
      await cli(['status'], io, { projectRoot });
      return 0;
    }
    const port = o.port ?? settings.server.port;
    if (await portBusy(port)) {
      io.stderr(`開始できません（PORT_IN_USE）: ${portInUse(port).message} そのアプリは終了させません。使っているアプリを閉じるか、開発担当に相談してください。`);
      return 2;
    }
    const origin = r.snapshot.salonboardFields.allowed_origins[0];
    const auto: ChromeAuto = {
      extensionId: settings.server.allowed_extension_ids[0] ?? null,
      url: origin === undefined ? null : `${origin}/`,
      audiences: settings.audiences,
      ...(o.env === undefined ? {} : { env: o.env }),
    };
    return await supervise(o, settings, auto);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function supervise(o: LauncherOptions, settings: Settings, auto: ChromeAuto): Promise<number> {
  const { io } = o;
  const { restart_limit: limit, restart_window_minutes: windowMinutes } = settings.launcher;
  const signal = o.untilStop === undefined ? stopSignal() : { promise: o.untilStop, dispose: () => undefined };
  let stopping = false;
  void signal.promise.then(() => (stopping = true));
  const runTool = o.runTool ?? defaultRunTool(o.projectRoot);
  const now = o.now ?? Date.now;
  const restarts: number[] = [];
  const chrome = { opened: false, auto };
  try {
    for (;;) {
      const { exited } = runTool();
      await announce(o, settings, exited, chrome);
      const code = await exited;
      // The tool itself has said 「停止しました。」.
      if (code === 0) return 0;
      if (stopping) {
        io.stderr(`ツールは終了コード ${code ?? '不明'} で止まりました（停止の操作の後なので、起動し直しません）。`);
        return code ?? 3;
      }
      if (code === 1) {
        // A process ended from outside (Task Manager) also exits 1; either way a restart would not help.
        io.stderr('設定に誤りがあるか、ツールがほかから終了させられたため止まりました（自動では起動し直しません）。設定の誤りなら、上に表示された箇所を直してから、もう一度 起動.bat をダブルクリックしてください。');
        return 1;
      }
      if (code === 2) {
        io.stderr('起動の前提が足りないか、データを守るために止まりました（上の表示を確認してください。自動では起動し直しません）。');
        return 2;
      }
      const at = now();
      while (restarts.length > 0 && restarts[0]! <= at - windowMinutes * 60_000) restarts.shift();
      if (restarts.length >= limit) {
        io.stderr(
          `ツールが予期せず終了しました（終了コード ${code ?? '不明'}）。${windowMinutes}分の間に${limit}回を超えたため、自動での起動し直しをやめました。logs フォルダのログを確認し、原因を直してから 起動.bat をもう一度ダブルクリックしてください。`,
        );
        return 3;
      }
      io.stderr(`ツールが予期せず終了しました（終了コード ${code ?? '不明'}）。${RESTART_DELAY_MS / 1000}秒後に起動し直します（${windowMinutes}分の間に${limit}回まで。${restarts.length + 1}回目）。`);
      const stopped = await Promise.race([(o.sleep ?? delay)(RESTART_DELAY_MS).then(() => false), signal.promise.then(() => true)]);
      if (stopped) {
        io.stdout('起動し直さずに終了します。');
        return 0;
      }
      restarts.push(at);
    }
  } finally {
    signal.dispose();
  }
}

/** Once the tool's local API answers: the banner, then Chrome (once per launcher run). Gives up when the tool exits. */
async function announce(o: LauncherOptions, settings: Settings, exited: Promise<unknown>, chrome: { opened: boolean; auto: ChromeAuto }): Promise<void> {
  let ended = false;
  void exited.then(() => (ended = true));
  const pollMs = o.pollMs ?? 2000;
  for (let waited = 0; !ended && waited < UP_TIMEOUT_MS; waited += pollMs) {
    const client = await LocalApiClient.forProject(o.projectRoot).catch(() => null);
    if (client !== null) {
      const dto = await client
        .request('GET', '/v1/status')
        .then((r) => StatusDtoSchema.parse(r.body))
        .catch(() => null);
      if (dto !== null) {
        for (const line of bannerLines(dto)) o.io.stdout(line);
        if (!chrome.opened) {
          chrome.opened = true;
          await openChrome(o, settings, chrome.auto);
        }
        return;
      }
    }
    await Promise.race([delay(pollMs), exited]);
  }
}

/** Chrome never stops the tool: every problem is a note in this window and in the log. */
async function openChrome(o: LauncherOptions, settings: Settings, auto: ChromeAuto): Promise<void> {
  const warn = (note: string): void => {
    o.io.stdout(note);
    const logsDir = resolveDataPaths(o.projectRoot, settings).logsDir;
    createFileLogger({ logsDir, level: settings.logs.level, instanceId: newId('launcher'), mode: settings.mode, clock: systemClock }).warn('CHROME_NOT_OPENED', note);
  };
  try {
    const plan = chromeLaunch(settings.launcher, existsSync, auto);
    if (plan === null) return;
    if ('note' in plan) return warn(plan.note);
    await (o.openChrome ?? defaultOpenChrome)(plan.path, plan.args);
    o.io.stdout('Chrome を開きました。SALON BOARD にログインしていなければ、ご自分でログインしてください。');
  } catch (err) {
    warn(`Chrome を開けませんでした（${errorText(err)}）。Chrome はご自分で開いてください。`);
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runLauncher({
    projectRoot: findProjectRoot(),
    io: { stdout: (s) => process.stdout.write(`${forPlatform(s)}\n`), stderr: (s) => process.stderr.write(`${forPlatform(s)}\n`) },
  });
}
