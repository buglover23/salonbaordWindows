import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError, errorCodeOf, errorText, type ErrorCode } from '../shared/errors.js';
import { sha256File } from '../shared/hash.js';
import type { Job } from '../shared/job-schema.js';
import type { JobStatus } from '../shared/types.js';
import { jstFolderParts } from '../shared/time.js';
import {
  errnoCode,
  renameWithRetry,
  storageFailure,
  unlinkWithRetry,
  withTransientRetry,
  type FsLike,
  type RetryOptions,
} from './atomic-json.js';
import { writeFailureFile } from './failure-file.js';
import type { JobStore } from './job-store.js';
import type { DataPaths } from './paths.js';
import { SerialQueue } from './serial-queue.js';
import { internalFailure, revisionConflict } from './store-errors.js';

/** The fs/promises functions BundleMover calls: Task 7's FsLike plus copyFile, lstat and readdir. The real fs/promises satisfies it. */
export type BundleFs = FsLike & Pick<typeof fsp, 'copyFile' | 'lstat' | 'readdir'>;

type Operation = NonNullable<Job['operation']>;

// Spec 11.3. A Record so a new status cannot be added without deciding where its bundle lives.
export const BUNDLE_AREA: Record<JobStatus, 'processing' | 'failed' | 'posted'> = {
  PENDING: 'processing',
  ANALYZING: 'processing',
  GENERATING: 'processing',
  VALIDATING: 'processing',
  READY: 'processing',
  POSTING: 'processing',
  VERIFYING: 'processing',
  POSTED: 'posted',
  FAILED: 'failed',
  RETRY_WAIT: 'failed',
  BLOCKED: 'failed',
  VERIFY_REQUIRED: 'failed',
};

/**
 * The job's bundle folder for its status, relative to modeRoot with '/' separators (spec 11.3).
 * POSTED uses the JST date/time of `verified_at ?? posted_at`; a POSTED job without either is a caller bug.
 * `clock` only stamps that error.
 */
export function bundleRelDir(job: Pick<Job, 'id' | 'status' | 'posted_at' | 'verified_at'>, clock: Clock = systemClock): string {
  const area = BUNDLE_AREA[job.status];
  if (area !== 'posted') return `images/${area}/${job.id}`;
  const at = job.verified_at ?? job.posted_at;
  if (at === null) {
    throw new AppFailure(
      appError('INTERNAL_ERROR', 'storage', clock, {
        message: `投稿済み（POSTED）なのに投稿時刻が無いため、画像の置き場所を決められません: ${job.id}`,
        details: { job_id: job.id },
      }),
    );
  }
  const { date, hm } = jstFolderParts(new Date(at));
  return `images/posted/${date}/${hm}/${job.id}`;
}

export type RecoveryHaltReason =
  | 'both_exist'
  | 'neither_exists'
  | 'hash_mismatch'
  | 'image_missing'
  | 'unexpected_entry'
  | 'invalid_operation'
  | 'io_error';

/** Operator-facing explanation of each halt reason (for logs and the status display). */
export const RECOVERY_HALT_MESSAGES_JA: Record<RecoveryHaltReason, string> = {
  both_exist: '移動元と移動先の両方に画像があります',
  neither_exists: '元の場所にも、移動・コピー先にも画像がありません',
  hash_mismatch: '画像の内容（SHA-256）がjobの記録と一致しません',
  image_missing: '画像フォルダはありますが、中に画像ファイルがありません',
  unexpected_entry: '画像があるはずの場所に、想定と異なる種類のファイルやフォルダがあります',
  invalid_operation: '途中の処理の記録がjobの内容と一致しません',
  io_error: '確認中にファイルの読み書きに失敗しました',
};

export interface RecoveryHalt {
  job_id: string;
  reason: RecoveryHaltReason;
}

export interface RecoveryReport {
  recovered: string[];
  halted: RecoveryHalt[];
}

export interface BundleMoverDeps {
  paths: DataPaths;
  store: JobStore;
  clock: Clock;
  logger: AppLogger;
  fs?: BundleFs;
  /** Replaces the real waits between retries of transient Windows locks (tests). */
  retry?: RetryOptions;
  /** Replaces the SHA-256 reader used by every hash check (tests simulate an unreadable image). Default sha256File. */
  hashFile?: (path: string) => Promise<string>;
}

type EntryKind = 'file' | 'dir' | 'other' | 'none';

/** The operations this class carries out itself; cleanup belongs to RetentionManager (retention.ts). */
type Transfer = Exclude<Operation['kind'], 'cleanup'>;

/** 'file': importFile moved/copied one image file. 'dir': transition moved the whole bundle folder. */
type Layout = Extract<EntryKind, 'file' | 'dir'>;

type Outcome =
  | { kind: 'recovered'; action: 'resumed' | 'json_only' }
  | { kind: 'halted'; reason: RecoveryHaltReason };

type Failure = { code: ErrorCode; message: string };

const KIND_JA: Record<Operation['kind'], string> = { move: '移動', copy: 'コピー', cleanup: '整理' };

export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  // NTFS is case-insensitive; a differently-cased project path must not look like a different location.
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const halted = (reason: RecoveryHaltReason): Outcome => ({ kind: 'halted', reason });

// A copy goes through `<target name>.<pid>.<12 hex>.tmp` in the target folder; recovery removes only names of exactly this form.
const TEMP_TAIL = /^\d+\.[0-9a-f]{12}\.tmp$/;
const tempNameFor = (target: string): string => `${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
const isTempOf = (name: string, targetName: string): boolean =>
  name.startsWith(`${targetName}.`) && TEMP_TAIL.test(name.slice(targetName.length + 1));

/**
 * Moves image bundles between pending/processing/failed/posted (spec 11.3) with the move recorded in the job first
 * (spec 11.4-3), and finishes or halts interrupted moves at startup (spec 11.4-4).
 * Nothing here deletes or overwrites an image: a move or copy whose destination exists is refused, and the only files
 * ever removed are this class's own half-written temp copies (after a failed copy, or left behind by a crashed one).
 */
export class BundleMover {
  readonly #paths: DataPaths;
  readonly #store: JobStore;
  readonly #clock: Clock;
  readonly #logger: AppLogger;
  readonly #fs: BundleFs;
  readonly #retry: RetryOptions;
  readonly #hash: (path: string) => Promise<string>;
  /** importFile, transition and recoverAll never overlap (R18: recovery never runs during a transition, P3-R25). */
  readonly #opLock = new SerialQueue();

  constructor(d: BundleMoverDeps) {
    this.#paths = d.paths;
    this.#store = d.store;
    this.#clock = d.clock;
    this.#logger = d.logger;
    this.#fs = d.fs ?? fsp;
    this.#retry = d.retry ?? {};
    this.#hash = d.hashFile ?? sha256File;
  }

  /**
   * Creates `job` with the import recorded as its operation, moves or copies the file to `job.image.relative_path`
   * (which must sit directly in `bundleRelDir(job)`), then clears the operation. If the transfer fails the job keeps
   * its operation and the file stays where it was, for recoverAll to finish later.
   */
  importFile(job: Job, sourceAbsPath: string, kind: Transfer): Promise<Job> {
    return this.#opLock.run(() => this.#importFile(job, sourceAbsPath, kind));
  }

  async #importFile(job: Job, sourceAbsPath: string, kind: Transfer): Promise<Job> {
    const relDir = bundleRelDir(job, this.#clock);
    if (posix.dirname(job.image.relative_path) !== relDir) {
      throw internalFailure(this.#clock, `画像の保存先がjobの状態と一致しません: ${job.image.relative_path}`, {
        job_id: job.id,
        relative_path: job.image.relative_path,
        expected_dir: relDir,
      });
    }
    const source = resolve(sourceAbsPath);
    const target = this.#abs(job.image.relative_path);
    // Checked before anything is written, so a vanished source or an occupied target leaves no half-made job.
    if ((await this.#entryKind(source)) !== 'file') throw this.#imageNotFound(source, job.id, kind);
    if ((await this.#entryKind(target)) !== 'none') throw this.#targetExists(target, job.id, kind);

    const created = await this.#store.create({
      ...job,
      operation: { kind, source_path: source, target_path: target, started_at: this.#clock.now().toISOString() },
    });
    await this.#mkdirp(dirname(target));
    await this.#transfer(kind, source, target, job.id);
    return this.#store.update(created.id, created.revision, (j) => ({ ...j, operation: null }));
  }

  /**
   * Applies `mutate` (CAS on `expectedRevision`). If the new status puts the bundle in another folder:
   * 1. saves the new state with a move operation, 2. renames the folder, 3. points image.relative_path at the new
   * folder and clears the operation (spec 11.4-3). Otherwise it is a plain update. `mutate` must not change
   * image.relative_path or operation; this class owns them.
   *
   * An error thrown before step 1 leaves the job and its files as they were. An error thrown after step 1 does NOT mean
   * "status unchanged": the new status is already saved together with the move operation, and recoverAll finishes the
   * move later (it runs at startup and before each pending scan). Until then the job refuses further transitions with a
   * retryable FILE_IO_ERROR.
   */
  transition(id: string, expectedRevision: number, mutate: (j: Job) => Job): Promise<Job> {
    return this.#opLock.run(() => this.#transition(id, expectedRevision, mutate));
  }

  /**
   * R32: transition, but an error after the new state was saved (e.g. the folder rename failed) is not a failure when the
   * job on disk already is what the caller wanted: then `{ job: latest, moved: false }` and recoverAll finishes the move.
   */
  async transitionOrDetect(id: string, expectedRevision: number, mutate: (j: Job) => Job, isTarget: (latest: Job) => boolean): Promise<{ job: Job; moved: boolean }> {
    try {
      return { job: await this.transition(id, expectedRevision, mutate), moved: true };
    } catch (err) {
      const latest = await this.#store.get(id).catch(() => null);
      if (latest !== null && isTarget(latest)) return { job: latest, moved: false };
      throw err;
    }
  }

  async #transition(id: string, expectedRevision: number, mutate: (j: Job) => Job): Promise<Job> {
    const current = await this.#store.get(id);
    if (current === null) throw internalFailure(this.#clock, `更新するjobが見つかりません: ${id}`, { job_id: id });
    if (current.revision !== expectedRevision) throw revisionConflict(this.#clock, id, expectedRevision, current.revision);
    if (current.operation !== null) throw this.#operationPending(id, current.operation.kind);

    const fromRelDir = posix.dirname(current.image.relative_path);
    const next = mutate(structuredClone(current));
    if (next.image.relative_path !== current.image.relative_path || next.operation !== null) {
      throw internalFailure(this.#clock, `画像の場所と移動中の記録は直接変更できません: ${id}`, { job_id: id });
    }
    const toRelDir = bundleRelDir(next, this.#clock);
    // The store's CAS guarantees the job on disk is still `current` when `next` is written.
    if (toRelDir === fromRelDir) return this.#store.update(id, expectedRevision, () => next);

    const from = this.#abs(fromRelDir);
    const to = this.#abs(toRelDir);
    if ((await this.#entryKind(from)) !== 'dir') throw await this.#unlessChanged(id, expectedRevision, this.#imageNotFound(from, id, 'move'));
    if ((await this.#entryKind(to)) !== 'none') throw await this.#unlessChanged(id, expectedRevision, this.#targetExists(to, id, 'move'));

    const staged = await this.#store.update(id, expectedRevision, () => ({
      ...next,
      operation: { kind: 'move', source_path: from, target_path: to, started_at: this.#clock.now().toISOString() },
    }));
    await this.#mkdirp(dirname(to));
    await this.#moveNoReplace(from, to, id, 'move');
    return this.#finish(staged, `${toRelDir}/${posix.basename(current.image.relative_path)}`);
  }

  /**
   * The folder probe runs after the revision check, so another transition may have moved the bundle in between. That is
   * a conflict for the caller to re-read, not a missing image.
   */
  async #unlessChanged(id: string, expectedRevision: number, failure: AppFailure): Promise<AppFailure> {
    const latest = await this.#store.get(id);
    if (latest !== null && latest.revision === expectedRevision) return failure;
    return revisionConflict(this.#clock, id, expectedRevision, latest?.revision ?? null);
  }

  /**
   * Startup recovery for every job that still has an operation (spec 11.4-4). Resumes when only the source exists,
   * fixes the JSON when only the target exists (after checking the image hash), and otherwise halts that job without
   * touching any file. The caller must not dispatch posts while `halted` is non-empty.
   */
  recoverAll(): Promise<RecoveryReport> {
    return this.#opLock.run(() => this.#recoverAll());
  }

  async #recoverAll(): Promise<RecoveryReport> {
    const report: RecoveryReport = { recovered: [], halted: [] };
    for (const { id } of this.#store.summaries((s) => s.has_operation)) {
      let op: Operation | null = null;
      let outcome: Outcome | null;
      let failure: Failure | null = null;
      try {
        const job = await this.#store.get(id);
        op = job?.operation ?? null;
        // A cleanup of a POSTED job is resumed by RetentionManager.recover and never halts dispatch; on any other job it is invalid.
        const kind = op?.kind;
        if (job === null || op === null || kind === undefined || (kind === 'cleanup' && job.status === 'POSTED')) outcome = null;
        else outcome = kind === 'cleanup' ? halted('invalid_operation') : await this.#recoverOne(job, { ...op, kind });
      } catch (err) {
        // The next start retries from whatever is on disk by then; every step of recovery is safe to repeat.
        outcome = halted('io_error');
        failure = { code: errorCodeOf(err), message: errorText(err) };
      }
      if (outcome === null) continue;
      if (outcome.kind === 'recovered') report.recovered.push(id);
      else report.halted.push({ job_id: id, reason: outcome.reason });
      this.#logOutcome(id, op, outcome, failure);
    }
    return report;
  }

  #logOutcome(id: string, op: Operation | null, outcome: Outcome, failure: Failure | null): void {
    const kindJa = op === null ? '処理' : KIND_JA[op.kind];
    const fields = {
      job_id: id,
      operation_kind: op?.kind ?? null,
      source_path: op?.source_path ?? null,
      target_path: op?.target_path ?? null,
    };
    if (outcome.kind === 'recovered') {
      const what = outcome.action === 'resumed' ? `中断していた画像の${kindJa}を完了しました` : 'jobの記録を画像の場所に合わせました';
      this.#logger.info('RECOVERY_COMPLETED', `${what}: ${id}`, { ...fields, action: outcome.action });
      return;
    }
    const message =
      failure === null
        ? `中断していた画像の${kindJa}を自動では復旧できないため、ファイルには触れずに停止しました` +
          `（${RECOVERY_HALT_MESSAGES_JA[outcome.reason]}）。投稿は止まります: ${id}`
        : `中断していた画像の${kindJa}の復旧中にエラーが発生したため停止しました（${failure.message}）。` +
          `ファイルは削除していません。投稿は止まります: ${id}`;
    this.#logger.error('RECOVERY_HALTED', message, { ...fields, reason: outcome.reason, error_code: failure?.code ?? 'STATE_CORRUPT' });
  }

  async #recoverOne(job: Job, op: Operation & { kind: Transfer }): Promise<Outcome> {
    const kind = op.kind;
    const plan = this.#planOf(job, op);
    if (plan === null) return halted('invalid_operation');
    const { layout, source, target } = plan;

    const sourceKind = await this.#entryKind(source);
    const targetKind = await this.#entryKind(target);
    if ((sourceKind !== 'none' && sourceKind !== layout) || (targetKind !== 'none' && targetKind !== layout)) {
      return halted('unexpected_entry');
    }
    const imageName = posix.basename(job.image.relative_path);
    const imageIn = (p: string): string => (layout === 'file' ? p : join(p, imageName));
    const newRelPath = layout === 'file' ? job.image.relative_path : `${bundleRelDir(job, this.#clock)}/${imageName}`;

    if (sourceKind === 'none' && targetKind === 'none') return halted('neither_exists');
    if (targetKind !== 'none') {
      // Both present is expected only for a copy that finished before its JSON was saved (the pending original stays).
      if (sourceKind !== 'none' && kind === 'move') return halted('both_exist');
      const check = await this.#checkImage(imageIn(target), job.image.sha256);
      if (check !== null) return halted(check);
      return this.#complete(job, kind, target, newRelPath, 'json_only');
    }
    // Only the source exists: resume, but never carry an image that is not the one this job was made from.
    const check = await this.#checkImage(imageIn(source), job.image.sha256);
    if (check !== null) return halted(check);
    await this.#mkdirp(dirname(target));
    await this.#transfer(kind, source, target, job.id);
    return this.#complete(job, kind, target, newRelPath, 'resumed');
  }

  /**
   * The image is in place: removes a copy's leftover temp files (while the operation is still recorded, so a crash here
   * is simply repeated), saves the JSON, then fills in a missing failure.json. Only the JSON save can fail it.
   */
  async #complete(job: Job, kind: Transfer, target: string, relativePath: string, action: 'resumed' | 'json_only'): Promise<Outcome> {
    if (kind === 'copy') await this.#removeOwnTemps(target, job.id);
    const done = await this.#finish(job, relativePath);
    await this.#ensureFailureFile(done);
    return { kind: 'recovered', action };
  }

  /** A copy cut short by a crash leaves its temp file beside the target. Files of any other name are never touched. */
  async #removeOwnTemps(target: string, jobId: string): Promise<void> {
    const dir = dirname(target);
    const targetName = basename(target);
    let temps: string[];
    try {
      const entries = await withTransientRetry(() => this.#fs.readdir(dir, { withFileTypes: true }), this.#retry);
      temps = entries.filter((e) => e.isFile() && isTempOf(e.name, targetName)).map((e) => join(dir, e.name));
    } catch (err) {
      this.#logger.warn('RECOVERY_TEMP_NOT_REMOVED', `中断したコピーの一時ファイルを確認できませんでした（${errnoCode(err) ?? '不明'}）。画像の復旧は続けます: ${dir}`, {
        job_id: jobId,
        folder: dir,
      });
      return;
    }
    for (const file of temps) {
      try {
        await unlinkWithRetry(file, this.#fs, this.#retry);
        this.#logger.info('RECOVERY_TEMP_REMOVED', `中断したコピーの一時ファイルを削除しました: ${file}`, { job_id: jobId, file });
      } catch (err) {
        const message = errorText(err);
        this.#logger.warn('RECOVERY_TEMP_NOT_REMOVED', `中断したコピーの一時ファイルを削除できませんでした（画像の復旧は続けます）: ${message}`, {
          job_id: jobId,
          file,
        });
      }
    }
  }

  /**
   * A job recovered into images/failed/ never had failure.json written: the move was cut short before that step
   * (an intake IMAGE_INVALID job, or a transition to FAILED / VERIFY_REQUIRED). An existing file is left as it is.
   */
  async #ensureFailureFile(job: Job): Promise<void> {
    if (BUNDLE_AREA[job.status] !== 'failed') return;
    try {
      if ((await this.#entryKind(this.#abs(`${posix.dirname(job.image.relative_path)}/failure.json`))) !== 'none') return;
      await writeFailureFile(this.#paths, job, this.#clock, { fs: this.#fs, retry: this.#retry });
    } catch (err) {
      // The job itself is recovered; failure.json is only a readable copy.
      const failure = err instanceof AppFailure ? err.error : null;
      this.#logger.error('FAILURE_FILE_FAILED', `failure.json を書けませんでした（jobの復旧は完了しています）: ${failure?.message ?? String(err)}`, {
        job_id: job.id,
        stage: job.stage,
        error_code: failure?.code ?? 'INTERNAL_ERROR',
      });
    }
  }

  /**
   * What the operation moved, judged only against what importFile ('file': one image file) and transition ('dir': the
   * whole bundle folder) record. null if it matches neither, e.g. data_root was moved since.
   */
  #planOf(job: Job, op: Operation): { layout: Layout; source: string; target: string } | null {
    const { source_path: source, target_path: target } = op;
    if (source === undefined || target === undefined) return null;
    if (samePath(target, this.#abs(job.image.relative_path))) return { layout: 'file', source, target };
    if (op.kind !== 'move') return null;
    let relDir: string;
    try {
      relDir = bundleRelDir(job, this.#clock);
    } catch {
      return null;
    }
    const fromDir = this.#abs(posix.dirname(job.image.relative_path));
    return samePath(target, this.#abs(relDir)) && samePath(source, fromDir) ? { layout: 'dir', source, target } : null;
  }

  /** null when `path` holds the job's image; otherwise why recovery must halt. */
  async #checkImage(path: string, sha256: string): Promise<RecoveryHaltReason | null> {
    let actual: string;
    try {
      actual = await withTransientRetry(() => this.#hash(path), this.#retry);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'image_missing';
      if (code === 'EISDIR') return 'unexpected_entry';
      throw storageFailure(err, '画像の読込', path, { clock: this.#clock });
    }
    return actual === sha256 ? null : 'hash_mismatch';
  }

  #finish(job: Job, relativePath: string): Promise<Job> {
    return this.#store.update(job.id, job.revision, (j) => ({ ...j, image: { ...j.image, relative_path: relativePath }, operation: null }));
  }

  #abs(rel: string): string {
    return join(this.#paths.modeRoot, ...rel.split('/'));
  }

  async #entryKind(path: string): Promise<EntryKind> {
    try {
      const st = await withTransientRetry(() => this.#fs.lstat(path), this.#retry);
      if (st.isFile()) return 'file';
      if (st.isDirectory()) return 'dir';
      return 'other';
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'none';
      throw storageFailure(err, 'ファイルの確認', path, { clock: this.#clock });
    }
  }

  async #mkdirp(dir: string): Promise<void> {
    try {
      await withTransientRetry(() => this.#fs.mkdir(dir, { recursive: true }), this.#retry);
    } catch (err) {
      throw storageFailure(err, 'フォルダの作成', dir, { clock: this.#clock });
    }
  }

  #transfer(kind: Transfer, from: string, to: string, jobId: string): Promise<void> {
    return kind === 'move' ? this.#moveNoReplace(from, to, jobId, 'move') : this.#copyNoReplace(from, to, jobId);
  }

  /** rename would silently replace an existing file on Windows, so the target is checked first (single writer). */
  async #moveNoReplace(from: string, to: string, jobId: string, kind: Transfer): Promise<void> {
    if ((await this.#entryKind(to)) !== 'none') throw this.#targetExists(to, jobId, kind);
    await renameWithRetry(from, to, this.#fs, this.#retry);
  }

  /** Copies through a temp file in the target folder, so the target never exists half-written. */
  async #copyNoReplace(from: string, to: string, jobId: string): Promise<void> {
    if ((await this.#entryKind(to)) !== 'none') throw this.#targetExists(to, jobId, 'copy');
    const tmp = join(dirname(to), tempNameFor(to));
    try {
      await withTransientRetry(() => this.#fs.copyFile(from, tmp, constants.COPYFILE_EXCL), this.#retry);
      await this.#moveNoReplace(tmp, to, jobId, 'copy');
    } catch (err) {
      // Only our own partial copy is removed; the original is untouched.
      await unlinkWithRetry(tmp, this.#fs, this.#retry).catch(() => undefined);
      throw storageFailure(err, '画像のコピー', to, { clock: this.#clock, details: { from, to } });
    }
  }

  /** The job still has a move/copy recorded: a file problem that recovery finishes, so it is retryable (not a bug). */
  #operationPending(jobId: string, kind: Operation['kind']): AppFailure {
    const what = KIND_JA[kind];
    const after = kind === 'cleanup' ? '起動時の復旧の結果を確認してください' : `中断した${what}は復旧処理で自動的に完了させます`;
    return new AppFailure(
      appError('FILE_IO_ERROR', 'storage', this.#clock, {
        message: `前回の画像の${what}が終わっていないため、jobの状態を変えられません。${after}: ${jobId}`,
        retryable: true,
        details: { job_id: jobId, operation_kind: kind, reason: 'operation_pending' },
      }),
    );
  }

  #imageNotFound(path: string, jobId: string, kind: Transfer): AppFailure {
    return new AppFailure(
      appError('IMAGE_NOT_FOUND', 'storage', this.#clock, {
        message: `画像が見つからないため、${KIND_JA[kind]}しませんでした: ${path}`,
        details: { job_id: jobId, path },
      }),
    );
  }

  #targetExists(path: string, jobId: string, kind: Transfer): AppFailure {
    return new AppFailure(
      appError('FILE_IO_ERROR', 'storage', this.#clock, {
        message: `${KIND_JA[kind]}先に同じ名前のファイルまたはフォルダが既にあるため、上書きせずに中止しました: ${path}`,
        details: { job_id: jobId, path },
      }),
    );
  }
}
