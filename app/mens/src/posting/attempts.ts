import { ERROR_MESSAGES_JA, type AppError } from '../shared/errors.js';
import type { Attempt, Job } from '../shared/job-schema.js';
import type { RouteSnapshot } from '../shared/protocol/commands.js';
import { jstDateKey } from '../shared/time.js';
import type { JobStatus, SubmissionState } from '../shared/types.js';
import { internalFailure } from '../storage/store-errors.js';
import type { Disposition } from './retry-policy.js';
import { RECONCILE_DELAYS_MS } from './timing.js';
import { assertTransition } from './transitions.js';

// Pure mutators of a job's posting attempt. Each keeps job.submission_state equal to its latest attempt's, maintains
// resolved_route (set at claim, frozen after intent, cleared when a pre-intent attempt ends) and never touches
// image.relative_path or operation (BundleMover owns them).

const at = (now: Date): { now: () => Date } => ({ now: () => now });

/** The job's latest attempt, which must be `attemptId` (mutators only ever act on the current attempt). */
function current(job: Job, attemptId: string, now: Date): Attempt {
  const latest = job.attempts.at(-1);
  if (latest === undefined || latest.id !== attemptId) {
    throw internalFailure(at(now), `現在の送信試行ではないため変更できません: ${job.id} ${attemptId}`, { job_id: job.id, attempt_id: attemptId });
  }
  return latest;
}

function withLatest(job: Job, patch: Partial<Attempt>): Attempt[] {
  return job.attempts.map((a, i) => (i === job.attempts.length - 1 ? { ...a, ...patch } : a));
}

const intentRecorded = (a: Attempt): boolean => a.submit_intent_at !== null;

/** READY or RETRY_WAIT → POSTING with a new attempt (claim). */
export function startAttempt(
  job: Job,
  i: { attemptId: string; commandId: string; instanceId: string; clientId: string; now: Date; route: RouteSnapshot; configHash: string; isRetry: boolean },
): Job {
  assertTransition(job.status, 'POSTING', { intentRecorded: false });
  const attempt: Attempt = {
    id: i.attemptId,
    command_id: i.commandId,
    assigned_instance_id: i.instanceId,
    claimed_at: i.now.toISOString(),
    submit_intent_at: null,
    submitted_at: null,
    completed_at: null,
    submission_state: 'not_started',
    error: null,
    evidence_refs: [],
    route: i.route,
    permission_id: null,
    client_id: i.clientId,
    flags: null,
  };
  return {
    ...job,
    status: 'POSTING',
    stage: 'posting',
    submission_state: 'not_started',
    attempt_count: job.attempt_count + 1,
    retry_count: job.retry_count + (i.isRetry ? 1 : 0),
    next_retry_at: null,
    attempts: [...job.attempts, attempt],
    resolved_route: { entry_url: i.route.entry_url, adapter_id: i.route.adapter_id, page_profile_id: i.route.page_profile_id, config_hash: i.configHash },
  };
}

/** The permission is issued: the intent is recorded (the route is persisted again; resolved_route stays as claimed). */
export function recordIntent(job: Job, attemptId: string, i: { now: Date; permissionId: string; route: RouteSnapshot }): Job {
  const a = current(job, attemptId, i.now);
  if (job.status !== 'POSTING' || a.submission_state !== 'not_started' || intentRecorded(a)) {
    throw internalFailure(at(i.now), `送信の許可を記録できる状態ではありません: ${job.id}（${job.status} / ${a.submission_state}）`, { job_id: job.id, attempt_id: attemptId });
  }
  return {
    ...job,
    submission_state: 'intent_recorded',
    attempts: withLatest(job, { submit_intent_at: i.now.toISOString(), submission_state: 'intent_recorded', permission_id: i.permissionId, route: i.route }),
  };
}

/** POSTING → VERIFYING: the click was reported (or inferred from a new document while clicking). */
export function markSubmitted(job: Job, attemptId: string, now: Date, inferred: boolean): Job {
  const a = current(job, attemptId, now);
  assertTransition(job.status, 'VERIFYING', { intentRecorded: intentRecorded(a) });
  return {
    ...job,
    status: 'VERIFYING',
    stage: 'verifying',
    attempts: withLatest(job, { submitted_at: now.toISOString(), flags: { mutated: a.flags?.mutated ?? true, unexpected_navigation: false, inferred_click: inferred } }),
  };
}

const STAGE_AFTER: Partial<Record<JobStatus, string>> = { READY: 'ready', RETRY_WAIT: 'retry_wait', GENERATING: 'generate' };

/**
 * A pre-intent attempt ends as `definitely_not_submitted` with the outcome `d` from dispose(). A VERIFY_REQUIRED outcome
 * (an unexpected navigation, P3-R40) is a possible send and goes through markUnknown instead. The slot is the caller's.
 */
export function endPreIntent(job: Job, attemptId: string, error: AppError, d: Disposition, now: Date): Job {
  if (d.status === 'VERIFY_REQUIRED') return markUnknown(job, attemptId, error, now, 'unexpected_navigation');
  const a = current(job, attemptId, now);
  assertTransition(job.status, d.status, { intentRecorded: intentRecorded(a), code: error.code });
  const state: SubmissionState = 'definitely_not_submitted';
  const stored: AppError =
    d.status === 'FAILED' && d.code !== error.code
      ? { ...error, code: d.code, message: ERROR_MESSAGES_JA[d.code], retryable: d.retryable, submission_state: state, details_redacted: { ...error.details_redacted, original_code: error.code } }
      : { ...error, retryable: d.status === 'FAILED' ? d.retryable : error.retryable, submission_state: state };
  const today = jstDateKey(now);
  const abandons = job.pre_intent_abandons?.date_jst === today ? job.pre_intent_abandons.count : 0;
  return {
    ...job,
    status: d.status,
    stage: STAGE_AFTER[d.status] ?? job.stage,
    submission_state: state,
    last_error: stored,
    resolved_route: null,
    next_retry_at: d.status === 'RETRY_WAIT' ? d.next_retry_at : null,
    drift_regenerations: job.drift_regenerations + (d.status === 'GENERATING' ? 1 : 0),
    pre_intent_abandons: error.code === 'EXTENSION_DISCONNECTED' ? { date_jst: today, count: abandons + 1 } : job.pre_intent_abandons,
    attempts: withLatest(job, { submission_state: state, completed_at: now.toISOString(), error: stored }),
  };
}

/**
 * The result is unknown (VERIFY_REQUIRED): never sent again automatically, and the first automatic reconcile is due in
 * 2 minutes. `anchor` 'unexpected_navigation' is P3-R40's pre-intent case (no intent, resolved_route cleared).
 */
export function markUnknown(job: Job, attemptId: string, error: AppError, now: Date, anchor: 'intent' | 'unexpected_navigation'): Job {
  const a = current(job, attemptId, now);
  const navigated = anchor === 'unexpected_navigation';
  assertTransition(job.status, 'VERIFY_REQUIRED', { intentRecorded: intentRecorded(a), unexpectedNavigation: navigated, code: error.code });
  const stored: AppError = { ...error, submission_state: 'unknown' };
  return {
    ...job,
    status: 'VERIFY_REQUIRED',
    stage: 'verify_required',
    submission_state: 'unknown',
    last_error: stored,
    resolved_route: intentRecorded(a) ? job.resolved_route : null,
    reconcile: {
      attempt_id: attemptId,
      auto_count: 0,
      next_auto_at: new Date(now.getTime() + RECONCILE_DELAYS_MS[0]).toISOString(),
      last_at: null,
      last_outcome: null,
      operator_needed: false,
      in_flight_command_id: null,
    },
    attempts: withLatest(job, {
      submission_state: 'unknown',
      completed_at: now.toISOString(),
      error: stored,
      ...(navigated ? { flags: { mutated: true, unexpected_navigation: true, inferred_click: a.flags?.inferred_click ?? false } } : {}),
    }),
  };
}

/**
 * POSTED from screen evidence (result or reconcile). verified_at (the posted-folder date, P3-R21) is `now`. The confirmed
 * attempt is normally the latest; a late reconcile `found` may confirm an older one (P3-R42), and the job is POSTED then.
 */
export function markPosted(
  job: Job,
  attemptId: string,
  i: { now: Date; postedAt: string; source: NonNullable<Job['posted_at_source']>; remoteId: string | null; remoteUrl: string | null; evidenceRefs: string[] },
): Job {
  const a = job.attempts.find((x) => x.id === attemptId);
  if (a === undefined) throw internalFailure(at(i.now), `送信試行が見つかりません: ${job.id} ${attemptId}`, { job_id: job.id, attempt_id: attemptId });
  assertTransition(job.status, 'POSTED', { intentRecorded: intentRecorded(a) || a.submission_state === 'unknown', screenEvidence: true });
  return {
    ...job,
    status: 'POSTED',
    stage: 'posted',
    submission_state: 'confirmed',
    posted_at: i.postedAt,
    verified_at: i.now.toISOString(),
    posted_at_source: i.source,
    remote_post_id: i.remoteId,
    remote_post_url: i.remoteUrl,
    attempts: job.attempts.map((x) => (x === a ? { ...x, submission_state: 'confirmed', completed_at: i.now.toISOString(), evidence_refs: [...a.evidence_refs, ...i.evidenceRefs] } : x)),
  };
}

/**
 * P3-R27: what happens to the slot `job` holds. `windowEnd` is the end of the posting window holding that slot (null: none).
 * - release: nothing was sent (open again within grace, else skipped);
 * - keep: in flight, a recorded intent or an unknown result, or a retry still due within the slot's window;
 * - carry_over: a retry that no longer fits the window (skipped, retry_carried_over);
 * - done: POSTED; failed: "not registered" after intent (not counted).
 */
export function slotReleasable(job: Job, windowEnd: Date | null, now: Date): 'release' | 'keep' | 'carry_over' | 'done' | 'failed' {
  if (job.status === 'POSTED') return 'done';
  const latest = job.attempts.at(-1);
  const state = latest?.submission_state ?? 'not_started';
  // Either record of a possible send keeps the slot (they should agree; the job's own state is checked too, conservatively).
  const sent = (x: string): boolean => x === 'intent_recorded' || x === 'unknown' || x === 'confirmed';
  if (job.operation !== null || sent(state) || sent(job.submission_state)) return 'keep';
  if (state === 'definitely_not_submitted' && latest !== undefined && intentRecorded(latest)) return 'failed';
  switch (job.status) {
    case 'POSTING':
    case 'VERIFYING':
    case 'VERIFY_REQUIRED':
      return 'keep';
    case 'RETRY_WAIT': {
      const next = job.next_retry_at === null ? Infinity : Date.parse(job.next_retry_at);
      return windowEnd !== null && now.getTime() < windowEnd.getTime() && next < windowEnd.getTime() ? 'keep' : 'carry_over';
    }
    default:
      return 'release';
  }
}
