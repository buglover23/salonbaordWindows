import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunFile } from '../storage/app-lock.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// P3-R43: whether other Windows users may change the project, config\, .env or data\. A warning only (never blocking,
// nothing is changed); icacls is run by absolute path so a planted icacls.exe elsewhere is never used.

const SHARED_WRITE = /(?:^|[\\\s])(?:Authenticated Users|Users|Everyone):((?:\([A-Z,]+\))+)/gim;
const WRITE_RIGHTS = new Set(['F', 'M', 'W', 'WD', 'AD']);

export const ACL_WARNING_JA = 'このフォルダは、このPCの他のユーザーも書き換えられる設定になっています。README の「安全のための設定」を確認してください。';
export const ACL_UNKNOWN_JA = 'フォルダのアクセス権を確認できませんでした（README の「安全のための設定」を確認してください）。';

const runDefault: RunFile = (file, args, options) => promisify(execFile)(file, [...args], options);

/** Japanese warnings for status: empty when only the owner (and the system) can write. */
export async function checkAcl(
  projectRoot: string,
  o: { env?: NodeJS.ProcessEnv; runFile?: RunFile; exists?: (path: string) => boolean; platform?: NodeJS.Platform; envDir?: string } = {},
): Promise<string[]> {
  if ((o.platform ?? process.platform) !== 'win32' && o.runFile === undefined) return [];
  const systemRoot = (o.env ?? process.env).SystemRoot;
  if (!systemRoot) return [ACL_UNKNOWN_JA];
  const icacls = `${systemRoot}\\System32\\icacls.exe`;
  const targets = [projectRoot, join(projectRoot, 'config'), join(o.envDir ?? projectRoot, '.env'), join(projectRoot, 'data')].filter(o.exists ?? existsSync);
  const shared: string[] = [];
  for (const target of targets) {
    let out: string;
    try {
      out = (await (o.runFile ?? runDefault)(icacls, [target], { timeout: 15_000, windowsHide: true })).stdout;
    } catch {
      return [ACL_UNKNOWN_JA];
    }
    const writable = [...out.matchAll(SHARED_WRITE)].some((m) => [...m[1]!.matchAll(/\(([A-Z,]+)\)/g)].some((r) => r[1]!.split(',').some((right) => WRITE_RIGHTS.has(right))));
    if (writable) shared.push(target);
  }
  return shared.length === 0 ? [] : [`${ACL_WARNING_JA}（対象: ${shared.join('、')}）`];
}
