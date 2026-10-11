import type { Settings } from '../config/schemas.js';
import { ERROR_CODES, type ErrorCode } from '../shared/errors.js';
import type { ApiErrorCode } from '../shared/protocol/version.js';
import { STOP_SCOPE, type StopScope } from './stops.js';
import { ABANDON_CAP_PER_DAY } from './timing.js';

/** What becomes of a job whose attempt ended (or was refused) with an error. */
export type Disposition =
  | { status: 'READY'; releaseSlot: true; stop?: StopScope }
  | { status: 'RETRY_WAIT'; next_retry_at: string; keepSlot: boolean }
  | { status: 'FAILED'; code: ErrorCode; retryable: boolean; releaseSlot: true }
  | { status: 'BLOCKED'; code: ErrorCode; stop?: StopScope; releaseSlot: true }
  | { status: 'GENERATING'; releaseSlot: true }
  | { status: 'VERIFY_REQUIRED'; keepSlot: true; stop?: StopScope };

export interface DisposeContext {
  intentRecorded: boolean;
  /** P3-R14: client-side-only rejection, same document, no completion, and no candidate on every list page. */
  exceptionEvidence: boolean;
  /** P3-R40: the page changed after the first form input and before intent. */
  unexpectedNavigation: boolean;
  retryCount: number;
  /** Pre-intent abandons of this job already recorded today (this one not included). */
  abandonsToday: number;
  driftRegenerations: number;
  settings: Settings['retry'];
  now: Date;
  /** End of the posting window holding the job's slot; null = no window (the slot cannot be kept). */
  windowEnd: Date | null;
  retryAfterSeconds?: number;
  random: () => number;
  /** LIMIT_REACHED computed by Node from the recorded limits (not seen on the screen): no stop (P3-R9). */
  computedQuota?: boolean;
}

// Waits: the job goes back to READY and the attempt does not count as a retry.
const WAIT = new Set<ApiErrorCode>([
  'EXTENSION_DISCONNECTED',
  'STALE_COMMAND',
  'WINDOW_CLOSED',
  'PAUSED',
  'RESOURCE_DISK_LOW',
  'RESOURCE_MEMORY_HIGH',
  'DISK_FULL',
  'FILE_IO_ERROR',
  'BUSY',
  'STALE_CLIENT',
  'REVISION_CONFLICT',
  'STATE_CORRUPT',
  // gate refusals at claim/intent (readiness, quota unknown, route not usable, instruction refresh)
  'POST_CAPACITY_UNKNOWN',
  'EXTERNAL_REQUIREMENT_UNVERIFIED',
  'AUTOMATION_NOT_PERMITTED',
  'POST_TARGET_UNCONFIGURED',
  'POST_TARGET_UNVERIFIED',
  'INSTRUCTION_INVALID',
  'INSTRUCTION_CONFLICT',
]);
const RETRYABLE = new Set<ApiErrorCode>(['UPLOAD_TIMEOUT', 'UPLOAD_FAILED', 'NETWORK_ERROR', 'PAGE_TIMEOUT']);
const NEVER_RETRIED = new Set<ApiErrorCode>(['DUPLICATE_IMAGE', 'ALREADY_POSTED', 'IMAGE_INVALID', 'IMAGE_NOT_FOUND']);
const REGENERATE = new Set<ApiErrorCode>(['VALIDATION_FAILED', 'DUPLICATE_CONTENT']);
const JOB_BLOCKED = new Set<ApiErrorCode>(['CONFIG_INCOMPLETE', 'CONFIG_INVALID']);
/** P3-R29: returns to GENERATING because the rules changed, at most this many times. */
const MAX_DRIFT_REGENERATIONS = 2;

const isErrorCode = (code: ApiErrorCode): code is ErrorCode => (ERROR_CODES as readonly string[]).includes(code);

function retry(code: ErrorCode, c: DisposeContext, keepSlotAllowed: boolean): Disposition {
  if (!c.settings.enabled) return { status: 'FAILED', code, retryable: true, releaseSlot: true };
  const delaySeconds = c.settings.delays_seconds[c.retryCount];
  if (c.retryCount >= c.settings.max_retries || delaySeconds === undefined) {
    return { status: 'FAILED', code: 'RETRY_EXHAUSTED', retryable: true, releaseSlot: true };
  }
  const backoffMs = Math.round(delaySeconds * 1000 * (1 + c.random() * c.settings.jitter_ratio));
  const next = c.now.getTime() + Math.max(backoffMs, (c.retryAfterSeconds ?? 0) * 1000);
  const keepSlot = keepSlotAllowed && c.windowEnd !== null && next < c.windowEnd.getTime();
  return { status: 'RETRY_WAIT', next_retry_at: new Date(next).toISOString(), keepSlot };
}

/**
 * Spec 15.2 / plan 7.2a: how a failed or refused attempt ends. After intent nothing is ever sent again automatically:
 * every outcome is VERIFY_REQUIRED except P3-R14's exception (`exceptionEvidence` with SUBMIT_FAILED). A refusal for a
 * rejected config edit or a recovery halt is a wait (pass BUSY / STATE_CORRUPT), not CONFIG_INVALID, which blocks the job.
 */
export function dispose(code: ErrorCode | ApiErrorCode, c: DisposeContext): Disposition {
  const scope = code === 'POST_RESULT_UNKNOWN' ? undefined : (STOP_SCOPE as Partial<Record<ApiErrorCode, StopScope>>)[code];
  if (c.intentRecorded) {
    if (code === 'SUBMIT_FAILED' && c.exceptionEvidence) return retry(code, c, false);
    return scope === undefined ? { status: 'VERIFY_REQUIRED', keepSlot: true } : { status: 'VERIFY_REQUIRED', keepSlot: true, stop: scope };
  }
  if (c.unexpectedNavigation) return { status: 'VERIFY_REQUIRED', keepSlot: true, stop: 'salon' };
  if (code === 'EXTENSION_DISCONNECTED' && c.abandonsToday + 1 >= ABANDON_CAP_PER_DAY) {
    return { status: 'FAILED', code, retryable: true, releaseSlot: true };
  }
  if (WAIT.has(code)) return { status: 'READY', releaseSlot: true };
  if (code === 'LIMIT_REACHED') return c.computedQuota === true ? { status: 'READY', releaseSlot: true } : { status: 'READY', releaseSlot: true, stop: 'type' };
  // An API-only refusal (unauthorized, rate limited, ...) only makes the job wait.
  if (!isErrorCode(code)) return { status: 'READY', releaseSlot: true };
  if (RETRYABLE.has(code)) return retry(code, c, true);
  if (scope !== undefined) return { status: 'BLOCKED', code, stop: scope, releaseSlot: true };
  if (JOB_BLOCKED.has(code)) return { status: 'BLOCKED', code, releaseSlot: true };
  if (REGENERATE.has(code)) {
    return c.driftRegenerations >= MAX_DRIFT_REGENERATIONS
      ? { status: 'FAILED', code: 'VALIDATION_FAILED', retryable: false, releaseSlot: true }
      : { status: 'GENERATING', releaseSlot: true };
  }
  if (NEVER_RETRIED.has(code)) return { status: 'FAILED', code, retryable: false, releaseSlot: true };
  // Anything else (an internal error, an AI code): stop this job and let the operator retry it, never loop.
  return { status: 'FAILED', code, retryable: true, releaseSlot: true };
}
