// US Pacific time, only for the Gemini API's daily quota, which resets at midnight Pacific
// (ai.google.dev/gemini-api/docs/rate-limits). The zone data shipped with Node (Intl) decides the offset; the US rule
// in force since 2007 is the fallback for a Node build without time zone data.
const ZONE = 'America/Los_Angeles';
const MS_PER_MINUTE = 60_000;
const PST = -480;
const PDT = -420;

let formatter: Intl.DateTimeFormat | null | undefined;

function zoneFormatter(): Intl.DateTimeFormat | null {
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONE,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      formatter = null;
    }
  }
  return formatter;
}

/** Minutes east of UTC at `d` (−480 PST, −420 PDT) from Node's zone data; null when it has none. */
export function intlPacificOffsetMinutes(d: Date): number | null {
  const f = zoneFormatter();
  if (f === null) return null;
  const parts = f.formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  const instant = Math.floor(d.getTime() / 1000) * 1000;
  return Math.round((wall - instant) / MS_PER_MINUTE);
}

// Day of the month of the n-th Sunday (UTC calendar arithmetic only).
function nthSunday(year: number, monthIndex: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstWeekday) % 7) + 7 * (n - 1);
}

/** The US rule since 2007: PDT from the second Sunday in March 02:00 PST to the first Sunday in November 02:00 PDT. */
export function usRulePacificOffsetMinutes(d: Date): number {
  const year = new Date(d.getTime() + PST * MS_PER_MINUTE).getUTCFullYear();
  const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 10); // 02:00 PST
  const end = Date.UTC(year, 10, nthSunday(year, 10, 1), 9); // 02:00 PDT
  const t = d.getTime();
  return t >= start && t < end ? PDT : PST;
}

function offsetMinutes(d: Date): number {
  return intlPacificOffsetMinutes(d) ?? usRulePacificOffsetMinutes(d);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The Pacific calendar date of `d` as YYYY-MM-DD (the Gemini quota day). */
export function pacificDateKey(d: Date): string {
  const wall = new Date(d.getTime() + offsetMinutes(d) * MS_PER_MINUTE);
  return `${String(wall.getUTCFullYear()).padStart(4, '0')}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

/** The first 00:00 Pacific strictly after `d` (when the quota day that contains `d` ends). */
export function nextPacificMidnight(d: Date): Date {
  const [year, month, day] = pacificDateKey(d).split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day + 1);
  // US clocks change at 02:00, so a Pacific midnight always exists and has exactly one of the two offsets.
  for (const offset of [PST, PDT]) {
    const instant = new Date(wall - offset * MS_PER_MINUTE);
    if (offsetMinutes(instant) === offset) return instant;
  }
  return new Date(wall - PST * MS_PER_MINUTE);
}
