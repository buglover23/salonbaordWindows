import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { errnoCode, readJsonFile, storageFailure, unlinkWithRetry, withTransientRetry, writeJsonAtomic } from './atomic-json.js';

// Single-instance lock (spec 11.4-1, 11.4-8). The lock file holds {pid, instance_id, started_at, hostname}.
// A stale lock is replaced only while holding `<lockFile>.takeover`, created exclusively, so two starters can never
// both replace the same stale lock. A lock is stale if its pid is dead or reused, or (when the pid's start time is
// unreadable) it was written before the last boot; whenever liveness cannot be established, the answer is LOCK_CONFLICT.

const LockRecordSchema = z.object({
  pid: z.number().int().positive(),
  instance_id: z.string().min(1),
  started_at: isoUtc,
  hostname: z.string(),
});
type LockRecord = z.infer<typeof LockRecordSchema>;

/** The fs/promises functions the lock uses; tests pass a wrapper that injects failures. */
export type LockFs = Pick<typeof fsp, 'open' | 'link' | 'rename' | 'unlink' | 'mkdir' | 'readFile'>;

export interface AcquireAppLockOptions {
  lockFile: string;
  instanceId: string;
  /**
   * Must tell wall-clock time (default systemClock): `started_at` is compared with the OS's process start times and
   * boot time, so a business or fake clock would make a live owner's lock look stale, or a stale one look live.
   */
  clock?: Clock;
  isPidAlive?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => Promise<Date | null>;
  /** When the PC last booted; a lock written before that cannot belong to a running process. */
  getBootTime?: () => Date;
  /** Replaces the real waits between re-reads and retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces node:fs/promises (tests). */
  fs?: LockFs;
}

/**
 * What release() found: `released` = our record, now deleted; `not_owner` = another instance's record, left alone;
 * `unreadable` = content that is not a lock record, left alone; `missing` = no lock file.
 */
export type LockReleaseStatus = 'released' | 'not_owner' | 'unreadable' | 'missing';

export interface AppLock {
  /** Deletes the lock file only if it still holds our record. Later calls return the first result; a thrown read error is retried. */
  release(): Promise<LockReleaseStatus>;
}

/** Runs a program and resolves with its standard output; tests inject it instead of starting PowerShell. */
export type RunFile = (file: string, args: readonly string[], options: { timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

/** A process that started this much later than the lock was written cannot be its owner: the pid was reused. */
const PID_REUSE_MIN_GAP_MS = 5_000;
/** Margin for uptime rounding and clock adjustment: only a lock written clearly before the last boot is stale by that alone. */
const PRE_BOOT_MARGIN_MS = 60_000;
/** A racing starter may have created a lock file without having written it yet; look again before calling it unreadable. */
const UNREADABLE_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;
const MAX_ROUNDS = 5;

const execFileAsync = promisify(execFile);
const runFileDefault: RunFile = (file, args, options) => execFileAsync(file, [...args], options);

/** Only ESRCH proves the process is gone; EPERM (exists, not ours to signal) and anything unexpected count as alive. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) !== 'ESRCH';
  }
}

export function defaultGetBootTime(): Date {
  return new Date(Date.now() - uptime() * 1000);
}

/** Windows PowerShell by absolute path: a PATH search could run a `powershell.exe` planted in another folder. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: an empty SystemRoot is as unusable as a missing one.
  return `${env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps -o lstart=` in the C locale ("Sat Oct 11 09:15:02 2026", local time) as a Date, or null. */
export function parseLstart(text: string): Date | null {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  const month = m === null ? -1 : MONTHS.indexOf(m[1]!);
  if (m === null || month < 0) return null;
  const d = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Start time of a process via PowerShell (Windows) or /bin/ps (macOS), or null if it cannot be determined. */
export async function defaultGetProcessStartTime(
  pid: number,
  o: { runFile?: RunFile; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<Date | null> {
  // The pid is interpolated into the command, so anything but a positive integer is refused outright.
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if ((o.platform ?? process.platform) === 'darwin') {
    try {
      // LC_ALL=C: lstart follows the locale, and a Japanese one would not parse.
      const env = { ...(o.env ?? process.env), LC_ALL: 'C' };
      return parseLstart((await (o.runFile ?? runFileDefault)('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 15_000, windowsHide: true, env })).stdout);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await (o.runFile ?? runFileDefault)(
      powershellPath(o.env),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
      { timeout: 15_000, windowsHide: true },
    );
    const ms = Date.parse(stdout.trim());
    return Number.isNaN(ms) ? null : new Date(ms);
  } catch {
    return null;
  }
}

interface Ctx {
  lockFile: string;
  marker: string;
  clock: Clock;
  isPidAlive: (pid: number) => boolean;
  getProcessStartTime: (pid: number) => Promise<Date | null>;
  /** NaN when unknown: then no lock is stale by the boot rule. */
  bootTimeMs: number;
  sleep: (ms: number) => Promise<void>;
  fs: LockFs;
}

function sameRecord(a: LockRecord, b: LockRecord): boolean {
  return a.pid === b.pid && a.instance_id === b.instance_id && a.started_at === b.started_at && a.hostname === b.hostname;
}

function conflict(ctx: Ctx, message: string, details: Record<string, unknown>): AppFailure {
  return new AppFailure(appError('LOCK_CONFLICT', 'storage', ctx.clock, { message, details: { lock_file: ctx.lockFile, ...details } }));
}

function readBootTimeMs(getBootTime: () => Date): number {
  try {
    return getBootTime().getTime();
  } catch {
    return Number.NaN;
  }
}

/** Creates `file` only if it does not exist yet and writes `record` into it; false if it already exists. */
async function createExclusive(file: string, record: LockRecord, ctx: Ctx): Promise<boolean> {
  let handle: fsp.FileHandle;
  try {
    // A name whose previous file is still being deleted, or that antivirus holds, reports EPERM/EBUSY/EACCES for a moment.
    handle = await withTransientRetry(() => ctx.fs.open(file, 'wx'), { sleep: ctx.sleep });
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw storageFailure(err, 'ロックファイルの作成', file, { clock: ctx.clock });
  }
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (err) {
    // An empty lock left behind would block every later start as unreadable.
    await unlinkWithRetry(file, ctx.fs, { sleep: ctx.sleep }).catch(() => undefined);
    throw storageFailure(err, 'ロックファイルの書込', file, { clock: ctx.clock });
  }
  return true;
}

/** The record in `file`, or null if there is none; unreadable content is LOCK_CONFLICT. */
async function readRecord(file: string, ctx: Ctx): Promise<LockRecord | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await readJsonFile(file, LockRecordSchema, ctx.fs, { sleep: ctx.sleep });
    if (r.kind === 'ok') return r.value;
    if (r.kind === 'missing') return null;
    const wait = UNREADABLE_RETRY_DELAYS_MS[attempt];
    if (wait === undefined) {
      throw conflict(
        ctx,
        `ロックファイルを読み取れないため開始しません（${r.reason}）。ほかに起動中のプロセスが無いことを確認してから、このファイルを削除してください: ${file}`,
        { file, reason: 'unreadable' },
      );
    }
    await ctx.sleep(wait);
  }
}

/**
 * Returns if the record's owner is provably gone; throws LOCK_CONFLICT otherwise. Order (R16a): other host → conflict;
 * dead pid → stale; readable start time → stale only if ≥ 5 s after the lock (pid reused); unreadable start time →
 * stale only if the lock was written before the last boot. An Invalid Date or a failed lookup counts as unreadable,
 * and an unknown boot time never makes a lock stale.
 */
async function assertStale(record: LockRecord, file: string, ctx: Ctx): Promise<void> {
  const details = { file, pid: record.pid, instance_id: record.instance_id, started_at: record.started_at, hostname: record.hostname };
  if (record.hostname !== hostname()) {
    throw conflict(
      ctx,
      `別のPC（${record.hostname}）が作ったロックがあり、動作中か確かめられないため開始しません。そのPCで動いていないことを確認してから、このファイルを削除してください: ${file}`,
      { ...details, reason: 'other_host' },
    );
  }
  if (!ctx.isPidAlive(record.pid)) return;
  let startMs: number;
  try {
    startMs = (await ctx.getProcessStartTime(record.pid))?.getTime() ?? Number.NaN;
  } catch {
    startMs = Number.NaN;
  }
  const lockMs = Date.parse(record.started_at);
  if (Number.isNaN(startMs)) {
    // Typical after a reboot: the old pid now belongs to a service whose start time we may not read. The boot time is
    // consulted only here, so a clock correction after boot can never override a readable start time.
    if (lockMs < ctx.bootTimeMs - PRE_BOOT_MARGIN_MS) return;
  } else if (startMs - lockMs >= PID_REUSE_MIN_GAP_MS) {
    return;
  }
  throw conflict(
    ctx,
    `別のプロセス(PID ${record.pid})がロックを保持している可能性があります。タスクマネージャーの［詳細］でPID ${record.pid}がこのツール(node.exe)か確認し、違う場合だけ ${file} を削除してから再起動してください。`,
    { ...details, reason: 'alive' },
  );
}

async function deleteIfOwn(file: string, mine: LockRecord, ctx: Ctx): Promise<LockReleaseStatus> {
  const r = await readJsonFile(file, LockRecordSchema, ctx.fs, { sleep: ctx.sleep });
  if (r.kind === 'missing') return 'missing';
  if (r.kind === 'corrupt') return 'unreadable';
  if (!sameRecord(r.value, mine)) return 'not_owner';
  await unlinkWithRetry(file, ctx.fs, { sleep: ctx.sleep });
  return 'released';
}

/** Removes a stale `file` only if it still holds `stale`: it is moved aside first, so a newer file is never deleted by mistake. */
async function removeStale(file: string, stale: LockRecord, ctx: Ctx): Promise<void> {
  const aside = `${file}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await withTransientRetry(() => ctx.fs.rename(file, aside), { sleep: ctx.sleep });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw storageFailure(err, 'ロックファイルの移動', file, { clock: ctx.clock });
  }
  const moved = await readJsonFile(aside, LockRecordSchema, ctx.fs, { sleep: ctx.sleep }).catch(() => null);
  if (moved?.kind !== 'ok' || !sameRecord(moved.value, stale)) {
    // A newer file was created after our check: put it back. link refuses if the name was taken again meanwhile and
    // fails where hard links are unsupported (exFAT/FAT32); either way the file stays aside and this start stops.
    try {
      await withTransientRetry(() => ctx.fs.link(aside, file), { sleep: ctx.sleep });
    } catch (err) {
      const cause = errnoCode(err) ?? (err instanceof Error ? err.message : String(err));
      throw conflict(
        ctx,
        `ロックの引継ぎ中に、別のプロセスの印（${file}）を元に戻せなかったため開始しません（${cause}）。印は ${aside} に退避したまま残してあります。ほかに起動中のプロセスが無いことを確認してから、${aside} を削除して再起動してください。`,
        { file, moved_to: aside, reason: 'restore_failed', errno: cause },
      );
    }
  }
  await unlinkWithRetry(aside, ctx.fs, { sleep: ctx.sleep }).catch(() => undefined);
}

/** Replaces the stale lock with ours under the takeover marker; false if someone else got there first. */
async function takeOver(stale: LockRecord, mine: LockRecord, ctx: Ctx): Promise<boolean> {
  if (!(await createExclusive(ctx.marker, mine, ctx))) {
    const holder = await readRecord(ctx.marker, ctx);
    if (holder !== null) {
      // A live holder is replacing the lock right now (LOCK_CONFLICT); a dead one left its marker behind.
      await assertStale(holder, ctx.marker, ctx);
      await removeStale(ctx.marker, holder, ctx);
    }
    return false;
  }
  try {
    const current = await readRecord(ctx.lockFile, ctx);
    if (current === null || !sameRecord(current, stale)) return false;
    await writeJsonAtomic(ctx.lockFile, mine, ctx.fs, { sleep: ctx.sleep });
    const written = await readRecord(ctx.lockFile, ctx);
    return written !== null && sameRecord(written, mine);
  } finally {
    // Best effort: a marker we fail to delete is judged by our pid like any other once we have exited.
    await deleteIfOwn(ctx.marker, mine, ctx).catch(() => undefined);
  }
}

function heldLock(mine: LockRecord, ctx: Ctx): AppLock {
  let outcome: Promise<LockReleaseStatus> | null = null;
  return {
    release() {
      // Deletes only our own record: a lock taken over by another instance, or now unreadable, is left alone.
      outcome ??= deleteIfOwn(ctx.lockFile, mine, ctx).catch((err: unknown) => {
        outcome = null;
        throw err;
      });
      return outcome;
    },
  };
}

export async function acquireAppLock(o: AcquireAppLockOptions): Promise<AppLock> {
  const clock = o.clock ?? systemClock;
  const ctx: Ctx = {
    lockFile: o.lockFile,
    marker: `${o.lockFile}.takeover`,
    clock,
    isPidAlive: o.isPidAlive ?? defaultIsPidAlive,
    getProcessStartTime: o.getProcessStartTime ?? defaultGetProcessStartTime,
    bootTimeMs: readBootTimeMs(o.getBootTime ?? defaultGetBootTime),
    sleep: o.sleep ?? ((ms) => delay(ms)),
    fs: o.fs ?? fsp,
  };
  const mine: LockRecord = { pid: process.pid, instance_id: o.instanceId, started_at: clock.now().toISOString(), hostname: hostname() };
  const dir = dirname(o.lockFile);
  try {
    await ctx.fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw storageFailure(err, 'フォルダの作成', dir, { clock });
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (await createExclusive(ctx.lockFile, mine, ctx)) return heldLock(mine, ctx);
    const current = await readRecord(ctx.lockFile, ctx);
    if (current === null) continue; // deleted between our create attempt and the read
    await assertStale(current, ctx.lockFile, ctx);
    if (await takeOver(current, mine, ctx)) return heldLock(mine, ctx);
  }
  throw conflict(ctx, `ロックファイルが繰り返し変化したため開始しません。ほかに起動中のプロセスが無いか確認してください: ${o.lockFile}`, {
    reason: 'unstable',
  });
}
