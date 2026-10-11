import type { AppFailure, ErrorCode } from '../shared/errors.js';

// App-level retries of one AI call (the SDKs' own retries are off, so every attempt is metered and budget-checked).

/** Waits before the 2nd and 3rd attempt (later ones repeat the last), plus 0-20 % jitter. */
const BACKOFF_MS = [2000, 8000] as const;
const JITTER_RATIO = 0.2;
/** A longer server-requested wait is not waited out inside one call; the job is retried later instead. */
export const MAX_RETRY_AFTER_MS = 120_000;
const TRANSPORT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['AI_TIMEOUT', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE']);

/**
 * Milliseconds to wait before attempt `attempt + 1`, or null = do not retry: only AI_TIMEOUT / AI_RATE_LIMIT /
 * AI_UNAVAILABLE are retried, at most `maxAttempts` attempts in all, never when the server asks for more than
 * MAX_RETRY_AFTER_MS; a shorter server wait longer than the backoff is honoured.
 */
export function transportRetryWait(failure: AppFailure, retryAfterMs: number | undefined, attempt: number, maxAttempts: number, random: () => number): number | null {
  if (!TRANSPORT_CODES.has(failure.error.code) || attempt >= maxAttempts) return null;
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return null;
  const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] as number;
  const backoff = Math.round(base * (1 + JITTER_RATIO * random()));
  return Math.max(backoff, Math.ceil(retryAfterMs ?? 0));
}
