import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { AiService, keyStateOf } from './ai/ai-service.js';
import { currentAiSetup, loadAiSetup, type AiSetup } from './ai/ai-setup.js';
import { geminiQuotaStatusLines } from './ai/gemini-status.js';
import { RealContentPipeline } from './ai/content-pipeline.js';
import { aiConfigFailure, envUnreadableFailure, usesRealAi } from './ai/factory.js';
import { UsageMeter } from './ai/usage-meter.js';
import { ConfigManager } from './config/loader.js';
import { EffectiveConfigSource, effectiveReadiness, scheduleCapacityIssues } from './content/effective-config.js';
import { LivePostingCoordinator } from './posting/coordinator.js';
import { EffectiveConfigService } from './posting/effective-refresh.js';
import { IntentLedger } from './posting/intent-ledger.js';
import { backfillPosted } from './posting/post-commit.js';
import { StopRegistry } from './posting/stops.js';
import { PRODUCTION_URL_POLICY } from './shared/url-policy.js';
import { InstructionManager } from './content/instructions/store.js';
import { TemplateSource } from './content/template-source.js';
import { TrendFeed } from './content/trend-feed.js';
import { syncTrendWorkbooks, trendListAudience } from './content/trend-workbook.js';
import { WebTrendsRunner, readAllWebTrends, webTrendAudiences } from './content/web-trends.js';
import { DryRunPoster } from './execution/dry-run-poster.js';
import { JobProcessor } from './execution/job-processor.js';
import { RunLoop, type RunLoopDeps } from './execution/run-loop.js';
import { ScheduleStore } from './execution/schedule-store.js';
import { Scheduler, blockingUnresolved } from './execution/scheduler.js';
import { markInterruptedPostsUnknown, rearmReconcile, releaseInterruptedReservations, suspectUnrecordedSend } from './execution/startup-recovery.js';
import { createFileLogger, loggerFrom, withEcho, type AppLogger } from './logger.js';
import { FakeClock, systemClock, type Clock } from './shared/clock.js';
import { AppFailure, appError, errorCodeOf, errorText } from './shared/errors.js';
import { newId } from './shared/ids.js';
import type { Mode, PostType } from './shared/types.js';
import { acquireAppLock, type AppLock } from './storage/app-lock.js';
import { BundleMover } from './storage/bundles.js';
import { ControlStore } from './storage/control-store.js';
import { DedupeStore } from './storage/dedupe-store.js';
import { HistoryStore, historyFullTextDays } from './storage/history-store.js';
import { ImageIntake } from './storage/image-intake.js';
import { JobStore } from './storage/job-store.js';
import { RetentionManager } from './storage/retention.js';
import { ResourceMonitor } from './resource-monitor.js';
import { ensureDirs, envDirOf, resolveDataPaths } from './storage/paths.js';
import { RuntimeStatusWriter, haltCode } from './storage/runtime-status.js';
import { SerialQueue } from './storage/serial-queue.js';
import { contentStatusFrom } from './status-content.js';
import { buildStatus, type StatusSnapshot } from './status.js';
import type { RuntimeAiOptions, RuntimeOptions, RuntimeTiming } from './runtime-types.js';
import { checkAcl } from './server/acl-check.js';
import { pairingCodeLine } from './server/handlers/system.js';
import { formatJst } from './shared/time.js';
import { createLocalApiServer } from './server/http-server.js';
import { ensureMasterSecret, removeLocalApiFile, writeLocalApiFile } from './server/keys.js';
import { PairingService } from './server/pairing.js';

export type { RuntimeAiOptions, RuntimeOptions, RuntimeTiming };

const DEFAULT_TIMING: RuntimeTiming = { intakeMs: 10_000, tickMs: 30_000, configMs: 30_000 };
/** Spec 16.6: memory, disk and logs are looked at about every 30 s. */
const MONITOR_MS = 30_000;
/** How often the running tool checks whether the weekly web look-up of trend words is due (Sundays from 06:00 JST). */
const WEB_TRENDS_CHECK_MS = 10 * 60_000;
/** runOnce: two pending scans this far apart (business clock) so a finished copy counts as stable. */
const ONCE_SCAN_GAP_MS = 3000;

export interface RuntimeHandle {
  /** Finishes the work item in progress, stops the loops and releases the lock. Safe to call any number of times. */
  stop(): Promise<void>;
  status(): Promise<StatusSnapshot>;
  /** Settles once the runtime has stopped and released the lock; rejects if an unexpected error ended the loop. */
  readonly closed: Promise<void>;
  /** The live poster (tests drive its maintain() and resource pressure directly). */
  readonly coordinator: LivePostingCoordinator;
  /** The pairing-code line shown at startup while no extension is paired (start repeats it below the status). */
  readonly pairingLine: string | null;
}

interface Core extends RunLoopDeps {
  instructions: InstructionManager;
  /** config + the latest instruction overlay: what the scheduler and the status use. */
  effective: EffectiveConfigSource;
  runtimeStatus: RuntimeStatusWriter;
  lock: AppLock;
  clock: Clock;
  store: JobStore;
  control: ControlStore;
  dedupe: DedupeStore;
  schedules: ScheduleStore;
  /** The log without the console echo: for failures the CLI itself prints, so they are not shown twice. */
  logOnly: AppLogger;
  ai: AiService;
  meter: UsageMeter;
  templates: TemplateSource;
  trends: TrendFeed;
  /** The weekly web look-ups of men's and women's hair trend words, per audience; only startRuntime runs it. */
  webTrends: WebTrendsRunner;
  /** The .env file and environment as read once at startup (an edited .env applies after a restart). */
  aiSetup: AiSetup;
  instanceId: string;
  /** Random per process start: part of every signed local API request (D1-2). */
  serverNonce: string;
  /** The live poster (Plan 3 Task 2b); built in both modes, it serves posts only in live. */
  coordinator: LivePostingCoordinator;
  /** Plan 4: the 30-day cleanup (spec 16.5) and the daily backups. */
  retention: RetentionManager;
  /** Plan 4 (spec 16.6): memory, disk, logs; its checks run only in startRuntime (monitoring). */
  monitor: ResourceMonitor;
  monitoring: boolean;
}

function forwardTo(get: () => AppLogger | null): AppLogger {
  return loggerFrom((level, event, message, fields) => get()?.[level](event, message, fields));
}

/** RECOVERY_HALTED repeats every intake cycle while a job stays halted: log each job/reason once until it recovers. */
function quietRepeatedHalts(base: AppLogger): AppLogger {
  const logged = new Set<string>();
  return loggerFrom((level, event, message, fields) => {
    const job = String(fields?.job_id ?? '');
    if (event === 'RECOVERY_COMPLETED') for (const key of [...logged]) if (key.startsWith(`${job}|`)) logged.delete(key);
    if (event === 'RECOVERY_HALTED') {
      const key = `${job}|${String(fields?.reason)}|${String(fields?.error_code)}`;
      if (logged.has(key)) return;
      logged.add(key);
    }
    base[level](event, message, fields);
  });
}

interface OpenOptions {
  projectRoot: string;
  clock: Clock;
  logger?: AppLogger | undefined;
  echo?: ((line: string) => void) | undefined;
  requireMode?: Mode;
  ai?: RuntimeAiOptions | undefined;
  /** Local API seams and test-only overrides (RuntimeOptions; DI only). */
  api?: RuntimeOptions['api'];
  testOverrides?: RuntimeOptions['testOverrides'];
  maintainMs?: number | undefined;
  /** The resource monitor saw memory over its limit for too long (startRuntime stops). */
  onExhausted?: () => void;
}

/**
 * Startup, in the order of spec 16.7-4 (Plan 1 part): config → folders → lock → stores → recoverAll (R18) → R23 → R21 →
 * resumeInterrupted. Whatever fails after the lock was taken releases it again.
 */
async function openCore(o: OpenOptions): Promise<Core> {
  const { clock } = o;
  let target: AppLogger | null = null; // the log folder comes from the config, so the logger is attached afterwards
  const config = await ConfigManager.init(join(o.projectRoot, 'config'), forwardTo(() => target), { createCountsFile: true });
  const settings = config.current.settings;
  if (o.requireMode !== undefined && settings.mode !== o.requireMode) {
    const message = `この操作は settings.json の mode が "${o.requireMode}" のときだけ使えます（現在: "${settings.mode}"）`;
    throw new AppFailure(appError('CONFIG_INVALID', 'config', clock, { message, details: { issues: [{ file: 'settings.json', path: 'mode', message }] } }));
  }
  const mode = settings.mode;
  // .env is read once here (an edited .env applies after a restart); AI lines a real AI needs must be right to start.
  const startupAi = await loadAiSetup(envDirOf(o.projectRoot, settings), settings.ai, o.ai?.env);
  const realAi = usesRealAi(settings, mode, startupAi.config);
  if (realAi && startupAi.config.issues.length > 0) throw aiConfigFailure(startupAi.config, clock);
  if (realAi && startupAi.envFile === 'unreadable') throw envUnreadableFailure(clock);
  const paths = resolveDataPaths(o.projectRoot, settings);
  await ensureDirs(paths);
  const instanceId = newId('inst');
  // Log timestamps are real time even for `dry-run --once --at` (an audit trail); the echo shows the business clock.
  const base = o.logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId, mode, clock: systemClock, maxFileMb: settings.logs.max_file_mb });
  const logger = o.echo === undefined ? base : withEcho(base, o.echo, clock);
  target = logger;
  config.reportCountsFile();
  // Problems of .env AI lines that this run does not use (the mock answers) are only warnings.
  for (const i of [...(realAi ? [] : startupAi.config.issues), ...startupAi.config.warnings]) {
    logger.warn('AI_ENV_WARNING', `AIの設定（${i.file} ${i.path}）: ${i.message}`, { file: i.file, path: i.path });
  }
  if (startupAi.envFile === 'unreadable') logger.warn('ENV_FILE_UNREADABLE', '.env を読み込めなかったため、settings.json と環境変数の設定だけで動きます（.env を閉じてから起動し直してください）。');

  let lock: AppLock;
  try {
    // The lock's started_at is compared with OS process start times, so it always uses the real clock.
    lock = await acquireAppLock({ lockFile: paths.lockFile, instanceId, clock: systemClock });
  } catch (err) {
    logFailure(base, 'RUNTIME_START_FAILED', '起動できませんでした', err);
    throw err;
  }
  try {
    // A write that finds the disk full stops new posts until the coordinator's probe write works again (15.1-q).
    let coordinator: LivePostingCoordinator | null = null;
    let monitor: ResourceMonitor | null = null;
    const queue = new SerialQueue((err) => coordinator?.noteFailure(err));
    const store = await JobStore.open(paths, queue, clock);
    const dedupe = await DedupeStore.load(paths, queue, clock);
    const control = await ControlStore.load(paths, queue, clock);
    const schedules = new ScheduleStore(paths, queue, clock);
    const instructions = new InstructionManager({
      dir: paths.instructionsDir,
      recordFile: paths.instructionsFile,
      config: () => config.current,
      logger,
      queue,
      validate: scheduleCapacityIssues,
    });
    const effective = new EffectiveConfigSource(config, instructions);
    const refresher = new EffectiveConfigService({ config, instructions, effective });
    const bundles = new BundleMover({ paths, store, clock, logger: quietRepeatedHalts(logger) });
    // Real time: the read-only status shows when the run stopped, whatever business clock `dry-run --once --at` used.
    const runtimeStatus = new RuntimeStatusWriter({ paths, queue, instanceId, clock: systemClock, logger });

    // Plan 2: the content pipeline (spec 6-10). .env is read before the provider is chosen; values are never logged.
    const getSettings = (): typeof settings => config.current.settings;
    // The business clock: a day's budget is the JST day the run believes it is (also for `dry-run --once --at`).
    const meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue, getSettings, clock });
    const ai = new AiService({
      getSettings,
      mode,
      meter,
      env: startupAi.env,
      envUnreadable: startupAi.envFile === 'unreadable',
      getSnapshot: () => config.current,
      clock,
      logger,
      onStopChange: (stop) => void runtimeStatus.setAiStop(stop),
      ...(o.ai?.createClient === undefined ? {} : { createClient: o.ai.createClient }),
      ...(o.ai?.sleep === undefined ? {} : { sleep: o.ai.sleep }),
      ...(o.ai?.random === undefined ? {} : { random: o.ai.random }),
      ...(o.ai?.mock === undefined ? {} : { mock: o.ai.mock }),
    });
    ai.provider(); // chosen (and logged) at startup
    const templates = new TemplateSource({
      mapping: () => config.current.templateMapping,
      categories: () => config.current.categories,
      cacheDir: paths.templateCacheDir,
      baseDir: o.projectRoot,
      logger,
      clock,
    });
    const trends = new TrendFeed({ config: () => config.current, cacheDir: paths.trendCacheDir, baseDir: o.projectRoot, workbookDir: paths.trendWorkbookDir, logger, clock });
    const history = await HistoryStore.load(paths, queue, clock, {
      mode,
      fullTextDays: historyFullTextDays(settings.retention),
      dedupe,
      logger,
    });
    const pipeline = new RealContentPipeline({
      ai,
      snapshot: () => config.current,
      effective: () => effective.current,
      instructions: () => instructions.current,
      templates,
      trends,
      sources: { history, jobs: store, dedupe },
      paths,
      clock,
      logger,
    });
    // Decision 13: the type the coming slots need is prepared first, and a due slot waits for a job still being prepared.
    const processor: JobProcessor = new JobProcessor({
      store,
      bundles,
      pipeline,
      getSettings: () => config.current.settings,
      clock,
      logger,
      paths,
      preferredType: (): PostType | null => scheduler.neededType(),
      resourceHold: () => monitor?.hold() ?? null,
    });
    const scheduler: Scheduler = new Scheduler({
      clock,
      schedules,
      jobs: store,
      control,
      getSchedule: () => effective.current.schedule,
      getSettings: () => config.current.settings,
      getConfigHash: () => effective.current.hash,
      // Plan 3: inside a live claim the coordinator decides; elsewhere (dry-run ticks) everything is available.
      isRouteAvailable: (t, a) => coordinator?.isRouteAvailable(t, a) ?? true,
      isTypeAvailable: (t) => coordinator?.isTypeAvailable(t) ?? { ok: true },
      isJobDispatchable: (s) => coordinator?.isJobDispatchable(s) ?? true,
      // P3-R2: also in dry-run (deviation recorded in the plan).
      hasBlockingUnresolved: (today) => blockingUnresolved(store.summaries(), today),
      willPrepare: (type): boolean => processor.willPrepare(type),
      heldReason: (type) => processor.heldReason(type),
      isCurrent: (s): boolean => processor.isCurrent(s),
      logger,
    });
    const intake = new ImageIntake({
      paths,
      store,
      dedupe,
      bundles,
      settings: () => config.current.settings,
      salonId: config.current.salon.salon_id,
      mode,
      configHash: () => config.current.hash,
      clock,
      logger,
    });
    const poster = mode === 'dry_run' ? new DryRunPoster({ mode, store, bundles, dedupe, control, scheduler, instanceId, clock, logger, history }) : null;
    const libraries = {
      refresh: async (now: Date): Promise<void> => {
        await templates.refresh();
        await trends.refresh(now);
      },
    };

    logger.info('RUNTIME_STARTED', `起動しました（モード: ${mode === 'dry_run' ? 'dry-run' : '本番'}、データの場所: ${paths.modeRoot}）。`, {
      config_hash: config.current.hash,
      data_root: paths.modeRoot,
    });
    const stops = new StopRegistry(control, clock, logger);
    const ledger = new IntentLedger(paths.ledgerDir, { logger });
    const report = await bundles.recoverAll(); // before the first pending scan
    // Spec 16.5: an interrupted cleanup is finished before anything else reads the POSTED jobs (e.g. the history backfill).
    const retention = new RetentionManager({
      paths,
      store,
      dedupe,
      history,
      clock,
      logger,
      retention: () => config.current.settings.retention,
      inFlight: () => coordinator?.current()?.job_id ?? null,
    });
    await retention.recover();
    monitor = new ResourceMonitor({
      paths,
      settings: () => config.current.settings,
      clock,
      logger,
      retention,
      pressure: { current: () => coordinator?.resourcePressure ?? null, set: (code) => coordinator?.setResourcePressure(code) },
      ...(o.testOverrides?.resourceSample === undefined ? {} : { sample: o.testOverrides.resourceSample }),
      ...(o.onExhausted === undefined ? {} : { onExhausted: o.onExhausted }),
    });
    const recovery = { store, bundles, schedules, paths, clock, logger, mode, graceMinutes: config.current.schedule.slot_grace_minutes, schedule: config.current.schedule };
    await markInterruptedPostsUnknown(recovery);
    await releaseInterruptedReservations(recovery);
    await processor.resumeInterrupted();
    // POSTED records a crash kept out (dedupe, history.json: spec 11.4-5, slot done: R28), and reconcile after a restart.
    await backfillPosted({ store, dedupe, history, schedules, clock, logger });
    await rearmReconcile({ store, clock, logger });
    if (mode === 'live') {
      // P3-R38: sends the saved data does not know about (e.g. data/ restored from a backup) stop new posts. Fail closed.
      await suspectUnrecordedSend({ mode, ledger, store, dedupe, control, stops, clock, logger }).catch(async (err: unknown) => {
        logger.error('UNRECORDED_SEND_CHECK_FAILED', `送信記録（ledger）を確認できなかったため、念のため新規の送信を止めます: ${errorText(err)}`, { error_code: errorCodeOf(err) });
        await stops.raise('POST_RESULT_UNKNOWN', {}, { detail: 'unrecorded_send_suspected' });
      });
      await ledger.prune(clock.now()).catch(() => undefined);
    }
    // Before the first plan is built (spec 5.10). A failure is retried by the loop; nothing is dispatched until it works.
    await instructions.scan(clock.now()).catch((err: unknown) => {
      logger.error('INSTRUCTIONS_CHECK_FAILED', `作業指示書の確認にエラーが発生しました（処理は続けます）: ${errorText(err)}`, { error_code: errorCodeOf(err) });
    });
    // The owner's trend workbooks (no AI call): the hand-kept template once, and the weekly list when it is behind.
    await syncTrendWorkbooks(await readAllWebTrends(paths.trendCacheDir), paths.trendCacheDir, paths.trendWorkbookDir, logger, trendListAudience(settings));
    await libraries.refresh(clock.now());
    const acceptMockAi = o.testOverrides?.allowMockAiInLive === true;
    const policy = o.api?.urlPolicy ?? PRODUCTION_URL_POLICY;
    coordinator = new LivePostingCoordinator({
      mode,
      clock,
      store,
      bundles,
      scheduler,
      dedupe,
      history,
      control,
      stops,
      processor,
      pipeline,
      refresh: (now) => refresher.refresh(now),
      getEffective: () => effective.current,
      instructions: () => instructions.current,
      readiness: (eff, now) => effectiveReadiness(eff, instructions.current, currentAiSetup(startupAi, config.current.settings.ai).config, { now, policy, acceptMockAi }),
      getHalts: () => core.halted,
      ledger,
      paths,
      logger,
      instanceId,
      urlPolicy: policy,
      acceptMockDrafts: acceptMockAi,
      runtimeStatus,
      schedules,
      ...(o.maintainMs === undefined ? {} : { maintainMs: o.maintainMs }),
    });
    if (mode === 'live') {
      // P3-R41: READY drafts that no real AI wrote are written again before anything can post them (once, at startup).
      for (const s of store.summaries((x) => x.status === 'READY' && !x.provenance_real && !x.has_operation)) {
        const job = await store.get(s.id);
        if (job === null || job.status !== 'READY' || (acceptMockAi && job.draft_provenance?.provider === 'mock')) continue;
        await store.update(job.id, job.revision, (j) => ({ ...j, status: 'GENERATING', stage: 'generate' }));
        processor.notifyRegeneration(job.id);
        logger.info('JOB_REGENERATING', `本番用のAIで作られていない文章のため、作り直します: ${job.id}`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'generate' });
      }
      const r = effectiveReadiness(effective.current, instructions.current, startupAi.config, { now: clock.now(), policy, acceptMockAi });
      const count = r.global.length + Object.values(r.routes).reduce((n, items) => n + items.length, 0);
      if (count > 0) logger.warn('LIVE_NOT_READY', `本番の準備で未完了の項目が${count}件あります。終わった投稿先から SALON BOARD へ投稿します（status で確認できます）。`, { readiness_items: count });
    }
    const core: Core = {
      config,
      instructions,
      effective,
      mode,
      paths,
      lock,
      clock,
      logger,
      store,
      control,
      dedupe,
      schedules,
      bundles,
      scheduler,
      intake,
      processor,
      poster,
      runtimeStatus,
      libraries,
      halted: report.halted,
      logOnly: base,
      ai,
      meter,
      templates,
      trends,
      webTrends: new WebTrendsRunner({
        ai,
        snapshot: () => config.current,
        cacheDir: paths.trendCacheDir,
        workbookDir: paths.trendWorkbookDir,
        clock,
        logger,
        audiences: () => webTrendAudiences(effective.current.routes, effective.current.audiences),
      }),
      aiSetup: startupAi,
      instanceId,
      serverNonce: randomBytes(16).toString('base64url'),
      coordinator,
      refresher,
      retention,
      monitor,
      monitoring: false,
      resourceHold: () => monitor?.hold() ?? null,
    };
    return core;
  } catch (err) {
    logFailure(base, 'RUNTIME_START_FAILED', '起動できませんでした', err);
    await lock.release().catch(() => undefined);
    throw err;
  }
}

/** Records a failure that ends the command (the CLI prints it too, so `log` must not echo it to the console). */
function logFailure(log: AppLogger, event: string, what: string, err: unknown): void {
  const error_code = errorCodeOf(err);
  log.error(event, `${what}（${error_code}）: ${errorText(err)}`, { error_code });
}

async function statusOf(c: Core): Promise<StatusSnapshot> {
  const now = c.clock.now();
  const aiSetup = currentAiSetup(c.aiSetup, c.config.current.settings.ai);
  const status = await buildStatus({
    mode: c.mode,
    config: c.config.current,
    jobs: c.store,
    control: c.control,
    dedupe: c.dedupe,
    schedules: c.schedules,
    clock: c.clock,
    recoveryHalted: c.halted,
    runtimeRecord: c.runtimeStatus.current,
    configIssues: c.config.latestRejectedIssues,
    instructions: { scan: c.instructions.current, source: 'runtime' },
    ai: aiSetup,
    content: async () => {
      const stop = await c.ai.stop(now);
      const trends = c.config.current.trends.enabled ? c.trends.status(now) : null;
      return contentStatusFrom(c.config.current, {
        provider: c.ai.kind,
        ...keyStateOf(c.ai.kind, aiSetup.config),
        usage: () => c.meter.summary(now),
        quota: async () => geminiQuotaStatusLines(c.config.current.settings.ai, await c.meter.quotaSummary(now), now, aiSetup.config),
        stop,
        templates: c.templates.status,
        trends: trends === null ? null : { state: trends.state, label: trends.label, valid_records: c.trends.validRecords(now).length, sources: trends.sources, web: c.trends.webStatusLines(now, webTrendAudiences(c.effective.current.routes, c.effective.current.audiences)), manual: c.trends.manualStatusLine() },
      });
    },
  });
  return c.monitoring ? { ...status, dto: { ...status.dto, resources: c.monitor.view() } } : status;
}

/** End of a run: record it as stopped (with its last dispatch-halt state) in runtime-status.json, then release the lock. */
async function closeCore(c: Core): Promise<void> {
  await c.runtimeStatus.write(c.halted, true);
  try {
    if ((await c.lock.release()) === 'unreadable') {
      const lockFile = c.paths.lockFile;
      c.logger.warn(
        'LOCK_RELEASE_SKIPPED',
        `ロックファイルを読み取れないため、削除せずに残しました。ほかに起動中のプロセスが無いことを確認してから、このファイルを削除してください: ${lockFile}`,
        { lock_file: lockFile },
      );
    }
  } catch (err) {
    c.logger.error('LOCK_RELEASE_FAILED', `ロックファイルを削除できませんでした: ${errorText(err)}`, { error_code: 'FILE_IO_ERROR' });
  }
}

/** How long the stop waits for in-flight post-intent results before the local API closes. */
const API_DRAIN_MS = 90_000;

/**
 * The local API (Plan 3 Task 1b), started after the recovery and resumeInterrupted: the master secret from .env, a fresh
 * CLI key, listen on 127.0.0.1 only, then data/local-api.json; a pairing window when no extension is paired. stop():
 * stopping → drain → close → local-api.json removed (the caller then releases the lock).
 */
async function startLocalApi(c: Core, o: RuntimeOptions): Promise<{ stop: () => Promise<void>; pairingLine: string | null }> {
  const settings = c.config.current.settings;
  const { master, created } = await ensureMasterSecret(o.projectRoot, settings.server.token_env, envDirOf(o.projectRoot, settings));
  const cliKey = randomBytes(32);
  const pairing = new PairingService({ master, serverNonce: c.serverNonce });
  const echo = o.echo ?? ((): void => undefined);
  let warnings: string[] = [];
  const server = createLocalApiServer({
    port: o.api?.port ?? settings.server.port,
    instanceId: c.instanceId,
    serverNonce: c.serverNonce,
    mode: c.mode,
    clock: c.clock,
    logger: c.logger,
    allowedExtensionIds: () => c.config.current.settings.server.allowed_extension_ids,
    master,
    cliKey,
    pairedClient: () => c.control.get().paired_client,
    setPairedClient: (client) => c.control.setPairedClient(client),
    pairing,
    // The snapshot's body plus what only the running tool knows: its gate view, the extension now, the ACL check.
    status: async () => {
      const { dto } = await statusOf(c);
      const { last_seen, ...ext } = c.coordinator.extensionView();
      return {
        ...dto,
        dispatch: c.coordinator.dispatchView().dispatch,
        extension: { ...dto.extension, ...ext, last_seen_jst: last_seen === null ? dto.extension.last_seen_jst : formatJst(last_seen) },
        warnings: [...dto.warnings, ...warnings],
      };
    },
    control: c.control,
    coordinator: c.coordinator,
    config: () => c.config.current,
    surveyDir: c.paths.surveyDir,
    jobs: c.store,
    maintenance: c.retention,
    noteSeen: (clientId, at) => c.coordinator.noteSeen(clientId, at),
    echo,
    listenErrorCode: o.api?.faults?.listenErrorCode,
  });
  await server.listen();
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      await server.close(o.timing?.drainMs ?? API_DRAIN_MS);
      await removeLocalApiFile(c.paths.localApiFile, c.instanceId).catch((err: unknown) => {
        c.logger.warn('LOCAL_API_FILE_REMOVE_FAILED', `data/local-api.json を削除できませんでした（次の起動で置き換えます）: ${errorText(err)}`);
      });
    })());
  try {
    await writeLocalApiFile(c.paths.localApiFile, {
      schema_version: 1,
      instance_id: c.instanceId,
      pid: process.pid,
      port: server.port,
      data_root: resolve(o.projectRoot, settings.data_root),
      started_at: systemClock.now().toISOString(),
      cli_key: cliKey.toString('base64url'),
    });
  } catch (err) {
    await stop();
    throw err;
  }
  void checkAcl(c.paths.projectRoot, { envDir: c.paths.sharedRoot ?? c.paths.projectRoot })
    .then((w) => {
      warnings = w;
      for (const line of w) c.logger.warn('ACL_WARNING', line);
    })
    .catch(() => undefined);
  if (created && c.control.get().paired_client !== null) {
    // The old pairing can never verify again: forget it, so status, the banner and the popup all ask for a new one.
    await c.control.setPairedClient(null);
    c.logger.warn('PAIRING_KEY_RENEWED', '.env の LOCAL_API_TOKEN を作り直したため、拡張機能の接続をやり直してください（下の接続コードを拡張機能に入力します）。');
  }
  let pairingLine: string | null = null;
  if (c.control.get().paired_client === null) {
    const w = pairing.open(c.clock.now(), 'start');
    if (w !== 'rate_limited') echo((pairingLine = pairingCodeLine(w.code)));
    c.logger.info('PAIRING_OPENED', '拡張機能の接続を受け付けています（5分間）。接続コードはこの画面に表示しています。', { by: 'start' });
  }
  c.logger.info('LOCAL_API_STARTED', `拡張機能との接続口を開きました（127.0.0.1:${server.port}）。`, { port: server.port });
  return { stop, pairingLine };
}

/** `start`: the startup (recovery included), the local API, then the resident loop until stop(). */
export async function startRuntime(o: RuntimeOptions): Promise<RuntimeHandle> {
  let exhaust = (): void => undefined;
  const core = await openCore({
    projectRoot: o.projectRoot,
    clock: o.clock ?? systemClock,
    logger: o.logger,
    echo: o.echo,
    ai: o.ai,
    api: o.api,
    testOverrides: o.testOverrides,
    maintainMs: o.timing?.maintainMs,
    onExhausted: () => exhaust(),
  });
  let api: { stop: () => Promise<void>; pairingLine: string | null };
  try {
    api = await startLocalApi(core, o);
    core.coordinator.startTimer();
    // Spec 16.7-4: the resource check and the cleanup start right after the startup, without holding it up.
    core.monitoring = true;
    core.monitor.start(o.timing?.monitorMs ?? MONITOR_MS);
  } catch (err) {
    logFailure(core.logOnly, 'RUNTIME_START_FAILED', '起動できませんでした', err);
    await core.monitor.stop();
    await core.lock.release().catch(() => undefined);
    throw err;
  }
  // Never waits for the look-up: posting goes on while the AI searches.
  core.webTrends.check(core.clock.now());
  const webTimer = setInterval(() => core.webTrends.check(core.clock.now()), WEB_TRENDS_CHECK_MS);
  webTimer.unref();
  // The loop writes runtime-status.json at its start and whenever the dispatch-halt state changes (R25).
  const loop = new RunLoop(core, { ...DEFAULT_TIMING, ...o.timing }, async () => {
    clearInterval(webTimer);
    await api.stop();
    await core.coordinator.stopTimer();
    await core.monitor.stop();
    await core.webTrends.idle(); // a look-up in progress meters its call before the lock is released
    await closeCore(core);
    core.logger.info('RUNTIME_STOPPED', '常駐処理を終了しました。');
  });
  // Memory stayed over its limit: a graceful stop that ends with RESOURCE_MEMORY_HIGH, so nothing restarts it in a loop.
  let exhausted = false;
  exhaust = () => {
    exhausted = true;
    void api.stop();
    void loop.stop();
  };
  const closed = loop.closed.then(() => {
    if (exhausted) throw new AppFailure(appError('RESOURCE_MEMORY_HIGH', 'runtime', systemClock, { message: 'メモリの使用量が上限を超えた状態が続いたため停止しました。PCを再起動してから起動し直してください。' }));
  });
  closed.catch(() => undefined);
  return {
    stop: () => {
      void api.stop(); // new claims and intents are refused from now on, while the loop finishes its item
      return loop.stop();
    },
    status: () => statusOf(core),
    closed,
    coordinator: core.coordinator,
    pairingLine: api.pairingLine,
  };
}

/**
 * `dry-run --once`: the same startup as startRuntime, then on a clock that stands at `at`: two pending scans, every job
 * that can be prepared made READY, one tick, and the pseudo-post of whatever it dispatched. Dry-run only. The returned
 * status is taken after the run was recorded as stopped and the lock released.
 */
export async function runOnce(o: { projectRoot: string; at: Date; logger?: AppLogger; echo?: (line: string) => void; ai?: RuntimeAiOptions }): Promise<StatusSnapshot> {
  if (Number.isNaN(o.at.getTime())) throw new AppFailure(appError('INTERNAL_ERROR', 'cli', systemClock, { message: '基準時刻が不正です' }));
  // The scans straddle `at`, so the tick and the post happen exactly at `at`.
  const clock = new FakeClock(new Date(o.at.getTime() - ONCE_SCAN_GAP_MS).toISOString());
  const c = await openCore({ projectRoot: o.projectRoot, clock, logger: o.logger, echo: o.echo, requireMode: 'dry_run', ai: o.ai });
  const soft = async (event: string, what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      c.logger.error(event, `${what}にエラーが発生しました: ${errorText(err)}`, { error_code: errorCodeOf(err) });
    }
  };
  try {
    await soft('INTAKE_FAILED', '画像の取込中', () => c.intake.scanOnce());
    clock.advance(ONCE_SCAN_GAP_MS);
    await soft('INTAKE_FAILED', '画像の取込中', () => c.intake.scanOnce());
    // A second look at `at` as well: instruction files written just before (by the business clock) count as settled.
    await soft('INSTRUCTIONS_CHECK_FAILED', '作業指示書の確認中', () => c.instructions.scan(clock.now()));
    while (await c.processor.processNext()) {
      // prepare everything that can be prepared
    }
    c.halted = (await c.bundles.recoverAll()).halted;
    const code = haltCode(c.halted);
    if (code !== null) {
      c.logger.error('DISPATCH_HALTED', `復旧できないjobがあるため、投稿の配布をしませんでした（${c.halted.length}件）。`, {
        error_code: code,
        job_ids: c.halted.map((h) => h.job_id),
      });
    } else if (c.instructions.current === null) {
      c.logger.error('DISPATCH_WAITING_INSTRUCTIONS', '作業指示書（instructions フォルダ）を確認できなかったため、投稿の配布をしませんでした。');
    } else {
      await c.scheduler.replanIfScheduleChanged();
      const dispatch = await c.scheduler.tick();
      if (dispatch !== null && c.poster !== null) {
        const poster = c.poster;
        await soft('POST_FAILED', '擬似投稿中', () => poster.post(dispatch));
      }
    }
  } catch (err) {
    logFailure(c.logOnly, 'RUN_ONCE_FAILED', 'dry-run の1回実行を途中で中止しました', err);
    throw err;
  } finally {
    await closeCore(c);
  }
  return statusOf(c);
}
