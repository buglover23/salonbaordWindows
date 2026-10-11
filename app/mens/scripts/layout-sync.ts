import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { sharedRootOf } from '../src/storage/paths.js';

// The shared layout's top folder (settings.shared_root, e.g. C:\自動投稿サロンボード with app\mens and
// app\ladies inside): copies the repository's layout\起動.bat, 使い方.txt and layout\Mac用に書き出す.bat there when they
// differ. Nothing else in the top folder is ever touched (.env, images, 設定, トレンド語).

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Repository file → name in the top folder. */
export const LAYOUT_FILES: readonly (readonly [string, string])[] = [
  ['layout/起動.bat', '起動.bat'],
  ['使い方.txt', '使い方.txt'],
  ['layout/Mac用に書き出す.bat', 'Mac用に書き出す.bat'],
];

const bytesOf = (path: string): Promise<Buffer | null> => readFile(path).catch(() => null);

/** Copies each layout file to `sharedRoot` when its bytes differ (or it is missing); returns the names copied. */
export async function syncLayout(projectRoot: string, sharedRoot: string): Promise<string[]> {
  const copied: string[] = [];
  for (const [from, to] of LAYOUT_FILES) {
    const source = join(projectRoot, from);
    const target = join(sharedRoot, to);
    const want = await readFile(source);
    const have = await bytesOf(target);
    if (have !== null && have.equals(want)) continue;
    await copyFile(source, target);
    copied.push(to);
  }
  return copied;
}

/** The command: reads settings.shared_root from config\settings.json. 0 done, 1 not set up. */
export async function layoutSyncCommand(projectRoot: string, log: (line: string) => void): Promise<number> {
  const r = await loadConfig(join(projectRoot, 'config'));
  if (!r.ok) {
    log('設定ファイルに誤りがあるため、実行できません（npm.cmd run config:validate で確かめてください）。');
    return 1;
  }
  const shared = sharedRootOf(projectRoot, r.snapshot.settings);
  if (shared === null) {
    log('config\\settings.json の shared_root が未設定です（共通のフォルダを使うときは "shared_root": "../.." と書きます）。');
    return 1;
  }
  // "." would overwrite this copy's own 起動.bat with the top-folder one.
  if (resolve(shared) === resolve(projectRoot)) {
    log('config\\settings.json の shared_root がこのツールのフォルダを指しています（共通のフォルダは "shared_root": "../.." にします）。何も写しません。');
    return 1;
  }
  const copied = await syncLayout(projectRoot, shared);
  log(copied.length === 0 ? `${shared} の ${LAYOUT_FILES.map(([, to]) => to).join('・')} は最新です。` : `${shared} に ${copied.join('・')} を書き込みました。`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  layoutSyncCommand(ROOT, (line) => console.log(line)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
