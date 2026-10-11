import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { issueSummary } from '../shared/zod-helpers.js';

/** The fs/promises functions this module calls; tests pass a wrapper that injects failures. */
export type FsLike = Pick<typeof fsp, 'open' | 'rename' | 'unlink' | 'mkdir' | 'readFile'>;

export type ReadResult<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'corrupt'; reason: string };

export interface RetryOptions {
  /** Replaces the real wait between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Waits before each retry of a transient error; the first attempt plus these 5 retries = 6 attempts at most. */
export const FS_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

// Windows reports a file held open by antivirus, the search indexer or OneDrive as one of these; they clear on their own.
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

const defaultSleep = (ms: number): Promise<void> => delay(ms);

export function errnoCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function describeCause(err: unknown): string {
  return errnoCode(err) ?? (err instanceof Error ? err.message : String(err));
}

/**
 * Maps a filesystem error to an AppFailure naming the path: ENOSPC → DISK_FULL, anything else → FILE_IO_ERROR.
 * `action` is a Japanese noun phrase such as 'ファイルの書込'. AppFailures pass through unchanged.
 */
export function storageFailure(
  err: unknown,
  action: string,
  path: string,
  extra: { clock?: Clock; message?: string; details?: Record<string, unknown> } = {},
): AppFailure {
  if (err instanceof AppFailure) return err;
  const clock = extra.clock ?? systemClock;
  const cause = describeCause(err);
  const details = { path, errno: cause, ...extra.details };
  if (errnoCode(err) === 'ENOSPC') {
    return new AppFailure(
      appError('DISK_FULL', 'storage', clock, { message: `ディスクの空き容量が足りないため、${action}ができません: ${path}`, details }),
    );
  }
  return new AppFailure(
    appError('FILE_IO_ERROR', 'storage', clock, { message: extra.message ?? `${action}に失敗しました: ${path}（${cause}）`, details }),
  );
}

/** Runs `op`, retrying EPERM/EBUSY/EACCES after the FS_RETRY_DELAYS_MS waits; other errors and the last failure are rethrown as is. */
export async function withTransientRetry<T>(op: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const wait = FS_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || !TRANSIENT_CODES.has(errnoCode(err) ?? '')) throw err;
      await sleep(wait);
    }
  }
}

/** Renames (replacing `to` if it exists), retrying EPERM/EBUSY/EACCES with 50–800 ms waits. Failures → FILE_IO_ERROR / DISK_FULL. */
export async function renameWithRetry(from: string, to: string, fs: FsLike = fsp, opts: RetryOptions = {}): Promise<void> {
  let attempts = 0;
  try {
    await withTransientRetry(() => {
      attempts++;
      return fs.rename(from, to);
    }, opts);
  } catch (err) {
    const cause = describeCause(err);
    const hint = TRANSIENT_CODES.has(cause) ? 'ウイルス対策ソフトやOneDriveなどがファイルを使用中の可能性があります。' : '';
    throw storageFailure(err, 'ファイルの置き換え', to, {
      message: `ファイルの置き換えに失敗しました: ${from} → ${to}（${cause}、${attempts}回試行）。${hint}`,
      details: { from, to, attempts },
    });
  }
}

/** Deletes a file, retrying transient Windows locks; a missing file counts as deleted. Failures → FILE_IO_ERROR. */
export async function unlinkWithRetry(path: string, fs: FsLike = fsp, opts: RetryOptions = {}): Promise<void> {
  try {
    await withTransientRetry(() => fs.unlink(path), opts);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw storageFailure(err, 'ファイルの削除', path);
  }
}

/**
 * Reads and validates a JSON file without ever writing to it. A leading UTF-8 BOM is accepted.
 * Only ENOENT is `missing`; bad bytes, bad syntax and schema mismatches are `corrupt`; other read errors throw FILE_IO_ERROR
 * (after retrying transient Windows locks, e.g. a file another process is replacing at that moment).
 */
export async function readJsonFile<T>(path: string, schema: z.ZodType<T>, fs: FsLike = fsp, opts: RetryOptions = {}): Promise<ReadResult<T>> {
  let bytes: Uint8Array;
  try {
    bytes = await withTransientRetry(() => fs.readFile(path), opts);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'missing' };
    throw storageFailure(err, 'ファイルの読込', path);
  }
  let text: string;
  try {
    // fatal: an ANSI-saved file is reported, not silently mangled; the decoder drops a leading BOM.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'corrupt', reason: 'UTF-8として読み取れません' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { kind: 'corrupt', reason: `JSON構文エラー: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'corrupt', reason: `内容が不正です: ${issueSummary(parsed.error).join('; ')}` };
  }
  return { kind: 'ok', value: parsed.data };
}

// Serialized before touching the disk, so a value that cannot become JSON (undefined, BigInt, cycles) writes nothing.
function serialize(path: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = undefined;
  }
  if (typeof json !== 'string') {
    throw new AppFailure(
      appError('INTERNAL_ERROR', 'storage', systemClock, { message: `JSONに変換できない値を保存しようとしました: ${path}`, details: { path } }),
    );
  }
  return `${json}\n`;
}

/**
 * Replaces `path` atomically: writes `<name>.<pid>.<random>.tmp` in the same folder, fsyncs, closes, then renames over the target.
 * On any failure the tmp file is removed and the existing file is left exactly as it was.
 */
export async function writeJsonAtomic(path: string, value: unknown, fs: FsLike = fsp, opts: RetryOptions = {}): Promise<void> {
  await writeFileAtomic(path, serialize(path, value), fs, opts);
}

/**
 * Creates `path` with `data` only when it does not exist yet, all at once: a finished temporary file is hard-linked to the
 * name, so a reader never sees half of it and two processes (two copies of the tool) creating it together never overwrite
 * each other. false: the file was already there (it is left as it is).
 */
export async function createFileExclusive(path: string, data: string | Uint8Array): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
  await writeFileAtomic(tmp, data);
  try {
    await fsp.link(tmp, path);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw storageFailure(err, 'ファイルの作成', path);
  } finally {
    await unlinkWithRetry(tmp).catch(() => undefined);
  }
}

/** writeJsonAtomic for content that is already text (UTF-8) or bytes, such as a derived image. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, fs: FsLike = fsp, opts: RetryOptions = {}): Promise<void> {
  const dir = dirname(path);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw storageFailure(err, 'フォルダの作成', dir);
  }

  const tmp = join(dir, `${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: fsp.FileHandle;
  try {
    // 'wx': never reuse a file we did not create. Antivirus or the indexer can refuse a new name for a moment, too.
    handle = await withTransientRetry(() => fs.open(tmp, 'wx'), opts);
  } catch (err) {
    throw storageFailure(err, 'ファイルの書込', path);
  }

  let failed = false;
  let failure: unknown;
  try {
    await (typeof data === 'string' ? handle.writeFile(data, 'utf8') : handle.writeFile(data));
    await handle.sync();
  } catch (err) {
    failed = true;
    failure = err;
  }
  try {
    await handle.close();
  } catch (err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
  }

  try {
    if (failed) throw storageFailure(failure, 'ファイルの書込', path);
    await renameWithRetry(tmp, path, fs, opts);
  } catch (err) {
    await unlinkWithRetry(tmp, fs, opts).catch(() => undefined);
    throw err;
  }
}
