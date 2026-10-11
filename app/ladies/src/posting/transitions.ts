import { systemClock } from '../shared/clock.js';
import { AppFailure, appError, type ErrorCode } from '../shared/errors.js';
import type { JobStatus } from '../shared/types.js';
import { BUNDLE_AREA } from '../storage/bundles.js';

export interface TransitionContext {
  /** The latest attempt has a recorded submit intent (a click may have happened). */
  intentRecorded: boolean;
  code?: ErrorCode;
  /** P3-R14: a client-side-only rejection plus a full list check without a candidate. */
  exceptionEvidence?: boolean;
  /** P3-R40: the page changed after the first form input and before intent. */
  unexpectedNavigation?: boolean;
  operatorNotRegistered?: boolean;
  /** The post was found on the screen (P3-R42: FAILED → POSTED after an operator "not registered"). */
  screenEvidence?: boolean;
}

type Rule = (c: TransitionContext) => boolean;
const always: Rule = () => true;
const preIntent: Rule = (c) => !c.intentRecorded;
const postIntent: Rule = (c) => c.intentRecorded;
// After intent only the P3-R14 exception may leave the result as "not sent".
const preIntentOrException: Rule = (c) => !c.intentRecorded || c.exceptionEvidence === true;
const screen: Rule = (c) => c.screenEvidence === true;

// Plan §5.3: the posting part of the job state machine. Anything else is a bug.
const RULES: Partial<Record<JobStatus, Partial<Record<JobStatus, Rule>>>> = {
  // → POSTED with screen evidence: a late reconcile `found` for an older attempt of a job retried meanwhile (P3-R42).
  READY: { POSTING: always, GENERATING: always, FAILED: always, BLOCKED: always, POSTED: screen },
  RETRY_WAIT: { POSTING: always, FAILED: always, POSTED: screen },
  POSTING: {
    READY: preIntent,
    BLOCKED: preIntent,
    GENERATING: preIntent,
    RETRY_WAIT: preIntentOrException,
    FAILED: preIntentOrException,
    VERIFYING: postIntent,
    POSTED: postIntent,
    VERIFY_REQUIRED: (c) => c.intentRecorded || c.unexpectedNavigation === true,
  },
  VERIFYING: { POSTED: always, VERIFY_REQUIRED: always, RETRY_WAIT: (c) => c.exceptionEvidence === true, FAILED: (c) => c.exceptionEvidence === true },
  VERIFY_REQUIRED: { POSTED: always, FAILED: (c) => c.operatorNotRegistered === true },
  FAILED: { POSTED: screen, READY: always },
  BLOCKED: { READY: always, POSTED: screen },
};

/** Throws INTERNAL_ERROR unless `from → to` is allowed in this context (every coordinator, reconcile and retry mutation calls it). */
export function assertTransition(from: JobStatus, to: JobStatus, ctx: TransitionContext): void {
  if (RULES[from]?.[to]?.(ctx) === true) return;
  throw new AppFailure(
    appError('INTERNAL_ERROR', 'posting', systemClock, {
      message: `許可されていない状態の変更です: ${from} → ${to}`,
      details: { from, to, intent_recorded: ctx.intentRecorded, code: ctx.code ?? null },
    }),
  );
}

/** The image-folder move a transition needs (§5.3 Bundle column, spec 11.3). */
export function bundleMoveFor(from: JobStatus, to: JobStatus): 'none' | 'to_failed' | 'to_processing' | 'to_posted' {
  const target = BUNDLE_AREA[to];
  return BUNDLE_AREA[from] === target ? 'none' : `to_${target}`;
}
