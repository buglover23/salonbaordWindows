import { performance } from 'node:perf_hooks';
import type { ConfigManager } from '../config/loader.js';
import type { InstructionManager } from '../content/instructions/store.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf, errorText } from '../shared/errors.js';
import type { Mode } from '../shared/types.js';
import type { BundleMover, RecoveryHalt } from '../storage/bundles.js';
import type { ImageIntake } from '../storage/image-intake.js';
import { resolveDataPaths, type DataPaths } from '../storage/paths.js';
import { haltCode, type RuntimeStatusWriter } from '../storage/runtime-status.js';
import type { DryRunPoster } from './dry-run-poster.js';
import type { JobProcessor } from './job-processor.js';
import type { Scheduler } from './scheduler.js';

export interface RunLoopTiming {
  intakeMs: number;
  tickMs: number;
  /** Config and instruction-folder check. */
  configMs: number;
  /** The next instruction check while a file is still being written (default 3 s). */
  recheckMs?: number;
}

const DEFAULT_RECHECK_MS = 3000;

export interface RunLoopDeps {
  config: ConfigManager;
  /** The instruction folder (spec 5.10); null: none is used. */
  instructions: Pick<InstructionManager, 'scan' | 'current'> | null;
  /** The business clock passed to the instruction scans. */
  clock: Clock;
  /** The mode the process started in; a later change in settings.json needs a restart. */
  mode: Mode;
  paths: DataPaths;
  logger: AppLogger;
  bundles: BundleMover;
  intake: ImageIntake;
  processor: JobProcessor;
  scheduler: Scheduler;
  /** null: nothing is ever dispatched (live mode in Plan 1), so tick and replan are never called. */
  poster: DryRunPoster | null;
  /** Latest recoverAll result, shared with the status display. While non-empty nothing is dispatched (R18). */
  halted: RecoveryHalt[];
  /** runtime-status.json (R25): written at startup and whenever the dispatch-halt state changes. Must never throw. */
  runtimeStatus: Pick<RuntimeStatusWriter, 'write'>;
  /**
   * Plan 2: the Excel templates and the trend CSVs, looked at in every config step and loaded again only when they
   * changed. Must never throw.
   */
  libraries?: { refresh(now: Date): Promise<void> };
  /** Plan 3: the config step runs alone with the live poster's claim/intent refresh (EffectiveConfigService). */
  refresher?: { serialize<T>(fn: () => Promise<T>): Promise<T> };
  /** Plan 4 (spec 16.6): memory or disk over its limit; no new intake (image decodes) or dry-run dispatch meanwhile. */
  resourceHold?: () => unknown;
}

/**
 * The resident loop: one work item at a time, never two at once. Each round advances at most one job (processNext),
 * then checks the config and the instruction folder when due, then the slots (tick + pseudo-post) when due, and scans the
 * pending folder when there is nothing left to prepare (plan decision 13: however slow preparation is, a due slot is
 * looked at after every job, so it is not pushed past its grace time). Every step catches and logs its own errors, so a
 * failure never ends the loop. A tick happens only after the previous dispatch has been posted, since post() is awaited
 * inside the tick step.
 */
export class RunLoop {
  /** Settles when the loop has ended and `onStopped` has run; rejects if an unexpected error ended the loop. */
  readonly closed: Promise<void>;
  readonly #d: RunLoopDeps;
  readonly #timing: RunLoopTiming;
  #stopping = false;
  #wake: (() => void) | null = null;
  /** The halt state last logged and written; null until the startup write. */
  #haltKey: string | null = null;
  /** DISPATCH_WAITING_INSTRUCTIONS was logged (once until the instructions are known). */
  #waitingLogged = false;
  readonly #errorKeys = new Map<string, string>();

  constructor(d: RunLoopDeps, timing: RunLoopTiming, onStopped: () => Promise<void>) {
    this.#d = d;
    this.#timing = timing;
    this.closed = this.#run().then(onStopped, async (err: unknown) => {
      d.logger.error('RUNTIME_CRASHED', `想定外のエラーで常駐処理が止まりました: ${errorText(err)}`, { error_code: 'INTERNAL_ERROR' });
      await onStopped();
      throw err;
    });
    this.closed.catch(() => undefined); // reported through `closed`; never an unhandled rejection
  }

  /** Lets the item in progress finish, then ends the loop. Any number of calls share the same outcome. */
  stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    return this.closed.catch(() => undefined);
  }

  async #run(): Promise<void> {
    const due = { config: 0, tick: 0, intake: 0 };
    const ticking = this.#d.poster !== null;
    let work = true; // resumeInterrupted may have left jobs to continue
    await this.#syncHalts(); // the startup record
    while (!this.#stopping) {
      let busy = false;
      if (work) {
        work = await this.#guard('process', 'PROCESS_FAILED', '投稿の準備中', () => this.#d.processor.processNext(), false);
        busy = true;
      }
      if (!this.#stopping && performance.now() >= due.config) {
        const pending = await this.#configStep();
        due.config = performance.now() + (pending ? Math.min(this.#timing.configMs, this.#timing.recheckMs ?? DEFAULT_RECHECK_MS) : this.#timing.configMs);
        busy = true;
      }
      if (!this.#stopping && ticking && performance.now() >= due.tick) {
        await this.#tickStep();
        due.tick = performance.now() + this.#timing.tickMs;
        busy = true;
      }
      if (!this.#stopping && !work && performance.now() >= due.intake) {
        await this.#intakeStep();
        due.intake = performance.now() + this.#timing.intakeMs;
        work = true;
        busy = true;
      }
      if (!busy) await this.#sleep(Math.min(due.config, ticking ? due.tick : Infinity, due.intake) - performance.now());
    }
  }

  /**
   * Applies a valid config edit, reads the instruction folder, then lets the scheduler rebuild today's future slots if
   * today's effective schedule is no longer the one its plan was built for (R24 extended; a failed rebuild is simply
   * tried again at the next check, since the plan still records the old schedule). true = an instruction file is still
   * being written, so the folder should be looked at again soon.
   */
  #configStep(): Promise<boolean> {
    const refresher = this.#d.refresher;
    return refresher === undefined ? this.#configStepAlone() : refresher.serialize(() => this.#configStepAlone());
  }

  async #configStepAlone(): Promise<boolean> {
    const { config, instructions, clock, scheduler, logger, mode, paths } = this.#d;
    const r = await this.#guard('config', 'CONFIG_CHECK_FAILED', '設定の確認中', () => config.reloadIfChanged(), null);
    if (r !== null && r.applied) {
      const settings = config.current.settings;
      if (settings.mode !== mode || resolveDataPaths(paths.projectRoot, settings).modeRoot !== paths.modeRoot) {
        logger.warn('CONFIG_RESTART_REQUIRED', 'モード（mode）や保存先（data_root）の変更は、再起動するまで反映されません。', { mode, new_mode: settings.mode });
      }
    }
    const scan = instructions === null ? null : await this.#guard('instructions', 'INSTRUCTIONS_CHECK_FAILED', '作業指示書の確認中', () => instructions.scan(clock.now()), null);
    const libraries = this.#d.libraries;
    if (libraries !== undefined) await this.#guard('libraries', 'LIBRARIES_CHECK_FAILED', 'テンプレート・トレンドの確認中', () => libraries.refresh(clock.now()), null);
    // Until the folder has been read once the schedule lacks the instructions: today's slots are left as they are. In live
    // mode (claims tick) only a change of today's effective schedule replans (P1-R24); keywords alone never do.
    const known = instructions === null || instructions.current !== null;
    if ((this.#d.poster !== null || mode === 'live') && known) await this.#guard('replan', 'REPLAN_FAILED', '本日の枠の組み直し中', () => scheduler.replanIfScheduleChanged(), false);
    return scan !== null && scan.pending.length > 0;
  }

  /** Logs a change of the dispatch-halt state and records it in runtime-status.json (R25); a no-op while it is unchanged. */
  async #syncHalts(): Promise<void> {
    const { halted, logger, runtimeStatus } = this.#d;
    const key = halted.map((h) => `${h.job_id}:${h.reason}`).join(',');
    if (key === this.#haltKey) return;
    const previous = this.#haltKey;
    this.#haltKey = key;
    const code = haltCode(halted);
    if (code !== null) {
      logger.error('DISPATCH_HALTED', `復旧できないjobがあるため、投稿の配布を止めています（${halted.length}件）。状態表示（status）で確認してください。`, {
        error_code: code,
        job_ids: halted.map((h) => h.job_id),
      });
    } else if (previous !== null) {
      logger.info('DISPATCH_RESUMED', '復旧できないjobが無くなったため、投稿の配布を再開します。');
    }
    await runtimeStatus.write(halted, false);
  }

  async #tickStep(): Promise<void> {
    const { scheduler, poster, halted, instructions, logger } = this.#d;
    if (halted.length > 0 || poster === null || (this.#d.resourceHold?.() ?? null) !== null) return;
    // Without one successful look at the instruction folder the schedule may miss a closed day: nothing is dispatched.
    if (instructions !== null && instructions.current === null) {
      if (!this.#waitingLogged) {
        this.#waitingLogged = true;
        logger.warn('DISPATCH_WAITING_INSTRUCTIONS', '作業指示書（instructions フォルダ）を確認できるまで、投稿の配布を待っています（取込と準備は続けます）。');
      }
      return;
    }
    this.#waitingLogged = false;
    const dispatch = await this.#guard('tick', 'TICK_FAILED', '投稿枠の確認中', () => scheduler.tick(), null);
    if (dispatch === null) return;
    await this.#guard('post', 'POST_FAILED', '擬似投稿中', () => poster.post(dispatch), null);
  }

  /** R18: recovery runs right before each scan, while no import or transition is in flight. */
  async #intakeStep(): Promise<void> {
    const { bundles, intake } = this.#d;
    const report = await this.#guard('recover', 'RECOVERY_FAILED', '中断した処理の復旧中', () => bundles.recoverAll(), null);
    if (report !== null) {
      this.#d.halted = report.halted;
      await this.#syncHalts();
    }
    if ((this.#d.resourceHold?.() ?? null) !== null) return;
    await this.#guard('intake', 'INTAKE_FAILED', '画像の取込中', () => intake.scanOnce(), null);
  }

  /** Runs one step; an error is logged once (until it changes or the step succeeds) and the loop goes on. */
  async #guard<T, F>(kind: string, event: string, what: string, fn: () => Promise<T>, fallback: F): Promise<T | F> {
    try {
      const value = await fn();
      this.#errorKeys.delete(kind);
      return value;
    } catch (err) {
      const error_code = errorCodeOf(err);
      const message = errorText(err);
      if (this.#errorKeys.get(kind) !== `${error_code}|${message}`) {
        this.#errorKeys.set(kind, `${error_code}|${message}`);
        this.#d.logger.error(event, `${what}にエラーが発生しました（処理は続けます）: ${message}`, { error_code });
      }
      return fallback;
    }
  }

  #sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.#stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }
}
