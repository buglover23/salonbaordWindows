import type { ConfigSnapshot } from '../config/loader.js';
import type { Scheduler } from '../execution/scheduler.js';
import { slotDate } from '../execution/startup-recovery.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { appError, errorCodeOf } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import type { AutoReconcileRequest, Evidence, OperatorReconcileRequest } from '../shared/protocol/results.js';
import { formatJst, jstToUtc, parseHHmm } from '../shared/time.js';
import type { JobStatus, Mode } from '../shared/types.js';
import type { BundleMover } from '../storage/bundles.js';
import type { ControlStore } from '../storage/control-store.js';
import type { DedupeStore } from '../storage/dedupe-store.js';
import { writeFailureFile } from '../storage/failure-file.js';
import type { HistoryStore } from '../storage/history-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { DataPaths } from '../storage/paths.js';
import { ApiError } from '../server/errors.js';
import { markPosted } from './attempts.js';
import { writeEvidence, type EvidenceName } from './evidence-store.js';
import { onJobFinal } from './live-single.js';
import { commitPosted } from './post-commit.js';
import type { StopRegistry } from './stops.js';
import { RECONCILE_DELAYS_MS } from './timing.js';
import { assertTransition } from './transitions.js';

// Reconcile of an unknown result (plan Task 2c, D7, P3-R14, P3-R42): the extension's automatic list check and the
// operator's verdict. Automatic reconcile never concludes "not registered"; only the operator does.

/** What the operator-facing services (reconcile, retry, resume) work on: the runtime's stores, or the CLI's under app.lock. */
export interface OpsDeps {
  mode: Mode;
  clock: Clock;
  logger: AppLogger;
  paths: DataPaths;
  store: JobStore;
  bundles: BundleMover;
  control: ControlStore;
  stops: StopRegistry;
  dedupe: DedupeStore;
  history?: Pick<HistoryStore, 'upsert'> | undefined;
  scheduler: Pick<Scheduler, 'complete' | 'release'>;
  /** The base config (allowed origins, limits, retry settings). */
  config: () => ConfigSnapshot;
}

export const VERDICT_BUSY_JA = '自動照合の実行中です。数分後にもう一度実行してください。';
const CONFLICT_ACTION_JA = '「登録なし」とした投稿が画面では登録されていました。同じ投稿が2回登録されていないか SALON BOARD で確認してください。';
const JST_TEXT = /^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?\s*(\d{1,2})[:時](\d{2})/;

/** registered_at_text as JST ('2026/10/05 10:03', '2026-10-05 10:03', '2026年10月5日 10:03'), or null. */
export function parseRegisteredAt(text: string | null | undefined): Date | null {
  const m = text === null || text === undefined ? null : JST_TEXT.exec(text.trim());
  if (m === null) return null;
  const day = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  try {
    const d = jstToUtc(day, parseHHmm(`${m[4]!.padStart(2, '0')}:${m[5]}`));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Exactly one candidate on the list, with the salon identified on the list or detail page (D7). */
export function foundOnList(e: Evidence | null): boolean {
  return e !== null && e.list !== null && e.list.matched !== null && e.list.candidates === 1 && e.salon.some((s) => (s.page === 'list' || s.page === 'detail') && s.identified);
}

/**
 * D7 for a post result: the completion signal as well. A completion_only profile (owner-confirmed) needs the salon
 * identified on the completion page instead of the list.
 */
export const provesPost = (e: Evidence | null, completionOnly = false): boolean =>
  e !== null && e.completion?.matched === true && (completionOnly ? e.salon.some((s) => s.page === 'completion' && s.identified) : foundOnList(e));

export function slotOf(job: Pick<Job, 'schedule_slot_id'>): { date: string; slotId: string } | null {
  const slotId = job.schedule_slot_id;
  const date = slotId === null ? null : slotDate(slotId);
  return slotId === null || date === null ? null : { date, slotId };
}

/** The time a possible send is matched around: the intent, or the unexpected navigation (P3-R40). */
const anchorOf = (job: Job, attemptId: string): Date => {
  const a = job.attempts.find((x) => x.id === attemptId);
  return new Date(a?.submit_intent_at ?? a?.completed_at ?? job.updated_at);
};

const titleOf = (job: Job): string => {
  const t = (job.draft as { title?: unknown } | null)?.title;
  return typeof t === 'string' ? t : '（タイトル不明）';
};

/** The operator's task for a job automatic reconcile could not settle (plan §11 "operator reconcile"). */
export const operatorReconcileJa = (job: Job): string =>
  `SALON BOARD の投稿一覧で、タイトル「${titleOf(job)}」（${formatJst(anchorOf(job, job.reconcile?.attempt_id ?? ''))} 頃）が登録されているか確認し、npm.cmd run reconcile -- --id ${job.id} --registered か --not-registered --basis "確認内容" を実行してください。`;

/** The list page's own path as a URL on the send-time route's origin (never another origin). */
export function remoteUrlOf(job: Job, attemptId: string, path: string | null | undefined): string | null {
  const entry = job.attempts.find((a) => a.id === attemptId)?.route?.entry_url;
  const origin = entry === undefined ? null : (URL.parse(entry)?.origin ?? null);
  const url = origin !== null && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? URL.parse(path, origin) : null;
  return url !== null && url.origin === origin ? `${url.origin}${url.pathname}` : null;
}

/**
 * POSTED from screen evidence or the operator's verdict (D3): evidence saved (best effort), the bundle move that tolerates a
 * failed rename (R32), then the post-commit records (slot done, dedupe, history, first post / live_single).
 */
export async function commitScreenPost(
  d: Pick<OpsDeps, 'bundles' | 'logger' | 'paths' | 'scheduler' | 'dedupe' | 'history' | 'control' | 'clock'>,
  job: Job,
  attemptId: string,
  o: { postedAt: Date; source: NonNullable<Job['posted_at_source']>; remoteId: string | null; remoteUrl: string | null; evidence: { name: EvidenceName; data: unknown } | null; patch?: Partial<Job> },
): Promise<Job> {
  const fields = { job_id: job.id, attempt_id: attemptId, post_type: job.post_type, audience_category: job.audience_category };
  const refs: string[] = [];
  if (o.evidence !== null) {
    try {
      refs.push(await writeEvidence(d.paths, job.id, attemptId, o.evidence.name, o.evidence.data));
    } catch (err) {
      d.logger.warn('EVIDENCE_NOT_SAVED', `登録の証跡を保存できませんでした（投稿の記録は続けます）: ${job.id}`, { ...fields, error_code: errorCodeOf(err) });
    }
  }
  const now = d.clock.now();
  const { job: posted } = await d.bundles.transitionOrDetect(
    job.id,
    job.revision,
    (j) => ({
      ...markPosted(j, attemptId, { now, postedAt: o.postedAt.toISOString(), source: o.source, remoteId: o.remoteId, remoteUrl: o.remoteUrl, evidenceRefs: refs }),
      ...o.patch,
    }),
    (latest) => latest.status === 'POSTED',
  );
  await commitPosted({ scheduler: d.scheduler, dedupe: d.dedupe, ...(d.history === undefined ? {} : { history: d.history }), control: d.control, logger: d.logger }, posted, slotOf(posted));
  const claimed = posted.attempts.find((a) => a.id === attemptId)?.claimed_at ?? null;
  d.logger.info('JOB_POSTED', `SALON BOARD への投稿が完了しました: ${job.id}`, {
    ...fields,
    stage: posted.stage,
    retry_count: posted.retry_count,
    duration_ms: claimed === null ? null : Math.max(0, now.getTime() - Date.parse(claimed)),
    posted_at_source: posted.posted_at_source,
  });
  return posted;
}

/** Statuses a late `found` may move to POSTED (nothing of the job is in flight). */
const SETTLED: ReadonlySet<JobStatus> = new Set<JobStatus>(['VERIFY_REQUIRED', 'FAILED', 'READY', 'RETRY_WAIT', 'BLOCKED']);

/**
 * A post proven for `attemptId` contradicts what was concluded for that attempt itself (the operator's "not registered"
 * leaves it definitely_not_submitted), a failed end or a newer attempt. A verdict on an earlier attempt does not count.
 */
export const contradicts = (job: Job, attemptId: string): boolean =>
  job.attempts.find((a) => a.id === attemptId)?.submission_state === 'definitely_not_submitted' || job.status === 'FAILED' || job.attempts.at(-1)?.id !== attemptId;

/**
 * P3-R42: screen evidence (one candidate, the salon identified) that `attemptId` registered the post, applied even late.
 * If the operator said "not registered" meanwhile, or another attempt exists or posted, the post is still recorded, the
 * salon stops (reconcile_conflict) and retry is blocked. Returns null when the job was already POSTED (nothing new).
 */
export async function applyScreenFound(
  d: OpsDeps,
  job: Job,
  attemptId: string,
  o: { evidence: Evidence; registeredAtText: string | null | undefined; evidenceName: EvidenceName },
): Promise<Job | null> {
  if (job.status === 'POSTED') {
    if (job.attempts.find((a) => a.submission_state === 'confirmed')?.id !== attemptId) await conflictStop(d, job);
    return null;
  }
  const conflict = contradicts(job, attemptId);
  if (conflict) await conflictStop(d, job);
  if (!SETTLED.has(job.status)) throw new ApiError(503, 'BUSY', 'この投稿は処理中のため、少し待ってから照合の結果を受け取ります。', true);
  const anchor = anchorOf(job, attemptId);
  const read = parseRegisteredAt(o.registeredAtText);
  const inWindow = read !== null && read.getTime() >= anchor.getTime() - 2 * 60_000 && read.getTime() <= anchor.getTime() + 30 * 60_000;
  const matched = o.evidence.list?.matched ?? null;
  const now = d.clock.now();
  const rec = job.reconcile;
  return commitScreenPost(d, job, attemptId, {
    postedAt: inWindow ? read : anchor,
    source: inWindow ? 'screen' : 'intent_estimate',
    remoteId: matched?.remote_post_id ?? null,
    remoteUrl: matched === null ? null : remoteUrlOf(job, attemptId, matched.detail_url_path),
    evidence: { name: o.evidenceName, data: o.evidence },
    patch: {
      ...(rec === null ? {} : { reconcile: { ...rec, last_outcome: 'found' as const, last_at: now.toISOString(), next_auto_at: null, operator_needed: false, in_flight_command_id: null } }),
      ...(conflict ? { retry_blocked_reason: 'reconcile_conflict' as const } : {}),
    },
  });
}

/**
 * An automatic reconcile result. `current`: it answers the command in flight for this job. A `found` is screen evidence
 * (applyScreenFound). Anything else counts as a try: +5 min, +15 min, then the operator.
 */
export async function applyAutoReconcile(d: OpsDeps, jobId: string, req: AutoReconcileRequest, current: boolean): Promise<{ job_status: JobStatus; reconcile_outcome: AutoReconcileRequest['outcome'] }> {
  const job = await d.store.get(jobId);
  const rec = job?.reconcile ?? null;
  if (job === null || rec === null) throw new ApiError(409, 'STALE_COMMAND', 'この照合の指示は現在のものではありません。');
  if (req.outcome === 'found' && foundOnList(req.evidence)) {
    const posted = await applyScreenFound(d, job, rec.attempt_id, { evidence: req.evidence, registeredAtText: req.observed?.registered_at_text, evidenceName: `reconcile-${rec.auto_count + 1}` });
    if (posted !== null) d.logger.info('VERIFY_SUCCEEDED', `自動照合で登録を画面で確認しました: ${job.id}`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'reconcile' });
    return { job_status: 'POSTED', reconcile_outcome: 'found' };
  }
  if (job.status === 'POSTED') return { job_status: 'POSTED', reconcile_outcome: req.outcome };
  if (!current) throw new ApiError(409, 'STALE_COMMAND', 'この照合の指示は現在のものではありません。');
  const next = await countReconcileTry(d, job, req.outcome === 'found' ? 'ambiguous' : req.outcome, req.evidence);
  // Unattended operation (owner, 2026-10-07): the last automatic try still finds no candidate on any checked list page →
  // "not registered" like the operator's verdict (FAILED, never re-sent), so it stops blocking the schedule.
  const list = req.evidence?.list ?? null;
  if (next.reconcile?.operator_needed === true && req.outcome === 'not_found' && list !== null && list.all_pages && list.candidates === 0) {
    const r = await applyOperatorReconcile(d, job.id, { verdict: 'not_registered', basis: AUTO_NOT_FOUND_BASIS }, false, true);
    return { job_status: r.status === 200 ? r.body.job_status : next.status, reconcile_outcome: req.outcome };
  }
  return { job_status: next.status, reconcile_outcome: req.outcome };
}

const AUTO_NOT_FOUND_BASIS = '自動照合（3回）で投稿一覧に見つかりませんでした';

/**
 * A reconcile try without a unique match (or one that never reported: 'error', evidence null): the next try +5 / +15 min,
 * after the third the operator decides (VERIFY_REQUIRED logged with the task).
 */
export async function countReconcileTry(d: Pick<OpsDeps, 'store' | 'clock' | 'logger' | 'paths'>, job: Job, outcome: 'not_found' | 'ambiguous' | 'error', evidence: Evidence | null): Promise<Job> {
  const rec = job.reconcile!;
  const now = d.clock.now();
  const count = rec.auto_count + 1;
  const delay = RECONCILE_DELAYS_MS[count];
  const ref = evidence === null ? null : await writeEvidence(d.paths, job.id, rec.attempt_id, `reconcile-${count}`, evidence).catch(() => null);
  const next = await d.store.update(job.id, job.revision, (j) => ({
    ...j,
    reconcile: { ...rec, auto_count: count, in_flight_command_id: null, last_at: now.toISOString(), last_outcome: outcome, next_auto_at: delay === undefined ? null : new Date(now.getTime() + delay).toISOString(), operator_needed: delay === undefined },
    attempts: ref === null ? j.attempts : j.attempts.map((a) => (a.id === rec.attempt_id ? { ...a, evidence_refs: [...a.evidence_refs, ref] } : a)),
  }));
  const fields = { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'reconcile', reconcile_outcome: outcome, auto_count: count };
  if (delay === undefined) d.logger.error('VERIFY_REQUIRED', `自動照合で登録を確認できませんでした。${operatorReconcileJa(next)}`, fields);
  else d.logger.info('RECONCILE_RETRY', `自動照合で登録を確認できなかったため、${formatJst(new Date(now.getTime() + delay))} にもう一度照合します: ${job.id}`, fields);
  return next;
}

/** P3-R42: a post the operator called "not registered" (or a newer attempt's job) is on the screen. */
async function conflictStop(d: OpsDeps, job: Job): Promise<void> {
  await d.stops.raise('POST_RESULT_UNKNOWN', {}, { jobId: job.id, detail: 'reconcile_conflict' });
  d.logger.error('RECONCILE_CONFLICT', `${CONFLICT_ACTION_JA}（${job.id}）`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category });
}

const notVerifyRequired = (job: Job, dryRun: boolean): ApiError =>
  new ApiError(409, 'STALE_COMMAND', `${job.id} は結果不明（VERIFY_REQUIRED）ではないため、照合の記録はできません。${dryRun ? '' : '状態は npm.cmd run status で確認できます。'}`);

/**
 * The operator's reconcile (`npm.cmd run reconcile`): --registered → POSTED, --not-registered → FAILED (not counted, retry
 * allowed), no verdict → an automatic reconcile now. `inFlight`: an automatic reconcile of this job is running (409 BUSY).
 * Never re-sends anything (15.3-g).
 */
export async function applyOperatorReconcile(
  d: OpsDeps,
  jobId: string,
  req: Omit<OperatorReconcileRequest, 'protocol_version' | 'request_id'>,
  inFlight: boolean,
  auto = false,
): Promise<{ status: 200; body: { job_status: JobStatus; reconcile_outcome: 'registered' | 'not_registered' } } | { status: 202; body: { scheduled_at: string } }> {
  const job = await d.store.get(jobId);
  if (job === null) throw new ApiError(404, 'NOT_FOUND', `job「${jobId}」が見つかりません。status で job_id を確認してください。`);
  const dryRun = d.mode === 'dry_run';
  if (job.status !== 'VERIFY_REQUIRED') throw notVerifyRequired(job, dryRun);
  if (inFlight) throw new ApiError(409, 'BUSY', VERDICT_BUSY_JA, true);
  const now = d.clock.now();
  const attempt = job.attempts.at(-1)!;
  const rec = job.reconcile ?? { attempt_id: attempt.id, auto_count: 0, next_auto_at: null, last_at: null, last_outcome: null, operator_needed: false, in_flight_command_id: null };
  const fields = { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'reconcile' };
  if (req.verdict === undefined) {
    if (dryRun) throw new ApiError(409, 'STALE_COMMAND', 'dry-run では自動照合はしません（擬似投稿は SALON BOARD に送信していません）。--registered か --not-registered --basis "確認内容" で擬似投稿の結果を記録してください。');
    await d.store.update(job.id, job.revision, (j) => ({ ...j, reconcile: { ...rec, auto_count: 0, next_auto_at: now.toISOString(), operator_needed: false, in_flight_command_id: null } }));
    d.logger.info('RECONCILE_SCHEDULED', `自動照合を予約しました: ${job.id}`, fields);
    return { status: 202, body: { scheduled_at: now.toISOString() } };
  }
  const verdict = { verdict: req.verdict, at: now.toISOString(), basis: req.basis! };
  if (req.verdict === 'registered') {
    const url = req.remote_post_url === undefined ? null : new URL(req.remote_post_url);
    if (url !== null && !d.config().salonboardFields.allowed_origins.includes(url.origin)) {
      throw new ApiError(422, 'INVALID_REQUEST', '投稿のURLが SALON BOARD の接続先（allowed_origins）ではありません。');
    }
    const at = req.registered_at_jst === undefined ? null : jstToUtc(req.registered_at_jst.slice(0, 10), parseHHmm(req.registered_at_jst.slice(11)));
    const posted = await commitScreenPost(d, job, attempt.id, {
      postedAt: at ?? anchorOf(job, attempt.id),
      source: at === null ? 'intent_estimate' : 'operator',
      remoteId: null,
      remoteUrl: url === null ? null : `${url.origin}${url.pathname}`,
      evidence: { name: 'operator-reconcile', data: { verdict: 'registered', basis: verdict.basis, registered_at_jst: req.registered_at_jst ?? null, remote_post_url: req.remote_post_url ?? null, at: verdict.at } },
      patch: { operator_verdict: verdict, reconcile: { ...rec, operator_needed: false, next_auto_at: null, in_flight_command_id: null } },
    });
    d.logger.info('RECONCILE_OPERATOR', `運用者の確認で「登録あり」と記録しました: ${job.id}`, { ...fields, verdict: 'registered' });
    return { status: 200, body: { job_status: posted.status, reconcile_outcome: 'registered' } };
  }
  const message = auto ? '自動照合を3回行っても投稿一覧に見つからないため「登録なし」と判断しました（二重投稿を避けるため、自動では送り直しません）。' : dryRun ? '運用者が擬似投稿を「登録なし」と記録しました（SALON BOARD には送信していません）。' : '運用者が SALON BOARD の画面で「登録なし」と確認しました。';
  const error = appError('POST_RESULT_UNKNOWN', 'reconcile', d.clock, {
    message,
    retryable: true,
    submission_state: 'definitely_not_submitted',
    details: { ...job.last_error?.details_redacted, resolved: true, basis: verdict.basis },
  });
  const failed = await d.bundles.transition(job.id, job.revision, (j) => {
    assertTransition(j.status, 'FAILED', { intentRecorded: true, operatorNotRegistered: true });
    return {
      ...j,
      status: 'FAILED',
      stage: 'reconcile',
      submission_state: 'definitely_not_submitted',
      last_error: error,
      operator_verdict: verdict,
      reconcile: { ...rec, operator_needed: false, next_auto_at: null, in_flight_command_id: null },
      attempts: j.attempts.map((a) => (a.id === attempt.id ? { ...a, submission_state: 'definitely_not_submitted', error } : a)),
    };
  });
  await writeEvidence(d.paths, job.id, attempt.id, 'operator-reconcile', { verdict: 'not_registered', basis: verdict.basis, at: verdict.at }).catch(() => undefined);
  const slot = slotOf(failed);
  if (slot !== null) await d.scheduler.release(slot.date, slot.slotId, job.id, 'not_registered').catch(() => undefined);
  await writeFailureFile(d.paths, failed, d.clock).catch(() => undefined);
  await onJobFinal(d.control, failed, d.logger);
  d.logger.info('RECONCILE_OPERATOR', `${auto ? '自動照合で' : '運用者の確認で'}「登録なし」と記録しました（失敗として保存し、retry で再開できます）: ${job.id}`, { ...fields, verdict: 'not_registered' });
  return { status: 200, body: { job_status: 'FAILED', reconcile_outcome: 'not_registered' } };
}

/** status.operator_actions: jobs automatic reconcile handed to the operator, and P3-R42 conflicts to check on the screen. */
export async function operatorActions(store: Pick<JobStore, 'summaries' | 'get'>, control: Pick<ControlStore, 'get'>): Promise<{ job_id: string; action_ja: string }[]> {
  const out: { job_id: string; action_ja: string }[] = [];
  for (const s of store.summaries((x) => x.status === 'VERIFY_REQUIRED' && x.reconcile_next_at === null)) {
    const job = await store.get(s.id).catch(() => null);
    if (job?.reconcile?.operator_needed === true) out.push({ job_id: job.id, action_ja: operatorReconcileJa(job) });
  }
  for (const stop of control.get().stops) {
    if (stop.detail === 'reconcile_conflict' && stop.job_id !== null) out.push({ job_id: stop.job_id, action_ja: CONFLICT_ACTION_JA });
  }
  return out;
}
