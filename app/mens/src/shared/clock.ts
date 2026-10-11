export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

// Accepts only ISO 8601 strings with an explicit zone (Z or +hh:mm) so tests never depend on the host time zone.
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Date.parse rolls impossible days over (2026-02-30 becomes Mar 2), so the written calendar date is checked on its own.
function calendarDateExists(year: number, month: number, day: number): boolean {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseIso(iso: string): number {
  const m = ISO_WITH_ZONE.exec(iso);
  if (m && !calendarDateExists(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new Error(`FakeClock: 存在しない日付です: ${JSON.stringify(iso)}`);
  }
  const ms = m ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new Error(`FakeClock: 時刻の形式が不正です（タイムゾーン付きISO 8601）: ${JSON.stringify(iso)}`);
  }
  return ms;
}

export class FakeClock implements Clock {
  #ms: number;

  constructor(iso: string) {
    this.#ms = parseIso(iso);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  set(iso: string): void {
    this.#ms = parseIso(iso);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new Error(`FakeClock: advance には有限の数値が必要です: ${ms}`);
    }
    this.#ms += ms;
  }
}
