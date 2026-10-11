import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ContentPipeline } from '../execution/job-processor.js';
import type { ScheduleStore } from '../execution/schedule-store.js';
import type { Dispatch, Scheduler } from '../execution/scheduler.js';
import { blockingUnresolved } from '../execution/scheduler.js';
import { windowEndFor } from '../execution/slots.js';
import { SubmitGap } from '../execution/submit-gap.js';
import { slotDate } from '../execution/startup-recovery.js';
import type { ReadinessItem } from '../config/readiness.js';
import type { EffectiveConfig } from '../content/effective-config.js';
import type { InstructionScanResult } from '../content/instructions/store.js';
import type { AppLogger, LogFields } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, ERROR_CODES, appError, errorCodeOf, errorText, type ErrorCode } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import { newId } from '../shared/ids.js';
import type { Job } from '../shared/job-schema.js';
import type { HelloRequest, LiveSinglePreview, Phase, SubmitIntentRequest, SubmitIntentResponse } from '../shared/protocol/api.js';
import type { Command, PreflightCommand, ReconcileCommand } from '../shared/protocol/commands.js';
import type { PageProfile } from '../shared/protocol/profile.js';
import type { AutoReconcileRequest, Evidence, OperatorReconcileRequest, PreflightResult, PreflightResultRequest, ResultRequest } from '../shared/protocol/results.js';
import type { StopDto } from '../shared/protocol/status.js';
import { ROUTE_KEYS, type ApiErrorCode, type RouteKey } from '../shared/protocol/version.js';
import { wrongLoginJa } from '../shared/labels.js';
import { formatJst, jstDateKey } from '../shared/time.js';
import type { AudienceCategory, JobStatus, Mode, PostType } from '../shared/types.js';
import type { UrlPolicy } from '../shared/url-policy.js';
import type { BundleMover, RecoveryHalt } from '../storage/bundles.js';
import type { ControlStore } from '../storage/control-store.js';
import type { DedupeStore } from '../storage/dedupe-store.js';
import { writeFailureFile } from '../storage/failure-file.js';
import type { HistoryStore } from '../storage/history-store.js';
import type { JobStore, JobSummary } from '../storage/job-store.js';
import type { DataPaths } from '../storage/paths.js';
import type { RuntimeStatusWriter } from '../storage/runtime-status.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { ApiError } from '../server/errors.js';
import { endPreIntent, markSubmitted, markUnknown, recordIntent, startAttempt } from './attempts.js';
import { applyPreflightResult, liveSingle, preflightTargets, resume, schedulePreflight } from './control-service.js';
import type { RefreshResult } from './effective-refresh.js';
import { buildPostCommand, matchKeysFor, renderFormInputs } from './form-inputs.js';
import { DRY_RUN_JA, firstPostState, gate, gateRefusals, isDispatchable, type CommandKind, type DispatchContext, type GateContext, type GateRefusal, type Pressure } from './gates.js';
import type { IntentLedger } from './intent-ledger.js';
import { bindingChanged, disarm, LIVE_SINGLE_CHANGED_JA, onJobFinal } from './live-single.js';
import { profileHash } from './profile-hash.js';
import { otherRoutesFor, resolveRoute } from './profile/route-resolve.js';
import { oursPostedFrom, remainingQuota, unresolvedFrom } from './quota.js';
import { applyAutoReconcile, applyOperatorReconcile, applyScreenFound, commitScreenPost, contradicts, countReconcileTry, parseRegisteredAt, provesPost, remoteUrlOf, slotOf, type OpsDeps } from './reconcile.js';
import { redraft, retryEligible, retryOne, type RedraftResult, type Restart } from './retry-service.js';
import { dispose, type Disposition } from './retry-policy.js';
import { STOP_SCOPE, stopDto, type StopCode, type StopRegistry } from './stops.js';
import {
  CLAIM_IDEMPOTENCY_MS,
  CONNECTED_WITHIN_MS,
  INTENT_MIN_WINDOW_MS,
  MAINTAIN_INTERVAL_MS,
  PERMISSION_TTL_MAX_MS,
  PERMISSION_WINDOW_MARGIN_MS,
  POST_INTENT_TIMEOUT_FACTOR,
  PREFLIGHT_EXPIRY_MS,
  PRE_INTENT_TIMEOUT_FACTOR,
  RECONCILE_MAX_AUTO,
  UNUSED_PERMISSION_GRACE_MS,
} from './timing.js';
import { assertTransition } from './transitions.js';
import { constraintsHash, prepareUploadImage } from './upload-image.js';

// The live poster's single source of truth (plan Task 2b, §5.2): one command in flight, claim → submit intent → result,
// the §5.5 gates re-checked at claim and at intent, and its own maintain timer (never the RunLoop, so a long AI call
// never delays a timeout, a pause or a carry-over). Lock order: coordinator → scheduler → bundle mover → store queue;
// the JobProcessor's lock is never taken (regeneration goes through its lock-free notifyRegeneration).

export interface Readiness {
  global: ReadinessItem[];
  routes: Record<RouteKey, ReadinessItem[]>;
}

export interface CoordinatorDeps {
  mode: Mode;
  clock: Clock;
  store: JobStore;
  bundles: BundleMover;
  scheduler: Pick<Scheduler, 'tick' | 'release' | 'closeQuota' | 'holdFor' | 'complete'>;
  dedupe: DedupeStore;
  history?: Pick<HistoryStore, 'upsert'>;
  control: ControlStore;
  stops: StopRegistry;
  /** `stop`: why the processor last found AI work stopped (null: it runs). */
  processor: { notifyRegeneration(id: string): void; readonly stop: { message: string } | null };
  /** The deterministic Validator plus duplicates (no AI call): Plan 2's A41 recheck. */
  pipeline: Pick<Required<ContentPipeline>, 'recheck'>;
  refresh: (now: Date) => Promise<RefreshResult>;
  getEffective: () => EffectiveConfig;
  instructions: () => InstructionScanResult | null;
  /** checkLiveReadiness for the effective config (readiness relaxations, if any, are the runtime's). */
  readiness: (effective: EffectiveConfig, now: Date) => Readiness;
  getHalts: () => readonly RecoveryHalt[];
  ledger: IntentLedger;
  paths: DataPaths;
  logger: AppLogger;
  instanceId: string;
  urlPolicy: UrlPolicy;
  /** Drafts of the mock provider count as real (tests only; P3-R41). */
  acceptMockDrafts: boolean;
  runtimeStatus?: Pick<RuntimeStatusWriter, 'setExtension'>;
  /** The day's plan, for the next slot a live_single arming names. */
  schedules?: Pick<ScheduleStore, 'load'>;
  random?: () => number;
  maintainMs?: number;
}

interface InFlight {
  kind: 'post' | 'reconcile' | 'preflight';
  command: Command;
  job_id: string;
  attempt_id: string;
  command_id: string;
  client_id: string;
  phase: Phase | 'claimed';
  claimedAt: number;
  lastArrival: number;
  /** Set when the permission was issued. */
  permission: { at: number; ttl: number } | null;
  /** clicking / clicked / submitted seen after the permission. */
  clicked: boolean;
}

type Outcome = { job_status: JobStatus; idempotent_replay: boolean; applied: boolean };

/** A hello abandons this client's command only after it has been silent this long (3 SW heartbeats). */
const HELLO_SILENCE_MS = 30_000;
const AFTER_CLICK: ReadonlySet<string> = new Set(['clicking', 'clicked', 'verifying_completion', 'verifying_list']);
const stale = (message = 'この送信の指示は現在のものではありません。'): ApiError => new ApiError(409, 'STALE_COMMAND', message);
const isErrorCode = (c: string): c is ErrorCode => (ERROR_CODES as readonly string[]).includes(c);

/** P3-R14: the only way a post-intent outcome may end as "not registered". */
function exceptionEvidence(req: ResultRequest): boolean {
  const e = req.evidence;
  return (
    req.code === 'SUBMIT_FAILED' &&
    e !== null &&
    e.rejection?.client_side_only === true &&
    e.rejection.navigated === false &&
    e.completion?.matched !== true &&
    e.list?.all_pages === true &&
    e.list.candidates === 0
  );
}

/** A writing-policy instruction for the job's type and audience changed (or appeared) since its draft (P3-R29). */
function policyDrift(job: Job, scan: InstructionScanResult | null): boolean {
  const item = `writing_policies.${job.post_type}.${job.audience_category}`;
  const have = new Set(job.instruction_refs.map((r) => `${r.file_name}\u0000${r.sha256}`));
  return (scan?.applied ?? []).some((a) => a.items.includes(item) && !have.has(`${a.file}\u0000${a.sha256}`));
}

export class LivePostingCoordinator {
  readonly #d: CoordinatorDeps;
  readonly #lock = new SerialQueue();
  readonly #gap: SubmitGap;
  #cur: InFlight | null = null;
  #pressure: Pressure | null = null;
  #lastRejected = false;
  #gatedKey: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #maintaining: Promise<void> | null = null;
  #ext: { clientId: string; lastSeen: number; version: string; loggedIn: boolean | null; tab: HelloRequest['tab']['state']; connected: boolean; written: number; salonShown: string | null } | null = null;
  /** Ticks evaluate the scheduler predicates against this claim's context (null: not inside a claim → always true). */
  #tickCtx: { dispatch: DispatchContext; typeOk: (t: PostType) => { ok: true } | { ok: false; close: 'type_stopped' | 'quota_reached' } } | null = null;

  /** The reconcile / retry / control services' view of the same stores. */
  readonly #ops: OpsDeps;

  constructor(d: CoordinatorDeps) {
    this.#d = d;
    this.#gap = new SubmitGap({ control: d.control, jobs: d.store, getSettings: () => d.getEffective().base.settings, logger: d.logger });
    this.#ops = {
      mode: d.mode,
      clock: d.clock,
      logger: d.logger,
      paths: d.paths,
      store: d.store,
      bundles: d.bundles,
      control: d.control,
      stops: d.stops,
      dedupe: d.dedupe,
      history: d.history,
      scheduler: d.scheduler,
      config: () => d.getEffective().base,
    };
  }

  // ---------------------------------------------------------------- scheduler predicates (used only inside a claim)

  isRouteAvailable(t: PostType, a: AudienceCategory): boolean {
    return this.#tickCtx === null || this.#tickCtx.dispatch.routeOk(`${t}.${a}`);
  }

  isTypeAvailable(t: PostType): { ok: true } | { ok: false; close: 'type_stopped' | 'quota_reached' } {
    return this.#tickCtx === null ? { ok: true } : this.#tickCtx.typeOk(t);
  }

  isJobDispatchable(s: JobSummary): boolean {
    return this.#tickCtx === null || isDispatchable(s, this.#tickCtx.dispatch);
  }

  // ---------------------------------------------------------------- views

  /** Memory only. */
  current(): { kind: InFlight['kind']; job_id: string; attempt_id: string; command_id: string; client_id: string; phase: string; last_heartbeat_arrival: string } | null {
    const c = this.#cur;
    return c === null
      ? null
      : { kind: c.kind, job_id: c.job_id, attempt_id: c.attempt_id, command_id: c.command_id, client_id: c.client_id, phase: c.phase, last_heartbeat_arrival: new Date(c.lastArrival).toISOString() };
  }

  /** The current resource stop of new posts (the Plan 4 monitor leaves a DISK_FULL to the probe write). */
  get resourcePressure(): Pressure | null {
    return this.#pressure;
  }

  setResourcePressure(code: Pressure | null): void {
    if (code === this.#pressure) return;
    this.#pressure = code;
    if (code === null) this.#d.logger.info('RESOURCE_PRESSURE_CLEARED', '資源の不足が解消したため、新しい投稿を再開できます。');
    else this.#d.logger.warn('RESOURCE_PRESSURE', `資源が不足しているため、新しい投稿を止めています（${code}）。照合は続けます。`, { error_code: code });
  }

  /** A failed write anywhere: a full disk stops new posts until a probe write works again (15.1-q). */
  noteFailure(err: unknown): void {
    if (errorCodeOf(err) === 'DISK_FULL') this.setResourcePressure('DISK_FULL');
  }

  /** The §5.5 rows that currently refuse a post, and the stops (status and hello). */
  dispatchView(): { dispatch: { post_allowed: boolean; reasons: { code: ApiErrorCode; message_ja: string }[] }; stops: StopDto[] } {
    const refusals = gateRefusals('post', this.#gateContext(null, this.#now()));
    return { dispatch: { post_allowed: refusals.length === 0, reasons: refusals.map((r) => ({ code: r.code, message_ja: r.reason_ja })) }, stops: this.#d.control.get().stops.map(stopDto) };
  }

  /** The one record of the extension (hello), connected while any authenticated request of it arrived within 90 s. */
  extensionView(): { version: string | null; logged_in: boolean | null; tab_state: string | null; connected: boolean; last_seen: Date | null } {
    const e = this.#ext;
    const connected = e !== null && this.#now().getTime() - e.lastSeen <= CONNECTED_WITHIN_MS;
    return { version: e?.version ?? null, logged_in: e?.loggedIn ?? null, tab_state: e?.tab ?? null, connected, last_seen: e === null ? null : new Date(e.lastSeen) };
  }

  /** Any authenticated request of the extension (heartbeats included: the SW sends no hello while a command runs). */
  noteSeen(clientId: string, at: Date): void {
    if (this.#ext?.clientId === clientId) this.#ext.lastSeen = Math.max(this.#ext.lastSeen, at.getTime());
  }

  // ---------------------------------------------------------------- hello

  hello(clientId: string, req: HelloRequest): Promise<{ dispatch: ReturnType<LivePostingCoordinator['dispatchView']>['dispatch']; stops: StopDto[]; probe_gate: boolean; survey_gate: boolean }> {
    return this.#lock.run(async () => {
      const now = this.#now();
      this.#noteExtension(clientId, req, now);
      // Step 0: this client's command silent for a while is abandoned (the SW recovers its own restart locally). A
      // preflight sends no heartbeats: only its result or its expiry ends it.
      const cur = this.#cur;
      if (cur !== null && cur.client_id === clientId && cur.kind !== 'preflight' && now.getTime() - cur.lastArrival > HELLO_SILENCE_MS) await this.#abandon(cur, 'hello_without_command');
      const ctx = this.#gateContext(null, now);
      const view = this.dispatchView();
      return { dispatch: view.dispatch, stops: view.stops, probe_gate: gate('probe', ctx).ok, survey_gate: gate('survey', ctx).ok };
    });
  }

  // ---------------------------------------------------------------- claim

  claim(clientId: string): Promise<{ command: Command } | null> {
    return this.#lock.run(() => this.#claim(clientId));
  }

  async #claim(clientId: string): Promise<{ command: Command } | null> {
    const now = this.#now();
    const cur = this.#cur;
    // 1. The same client asking again for a command it has not started yet gets it again (P3-R49).
    if (cur !== null && cur.client_id === clientId && cur.phase === 'claimed' && now.getTime() - cur.claimedAt < CLAIM_IDEMPOTENCY_MS) return { command: cur.command };
    // Dry-run serves nothing but a preflight (P3-R34).
    const live = this.#d.mode === 'live';
    if (!live && !this.#preflightWaiting()) return null;
    // 3. Refresh, 4. one command in flight.
    const r = await this.#d.refresh(now);
    this.#lastRejected = r.rejected;
    if (cur !== null) return null;
    const readiness = live ? this.#d.readiness(r.effective, now) : null;
    const ctx = this.#gateContext(r, now, readiness ?? undefined);
    // 5. A due reconcile goes first; pause, pressure, halts and a rejected config do not block it (§5.5). Never in dry-run.
    const reconcile = await this.#reconcileCommand(clientId, ctx, r.effective, now);
    if (reconcile !== null) return { command: reconcile };
    // 6. A pending preflight (also in dry-run, during pause and under stops: P3-R34, P3-R35).
    const preflight = await this.#preflightCommand(clientId, ctx, r.effective, now);
    if (preflight !== null) return { command: preflight };
    if (!live || readiness === null) return null;
    // 7. The post gates.
    const g = gate('post', ctx);
    this.#noteGated(g.ok ? null : g);
    if (!g.ok) return null;
    const dispatch = this.#dispatchContext(r.effective, readiness, now);
    const typeOk = (t: PostType): { ok: true } | { ok: false; close: 'type_stopped' | 'quota_reached' } => {
      if (this.#d.stops.blocksType(t) !== null) return { ok: false, close: 'type_stopped' };
      return this.#quota(r.effective, t, now, null, null).kind === 'ok' ? { ok: true } : { ok: false, close: 'quota_reached' };
    };
    // 8. A due retry holding its slot, 9. the scheduler's tick.
    let picked: { job: Job; isRetry: boolean } | null = await this.#dueRetry(r.effective, dispatch, typeOk, now);
    if (picked === null) {
      this.#tickCtx = { dispatch, typeOk };
      let d: Dispatch | null;
      try {
        d = await this.#d.scheduler.tick();
      } finally {
        this.#tickCtx = null;
      }
      if (d !== null) picked = { job: d.job, isRetry: d.job.status === 'RETRY_WAIT' };
    }
    return picked === null ? null : this.#start(picked.job, picked.isRetry, clientId, r.effective, now);
  }

  async #dueRetry(eff: EffectiveConfig, dispatch: DispatchContext, typeOk: (t: PostType) => { ok: boolean }, now: Date): Promise<{ job: Job; isRetry: true } | null> {
    const due = this.#d.store
      .summaries((s) => s.status === 'RETRY_WAIT' && s.schedule_slot_id !== null && s.next_retry_at !== null && Date.parse(s.next_retry_at) <= now.getTime())
      .sort((a, b) => Date.parse(a.next_retry_at!) - Date.parse(b.next_retry_at!));
    for (const s of due) {
      if (!typeOk(s.post_type).ok || !isDispatchable(s, dispatch) || !this.#gapOk(now)) continue;
      const job = await this.#d.store.get(s.id);
      const slotId = job?.schedule_slot_id ?? null;
      const date = slotId === null ? null : slotDate(slotId);
      if (job === null || slotId === null || date === null || job.scheduled_at === null) continue;
      // Only within the window holding its slot (a retry never moves to another window of the day by itself).
      if (windowEndFor(eff.schedule, new Date(job.scheduled_at))?.getTime() !== dispatch.windowEnd?.getTime()) continue;
      if (await this.#d.scheduler.holdFor(date, slotId, job.id)) return { job, isRetry: true };
    }
    return null;
  }

  /** Step 10: READY / RETRY_WAIT → POSTING with a new attempt, then the per-job checks; any failure ends it before intent. */
  async #start(job0: Job, isRetry: boolean, clientId: string, eff: EffectiveConfig, now: Date): Promise<{ command: Command } | null> {
    const { control, logger } = this.#d;
    const resolved = resolveRoute(eff, job0.post_type, job0.audience_category, this.#d.urlPolicy);
    if (!resolved.ok) {
      await this.#releaseSlot(job0, 'route_unavailable');
      return null;
    }
    const { snapshot: route, profile } = resolved;
    const attemptId = newId('att');
    const commandId = newId('cmd');
    let job: Job;
    try {
      job = await this.#move(job0, (j) => startAttempt(j, { attemptId, commandId, instanceId: this.#d.instanceId, clientId, now, route, configHash: eff.hash, isRetry }));
    } catch (err) {
      logger.warn('CLAIM_NOT_STARTED', `投稿を始められませんでした（次の確認でもう一度試します）: ${job0.id}（${errorText(err)}）`, { job_id: job0.id, error_code: errorCodeOf(err) });
      if (job0.status === 'READY') await this.#releaseSlot(job0, 'interrupted');
      return null;
    }
    const bound = control.get().live_single;
    if (bound !== null && (bound.job_id !== job.id || bindingChanged(bound, job))) {
      if (bound.job_id === job.id) await disarm(control, job.id, logger);
      await this.#endPre(job, 'STALE_COMMAND', { message: LIVE_SINGLE_CHANGED_JA, details: { reason: 'live_single_binding' } });
      return null;
    }
    const content = await this.#contentRefusal(job);
    if (content !== null) {
      await this.#endPre(job, content.code, { message: content.message, details: content.details });
      return null;
    }
    if (job.upload === null || job.upload.constraints_hash !== constraintsHash(profile.image)) {
      await this.#endPre(job, 'BUSY', { message: '投稿用の画像の準備ができていません（準備を待ちます）。' });
      return null;
    }
    const label = eff.base.salon.expected_account_label ?? '';
    const rendered = await renderFormInputs(job, profile, eff.base, this.#bundleDir(job));
    if (!rendered.ok) {
      await this.#endPre(job, 'CONFIG_INCOMPLETE', { message: rendered.message, details: { config_hash: eff.hash } });
      return null;
    }
    const command = buildPostCommand(job, { route, profile, otherRoutes: otherRoutesFor(eff, route.route_key), inputs: rendered.inputs, label, liveSingle: bound !== null, isRetry });
    this.#cur = { kind: 'post', command, job_id: job.id, attempt_id: attemptId, command_id: commandId, client_id: clientId, phase: 'claimed', claimedAt: now.getTime(), lastArrival: now.getTime(), permission: null, clicked: false };
    logger.info('CLAIMED', `投稿を拡張機能に渡しました: ${job.id}`, this.#fields(job, { route_key: route.route_key, is_retry: isRetry, live_single: bound !== null }));
    return { command };
  }

  /** Provenance (live), image duplicates, writing-policy drift and the deterministic Validator with duplicates (P3-R29, P3-R41). */
  async #contentRefusal(job: Job): Promise<{ code: ApiErrorCode; message: string; details: Record<string, unknown> } | null> {
    const prov = job.draft_provenance;
    if (prov === null || (prov.provider === 'mock' && !this.#d.acceptMockDrafts)) {
      return { code: 'VALIDATION_FAILED', message: '本番用のAIで作られた文章ではないため、作り直します。', details: { reason: 'provenance' } };
    }
    const other = this.#d.dedupe.findByImage(job.post_type, job.image.sha256);
    if (other !== undefined && other.job_id !== job.id) {
      return { code: 'ALREADY_POSTED', message: `同じ画像がすでに投稿されています（${other.job_id}）。`, details: { duplicate_of: other.job_id } };
    }
    if (policyDrift(job, this.#d.instructions())) return { code: 'VALIDATION_FAILED', message: '作業指示書の文章の方針が変わったため、文章を作り直します。', details: { reason: 'writing_policy_changed' } };
    const r = await this.#d.pipeline.recheck(job);
    if (r.kind === 'skip') return { code: 'BUSY', message: 'テンプレートを読めないため、文章を確かめられません（読めるまで待ちます）。', details: {} };
    if (r.kind === 'current') return null;
    const code = r.error.code === 'DUPLICATE_CONTENT' ? 'DUPLICATE_CONTENT' : 'VALIDATION_FAILED';
    return { code, message: r.error.message, details: { reason: 'revalidation' } };
  }

  // ---------------------------------------------------------------- heartbeat and asset

  heartbeat(clientId: string, jobId: string, req: { attempt_id: string | null; command_id: string; phase: Phase; detail?: string | undefined }): { continue: boolean; paused: boolean; reason_ja: string | null } {
    const now = this.#now().getTime();
    const c = this.#cur;
    if (c === null || c.client_id !== clientId || c.job_id !== jobId || c.command_id !== req.command_id || (req.attempt_id !== null && req.attempt_id !== c.attempt_id)) throw stale();
    c.lastArrival = now;
    c.phase = req.phase;
    if (c.permission !== null && AFTER_CLICK.has(req.phase)) c.clicked = true;
    const control = this.#d.control.get();
    // After intent (and for a reconcile) the command always continues: verification must not be cut short.
    if (c.permission !== null || c.kind === 'reconcile') return { continue: true, paused: control.paused, reason_ja: null };
    const halt = control.paused
      ? '一時停止中です。'
      : this.#pressure !== null
        ? '資源が不足しています。'
        : this.#d.stops.blocksSalon() !== null
          ? '投稿を止めています（status で理由を確認できます）。'
          : this.#d.getHalts().length > 0 || this.#lastRejected
            ? '新しい投稿を止めています（status で理由を確認できます）。'
            : null;
    return { continue: halt === null, paused: control.paused, reason_ja: halt };
  }

  async asset(clientId: string, jobId: string, attemptId: string, commandId: string): Promise<{ stream: Readable; bytes: number; sha256: string; mime: string }> {
    const c = this.#cur;
    if (c === null || c.kind !== 'post' || c.client_id !== clientId || c.job_id !== jobId || c.attempt_id !== attemptId || c.command_id !== commandId || c.permission !== null) throw stale();
    const job = await this.#d.store.get(jobId);
    const upload = job?.upload ?? null;
    if (job === null || job.status !== 'POSTING' || upload === null) throw stale();
    const notFound = (): ApiError => new ApiError(404, 'NOT_FOUND', '投稿用の画像が見つかりません。');
    try {
      const root = await realpath(this.#d.paths.processingDir);
      const file = await realpath(join(this.#bundleDir(job), upload.file_name));
      const st = await lstat(file);
      if (!file.startsWith(root + sep) || !st.isFile() || st.isSymbolicLink() || st.size > 10 * 1024 * 1024) throw notFound();
      const data = await readFile(file);
      if (sha256Hex(data) !== upload.sha256) throw notFound();
      // The bytes live only as long as the stream (16.6-b).
      return { stream: Readable.from([data]), bytes: data.length, sha256: upload.sha256, mime: upload.mime };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw notFound();
    }
  }

  // ---------------------------------------------------------------- submit intent

  submitIntent(clientId: string, jobId: string, req: SubmitIntentRequest): Promise<Omit<SubmitIntentResponse, 'protocol_version' | 'request_id'>> {
    return this.#lock.run(() => this.#submitIntent(clientId, jobId, req));
  }

  async #submitIntent(clientId: string, jobId: string, req: SubmitIntentRequest): Promise<Omit<SubmitIntentResponse, 'protocol_version' | 'request_id'>> {
    const { store, control, ledger, logger } = this.#d;
    const now = this.#now();
    if (this.#d.mode !== 'live') throw new ApiError(409, 'STALE_COMMAND', DRY_RUN_JA);
    const cur = this.#cur;
    if (cur?.kind !== 'post' || cur.client_id !== clientId || cur.job_id !== jobId || cur.attempt_id !== req.attempt_id || cur.command_id !== req.command_id) throw stale();
    let job = await store.get(jobId);
    const attempt = job?.attempts.at(-1);
    if (job === null || attempt?.id !== req.attempt_id || attempt.route === null) throw stale();
    cur.lastArrival = now.getTime();
    // A21: one permission per attempt, ever. A second request means the first answer may have been lost: unknown.
    if (cur.permission !== null || attempt.submit_intent_at !== null) {
      await this.#unknown(job, 'POST_RESULT_UNKNOWN', 'second_intent_request');
      throw new ApiError(409, 'POST_RESULT_UNKNOWN', '登録できたか確認できないため、自動では送信し直しません。数分後に自動で照合します。');
    }
    const r = await this.#d.refresh(now);
    this.#lastRejected = r.rejected;
    const refusal = await this.#intentRefusal(job, req, r, now);
    if (refusal !== null) {
      await refusal.settle().catch((err: unknown) => logger.error('ATTEMPT_NOT_SETTLED', `送信を断ったjobの状態を保存できませんでした（時間切れで戻します）: ${jobId}（${errorText(err)}）`, { job_id: jobId, error_code: errorCodeOf(err) }));
      throw new ApiError(refusal.http, refusal.code, refusal.message, true);
    }
    // The three writes, in this order, before any permission exists (§13.3-3, P3-R38).
    const permissionId = newId('perm');
    const windowEnd = windowEndFor(r.effective.schedule, now)!;
    const ttl = Math.min(PERMISSION_TTL_MAX_MS, windowEnd.getTime() - now.getTime() - PERMISSION_WINDOW_MARGIN_MS);
    const entry = { at: now.toISOString(), job_id: job.id, attempt_id: attempt.id, instance_id: this.#d.instanceId, post_type: job.post_type };
    try {
      await control.recordSubmit(now);
      await ledger.appendIntent(entry);
    } catch (err) {
      throw await this.#intentWriteFailed(job, err, false);
    }
    try {
      job = await store.update(job.id, job.revision, (j) => recordIntent(j, attempt.id, { now, permissionId, route: attempt.route! }));
    } catch (err) {
      throw await this.#intentWriteFailed(job, err, true);
    }
    cur.permission = { at: now.getTime(), ttl };
    cur.phase = 'authorized';
    logger.info('SUBMIT_INTENT_SAVED', `送信の許可を記録しました（このあと1回だけ登録ボタンを押します）: ${job.id}`, this.#fields(job, { permission_ttl_ms: ttl }));
    const label = r.effective.base.salon.expected_account_label ?? '';
    return {
      permission: { permission_id: permissionId, attempt_id: attempt.id, command_id: cur.command_id, document_ref: req.document_ref, ttl_ms: ttl },
      match: matchKeysFor(job, now, 'intent', label),
    };
  }

  /** A failed intent write: no permission; the attempt ends before intent (a written ledger line gets its void line). */
  async #intentWriteFailed(job: Job, err: unknown, voidLine: boolean): Promise<ApiError> {
    const { ledger, logger } = this.#d;
    this.noteFailure(err);
    const attempt = job.attempts.at(-1)!;
    if (voidLine) {
      await ledger
        .appendVoid({ at: this.#now().toISOString(), job_id: job.id, attempt_id: attempt.id, instance_id: this.#d.instanceId, post_type: job.post_type })
        .catch((e: unknown) => logger.error('LEDGER_VOID_FAILED', `送信記録の取消行を書けませんでした（次回の起動時に確認のため停止します）: ${job.id}`, { job_id: job.id, error_code: errorCodeOf(e) }));
    }
    logger.error('SUBMIT_INTENT_NOT_SAVED', `送信の許可を記録できなかったため、送信しません: ${job.id}（${errorText(err)}）`, this.#fields(job, { error_code: errorCodeOf(err) }));
    await this.#endPre(job, errorCodeOf(err) === 'DISK_FULL' ? 'DISK_FULL' : 'FILE_IO_ERROR', { message: '送信の許可を記録できなかったため、送信していません。' }).catch(() => undefined);
    return new ApiError(500, 'INTERNAL_ERROR', '想定外のエラーです。ログを確認してください');
  }

  /** §5.5 for an intent, in the plan's order; each refusal knows how the attempt ends. */
  async #intentRefusal(job: Job, req: SubmitIntentRequest, r: RefreshResult, now: Date): Promise<{ code: ApiErrorCode; http: number; message: string; settle: () => Promise<unknown> } | null> {
    const eff = r.effective;
    const attempt = job.attempts.at(-1)!;
    const routeKey: RouteKey = `${job.post_type}.${job.audience_category}`;
    // A gate, readiness gap, stop or changed route only makes the job wait (READY): its own cause is not the job's.
    const wait = (code: ApiErrorCode, http: number, message: string, details: Record<string, unknown> = {}) => ({ code, http, message, settle: () => this.#endPre(job, code, { message, details, wait: true }) });
    const readiness = this.#d.readiness(eff, now);
    const g = gate('intent', this.#gateContext(r, now, readiness));
    if (!g.ok) return wait(g.code, g.http, g.reason_ja);
    const item = readiness.routes[routeKey][0];
    if (item !== undefined) return wait(item.code, 409, item.detail);
    const typeStop = this.#d.stops.blocksType(job.post_type) ?? this.#d.stops.blocksRoute(job.post_type, job.audience_category);
    if (typeStop !== null) return wait(typeStop.code, 409, typeStop.remedy);
    const control = this.#d.control.get();
    const bound = control.live_single;
    if (bound !== null && (bound.job_id !== job.id || bindingChanged(bound, job))) {
      return {
        code: 'STALE_COMMAND',
        http: 409,
        message: LIVE_SINGLE_CHANGED_JA,
        settle: async () => {
          if (bound.job_id === job.id) await disarm(this.#d.control, job.id, this.#d.logger);
          await this.#endPre(job, 'STALE_COMMAND', { message: LIVE_SINGLE_CHANGED_JA, wait: true });
        },
      };
    }
    const verified = resolveRoute(eff, job.post_type, job.audience_category, this.#d.urlPolicy);
    if (bound === null && firstPostState(routeKey, control, verified.ok ? verified.snapshot.profile_hash : null) !== 'done') {
      return wait('STALE_COMMAND', 409, `この投稿先の初回の本番投稿は、npm.cmd run live:single -- --route ${routeKey} で1件だけ行ってください。`);
    }
    const windowEnd = windowEndFor(eff.schedule, now);
    if (windowEnd === null || windowEnd.getTime() - now.getTime() < INTENT_MIN_WINDOW_MS) {
      return wait('WINDOW_CLOSED', 409, '投稿できる時間帯の終わりが近いため、この投稿は送信しませんでした（次の枠で投稿します）。');
    }
    const observed = req.observed_count.before_submit;
    const q = this.#quota(eff, job.post_type, now, job.id, observed === null ? null : { ...observed, at: now });
    if (q.kind === 'reached' && q.screenEvidence) {
      return { code: 'LIMIT_REACHED', http: 409, message: q.reason_ja, settle: () => this.#endPre(job, 'LIMIT_REACHED', { message: q.reason_ja, period: observed?.kind ?? 'unknown' }) };
    }
    if (q.kind !== 'ok') {
      const message = q.reason_ja;
      return { code: 'LIMIT_REACHED', http: 409, message, settle: () => this.#endPre(job, 'LIMIT_REACHED', { message, computedQuota: true }) };
    }
    const route = attempt.route!;
    if (!verified.ok || verified.snapshot.profile_hash !== route.profile_hash || verified.snapshot.entry_url !== route.entry_url) {
      return wait('STALE_COMMAND', 409, '投稿先の設定が変わったため、この送信はやめて新しい設定でやり直します。', { reason: 'route_changed' });
    }
    const rb = req.readback;
    const bad = Object.entries(rb.fields).filter(([, v]) => !v.ok).map(([k]) => k);
    if (bad.length > 0 || !rb.image_preview || !rb.poster_ok || !rb.constraint_check_ok) {
      const message = '入力した内容を画面で読み直したところ一致しませんでした（画面の形が変わった可能性があります）。';
      return { code: 'SALON_BOARD_PAGE_CHANGED', http: 409, message, settle: () => this.#endPre(job, 'SALON_BOARD_PAGE_CHANGED', { message, details: { readback_mismatch: bad.slice(0, 10) } }) };
    }
    const content = await this.#contentRefusal(job);
    if (content !== null) {
      return { code: content.code, http: content.code === 'BUSY' ? 503 : content.code === 'ALREADY_POSTED' ? 409 : 422, message: content.message, settle: () => this.#endPre(job, content.code, { message: content.message, details: content.details }) };
    }
    if (!this.#gapOk(now)) return wait('BUSY', 503, '前回の送信から間隔を空けるため、今は送信しません。');
    return null;
  }

  // ---------------------------------------------------------------- result

  result(clientId: string, jobId: string, req: ResultRequest): Promise<Outcome> {
    return this.#lock.run(() => this.#result(clientId, jobId, req));
  }

  async #result(clientId: string, jobId: string, req: ResultRequest): Promise<Outcome> {
    const { store, dedupe } = this.#d;
    const replay: Outcome = { job_status: 'POSTED', idempotent_replay: true, applied: false };
    const job = await store.get(jobId);
    // P3-R42: proof that an earlier send registered, after the operator's "not registered", a newer attempt or another
    // post, is never dropped as stale: it is recorded and the salon stops (reconcile_conflict).
    const sent = job?.attempts.find((a) => a.id === req.attempt_id && a.command_id === req.command_id && a.submit_intent_at !== null);
    if (job !== null && sent !== undefined && req.outcome === 'posted' && provesPost(req.evidence, this.#completionOnly(sent))) {
      const other = job.status === 'POSTED' || contradicts(job, sent.id);
      if (other && (await applyScreenFound(this.#ops, job, sent.id, { evidence: req.evidence!, registeredAtText: req.observed?.registered_at_text, evidenceName: 'result' })) !== null) {
        this.#d.logger.info('VERIFY_SUCCEEDED', `登録を画面で確認しました（遅れて届いた結果）: ${job.id}`, this.#fields(job));
        return { job_status: 'POSTED', idempotent_replay: false, applied: true };
      }
    }
    // Idempotency first (A22, A51): a POSTED job, or one only the dedupe record remembers, is answered as such.
    if (dedupe.get(jobId) !== undefined) return replay;
    if (job === null) throw stale();
    if (job.status === 'POSTED') return replay;
    const attempt = job.attempts.find((a) => a.id === req.attempt_id);
    const latest = job.attempts.at(-1);
    if (attempt === undefined || attempt !== latest || attempt.command_id !== req.command_id) throw stale();
    const late: Outcome = { job_status: job.status, idempotent_replay: true, applied: false };
    const cur = this.#cur;
    const current = cur !== null && cur.kind === 'post' && cur.attempt_id === attempt.id && cur.client_id === clientId;
    if (cur !== null && current) cur.lastArrival = this.#now().getTime();
    const intent = attempt.submit_intent_at !== null;
    if (!current) {
      // A stale attempt counts only as reconcile information about a possible send (§13.3-6).
      if (intent && req.outcome === 'posted' && provesPost(req.evidence, this.#completionOnly(attempt))) return this.#posted(job, req);
      if (intent || attempt.client_id === clientId) return late;
      throw stale();
    }
    switch (req.outcome) {
      case 'submitted': {
        if (!intent || job.status !== 'POSTING') return late;
        const next = await store.update(job.id, job.revision, (j) => markSubmitted(j, attempt.id, this.#now(), req.flags.inferred_click));
        if (cur !== null) {
          cur.clicked = true;
          cur.phase = 'verifying_completion';
        }
        return { job_status: next.status, idempotent_replay: false, applied: true };
      }
      case 'posted':
        if (intent && provesPost(req.evidence, this.#completionOnly(attempt))) return this.#posted(job, req);
        if (!intent) return this.#settled(await this.#endPre(job, 'SALON_BOARD_PAGE_CHANGED', { unexpectedNavigation: true, message: '送信の許可の前に登録済みと報告されました。', evidence: req.evidence }));
        return this.#settled(await this.#unknown(job, 'POST_RESULT_UNKNOWN', 'posted_without_proof', req.evidence));
      case 'not_registered':
      case 'unknown': {
        if (!intent) {
          // Nothing was sent. Without a code: "not registered" is Node's own stop (heartbeat continue:false), "unknown" a
          // lost intent answer or connection (counted as an abandon).
          const navigated = req.flags.unexpected_navigation;
          const fallback: ErrorCode = req.outcome === 'unknown' ? 'EXTENSION_DISCONNECTED' : 'STALE_COMMAND';
          const code = req.code === null || req.code === 'POST_RESULT_UNKNOWN' ? fallback : req.code;
          const period = code === 'LIMIT_REACHED' ? { period: this.#screenLimitPeriod(attempt, req.evidence) } : {};
          return this.#settled(await this.#endPre(job, code, { unexpectedNavigation: navigated, evidence: req.evidence, stage: req.stage, retryAfter: req.retry_after_seconds, ...period }));
        }
        if (req.outcome === 'not_registered' && exceptionEvidence(req)) return this.#settled(await this.#notSentAfterIntent(job));
        return this.#settled(await this.#unknown(job, req.code ?? 'POST_RESULT_UNKNOWN', null, req.evidence));
      }
    }
  }

  #settled(job: Job): Outcome {
    return { job_status: job.status, idempotent_replay: false, applied: true };
  }

  /**
   * §5.6 row 5a before intent: the period the screen showed (the content script's `limit_period:<p>` note), accepted only
   * when the send-time profile can show that period (its limit_reached signal or its count display), so a daily or
   * monthly limit clears by itself at the next period; anything else stays a manual stop ('unknown').
   */
  #screenLimitPeriod(attempt: Job['attempts'][number], evidence: Evidence | null): 'daily' | 'monthly' | 'total' | 'unknown' {
    const id = attempt.route?.page_profile_id;
    const p = id === undefined ? undefined : this.#d.getEffective().base.salonboardFields.pages[id];
    const shown = new Set<string | undefined>([p?.failure_signals.limit_reached?.limit_period, p?.count_display?.kind]);
    const named = evidence?.notes.map((n) => /^limit_period:(daily|monthly|total|unknown)$/.exec(n)?.[1]).find((x) => x !== undefined);
    return named !== undefined && shown.has(named) ? (named as 'daily' | 'monthly' | 'total' | 'unknown') : 'unknown';
  }

  /** The send-time profile (unchanged since) proves posts by its completion page alone (completion_only). */
  #completionOnly(attempt: Job['attempts'][number]): boolean {
    const r = attempt.route;
    const p = r === null ? undefined : this.#d.getEffective().base.salonboardFields.pages[r.page_profile_id];
    return p?.success_signals.completion_only === true && profileHash(p) === r?.profile_hash;
  }

  /** POSTED from screen evidence (D3): the bundle move tolerates a failed rename (R32), then the post-commit records. */
  async #posted(job: Job, req: ResultRequest): Promise<Outcome> {
    const attempt = job.attempts.at(-1)!;
    const intentAt = new Date(attempt.submit_intent_at!);
    const read = parseRegisteredAt(req.observed?.registered_at_text);
    const inWindow = read !== null && read.getTime() >= intentAt.getTime() - 2 * 60_000 && read.getTime() <= intentAt.getTime() + 30 * 60_000;
    const matched = req.evidence?.list?.matched ?? null; // null for a completion_only proof
    const posted = await commitScreenPost(this.#ops, job, attempt.id, {
      postedAt: inWindow ? read : intentAt,
      source: inWindow ? 'screen' : 'intent_estimate',
      remoteId: matched?.remote_post_id ?? null,
      remoteUrl: matched === null ? null : remoteUrlOf(job, attempt.id, matched.detail_url_path),
      evidence: { name: 'result', data: req.evidence },
    });
    this.#clear(attempt.id);
    this.#d.logger.info('VERIFY_SUCCEEDED', `登録を画面で確認しました: ${job.id}`, this.#fields(posted));
    // 反映申請 (profile.publish): never changes the result; the next post's 反映申請 publishes what this one could not.
    const why = req.evidence?.notes.find((n) => n.startsWith('publish_failed:'))?.slice('publish_failed:'.length);
    if (why !== undefined) this.#d.logger.warn('PUBLISH_FAILED', `スタイルは登録できましたが、反映申請（公開）ができませんでした（${why}）。次のスタイル投稿の反映申請でまとめて公開されます。`, this.#fields(posted, { reason: why }));
    else if (req.evidence?.notes.includes('published') === true) this.#d.logger.info('PUBLISHED', '反映申請（公開）まで行いました', this.#fields(posted));
    return { job_status: 'POSTED', idempotent_replay: false, applied: true };
  }

  /** P3-R14's exception: an owner-confirmed client-side rejection with no candidate on any list page. */
  async #notSentAfterIntent(job: Job): Promise<Job> {
    const now = this.#now();
    const d = dispose('SUBMIT_FAILED', this.#disposeContext(job, now, { intentRecorded: true, exceptionEvidence: true }));
    const status = d.status === 'FAILED' ? 'FAILED' : 'RETRY_WAIT';
    const error = appError(d.status === 'FAILED' ? d.code : 'SUBMIT_FAILED', 'posting', this.#d.clock, { submission_state: 'definitely_not_submitted', details: { reason: 'client_side_rejection' } });
    const attemptId = job.attempts.at(-1)!.id;
    const next = await this.#move(job, (j) => {
      assertTransition(j.status, status, { intentRecorded: true, exceptionEvidence: true, code: 'SUBMIT_FAILED' });
      return {
        ...j,
        status,
        stage: status === 'RETRY_WAIT' ? 'retry_wait' : j.stage,
        submission_state: 'definitely_not_submitted',
        last_error: error,
        next_retry_at: d.status === 'RETRY_WAIT' ? d.next_retry_at : null,
        attempts: j.attempts.map((a) => (a.id === attemptId ? { ...a, submission_state: 'definitely_not_submitted', completed_at: now.toISOString(), error } : a)),
      };
    });
    return this.#after(next, d, 'SUBMIT_FAILED', { detail: null, period: null, computedQuota: false });
  }

  // ---------------------------------------------------------------- settling attempts

  #disposeContext(job: Job, now: Date, o: { intentRecorded: boolean; exceptionEvidence?: boolean; unexpectedNavigation?: boolean; computedQuota?: boolean; retryAfter?: number | undefined }) {
    const eff = this.#d.getEffective();
    const today = jstDateKey(now);
    return {
      intentRecorded: o.intentRecorded,
      exceptionEvidence: o.exceptionEvidence ?? false,
      unexpectedNavigation: o.unexpectedNavigation ?? false,
      retryCount: job.retry_count,
      abandonsToday: job.pre_intent_abandons?.date_jst === today ? job.pre_intent_abandons.count : 0,
      driftRegenerations: job.drift_regenerations,
      settings: eff.base.settings.retry,
      now,
      windowEnd: job.scheduled_at === null ? null : windowEndFor(eff.schedule, new Date(job.scheduled_at)),
      random: this.#d.random ?? Math.random,
      ...(o.computedQuota === undefined ? {} : { computedQuota: o.computedQuota }),
      ...(o.retryAfter === undefined ? {} : { retryAfterSeconds: o.retryAfter }),
    };
  }

  /** Ends the current attempt before intent (dispose), or as VERIFY_REQUIRED for an unexpected navigation (P3-R40). */
  async #endPre(
    job: Job,
    code: ApiErrorCode,
    o: { message?: string; details?: Record<string, unknown>; unexpectedNavigation?: boolean; computedQuota?: boolean; period?: 'daily' | 'monthly' | 'total' | 'unknown'; evidence?: Evidence | null; stage?: string | null; retryAfter?: number | undefined; wait?: boolean } = {},
  ): Promise<Job> {
    const now = this.#now();
    const attempt = job.attempts.at(-1)!;
    const d: Disposition = o.wait === true ? { status: 'READY', releaseSlot: true } : dispose(code, this.#disposeContext(job, now, { intentRecorded: false, unexpectedNavigation: o.unexpectedNavigation ?? false, ...(o.computedQuota === undefined ? {} : { computedQuota: o.computedQuota }), retryAfter: o.retryAfter }));
    const stored: ErrorCode = o.unexpectedNavigation === true ? 'SALON_BOARD_PAGE_CHANGED' : isErrorCode(code) ? code : 'STALE_COMMAND';
    // A config hold (also one the content script reported) is lifted only once the config changed (#housekeeping).
    const held = stored === 'CONFIG_INCOMPLETE' || stored === 'CONFIG_INVALID' ? { config_hash: job.resolved_route?.config_hash ?? this.#d.getEffective().hash } : {};
    const error = appError(stored, 'posting', this.#d.clock, {
      ...(o.message === undefined ? {} : { message: o.message }),
      submission_state: d.status === 'VERIFY_REQUIRED' ? 'unknown' : 'definitely_not_submitted',
      details: { ...held, ...(o.details ?? {}), ...(stored !== code ? { api_code: code } : {}), ...(o.stage ? { extension_stage: o.stage } : {}), ...(o.evidence?.notes.length ? { notes: o.evidence.notes } : {}) },
    });
    const next = await this.#move(job, (j) => endPreIntent(j, attempt.id, error, d, now));
    const slotReason = code === 'WINDOW_CLOSED' ? 'window_closed' : 'interrupted';
    const routeConfigHash = job.resolved_route?.config_hash ?? null;
    return this.#after(next, d, stored, { detail: o.unexpectedNavigation === true ? 'navigated_during_input' : null, period: o.period ?? null, computedQuota: o.computedQuota === true, slotReason, routeConfigHash });
  }

  /** Post-intent: VERIFY_REQUIRED, never sent again automatically; auto reconcile is armed (+2 min). */
  async #unknown(job: Job, code: ErrorCode, detail: string | null, evidence: Evidence | null = null): Promise<Job> {
    const now = this.#now();
    const attempt = job.attempts.at(-1)!;
    const d = dispose(code, this.#disposeContext(job, now, { intentRecorded: true }));
    const error = appError(code, 'posting', this.#d.clock, {
      message: '登録できたか確認できないため、自動では登録し直しません。数分後に自動で照合します。',
      submission_state: 'unknown',
      details: { ...(detail === null ? {} : { reason: detail }), ...(evidence?.notes.length ? { notes: evidence.notes } : {}) },
    });
    const next = await this.#move(job, (j) => markUnknown(j, attempt.id, error, now, 'intent'));
    let period: 'daily' | 'monthly' | 'total' | 'unknown' | null = null;
    if (code === 'LIMIT_REACHED') {
      const id = attempt.route?.page_profile_id;
      period = (id === undefined ? undefined : this.#d.getEffective().base.salonboardFields.pages[id]?.failure_signals.limit_reached?.limit_period) ?? 'unknown';
    }
    return this.#after(next, d, code, { detail: null, period, computedQuota: false });
  }

  /** What follows a settled attempt: the in-flight slot freed, stop, slot, failure.json, logs, regeneration, live_single. */
  async #after(
    job: Job,
    d: Disposition,
    code: ErrorCode,
    o: { detail: string | null; period: 'daily' | 'monthly' | 'total' | 'unknown' | null; computedQuota: boolean; slotReason?: string; routeConfigHash?: string | null },
  ): Promise<Job> {
    const { logger, stops, paths, control } = this.#d;
    const attemptId = job.attempts.at(-1)!.id;
    this.#clear(attemptId);
    if ('stop' in d && d.stop !== undefined) {
      const stopCode: StopCode = o.detail === 'navigated_during_input' || !(code in STOP_SCOPE) ? 'SALON_BOARD_PAGE_CHANGED' : (code as StopCode);
      await stops
        .raise(stopCode, { post_type: job.post_type, audience_category: job.audience_category }, { jobId: job.id, detail: o.detail, period: o.period, routeConfigHash: o.routeConfigHash ?? job.resolved_route?.config_hash ?? null })
        .catch((err: unknown) => logger.error('STOP_NOT_SAVED', `停止を記録できませんでした: ${errorText(err)}`, this.#fields(job, { error_code: errorCodeOf(err) })));
    }
    if (o.computedQuota) await this.#closeQuota(job);
    else await this.#releaseSlot(job, o.slotReason ?? 'interrupted');
    if (job.status === 'FAILED' || job.status === 'BLOCKED' || job.status === 'RETRY_WAIT' || job.status === 'VERIFY_REQUIRED') {
      await writeFailureFile(paths, job, this.#d.clock).catch((err: unknown) =>
        logger.warn('FAILURE_FILE_FAILED', `failure.json を書けませんでした（jobの状態は保存済みです）: ${errorText(err)}`, this.#fields(job, { error_code: errorCodeOf(err) })),
      );
    }
    const fields = this.#fields(job, { error_code: code, status: job.status });
    if (job.status === 'VERIFY_REQUIRED') logger.error('VERIFY_REQUIRED', `登録できたか確認できないため、自動では登録し直しません。数分後に自動で照合します: ${job.id}`, fields);
    else if (job.status === 'RETRY_WAIT') logger.warn('RETRY_SCHEDULED', `${formatJst(new Date(job.next_retry_at!))} 以降にもう一度送信します: ${job.id}`, { ...fields, next_retry_at: job.next_retry_at });
    else if (job.status === 'READY') logger.info('ATTEMPT_ABANDONED', `送信せずに投稿待ちへ戻しました（${job.last_error?.message ?? code}）: ${job.id}`, fields);
    else logger.warn('ATTEMPT_ENDED', `送信せずに止めました（${job.last_error?.message ?? code}）: ${job.id}`, fields);
    if (job.status === 'GENERATING') this.#d.processor.notifyRegeneration(job.id);
    await onJobFinal(control, job, logger);
    return job;
  }

  /** Abandons the in-flight command (hello without it, or a timeout). */
  async #abandon(cur: InFlight, reason: string): Promise<void> {
    if (cur.kind === 'preflight') {
      // Its pending record expires by itself (maintain) when no result came.
      this.#cur = null;
      return;
    }
    const job = await this.#d.store.get(cur.job_id).catch(() => null);
    if (cur.kind === 'reconcile') {
      if (job !== null) await this.#reconcileMissed(job, cur.command_id);
      this.#cur = null;
      return;
    }
    const attempt = job?.attempts.at(-1);
    if (job === null || attempt?.id !== cur.attempt_id || (job.status !== 'POSTING' && job.status !== 'VERIFYING')) {
      this.#cur = null;
      return;
    }
    try {
      if (attempt.submit_intent_at === null) await this.#endPre(job, 'EXTENSION_DISCONNECTED', { details: { reason } });
      else await this.#unknown(job, 'EXTENSION_DISCONNECTED', reason);
    } catch (err) {
      this.#d.logger.error('ATTEMPT_NOT_SETTLED', `拡張機能と途切れた投稿の状態を保存できませんでした（次の確認でもう一度試します）: ${job.id}（${errorText(err)}）`, { job_id: job.id, error_code: errorCodeOf(err) });
    }
  }

  // ---------------------------------------------------------------- reconcile command (its result: reconcile.ts)

  async #reconcileCommand(clientId: string, ctx: GateContext, eff: EffectiveConfig, now: Date): Promise<ReconcileCommand | null> {
    if (!gate('reconcile', ctx).ok) return null;
    const due = this.#d.store
      .summaries((s) => s.status === 'VERIFY_REQUIRED' && s.reconcile_next_at !== null && Date.parse(s.reconcile_next_at) <= now.getTime())
      .sort((a, b) => Date.parse(a.reconcile_next_at!) - Date.parse(b.reconcile_next_at!));
    for (const s of due) {
      const job = await this.#d.store.get(s.id);
      const rec = job?.reconcile ?? null;
      if (job === null || rec === null || rec.operator_needed || rec.in_flight_command_id !== null || rec.auto_count >= RECONCILE_MAX_AUTO) continue;
      const attempt = job.attempts.find((a) => a.id === rec.attempt_id);
      const route = attempt?.route ?? null;
      const profile: PageProfile | undefined = route === null ? undefined : eff.base.salonboardFields.pages[route.page_profile_id];
      if (attempt === undefined || route === null || profile === undefined || profile.success_signals.list === null) {
        await this.#d.store.update(job.id, job.revision, (j) => ({ ...j, reconcile: { ...rec, operator_needed: true, next_auto_at: null } }));
        this.#d.logger.warn('VERIFY_REQUIRED', `投稿時の画面設定が見つからないため自動照合できません: ${job.id}`, this.#fields(job));
        continue;
      }
      const label = eff.base.salon.expected_account_label ?? '';
      const intentAt = attempt.submit_intent_at;
      const anchorAt = new Date(intentAt ?? attempt.completed_at ?? job.updated_at);
      const commandId = newId('cmd');
      const command: ReconcileCommand = {
        kind: 'reconcile',
        command_id: commandId,
        job_id: job.id,
        reconcile_id: newId('rec'),
        attempt_id: attempt.id,
        route,
        profile,
        match: matchKeysFor(job, anchorAt, intentAt === null ? 'unexpected_navigation' : 'intent', label),
        salon: { expected_account_label: label },
      };
      await this.#d.store.update(job.id, job.revision, (j) => ({ ...j, reconcile: { ...rec, in_flight_command_id: commandId } }));
      this.#cur = { kind: 'reconcile', command, job_id: job.id, attempt_id: attempt.id, command_id: commandId, client_id: clientId, phase: 'claimed', claimedAt: now.getTime(), lastArrival: now.getTime(), permission: null, clicked: false };
      this.#d.logger.info('CLAIMED', `登録の自動照合を拡張機能に渡しました: ${job.id}`, this.#fields(job, { kind: 'reconcile' }));
      return command;
    }
    return null;
  }

  /** A reconcile command that never reported: counted as a try without result ('error'); the operator after the third. */
  async #reconcileMissed(job: Job, commandId: string): Promise<void> {
    if (job.reconcile?.in_flight_command_id !== commandId) return;
    await countReconcileTry(this.#ops, job, 'error', null).catch((err: unknown) =>
      this.#d.logger.warn('RECONCILE_NOT_SAVED', `自動照合の記録を保存できませんでした: ${job.id}`, { job_id: job.id, error_code: errorCodeOf(err) }),
    );
  }

  // ---------------------------------------------------------------- preflight command (P3-R35)

  #preflightWaiting(): boolean {
    const p = this.#d.control.get().pending_preflight;
    return p !== null && p.result === null && p.command_id === null;
  }

  async #preflightCommand(clientId: string, ctx: GateContext, eff: EffectiveConfig, now: Date): Promise<PreflightCommand | null> {
    const p = this.#d.control.get().pending_preflight;
    if (p === null || !this.#preflightWaiting() || !gate('preflight', ctx).ok) return null;
    const targets = preflightTargets(eff, p.route_keys);
    const label = eff.base.salon.expected_account_label;
    if (targets.length === 0 || label === null) {
      const result: PreflightResult = { preflight_id: p.preflight_id, finished_at: now.toISOString(), outcome: 'failed', targets: [] };
      await this.#d.control.update((c) => (c.pending_preflight?.preflight_id === p.preflight_id ? { pending_preflight: { ...c.pending_preflight, result } } : null));
      return null;
    }
    const commandId = newId('cmd');
    const command: PreflightCommand = { kind: 'preflight', command_id: commandId, preflight_id: p.preflight_id, targets, salon: { expected_account_label: label } };
    await this.#d.control.update((c) => (c.pending_preflight?.preflight_id === p.preflight_id ? { pending_preflight: { ...c.pending_preflight, command_id: commandId } } : null));
    this.#cur = { kind: 'preflight', command, job_id: '', attempt_id: '', command_id: commandId, client_id: clientId, phase: 'claimed', claimedAt: now.getTime(), lastArrival: now.getTime(), permission: null, clicked: false };
    this.#d.logger.info('CLAIMED', `SALON BOARD の画面の確認を拡張機能に渡しました（入力も登録もしません）: ${targets.map((t) => t.route_key).join('、')}`, { kind: 'preflight', preflight_id: p.preflight_id });
    return command;
  }

  // ---------------------------------------------------------------- operator and extension results (Task 2c)

  /** POST /v1/jobs/:id/reconcile from the extension: the automatic reconcile's outcome. */
  reconcileResult(clientId: string, jobId: string, req: AutoReconcileRequest): Promise<{ job_status: JobStatus; reconcile_outcome: AutoReconcileRequest['outcome'] }> {
    return this.#lock.run(async () => {
      const cur = this.#cur;
      const current = cur?.kind === 'reconcile' && cur.job_id === jobId && cur.command_id === req.command_id && cur.client_id === clientId && cur.command.kind === 'reconcile' && cur.command.reconcile_id === req.reconcile_id;
      const out = await applyAutoReconcile(this.#ops, jobId, req, current);
      if (current) this.#cur = null;
      return out;
    });
  }

  /** POST /v1/jobs/:id/reconcile from the CLI: the operator's verdict, or an automatic reconcile now. */
  operatorReconcile(jobId: string, req: Omit<OperatorReconcileRequest, 'protocol_version' | 'request_id'>): ReturnType<typeof applyOperatorReconcile> {
    return this.#lock.run(() => applyOperatorReconcile(this.#ops, jobId, req, this.#cur?.kind === 'reconcile' && this.#cur.job_id === jobId));
  }

  /** POST /v1/retry: one job (--id) or every posting failure safe to send again. */
  retry(jobId: string | null): Promise<{ requeued: { job_id: string; reset_budget: boolean; restart: Restart }[]; excluded: { job_id: string; code: ErrorCode; reason_ja: string }[] }> {
    return this.#lock.run(async () => {
      const d = { ...this.#ops, notifyRegeneration: (id: string) => this.#d.processor.notifyRegeneration(id) };
      return jobId === null ? retryEligible(d) : { requeued: [await retryOne(d, jobId)], excluded: [] };
    });
  }

  /** POST /v1/redraft: under the claim lock, so a job cannot be dispatched while it is sent back. */
  redraft(o: { id: string | null; type: PostType | null; dry: boolean }): Promise<RedraftResult> {
    const contentBlocked = async (): Promise<string | null> => this.#d.processor.stop?.message ?? null;
    return this.#lock.run(() => redraft({ ...this.#ops, notifyRegeneration: (id: string) => this.#d.processor.notifyRegeneration(id), contentBlocked }, o));
  }

  /** POST /v1/control/resume. */
  resume(confirmChecked: boolean): ReturnType<typeof resume> {
    return this.#lock.run(async () => {
      const now = this.#now();
      const eff = (await this.#d.refresh(now)).effective;
      return resume(this.#ops, { confirmChecked, effective: eff, quota: (t) => this.#quota(eff, t, now, null, null) });
    });
  }

  /** POST /v1/control/preflight (owner). */
  preflight(routeKey: RouteKey | 'configured'): Promise<string> {
    return this.#lock.run(async () => schedulePreflight(this.#ops, (await this.#d.refresh(this.#now())).effective, routeKey === 'configured' ? ROUTE_KEYS : [routeKey], 'owner'));
  }

  /** POST /v1/control/preflight/:id/result from the extension. */
  preflightResult(clientId: string, id: string, req: PreflightResultRequest): Promise<{ applied: true }> {
    return this.#lock.run(async () => {
      const out = await applyPreflightResult(this.#ops, id, req);
      if (this.#cur?.kind === 'preflight' && this.#cur.command_id === req.command_id && this.#cur.client_id === clientId) this.#cur = null;
      return out;
    });
  }

  /** POST /v1/control/live-single (P3-R4). */
  liveSingle(req: { route_key: RouteKey; job_id?: string | undefined; confirm: boolean; content_hash?: string | undefined; image_sha256?: string | undefined; now?: boolean | undefined }): Promise<{ preview: LiveSinglePreview } | { armed: true; job_id: string; next_slot_at_jst: string | null }> {
    return this.#lock.run(async () => {
      const now = this.#now();
      const r = await this.#d.refresh(now);
      return liveSingle(this.#ops, req, { effective: r.effective, readiness: this.#d.readiness(r.effective, now), urlPolicy: this.#d.urlPolicy, schedules: this.#d.schedules });
    });
  }

  // ---------------------------------------------------------------- maintain

  startTimer(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      this.#maintaining ??= this.maintain()
        .catch((err: unknown) => this.#d.logger.error('MAINTAIN_FAILED', `投稿の見回りでエラーが発生しました（続けます）: ${errorText(err)}`, { error_code: errorCodeOf(err) }))
        .finally(() => (this.#maintaining = null));
    }, this.#d.maintainMs ?? MAINTAIN_INTERVAL_MS);
    this.#timer.unref();
  }

  async stopTimer(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#maintaining;
  }

  /** Waits up to `maxMs` (real time) while a post-intent attempt is in flight (its result may still come). */
  async drain(maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    while (this.#cur?.permission != null && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  /** The coordinator's own housekeeping (15 s): timeouts, carry-over, stops, unblocking, preflight expiry, uploads, disk. */
  async maintain(): Promise<void> {
    await this.#lock.run(() => this.#timeouts());
    await this.#lock.run(() => this.#housekeeping());
    await this.#prepareOneUpload();
    await this.#probeDisk();
  }

  async #timeouts(): Promise<void> {
    const cur = this.#cur;
    if (cur === null) return;
    const now = this.#now().getTime();
    const hb = this.#d.getEffective().base.settings.queue.heartbeat_seconds * 1000;
    const idle = now - cur.lastArrival;
    if (cur.kind === 'preflight') {
      if (now - cur.claimedAt > PREFLIGHT_EXPIRY_MS) await this.#abandon(cur, 'preflight_expired');
      return;
    }
    if (cur.kind === 'reconcile' || cur.permission === null) {
      if (idle > (cur.kind === 'reconcile' ? POST_INTENT_TIMEOUT_FACTOR : PRE_INTENT_TIMEOUT_FACTOR) * hb) await this.#abandon(cur, 'heartbeat_timeout');
      return;
    }
    const unused = !cur.clicked && now - cur.permission.at > cur.permission.ttl + UNUSED_PERMISSION_GRACE_MS;
    if (idle <= POST_INTENT_TIMEOUT_FACTOR * hb && !unused) return;
    const job = await this.#d.store.get(cur.job_id);
    if (job === null || job.attempts.at(-1)?.id !== cur.attempt_id || (job.status !== 'POSTING' && job.status !== 'VERIFYING')) {
      this.#cur = null;
      return;
    }
    await this.#unknown(job, unused ? 'POST_RESULT_UNKNOWN' : 'VERIFY_TIMEOUT', unused ? 'permission_unused' : 'no_heartbeat');
  }

  async #housekeeping(): Promise<void> {
    const { store, control, stops, logger } = this.#d;
    const now = this.#now();
    const eff = this.#d.getEffective();
    // Retries whose slot's window can no longer hold them give the slot up (P3-R11).
    for (const s of store.summaries((x) => x.status === 'RETRY_WAIT' && x.schedule_slot_id !== null)) {
      const job = await store.get(s.id);
      if (job === null || job.scheduled_at === null) continue;
      const end = windowEndFor(eff.schedule, new Date(job.scheduled_at));
      if (end === null || now.getTime() >= end.getTime() || (job.next_retry_at !== null && Date.parse(job.next_retry_at) >= end.getTime())) {
        await this.#releaseSlot(job, 'retry_carried_over');
      }
    }
    await stops.clearExpiredPeriods(now).catch((err: unknown) => logger.warn('STOP_NOT_SAVED', `期間の過ぎた停止を解除できませんでした: ${errorText(err)}`, { error_code: errorCodeOf(err) }));
    // Job-level config holds (CONFIG_INCOMPLETE / CONFIG_INVALID) are lifted once the config changed and the job renders.
    for (const s of store.summaries((x) => x.status === 'BLOCKED' && (x.last_error_code === 'CONFIG_INCOMPLETE' || x.last_error_code === 'CONFIG_INVALID'))) {
      const job = await store.get(s.id);
      if (job === null || job.last_error?.details_redacted.config_hash === eff.hash) continue;
      const resolved = resolveRoute(eff, job.post_type, job.audience_category, this.#d.urlPolicy);
      if (!resolved.ok || !(await renderFormInputs(job, resolved.profile, eff.base, this.#bundleDir(job))).ok) continue;
      await this.#move(job, (j) => ({ ...j, status: 'READY', stage: 'ready' }))
        .then(() => logger.info('JOB_UNBLOCKED', `設定の変更で原因が解消したため、投稿待ちに戻しました: ${job.id}`, this.#fields(job)))
        .catch((err: unknown) => logger.warn('JOB_NOT_UNBLOCKED', `保留中のjobを投稿待ちに戻せませんでした: ${job.id}`, { job_id: job.id, error_code: errorCodeOf(err) }));
    }
    const pending = control.get().pending_preflight;
    if (pending !== null && pending.result === null && now.getTime() - Date.parse(pending.requested_at) > PREFLIGHT_EXPIRY_MS) {
      await control
        .update((c) =>
          c.pending_preflight?.preflight_id === pending.preflight_id && c.pending_preflight.result === null
            ? { pending_preflight: { ...c.pending_preflight, result: { preflight_id: pending.preflight_id, finished_at: now.toISOString(), outcome: 'timeout', targets: [] } } }
            : null,
        )
        .catch(() => undefined);
    }
    const e = this.#ext;
    if (e !== null && e.connected && now.getTime() - e.lastSeen > CONNECTED_WITHIN_MS) {
      e.connected = false;
      logger.warn('EXTENSION_DISCONNECTED', '拡張機能からの連絡が途絶えています（Chrome と投稿用のウィンドウを確認してください）。');
      await this.#writeExtension(now);
    }
  }

  /** D6: at most one upload per tick, prepared outside the lock and stored with a revision check; a job that cannot be
   * prepared for another reason (a locked file) never holds up the others. */
  async #prepareOneUpload(): Promise<void> {
    if (this.#d.mode !== 'live') return;
    const { store, logger } = this.#d;
    const eff = this.#d.getEffective();
    for (const s of store.summaries((x) => x.status === 'READY' && !x.has_operation).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      const resolved = resolveRoute(eff, s.post_type, s.audience_category, this.#d.urlPolicy);
      if (!resolved.ok) continue;
      const want = constraintsHash(resolved.profile.image);
      if (s.upload_constraints_hash === want) continue;
      const job = await store.get(s.id);
      if (job === null || job.status !== 'READY') continue;
      try {
        const prepared = await prepareUploadImage(this.#bundleDir(job), posix.basename(job.image.relative_path), resolved.profile.image);
        await store.update(job.id, job.revision, (j) => ({ ...j, upload: { ...prepared, prepared_at: this.#now().toISOString() } }));
        logger.info('UPLOAD_PREPARED', `投稿用の画像を準備しました（${prepared.width}×${prepared.height}、${prepared.file_name}）: ${job.id}`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category });
      } catch (err) {
        this.noteFailure(err);
        const code = errorCodeOf(err);
        if (code === 'IMAGE_INVALID' || code === 'IMAGE_NOT_FOUND') {
          const failed = await this.#lock.run(async () => {
            const latest = await store.get(job.id);
            if (latest === null || latest.status !== 'READY') return null;
            return this.#move(latest, (j) => ({ ...j, status: 'FAILED', last_error: err instanceof AppFailure ? err.error : appError(code, 'upload', this.#d.clock) }));
          }).catch(() => null);
          if (failed !== null) {
            await writeFailureFile(this.#d.paths, failed, this.#d.clock).catch(() => undefined);
            logger.error('JOB_FAILED', `投稿用の画像を作れないため、このjobは投稿しません: ${job.id}（${errorText(err)}）`, { job_id: job.id, error_code: code });
          }
        } else {
          if (code !== 'REVISION_CONFLICT') logger.warn('UPLOAD_NOT_PREPARED', `投稿用の画像を準備できませんでした（次の見回りで再度試します）: ${job.id}（${errorText(err)}）`, { job_id: job.id, error_code: code });
          if (code !== 'DISK_FULL') continue;
        }
      }
      return;
    }
  }

  async #probeDisk(): Promise<void> {
    if (this.#pressure !== 'DISK_FULL') return;
    const file = join(this.#d.paths.modeRoot, 'data', `.disk-probe-${process.pid}`);
    try {
      await writeFile(file, 'x'.repeat(4096));
      await unlink(file);
      this.setResourcePressure(null);
    } catch {
      // Still full: try again at the next tick.
    }
  }

  // ---------------------------------------------------------------- helpers

  #now(): Date {
    return this.#d.clock.now();
  }

  #clear(attemptId: string): void {
    if (this.#cur?.attempt_id === attemptId) this.#cur = null;
  }

  #bundleDir(job: Pick<Job, 'image'>): string {
    return join(this.#d.paths.modeRoot, ...posix.dirname(job.image.relative_path).split('/'));
  }

  async #releaseSlot(job: Job, reason: string): Promise<void> {
    const slot = slotOf(job);
    if (slot === null) return;
    await this.#d.scheduler
      .release(slot.date, slot.slotId, job.id, reason)
      .catch((err: unknown) => this.#d.logger.warn('SLOT_RELEASE_NOT_SAVED', `枠を戻せませんでした（次回の起動時に戻します）: ${slot.slotId}`, { job_id: job.id, slot_id: slot.slotId, error_code: errorCodeOf(err) }));
  }

  async #closeQuota(job: Job): Promise<void> {
    const slot = slotOf(job);
    if (slot === null) return;
    await this.#d.scheduler.closeQuota(slot.date, slot.slotId, job.id).catch((err: unknown) => this.#d.logger.warn('SLOT_NOT_SAVED', `枠を見送りにできませんでした: ${slot.slotId}`, { job_id: job.id, error_code: errorCodeOf(err) }));
  }

  /** A job update that moves its bundle when the status needs it (a missing folder: the job file alone, cf. R17). */
  async #move(job: Job, mutate: (j: Job) => Job): Promise<Job> {
    try {
      return await this.#d.bundles.transition(job.id, job.revision, mutate);
    } catch (err) {
      if (errorCodeOf(err) !== 'IMAGE_NOT_FOUND') throw err;
      return this.#d.store.update(job.id, job.revision, mutate);
    }
  }

  /** max(last_submit_at, latest intent) + gap ≤ now (R22, P3-R10). */
  #gapOk(now: Date): boolean {
    return this.#gap.waitUntil(now) === null;
  }

  #quota(eff: EffectiveConfig, t: PostType, now: Date, excludeJobId: string | null, observed: { kind: 'total' | 'daily' | 'monthly'; value: number; limit: number | null; at: Date } | null) {
    return remainingQuota({
      limits: eff.base.deploymentChecks.posting_limits[t],
      now,
      oursPosted: oursPostedFrom(this.#d.dedupe.records(), t),
      unresolved: unresolvedFrom(this.#d.store.summaries(), t),
      excludeJobId,
      observed,
    });
  }

  #gateContext(r: RefreshResult | null, now: Date, readiness?: Readiness): GateContext {
    const eff = r?.effective ?? this.#d.getEffective();
    const control = this.#d.control.get();
    return {
      stopping: false,
      mode: this.#d.mode,
      automation: eff.base.deploymentChecks.automation,
      pressure: this.#pressure,
      refreshFailed: r !== null && !r.ok,
      configRejected: r?.rejected ?? this.#lastRejected,
      halted: this.#d.getHalts().length > 0,
      paused: control.paused,
      pauseReason: control.pause_reason,
      stops: control.stops,
      readiness: this.#d.mode === 'live' ? (readiness ?? this.#d.readiness(eff, now)).global : [],
      blockingUnresolved: blockingUnresolved(this.#d.store.summaries(), jstDateKey(now)),
      wrongLogin: this.#wrongLogin(eff),
    };
  }

  /** While the connected extension sees another store logged in (it is in the wrong Chrome): what to do; else null. */
  #wrongLogin(eff: EffectiveConfig): string | null {
    const shown = this.#ext?.salonShown ?? null;
    if (shown === null || !this.extensionView().connected) return null;
    return wrongLoginJa(shown, eff.base.settings.audiences, eff.base.salon.expected_account_label ?? '');
  }

  #dispatchContext(eff: EffectiveConfig, readiness: Readiness, now: Date): DispatchContext {
    const routes = new Map<RouteKey, { hash: string; upload: string } | null>();
    const routeInfo = (key: RouteKey): { hash: string; upload: string } | null => {
      if (!routes.has(key)) {
        const [t, a] = key.split('.') as [PostType, Job['audience_category']];
        const r = resolveRoute(eff, t, a, this.#d.urlPolicy);
        routes.set(key, r.ok ? { hash: r.snapshot.profile_hash, upload: constraintsHash(r.profile.image) } : null);
      }
      return routes.get(key)!;
    };
    return {
      now,
      windowEnd: windowEndFor(eff.schedule, now),
      control: this.#d.control.get(),
      routeOk: (key) => {
        const [t, a] = key.split('.') as [PostType, Job['audience_category']];
        return readiness.routes[key].length === 0 && this.#d.stops.blocksType(t) === null && this.#d.stops.blocksRoute(t, a) === null && routeInfo(key) !== null;
      },
      verifiedHash: (key) => routeInfo(key)?.hash ?? null,
      uploadHash: (key) => routeInfo(key)?.upload ?? null,
    };
  }

  #noteGated(g: GateRefusal | null): void {
    const key = g === null ? null : `${g.code}|${g.reason_ja}`;
    if (key === this.#gatedKey) return;
    this.#gatedKey = key;
    if (g !== null) this.#d.logger.info('DISPATCH_GATED', `新しい投稿を止めています: ${g.reason_ja}`, { error_code: isErrorCode(g.code) ? g.code : null, gate_code: g.code });
  }

  #noteExtension(clientId: string, req: HelloRequest, now: Date): void {
    const prev = this.#ext;
    const signals = req.page?.signals;
    const loggedIn = signals === undefined ? (prev?.loggedIn ?? null) : !(signals.login || signals.mfa);
    const salonShown = req.salon_shown ?? null;
    const next = { clientId, lastSeen: now.getTime(), version: req.extension_version, loggedIn, tab: req.tab.state, connected: true, written: prev?.written ?? 0, salonShown };
    this.#ext = next;
    if (salonShown !== (prev?.salonShown ?? null)) {
      const wrong = this.#wrongLogin(this.#d.getEffective());
      if (wrong !== null) this.#d.logger.warn('WRONG_SALON_LOGIN', wrong, { error_code: 'WRONG_SALON' });
      else this.#d.logger.info('WRONG_SALON_LOGIN_CLEARED', 'SALON BOARD のログインがこのツールの店舗に戻りました。');
    }
    if (prev === null || !prev.connected) this.#d.logger.info('EXTENSION_CONNECTED', `拡張機能が接続しました（版 ${req.extension_version}）。`, { extension_version: req.extension_version });
    if (prev === null || !prev.connected || prev.loggedIn !== loggedIn || now.getTime() - prev.written >= 5 * 60_000) void this.#writeExtension(now);
  }

  async #writeExtension(now: Date): Promise<void> {
    const e = this.#ext;
    if (e === null || this.#d.runtimeStatus === undefined) return;
    e.written = now.getTime();
    const fingerprint = this.#d.control.get().paired_client?.fingerprint ?? '----';
    await this.#d.runtimeStatus.setExtension(e.connected ? { last_seen_at: new Date(e.lastSeen).toISOString(), extension_version: e.version, logged_in: e.loggedIn, tab_state: e.tab, fingerprint } : null);
  }

  #fields(job: Job, extra: LogFields = {}): LogFields {
    const a = job.attempts.at(-1);
    const claimed = a?.claimed_at === null || a?.claimed_at === undefined ? null : Date.parse(a.claimed_at);
    return {
      job_id: job.id,
      attempt_id: a?.id ?? null,
      post_type: job.post_type,
      audience_category: job.audience_category,
      stage: job.stage,
      retry_count: job.retry_count,
      duration_ms: claimed === null ? null : Math.max(0, this.#now().getTime() - claimed),
      ...extra,
    };
  }
}

export type { CommandKind };
