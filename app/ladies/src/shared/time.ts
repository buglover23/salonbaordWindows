// JST is a fixed UTC+9 offset (Japan has no DST). Only UTC accessors and epoch math are used here,
// so results never depend on the host time zone, the TZ variable, or ICU.
const MS_PER_MINUTE = 60_000;
const JST_OFFSET_MS = 9 * 60 * MS_PER_MINUTE;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// A Date whose UTC fields read as the JST wall-clock fields of `d`.
function toJstWallClock(d: Date): Date {
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    throw new Error('不正な日時（Invalid Date）です');
  }
  return new Date(ms + JST_OFFSET_MS);
}

// Epoch ms of 00:00 UTC on the given calendar date; rejects malformed or non-existent dates.
function dateKeyToUtcMidnight(dateKey: string): number {
  const m = DATE_KEY.exec(dateKey);
  if (!m) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${JSON.stringify(dateKey)}`);
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`存在しない日付です: ${dateKey}`);
  }
  return ms;
}

/** JST calendar date as YYYY-MM-DD. */
export function jstDateKey(d: Date): string {
  const w = toJstWallClock(d);
  return `${String(w.getUTCFullYear()).padStart(4, '0')}-${pad2(w.getUTCMonth() + 1)}-${pad2(w.getUTCDate())}`;
}

/** ISO weekday (Monday=1 ... Sunday=7) of a YYYY-MM-DD calendar date. */
export function jstIsoWeekday(dateKey: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const day = new Date(dateKeyToUtcMidnight(dateKey)).getUTCDay(); // 0 = Sunday
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** Minutes elapsed since 00:00 JST (0-1439). */
export function jstMinutesOfDay(d: Date): number {
  const w = toJstWallClock(d);
  return w.getUTCHours() * 60 + w.getUTCMinutes();
}

/** The instant at `minutes` after 00:00 JST on `dateKey`; 1440 or more rolls into the following days. */
export function jstToUtc(dateKey: string, minutes: number): Date {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`分は0以上の整数で指定してください: ${minutes}`);
  }
  return new Date(dateKeyToUtcMidnight(dateKey) + minutes * MS_PER_MINUTE - JST_OFFSET_MS);
}

/** Strict HH:mm (00:00-23:59) to minutes since midnight. */
export function parseHHmm(s: string): number {
  const m = HH_MM.exec(s);
  if (!m) {
    throw new Error(`時刻は HH:mm 形式（00:00〜23:59）で指定してください: ${JSON.stringify(s)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

const DATE_TIME_WITH_ZONE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * A hand-written export time: `YYYY-MM-DD` means 00:00 JST of that date (the earliest reading, so it never
 * outlives the real export); otherwise an ISO 8601 date-time with an explicit zone. null when neither, or the date does not exist.
 */
export function parseExportedAt(text: string): Date | null {
  try {
    if (DATE_KEY.test(text)) return jstToUtc(text, 0);
    const m = DATE_TIME_WITH_ZONE.exec(text);
    if (!m) return null;
    dateKeyToUtcMidnight(m[1]!); // Date.parse would roll 2026-02-30 over to March
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  } catch {
    return null;
  }
}

/** JST display string, YYYY-MM-DD HH:mm. */
export function formatJst(d: Date): string {
  const min = jstMinutesOfDay(d);
  return `${jstDateKey(d)} ${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** JST date and HH-mm, for folder names. */
export function jstFolderParts(d: Date): { date: string; hm: string } {
  const min = jstMinutesOfDay(d);
  return { date: jstDateKey(d), hm: `${pad2(Math.floor(min / 60))}-${pad2(min % 60)}` };
}

/** JST timestamp as YYYYMMDD-HHmmss (milliseconds dropped), for ids. */
export function jstCompact(d: Date): string {
  const w = toJstWallClock(d);
  const date = `${String(w.getUTCFullYear()).padStart(4, '0')}${pad2(w.getUTCMonth() + 1)}${pad2(w.getUTCDate())}`;
  return `${date}-${pad2(w.getUTCHours())}${pad2(w.getUTCMinutes())}${pad2(w.getUTCSeconds())}`;
}
