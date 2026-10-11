import { createHmac, randomBytes } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { parseEnvText } from '../config/env-file.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { errnoCode, readJsonFile, storageFailure, unlinkWithRetry, writeFileAtomic, writeJsonAtomic, type ReadResult } from '../storage/atomic-json.js';

// Keys of the local API (Plan 3 D1-1): the master secret in .env never leaves Node; a client key is derived from it per
// pairing; the CLI key is random per run and lives only in data/local-api.json while the process runs.

const MIN_SECRET_LENGTH = 43; // 32 bytes in base64url
/** A .env.lock older than this was left by a process that died while writing; it is taken over. */
const ENV_LOCK_STALE_MS = 30_000;
const ENV_LOCK_WAIT_MS = 15_000;

/**
 * Reads `<envDir>/.env` (the project root, or the shared root both copies use) for `envName` (the file only, not the
 * process environment). A missing line or an empty value (as copied from .env.example) is filled in place with 32 random
 * bytes, keeping every other line, the BOM and the line endings; a missing .env starts as a copy of the project's
 * .env.example (so its AI key lines are there for the owner). The value is never printed. Too short → CONFIG_INVALID.
 * Two copies may fill their own variables at the same moment: the write holds <envDir>/.env.lock and re-reads the file
 * just before its atomic write, so neither drops the other's line (or any other line).
 */
export async function ensureMasterSecret(projectRoot: string, envName: string, envDir: string = projectRoot): Promise<{ master: Uint8Array; created: boolean }> {
  const path = join(envDir, '.env');
  const existing = secretIn(await readEnvText(path, projectRoot), envName);
  if (existing !== null) return { master: existing, created: false };
  return withEnvLock(join(envDir, '.env.lock'), async () => {
    const text = await readEnvText(path, projectRoot);
    const again = secretIn(text, envName);
    if (again !== null) return { master: again, created: false };
    const secret = randomBytes(32).toString('base64url');
    await writeFileAtomic(path, withValue(text, envName, secret));
    return { master: Buffer.from(secret, 'utf8'), created: true };
  });
}

async function readEnvText(path: string, projectRoot: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw storageFailure(err, '.env ファイルの読み込み', path);
    return readFile(join(projectRoot, '.env.example'), 'utf8').catch(() => '');
  }
}

/** The line index and value of the variable's last line (-1 and '' when there is none). */
function findLine(lines: readonly string[], envName: string): { index: number; value: string } {
  let index = -1;
  let value = '';
  lines.forEach((raw, i) => {
    const entry = parseEnvText(raw).entries[0];
    if (entry?.key === envName) {
      index = i;
      value = entry.value;
    }
  });
  return { index, value };
}

/** The variable's value as the master secret; null when the line is missing or empty. Too short → CONFIG_INVALID. */
function secretIn(text: string, envName: string): Uint8Array | null {
  const { index, value } = findLine(text.split(/(?<=\n)/), envName);
  if (value === '') return null;
  if (value.length < MIN_SECRET_LENGTH) {
    const message = `${envName} が短すぎます。値を消して（${envName}= のまま）再起動すると作り直します`;
    throw new AppFailure(
      appError('CONFIG_INVALID', 'local_api', systemClock, { message, details: { issues: [{ file: '.env', path: `${index + 1}行目（${envName}）`, message }] } }),
    );
  }
  return Buffer.from(value, 'utf8');
}

/** `text` with the variable's line set to `secret` (in place, or appended); every other line is kept as it is. */
function withValue(text: string, envName: string, secret: string): string {
  const lines = text.split(/(?<=\n)/);
  const { index } = findLine(lines, envName);
  const eol = text === '' || text.includes('\r\n') ? '\r\n' : '\n';
  if (index >= 0) {
    const old = lines[index]!;
    lines[index] = `${old.startsWith('\uFEFF') ? '\uFEFF' : ''}${envName}=${secret}${/\r?\n$/.exec(old)?.[0] ?? ''}`;
  } else {
    lines.push(`${text === '' || text.endsWith('\n') ? '' : eol}${envName}=${secret}${eol}`);
  }
  return lines.join('');
}

/** Runs `fn` holding `lockPath` (created exclusively; a stale one is taken over). Always removes it afterwards. */
async function withEnvLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const until = Date.now() + ENV_LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw storageFailure(err, '.env の書き込みの準備', lockPath);
      const age = await stat(lockPath).then((st) => Date.now() - st.mtimeMs, () => 0);
      if (age > ENV_LOCK_STALE_MS) await removeStaleLock(lockPath);
      else if (Date.now() > until) throw storageFailure(err, '.env の書き込みの準備（ほかのツールが書き込み中のまま）', lockPath);
      else await delay(50 + Math.floor(Math.random() * 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Removes a stale lock under a takeover guard and only after checking its age again there, so a waiter acting on an
 * older look can never remove the fresh lock another copy has just taken. Guard busy: wait a moment and look again.
 */
async function removeStaleLock(lockPath: string): Promise<void> {
  const guard = `${lockPath}.takeover`;
  const ageOf = (path: string): Promise<number> => stat(path).then((st) => Date.now() - st.mtimeMs, () => 0);
  try {
    await (await open(guard, 'wx')).close();
  } catch {
    // shortcut: a guard left by a crash within its few milliseconds is removed by age, unguarded.
    if ((await ageOf(guard)) > ENV_LOCK_STALE_MS) await unlink(guard).catch(() => undefined);
    else await delay(50 + Math.floor(Math.random() * 100));
    return;
  }
  try {
    if ((await ageOf(lockPath)) > ENV_LOCK_STALE_MS) await unlink(lockPath).catch(() => undefined);
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}

/** K_c = HMAC-SHA256(master, "salon-ext-client|" + client_id): never stored; any id this master issued can be re-derived. */
export function clientKey(master: Uint8Array, clientId: string): Uint8Array {
  return createHmac('sha256', master).update(`salon-ext-client|${clientId}`).digest();
}

export const LocalApiFileSchema = z.strictObject({
  schema_version: z.literal(1),
  instance_id: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  data_root: z.string().min(1),
  started_at: isoUtc,
  /** base64url of the per-run CLI key. */
  cli_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type LocalApiFile = z.infer<typeof LocalApiFileSchema>;

export const writeLocalApiFile = (path: string, record: LocalApiFile): Promise<void> => writeJsonAtomic(path, record);

export const readLocalApiFile = (path: string): Promise<ReadResult<LocalApiFile>> => readJsonFile(path, LocalApiFileSchema);

/** Removes the file only while it is still this instance's (a newer start may have replaced it). */
export async function removeLocalApiFile(path: string, instanceId: string): Promise<void> {
  const current = await readLocalApiFile(path).catch(() => null);
  if (current?.kind === 'ok' && current.value.instance_id === instanceId) await unlinkWithRetry(path);
}
