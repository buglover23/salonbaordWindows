import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type Clock, systemClock } from './shared/clock.js';
import type { ErrorCode } from './shared/errors.js';
import { formatJst, jstDateKey } from './shared/time.js';
import type { AudienceCategory, Mode, PostType } from './shared/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  job_id?: string | null | undefined;
  post_type?: PostType | null | undefined;
  audience_category?: AudienceCategory | null | undefined;
  stage?: string | null | undefined;
  attempt_id?: string | null | undefined;
  retry_count?: number | null | undefined;
  duration_ms?: number | null | undefined;
  error_code?: ErrorCode | null | undefined;
  [k: string]: unknown;
}

export interface AppLogger {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** An AppLogger whose four methods all hand their level and arguments to `write` (every logger and wrapper is built on it). */
export function loggerFrom(write: (level: LogLevel, event: string, message: string, fields?: LogFields) => void): AppLogger {
  return {
    debug: (event, message, fields) => write('debug', event, message, fields),
    info: (event, message, fields) => write('info', event, message, fields),
    warn: (event, message, fields) => write('warn', event, message, fields),
    error: (event, message, fields) => write('error', event, message, fields),
  };
}

// Keys owned by the logger itself; caller fields with these names are ignored.
const CORE_KEYS: ReadonlySet<string> = new Set(['timestamp', 'level', 'event', 'instance_id', 'mode', 'message']);
// Spec 16.1 keys that are always present; null when the caller does not supply them.
const STRUCTURED_KEYS = ['job_id', 'post_type', 'audience_category', 'stage', 'attempt_id', 'retry_count', 'duration_ms', 'error_code'] as const;
const STRUCTURED_KEY_SET: ReadonlySet<string> = new Set(STRUCTURED_KEYS);

// Spec 16.1 / R29: a key is compared lowercased with '-' read as '_', and its whole value is redacted when it contains
// any of these words (access_token, x-api-key, Set-Cookie, accessToken, ...). Plan 3 adds the pairing code (a key named
// exactly `code`; error_code and the like stay), proofs, signatures, nonces, keys, image chunks and page HTML.
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|cookie|api_key|apikey|authorization|bearer|image_base64|pairing|^code$|proof|sealed|signature|nonce|b64|base64|chunk_data|skeleton|html|cli_key|client_key/;
const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key.toLowerCase().replaceAll('-', '_'));
const MAX_STRING_LENGTH = 2000;

function sanitizeEntries(entries: [string, unknown][], ancestors: WeakSet<object>): Record<string, unknown> {
  const kept: [string, unknown][] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue; // JSON.stringify would drop it; keep memory and file records identical
    kept.push([key, isSecretKey(key) ? '[REDACTED]' : sanitize(value, ancestors)]);
  }
  return Object.fromEntries(kept);
}

// Returns a JSON-safe copy: secrets redacted, binary and long strings replaced, cycles cut. Never mutates the input.
function sanitize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `[TRUNCATED len=${value.length}]` : value;
  }
  // JSON.stringify throws on BigInt, which would drop the whole record from the file.
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  // Buffer, Uint8Array, DataView, ...: never the bytes (image data, secrets), only the size.
  if (ArrayBuffer.isView(value)) return `[BINARY len=${value.byteLength}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ancestors.has(value)) return '[CIRCULAR]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => sanitize(v, ancestors) ?? null);
    // Error has no enumerable own properties, so it would serialize as {}.
    const source = value instanceof Error ? { name: value.name, message: value.message } : value;
    return sanitizeEntries(Object.entries(source), ancestors);
  } finally {
    ancestors.delete(value);
  }
}

interface RecordContext {
  instanceId: string;
  mode: Mode;
}

// The single place that decides what a log record looks like; both loggers go through it.
function buildRecord(ctx: RecordContext, now: Date, level: LogLevel, event: string, message: string, fields: LogFields | undefined): Record<string, unknown> {
  const ancestors = new WeakSet<object>();
  const clean = sanitizeEntries(
    Object.entries(fields ?? {}).filter(([key]) => !CORE_KEYS.has(key)),
    ancestors,
  );
  const head: Record<string, unknown> = {
    timestamp: now.toISOString(),
    level,
    event: sanitize(event, ancestors),
    instance_id: ctx.instanceId,
    mode: ctx.mode,
    message: sanitize(message, ancestors),
  };
  for (const key of STRUCTURED_KEYS) head[key] = clean[key] ?? null;
  const extras = Object.fromEntries(Object.entries(clean).filter(([key]) => !STRUCTURED_KEY_SET.has(key)));
  return { ...head, ...extras };
}

// With onError the logger never throws: any failure while reading the clock, building or writing a record is handed to
// onError (with `now` unset when the clock itself failed) and the record is dropped.
function makeLogger(
  minLevel: LogLevel,
  ctx: RecordContext,
  clock: Clock,
  sink: (record: Record<string, unknown>, now: Date) => void,
  onError?: (err: unknown, now: Date | undefined) => void,
): AppLogger {
  return loggerFrom((level, event, message, fields) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    if (!onError) {
      const now = clock.now();
      sink(buildRecord(ctx, now, level, event, message, fields), now);
      return;
    }
    let now: Date | undefined;
    try {
      now = clock.now();
      sink(buildRecord(ctx, now, level, event, message, fields), now);
    } catch (err) {
      onError(err, now);
    }
  });
}

const WARN_INTERVAL_MS = 60_000;

// Node's own code (EACCES, ENOSPC, ...) when there is one; otherwise the error name.
function failureCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { code, name } = err as { code?: unknown; name?: unknown };
    if (typeof code === 'string') return code;
    if (typeof name === 'string') return name;
  }
  return 'UNKNOWN';
}

// Never throws: a failed write is reported once per minute per error code on stderr and the record is dropped.
// The folder is created by each write, so creating the logger touches nothing on disk.
export function createFileLogger(o: { logsDir: string; level: LogLevel; instanceId: string; mode: Mode; clock: Clock; maxFileMb?: number }): AppLogger {
  const lastWarnedAt = new Map<string, number>();
  const warnWriteFailure = (err: unknown, now: Date | undefined): void => {
    try {
      const code = failureCodeOf(err);
      // The injected clock may be what failed; real time is still good enough to space out warnings.
      const clockMs = now?.getTime() ?? Number.NaN;
      const nowMs = Number.isFinite(clockMs) ? clockMs : Date.now();
      const last = lastWarnedAt.get(code);
      if (last !== undefined && nowMs >= last && nowMs - last < WARN_INTERVAL_MS) return;
      lastWarnedAt.set(code, nowMs);
      process.stderr.write(`ログを書き込めませんでした (${code}): ${o.logsDir}\n`);
    } catch {
      // Nothing left to report to.
    }
  };
  const maxBytes = (o.maxFileMb ?? DEFAULT_MAX_FILE_MB) * MB;
  let current: { date: string; part: number; size: number } | null = null;
  return makeLogger(
    o.level,
    { instanceId: o.instanceId, mode: o.mode },
    o.clock,
    (record, now) => {
      // The file is chosen per write so a long-running process rolls over at JST midnight, and at max_file_mb within a day.
      mkdirSync(o.logsDir, { recursive: true });
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      const date = jstDateKey(now);
      if (current?.date !== date) current = { date, part: 0, size: sizeOf(logFile(o.logsDir, date, 0)) };
      while (current.size > 0 && current.size + bytes > maxBytes) current = { date, part: current.part + 1, size: sizeOf(logFile(o.logsDir, date, current.part + 1)) };
      appendFileSync(logFile(o.logsDir, date, current.part), line, 'utf8');
      current.size += bytes;
    },
    warnWriteFailure,
  );
}

const MB = 1_048_576;
const DEFAULT_MAX_FILE_MB = 20;
const LOG_FILE = /^app-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const logFile = (dir: string, date: string, part: number): string => join(dir, part === 0 ? `app-${date}.jsonl` : `app-${date}.${part}.jsonl`);
const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Spec 16.1 / 16.5: removes the log files of days older than `retentionDays`, then the oldest ones while the total is over
 * `maxTotalBytes`. Today's files (still written to) and files of any other name are never touched. `over`: still over the
 * cap with only today's files left (the caller says so). A file that cannot be removed is left for the next run.
 */
export async function pruneLogs(dir: string, now: Date, o: { retentionDays: number; maxTotalBytes: number }): Promise<{ removed: number; total: number; over: boolean }> {
  const today = jstDateKey(now);
  const oldest = jstDateKey(new Date(now.getTime() - o.retentionDays * 86_400_000));
  const files: { path: string; date: string; part: number; size: number }[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const m = LOG_FILE.exec(name);
    if (m === null) continue;
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st?.isFile()) files.push({ path, date: m[1]!, part: Number(m[2] ?? 0), size: st.size });
  }
  files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.part - b.part));
  let total = files.reduce((n, f) => n + f.size, 0);
  let removed = 0;
  for (const f of files) {
    if (f.date === today || (f.date >= oldest && total <= o.maxTotalBytes)) continue;
    if (await unlink(f.path).then(() => true, () => false)) {
      total -= f.size;
      removed++;
    }
  }
  return { removed, total, over: total > o.maxTotalBytes };
}

/** The bytes of the log files (app-*.jsonl) in `dir`. */
export async function logsBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [])) {
    if (LOG_FILE.test(name)) total += (await lstat(join(dir, name)).catch(() => null))?.size ?? 0;
  }
  return total;
}

export function createMemoryLogger(o: { clock?: Clock; instanceId?: string; mode?: Mode } = {}): AppLogger & { records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = makeLogger('debug', { instanceId: o.instanceId ?? 'test', mode: o.mode ?? 'dry_run' }, o.clock ?? systemClock, (record) => {
    records.push(record);
  });
  return { ...logger, records };
}

/** A URL as it may be logged or shown (spec 16.1, A31): origin + path + the query's names, never values, userinfo or #. */
export function redactUrl(u: string): string {
  const url = URL.parse(u);
  if (url === null) return '(URLとして読み取れません)';
  const keys = [...new Set(url.searchParams.keys())];
  return `${url.origin}${url.pathname}${keys.length > 0 ? `?${keys.join('&')}` : ''}`;
}

const ECHO_PREFIX: Record<LogLevel, string> = { debug: '', info: '', warn: '【注意】', error: '【エラー】' };

/** Passes every record to `base` and shows each info/warn/error message as one line with the JST time (never throws). */
export function withEcho(base: AppLogger, echo: (line: string) => void, clock: Clock): AppLogger {
  return loggerFrom((level, event, message, fields) => {
    base[level](event, message, fields);
    if (level === 'debug') return;
    try {
      echo(`${formatJst(clock.now())} ${ECHO_PREFIX[level]}${message}`);
    } catch {
      // The console is best effort; the log file has the record.
    }
  });
}
