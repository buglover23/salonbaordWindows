import { execFile } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, writeSync } from 'node:fs';
import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, uptime } from 'node:os';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { AUDIENCE_JA } from '../src/shared/labels.js';
import { jstCompact } from '../src/shared/time.js';
import { defaultIsPidAlive, powershellPath } from '../src/storage/app-lock.js';
import { sharedRootOf } from '../src/storage/paths.js';

// Moving day (Windows → Mac): `npm.cmd run export:mac` in app\mens writes SalonBoard-Mac-YYYYMMDD-HHmm.zip with the top
// folder's owner files and both copies minus what the Mac rebuilds, then pauses both Windows copies so they never post
// again from here. `--check` only lists what would go in. The Windows files themselves are never changed.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const COPIES = ['mens', 'ladies'] as const;
type Copy = (typeof COPIES)[number];
const TOP = 'SalonBoard';
const RUNNING_REFUSAL = 'ツールが動いているため、書き出せません。メンズとレディースの黒い画面を2つとも ×で閉じてから、もう一度実行してください。';
export const PAUSE_REASON = 'Mac へ移したため（Windows からは投稿しません）';

/** Inside a copy ('/'-separated): rebuilt on the Mac, development only, or this PC's own state. */
const EXCLUDED = ['node_modules', 'dist', 'apps/extension/dist', 'apps/extension/dist-e2e', '.git', '.claude', 'dry-run', 'tests', 'docs'];
/** A running copy's files (data_root "."); their takeover and stale siblings too. */
const RUNNING_FILES = ['data/app.lock', 'data/launcher.lock', 'data/local-api.json'];
/** Already compressed: deflate level 0 (still the usual deflate + data descriptor that every unzip tool reads). */
const COMPRESSED = /\.(jpe?g|png|webp|heic|gif|zip|xlsx|gz)$/i;

export const excludedFromCopy = (rel: string): boolean =>
  EXCLUDED.some((e) => rel === e || rel.startsWith(`${e}/`)) || RUNNING_FILES.some((f) => rel === f || rel.startsWith(`${f}.`));

export interface Entry {
  /** The path inside the zip, '/'-separated; a directory ends with '/'. */
  name: string;
  source?: string;
  data?: Uint8Array;
  size: number;
  mtime: Date;
}

const isDir = (e: Entry): boolean => e.name.endsWith('/');
/** Unix permissions: the start files and the command run, the secrets file is the owner's only, everything else 0644. */
export const modeOf = (name: string): number =>
  name === `${TOP}/.env` ? 0o600 : name.endsWith('/') || name.endsWith('.command') || name === `${TOP}/bin/salonboard` ? 0o755 : 0o644;

class Plan {
  readonly entries: Entry[] = [];
  readonly #names = new Map<string, Entry>();

  has(name: string): boolean {
    return this.#names.has(name);
  }

  get(name: string): Entry | undefined {
    return this.#names.get(name);
  }

  add(e: Entry): void {
    const parent = e.name.slice(0, e.name.lastIndexOf('/', e.name.length - 2) + 1);
    if (parent !== '' && !this.#names.has(parent)) this.add({ name: parent, size: 0, mtime: e.mtime });
    if (this.#names.has(e.name)) return;
    this.#names.set(e.name, e);
    this.entries.push(e);
  }

  async file(name: string, source: string): Promise<void> {
    const s = await stat(source);
    // A zip date cannot be before 1980.
    this.add({ name, source, size: s.size, mtime: new Date(Math.max(s.mtimeMs, Date.UTC(1980, 1, 1))) });
  }

  /** Everything under `dir` (symlinks and junctions are skipped, never followed), empty folders included. */
  async tree(dir: string, name: string, skip: (rel: string) => boolean = () => false, rel = ''): Promise<void> {
    this.add({ name: `${name}/`, size: 0, mtime: new Date() });
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isSymbolicLink() || skip(r)) continue;
      if (d.isDirectory()) await this.tree(join(dir, d.name), `${name}/${d.name}`, skip, r);
      else if (d.isFile()) await this.file(`${name}/${d.name}`, join(dir, d.name));
    }
  }
}

const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
  try {
    const v: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The running-state files of the copies whose process is alive: a file written before the last boot cannot be, and an
 * unreadable one counts as running (the owner closes the windows; nothing is guessed away).
 */
export async function runningFiles(copyDirs: readonly string[], o: { isPidAlive?: (pid: number) => boolean; bootTimeMs?: number } = {}): Promise<string[]> {
  const alive = o.isPidAlive ?? defaultIsPidAlive;
  const boot = o.bootTimeMs ?? Date.now() - uptime() * 1000;
  const found: string[] = [];
  for (const dir of copyDirs) {
    for (const f of RUNNING_FILES) {
      const file = join(dir, ...f.split('/'));
      const s = await stat(file).catch(() => null);
      if (s === null || s.mtimeMs < boot - 60_000) continue;
      const pid = (await readJson(file))?.pid;
      if (typeof pid !== 'number' || alive(pid)) found.push(file);
    }
  }
  return found;
}

/** Builds the zip's entry list. The Windows files are only read; the zipped template_mapping.json may differ. */
export async function planExport(root: string, copies: readonly Copy[], o: { layoutDir: string; now: Date }): Promise<{ entries: Entry[]; notes: string[] }> {
  const plan = new Plan();
  const notes: string[] = [];
  await plan.file(`${TOP}/起動.command`, join(o.layoutDir, '起動.command'));
  await plan.file(`${TOP}/使い方.txt`, join(o.layoutDir, '使い方（Mac）.txt'));
  await plan.file(`${TOP}/bin/salonboard`, join(o.layoutDir, 'bin', 'salonboard'));
  if (existsSync(join(root, '.env'))) await plan.file(`${TOP}/.env`, join(root, '.env'));
  for (const dir of [['images', 'pending'], ['設定'], ['トレンド語']]) {
    if (existsSync(join(root, ...dir))) await plan.tree(join(root, ...dir), `${TOP}/${dir.join('/')}`);
  }
  for (const copy of copies) {
    const copyDir = join(root, 'app', copy);
    const prefix = `${TOP}/app/${copy}`;
    await plan.tree(copyDir, prefix, excludedFromCopy);
    await plan.file(`${prefix}/起動.command`, join(o.layoutDir, 'app', '起動.command'));
    const id = new TextEncoder().encode(`${o.now.toISOString()}\n`);
    plan.add({ name: `${prefix}/.package-id`, data: id, size: id.length, mtime: o.now });
    // Unpaired on the Mac (it overrides control.json's older copy), so each window prints a new code and 接続 works.
    const unpaired = new TextEncoder().encode(`${JSON.stringify({ schema_version: 1, paired_client: null }, null, 2)}\n`);
    const pairing = plan.get(`${prefix}/data/pairing.json`);
    if (pairing === undefined) plan.add({ name: `${prefix}/data/pairing.json`, data: unpaired, size: unpaired.length, mtime: o.now });
    else Object.assign(pairing, { source: undefined, data: unpaired, size: unpaired.length });
  }
  // The template workbook: a Windows path does not exist on the Mac, so the zipped mapping points at a copy in 設定.
  const copied = new Map<string, string>();
  for (const copy of copies) {
    const copyDir = join(root, 'app', copy);
    const mappingName = `${TOP}/app/${copy}/config/template_mapping.json`;
    const text = await readFile(join(copyDir, 'config', 'template_mapping.json'), 'utf8').catch(() => null);
    const filePath = text === null ? null : (JSON.parse(text) as { file_path?: unknown }).file_path;
    if (typeof filePath !== 'string') continue;
    const abs = resolve(copyDir, filePath);
    if (!existsSync(abs)) {
      notes.push(`${AUDIENCE_JA[copy]}のテンプレートの Excel が見つかりません（${abs}）。Mac では 設定 フォルダに置き、template_mapping.json の file_path を直してください。`);
      continue;
    }
    const rel = relative(root, abs);
    let name = `${TOP}/${rel.split(sep).join('/')}`;
    if (rel.startsWith('..') || isAbsolute(rel) || !plan.has(name)) {
      name = copied.get(abs) ?? (plan.has(`${TOP}/設定/${basename(abs)}`) ? `${TOP}/設定/${copy}-${basename(abs)}` : `${TOP}/設定/${basename(abs)}`);
      if (!copied.has(abs)) await plan.file(name, abs);
      copied.set(abs, name);
    }
    const macPath = posix.relative(`${TOP}/app/${copy}`, name);
    if (macPath === filePath) continue;
    // Only the file_path value changes, so the rest of the file keeps its layout.
    let rewritten = text!.replace(/("file_path"\s*:\s*)"(?:[^"\\]|\\.)*"/, (_m, key: string) => `${key}${JSON.stringify(macPath)}`);
    if ((JSON.parse(rewritten) as { file_path?: unknown }).file_path !== macPath) rewritten = `${JSON.stringify({ ...JSON.parse(text!), file_path: macPath }, null, 2)}\n`;
    const data = new TextEncoder().encode(rewritten);
    Object.assign(plan.get(mappingName)!, { source: undefined, data, size: data.length });
    notes.push(`${AUDIENCE_JA[copy]}のテンプレート: ${abs} → ${name}（Mac 用の template_mapping.json は "${macPath}"）`);
  }
  for (const copy of copies) {
    const trends = await readJson(join(root, 'app', copy, 'config', 'trends.json'));
    const sources = Array.isArray(trends?.sources) ? (trends.sources as { file_path?: unknown; enabled?: unknown }[]) : [];
    for (const s of sources) {
      if (s.enabled === true && typeof s.file_path === 'string' && isAbsolute(s.file_path)) {
        notes.push(`${AUDIENCE_JA[copy]}の trends.json に Windows の場所（${s.file_path}）があります。Mac では読めないため、書き直してください。`);
      }
    }
  }
  return { entries: plan.entries, notes };
}

/**
 * Streams the entries into `outFile` (one file in memory at a time, in chunks); returns its size. UTF-8 names get the
 * language-encoding flag from fflate; Unix permissions go in the external attributes (made by: Unix).
 * shortcut: no ZIP64, so the package must stay under 4 GB; use a ZIP64 writer if photos ever grow that large.
 */
export async function writeZip(entries: readonly Entry[], outFile: string): Promise<number> {
  const fd = openSync(outFile, 'w');
  let size = 0;
  let failure: Error | null = null;
  try {
    const zip = new Zip((err, chunk) => {
      if (err !== null) failure = err;
      else {
        writeSync(fd, chunk);
        size += chunk.length;
      }
    });
    for (const e of entries) {
      const file = isDir(e) ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: COMPRESSED.test(e.name) ? 0 : 6 });
      file.os = 3;
      file.attrs = ((((isDir(e) ? 0o040000 : 0o100000) | modeOf(e.name)) << 16) | (isDir(e) ? 0x10 : 0)) >>> 0;
      file.mtime = e.mtime;
      zip.add(file);
      if (e.data !== undefined) file.push(e.data, true);
      else {
        if (e.source !== undefined) for await (const chunk of createReadStream(e.source)) file.push(chunk as Buffer);
        file.push(new Uint8Array(0), true);
      }
      if (failure !== null) throw failure;
    }
    zip.end();
  } finally {
    closeSync(fd);
  }
  if (failure !== null) throw failure;
  return size;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The owner's Desktop (OneDrive may have moved it), else ~/Desktop, else the top folder. */
async function desktopOf(root: string): Promise<string> {
  if (process.platform === 'win32') {
    const dir = await new Promise<string>((done) =>
      execFile(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"],
        { timeout: 15_000, windowsHide: true },
        (err, stdout) => done(err === null ? stdout.trim() : ''),
      ),
    );
    if (dir !== '' && existsSync(dir)) return dir;
  }
  const home = join(homedir(), 'Desktop');
  return existsSync(home) ? home : root;
}

/** `pause` in that copy with its own program (offline: the copy is not running). */
const pauseCopyDefault = (copyDir: string): Promise<{ ok: boolean; output: string }> =>
  new Promise((done) =>
    execFile(process.execPath, [join(copyDir, 'dist', 'src', 'cli.js'), 'pause', '--reason', PAUSE_REASON], { cwd: copyDir, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) =>
      done({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
    ),
  );

export interface ExportMacOptions {
  args?: readonly string[];
  log: (line: string) => void;
  /** layout/mac of this repository (tests). */
  layoutDir?: string;
  now?: Date;
  /** Where the zip goes (tests; default the Desktop). */
  outDir?: string;
  isPidAlive?: (pid: number) => boolean;
  bootTimeMs?: number;
  pauseCopy?: (copyDir: string) => Promise<{ ok: boolean; output: string }>;
}

/** 0 done (or --check), 1 refused or failed. */
export async function exportMacCommand(projectRoot: string, o: ExportMacOptions): Promise<number> {
  const { log } = o;
  const check = (o.args ?? []).includes('--check');
  const settings = await readJson(join(projectRoot, 'config', 'settings.json'));
  const shared = typeof settings?.shared_root === 'string' ? sharedRootOf(projectRoot, { shared_root: settings.shared_root }) : null;
  if (shared === null) {
    log('config\\settings.json の shared_root が未設定のため、書き出せません（共通のフォルダ C:\\自動投稿サロンボード で使うときだけ書き出せます）。');
    return 1;
  }
  const root = resolve(shared);
  const copies = COPIES.filter((c) => existsSync(join(root, 'app', c, 'package.json')));
  if (copies.length === 0) {
    log(`${root} に app\\mens も app\\ladies も見つからないため、書き出せません。`);
    return 1;
  }
  for (const c of COPIES.filter((x) => !copies.includes(x))) log(`${AUDIENCE_JA[c]}のツール（app\\${c}）が無いため、${AUDIENCE_JA[c]}は書き出しません。`);
  for (const c of copies) {
    const s = await readJson(join(root, 'app', c, 'config', 'settings.json'));
    if (s?.data_root !== undefined && s.data_root !== '.') {
      log(`${AUDIENCE_JA[c]}の data_root が "." ではないため（投稿の記録が別の場所にあるため）、書き出せません。開発担当に相談してください。`);
      return 1;
    }
  }
  const running = await runningFiles(
    copies.map((c) => join(root, 'app', c)),
    o,
  );
  if (running.length > 0 && !check) {
    log(RUNNING_REFUSAL);
    for (const f of running) log(`  動いている印: ${f}`);
    return 1;
  }
  const now = o.now ?? new Date();
  const { entries, notes } = await planExport(root, copies, { layoutDir: o.layoutDir ?? join(ROOT, 'layout', 'mac'), now });
  const files = entries.filter((e) => !isDir(e));
  const total = files.reduce((n, e) => n + e.size, 0);

  if (check) {
    log(`書き出すもの（${root} から。まだ何も書き出していません）:`);
    const groups = new Map<string, { count: number; size: number }>();
    for (const e of files) {
      const key = e.name.split('/').slice(1, 4).join('/');
      const g = groups.get(key) ?? { count: 0, size: 0 };
      groups.set(key, { count: g.count + 1, size: g.size + e.size });
    }
    for (const [key, g] of groups) log(`  ${key}  ${g.count}件  ${mb(g.size)}`);
    log(`合計 ${files.length}件 ${mb(total)}（圧縮前）`);
    for (const n of notes) log(n);
    if (running.length > 0) log('（いまはツールが動いているため、本番の書き出しは断られます）');
    return 0;
  }

  const out = join(o.outDir ?? (await desktopOf(root)), `SalonBoard-Mac-${jstCompact(now).slice(0, 13)}.zip`);
  const partial = `${out}.partial`;
  log(`Mac 用に書き出しています（${files.length}件、${mb(total)}）…`);
  let size: number;
  try {
    size = await writeZip(entries, partial);
    // A copy started while the zip was written may have posted what the zip does not record.
    const late = await runningFiles(
      copies.map((c) => join(root, 'app', c)),
      o,
    );
    if (late.length > 0) {
      await unlink(partial).catch(() => undefined);
      log(RUNNING_REFUSAL);
      for (const f of late) log(`  動いている印: ${f}`);
      return 1;
    }
    await rename(partial, out);
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    log(`書き出せませんでした: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const n of notes) log(n);
  log(`書き出しました: ${out}（${mb(size)}）`);

  // Double-post protection: from now on only the Mac posts.
  let paused = true;
  for (const c of copies) {
    const r = await (o.pauseCopy ?? pauseCopyDefault)(join(root, 'app', c));
    if (r.ok) log(`${AUDIENCE_JA[c]}（Windows）を一時停止しました。`);
    else {
      paused = false;
      log(`【注意】${AUDIENCE_JA[c]}（Windows）を一時停止できませんでした。app\\${c} で npm.cmd run pause を実行してください。${r.output === '' ? '' : `\n${r.output}`}`);
    }
  }
  log('');
  log('次の手順:');
  log(' 1. この zip を USB メモリで MacBook に移します（AirDrop でも移せますが、最初に開くときの手順が増えます）。');
  log(' 2. Mac の Finder で zip をホーム（家のマークのフォルダ）に置き、ダブルクリックで展開します（ホーム > SalonBoard になります）。');
  log(' 3. SalonBoard フォルダの 起動.command を、右クリック >「開く」で開きます（くわしくは SalonBoard の 使い方.txt）。');
  log('    開けないとき（macOS 15 以降）は、システム設定 > プライバシーとセキュリティ の「このまま開く」を押します。');
  log('Mac と Windows のツールを同時に動かさないでください（二重に投稿されます）。');
  log('移すのをやめて Windows で続けるときは、app\\mens と app\\ladies で npm.cmd run resume を実行します。');
  return paused ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportMacCommand(ROOT, { args: process.argv.slice(2), log: (line) => console.log(line) }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
