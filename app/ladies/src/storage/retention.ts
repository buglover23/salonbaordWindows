import * as fsp from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { dedupeRecordOf } from '../posting/post-commit.js';
import type { Clock } from '../shared/clock.js';
import { errorCodeOf, errorText } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import type { CleanupPreview, CleanupReport } from '../shared/protocol/api.js';
import { jstDateKey } from '../shared/time.js';
import { errnoCode, storageFailure, withTransientRetry } from './atomic-json.js';
import { bundleRelDir, samePath } from './bundles.js';
import { DedupeStore } from './dedupe-store.js';
import type { HistoryStore } from './history-store.js';
import type { JobStore, JobSummary } from './job-store.js';
import type { DataPaths } from './paths.js';
import { SerialQueue } from './serial-queue.js';

// Spec 16.5: POSTED jobs whose max(posted_at, verified_at) + posted_data_days has passed lose their local images, evidence
// and full texts; dedupe.json keeps a small record for good. Only this PC's managed files are removed, never anything on
// SALON BOARD. Order per job: dedupe record saved and re-read → operation {cleanup, target_paths} saved → each target
// checked to be the job's own file (no link, no junction, nothing outside) and removed → history text → backup copies →
// dedupe cleaned_at → job JSON. A stop anywhere is resumed from job.operation by recover().

export type RetentionFs = Pick<typeof fsp, 'lstat' | 'readdir' | 'unlink' | 'rmdir'>;

type Exclusion = CleanupPreview['excluded'][number]['reason'];

export const CLEANUP_EXCLUSION_JA: Record<Exclusion, string> = {
  operation: '画像の移動や整理の途中です（復旧してから整理します）',
  in_flight: '拡張機能が処理中です',
  unresolved: '結果が確定していない送信があります',
  unexpected_entry: '画像や証跡のフォルダに、想定外のフォルダやリンク（ジャンクション等）があります',
};

export interface RetentionDeps {
  paths: DataPaths;
  store: JobStore;
  dedupe: DedupeStore;
  history: Pick<HistoryStore, 'forgetText'>;
  clock: Clock;
  logger: AppLogger;
  retention: () => Settings['retention'];
  /** The job the live poster is working on (never touched). */
  inFlight?: () => string | null;
  fs?: RetentionFs;
}

const DAY_MS = 86_400_000;
const PLAN_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const BACKUP_DIR = /^\d{4}-\d{2}-\d{2}$/;

interface Target {
  path: string;
  bytes: number;
}
type Candidate = { ok: true; job: Job; targets: Target[] } | { ok: false; reason: Exclusion };
type Kind = { kind: 'file'; size: number } | { kind: 'dir' | 'missing' | 'other' };

/** The operation must not be carried out as recorded; nothing more is removed and the job keeps it. */
class Refusal extends Error {
  constructor(readonly reason: 'outside' | 'unexpected_entry') {
    super(reason === 'outside' ? '整理の対象に、この job の画像・証跡以外の場所が含まれています' : CLEANUP_EXCLUSION_JA.unexpected_entry);
  }
}

export class RetentionManager {
  readonly #d: RetentionDeps;
  readonly #fs: RetentionFs;
  /** Cleanup, recovery and backups never overlap. */
  readonly #lock = new SerialQueue();
  #last: CleanupReport | null = null;

  constructor(d: RetentionDeps) {
    this.#d = d;
    this.#fs = d.fs ?? fsp;
  }

  /** The result of the last cleanup run (null before the first). */
  get last(): CleanupReport | null {
    return this.#last === null ? null : structuredClone(this.#last);
  }

  /** Runs `fn` alone with the cleanup (backups use it, so a cleaned job's copy cannot be written back meanwhile). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#lock.run(fn);
  }

  /** Ids of the expired POSTED jobs (by the summaries; exclusions are decided per job when it is read). */
  expiredIds(now: Date): string[] {
    return this.#expired(now).map((s) => s.id);
  }

  /** What a cleanup would do now (reads only). */
  async preview(): Promise<CleanupPreview> {
    const now = this.#d.clock.now();
    const r = this.#d.retention();
    const posted = this.#d.store.summaries((s) => s.status === 'POSTED');
    const preview: CleanupPreview = { enabled: r.enabled, days: r.posted_data_days, due: 0, bytes: 0, waiting: 0, excluded: [], protected_jobs: 0, schedules: 0 };
    preview.protected_jobs = this.#d.store.summaries((s) => s.status !== 'POSTED').length;
    if (!r.enabled) return { ...preview, waiting: posted.length };
    const excluded = new Map<Exclusion, number>();
    const limit = now.getTime() - r.posted_data_days * DAY_MS;
    for (const s of posted) {
      if (s.success_at === null || Date.parse(s.success_at) > limit) {
        preview.waiting++;
        continue;
      }
      const c = await this.#candidate(s.id).catch(() => null);
      if (c === null) continue;
      if (!c.ok) excluded.set(c.reason, (excluded.get(c.reason) ?? 0) + 1);
      else {
        preview.due++;
        preview.bytes += c.targets.reduce((n, t) => n + t.bytes, 0);
      }
    }
    preview.excluded = [...excluded].map(([reason, count]) => ({ reason, count }));
    preview.schedules = (await this.#oldPlans(now)).length;
    return preview;
  }

  /** Resumes interrupted cleanups (startup, before anything else reads the POSTED jobs). Returns how many finished. */
  recover(): Promise<number> {
    return this.#lock.run(async () => {
      const report = this.#emptyReport(this.#d.clock.now());
      await this.#recoverAll(report);
      return report.cleaned;
    });
  }

  /** One run: unfinished cleanups, then at most cleanup_batch_size expired jobs, then old daily plans. */
  cleanup(): Promise<CleanupReport> {
    return this.#lock.run(async () => {
      const now = this.#d.clock.now();
      const r = this.#d.retention();
      const report = this.#emptyReport(now);
      await this.#recoverAll(report);
      if (r.enabled) {
        const batch: Extract<Candidate, { ok: true }>[] = [];
        for (const s of this.#expired(now)) {
          if (batch.length >= r.cleanup_batch_size) break;
          const c = await this.#candidate(s.id).catch(() => null);
          if (c?.ok) batch.push(c);
        }
        for (const c of await this.#confirmDedupe(batch, report)) {
          try {
            const staged = await this.#d.store.update(c.job.id, c.job.revision, (j) => ({
              ...j,
              operation: { kind: 'cleanup', target_paths: c.targets.map((t) => t.path), started_at: now.toISOString() },
            }));
            report.bytes += await this.#finish(staged, now);
            report.cleaned++;
          } catch (err) {
            this.#failed(report, c.job.id, err);
          }
        }
        report.schedules = await this.#pruneOld(now);
        report.remaining = this.#expired(now).length;
      }
      const fields = { cleaned: report.cleaned, bytes: report.bytes, remaining: report.remaining, failed: report.failed.length, schedules: report.schedules };
      if (report.cleaned + report.failed.length + report.schedules > 0) {
        this.#d.logger.info('CLEANUP_COMPLETED', `30日を過ぎた投稿済みデータを整理しました（${report.cleaned}件、${mb(report.bytes)} MB。残り ${report.remaining}件）。`, fields);
      } else this.#d.logger.debug('CLEANUP_COMPLETED', '整理する投稿済みデータはありませんでした。', fields);
      this.#last = report;
      return structuredClone(report);
    });
  }

  #emptyReport(now: Date): CleanupReport {
    return { cleaned: 0, bytes: 0, remaining: 0, failed: [], schedules: 0, at: now.toISOString() };
  }

  /** POSTED jobs past their period, without a recorded operation; the oldest first. */
  #expired(now: Date): JobSummary[] {
    const r = this.#d.retention();
    if (!r.enabled) return [];
    const limit = now.getTime() - r.posted_data_days * DAY_MS;
    return this.#d.store
      .summaries((s) => s.status === 'POSTED' && !s.has_operation && s.success_at !== null && Date.parse(s.success_at) <= limit)
      .sort((a, b) => Date.parse(a.success_at!) - Date.parse(b.success_at!));
  }

  /** null: not (or no longer) a POSTED job. */
  async #candidate(id: string): Promise<Candidate | null> {
    const job = await this.#d.store.get(id);
    if (job === null || job.status !== 'POSTED') return null;
    if (job.operation !== null) return { ok: false, reason: 'operation' };
    if (this.#d.inFlight?.() === id) return { ok: false, reason: 'in_flight' };
    if (job.reconcile?.in_flight_command_id || job.attempts.some((a) => a.submission_state === 'intent_recorded' || a.submission_state === 'unknown')) {
      return { ok: false, reason: 'unresolved' };
    }
    const targets: Target[] = [];
    const { postedDir, evidenceDir } = this.#d.paths;
    if (!(await this.#collect(postedDir, this.#bundleSegs(job), targets))) return { ok: false, reason: 'unexpected_entry' };
    const evidence = await this.#walk(evidenceDir, [job.id]);
    if (evidence.kind === 'other') return { ok: false, reason: 'unexpected_entry' };
    if (evidence.kind === 'dir') {
      for (const attempt of await this.#names(join(evidenceDir, job.id))) {
        if (!(await this.#collect(evidenceDir, [job.id, attempt], targets))) return { ok: false, reason: 'unexpected_entry' };
      }
    }
    return { ok: true, job, targets };
  }

  /** Step 2: each job's dedupe record saved, then the file read again; only jobs whose record is on disk go on. */
  async #confirmDedupe<C extends { job: Job }>(batch: C[], report: CleanupReport): Promise<C[]> {
    const failed = new Set<string>();
    for (const c of batch) {
      if (this.#d.dedupe.get(c.job.id) !== undefined) continue;
      try {
        await this.#d.dedupe.upsert(dedupeRecordOf(c.job));
      } catch (err) {
        failed.add(c.job.id);
        this.#failed(report, c.job.id, err);
      }
    }
    if (batch.length === failed.size) return [];
    let disk: DedupeStore;
    try {
      disk = await DedupeStore.load(this.#d.paths, new SerialQueue(), this.#d.clock);
    } catch (err) {
      for (const c of batch) if (!failed.has(c.job.id)) this.#failed(report, c.job.id, err);
      return [];
    }
    return batch.filter((c) => !failed.has(c.job.id) && disk.get(c.job.id) !== undefined);
  }

  async #recoverAll(report: CleanupReport): Promise<void> {
    const now = this.#d.clock.now();
    for (const s of this.#d.store.summaries((x) => x.has_operation && x.status === 'POSTED')) {
      try {
        const job = await this.#d.store.get(s.id);
        if (job?.operation?.kind !== 'cleanup') continue;
        report.bytes += await this.#finish(job, now);
        report.cleaned++;
        this.#d.logger.info('RECOVERY_COMPLETED', `中断していた整理を完了しました: ${job.id}`, { job_id: job.id, operation_kind: 'cleanup' });
      } catch (err) {
        this.#failed(report, s.id, err);
      }
    }
  }

  /** Steps 4–6 for a job whose operation is saved; safe to repeat. Returns the bytes removed. */
  async #finish(job: Job, now: Date): Promise<number> {
    const places = (job.operation?.target_paths ?? []).map((p) => ({ p, place: this.#placeOf(job, p) }));
    if (places.some((x) => x.place === null)) throw new Refusal('outside');
    let bytes = 0;
    for (const { p, place } of places) {
      const chain = await this.#walk(place!.base, place!.segs);
      if (chain.kind === 'missing') continue;
      if (chain.kind !== 'dir') throw new Refusal('unexpected_entry');
      const file = await this.#kind(p);
      if (file.kind === 'missing') continue;
      if (file.kind !== 'file') throw new Refusal('unexpected_entry');
      try {
        await withTransientRetry(() => this.#fs.unlink(p));
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw storageFailure(err, 'ファイルの削除', p, { clock: this.#d.clock });
      }
      bytes += file.size;
    }
    const { postedDir, evidenceDir } = this.#d.paths;
    const segs = this.#bundleSegs(job);
    for (let n = segs.length; n > 0; n--) await this.#rmdirIfEmpty(postedDir, segs.slice(0, n));
    if ((await this.#walk(evidenceDir, [job.id])).kind === 'dir') {
      for (const attempt of await this.#names(join(evidenceDir, job.id))) await this.#rmdirIfEmpty(evidenceDir, [job.id, attempt]);
      await this.#rmdirIfEmpty(evidenceDir, [job.id]);
    }
    await this.#d.history.forgetText(job.id);
    await this.#purgeBackups(job.id);
    const record = this.#d.dedupe.get(job.id) ?? dedupeRecordOf(job);
    if (record.cleaned_at === null) await this.#d.dedupe.upsert({ ...record, cleaned_at: now.toISOString() });
    await this.#d.store.delete(job.id, job.revision);
    return bytes;
  }

  /** A recorded target is a file directly in the job's posted folder or in one of its evidence attempt folders. */
  #placeOf(job: Job, p: string): { base: string; segs: string[] } | null {
    const { postedDir, evidenceDir } = this.#d.paths;
    const segs = this.#bundleSegs(job);
    const dir = dirname(p);
    if (resolve(p) !== p || samePath(p, dir)) return null;
    if (samePath(dir, join(postedDir, ...segs))) return { base: postedDir, segs };
    if (samePath(dirname(dir), join(evidenceDir, job.id))) return { base: evidenceDir, segs: [job.id, basename(dir)] };
    return null;
  }

  /** `<date>/<hm>/<id>` under images/posted. */
  #bundleSegs(job: Job): string[] {
    return bundleRelDir(job, this.#d.clock).split('/').slice(2);
  }

  /** Adds the plain files of a folder; false when it holds anything else (a folder, a link, a junction) or its path does. */
  async #collect(base: string, segs: string[], out: Target[]): Promise<boolean> {
    const chain = await this.#walk(base, segs);
    if (chain.kind === 'missing') return true;
    if (chain.kind !== 'dir') return false;
    const dir = join(base, ...segs);
    for (const name of await this.#names(dir)) {
      const k = await this.#kind(join(dir, name));
      if (k.kind !== 'file') return false;
      out.push({ path: join(dir, name), bytes: k.size });
    }
    return true;
  }

  /** Follows `segs` below `base` with lstat: 'dir' only when each is a plain folder (a link or junction is 'other'). */
  async #walk(base: string, segs: string[]): Promise<Kind> {
    let p = base;
    for (const seg of segs) {
      if (seg === '' || seg === '.' || seg === '..' || /[\\/]/.test(seg)) return { kind: 'other' };
      p = join(p, seg);
      const k = await this.#kind(p);
      if (k.kind !== 'dir') return k.kind === 'missing' ? k : { kind: 'other' };
    }
    return { kind: 'dir' };
  }

  async #kind(p: string): Promise<Kind> {
    try {
      const st = await withTransientRetry(() => this.#fs.lstat(p));
      if (st.isFile()) return { kind: 'file', size: st.size };
      return { kind: st.isDirectory() ? 'dir' : 'other' };
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      throw storageFailure(err, 'ファイルの確認', p, { clock: this.#d.clock });
    }
  }

  async #names(dir: string): Promise<string[]> {
    try {
      return (await withTransientRetry(() => this.#fs.readdir(dir))).sort();
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return [];
      throw storageFailure(err, 'フォルダの読込', dir, { clock: this.#d.clock });
    }
  }

  /** Never recursive: a folder that still holds anything (e.g. a file that appeared later) stays. */
  async #rmdirIfEmpty(base: string, segs: string[]): Promise<void> {
    if ((await this.#walk(base, segs)).kind !== 'dir') return;
    await this.#fs.rmdir(join(base, ...segs)).catch(() => undefined);
  }

  /** backups/<date>/jobs/<id>.json: a backup never keeps a cleaned job's full text (spec 16.5 バックアップ). */
  async #purgeBackups(id: string): Promise<void> {
    const base = this.#d.paths.backupsDir;
    for (const name of await this.#names(base)) {
      if (!BACKUP_DIR.test(name) || (await this.#walk(base, [name, 'jobs'])).kind !== 'dir') continue;
      const copy = join(base, name, 'jobs', `${id}.json`);
      if ((await this.#kind(copy)).kind !== 'file') continue;
      await withTransientRetry(() => this.#fs.unlink(copy)).catch((err: unknown) => {
        if (errnoCode(err) !== 'ENOENT') throw storageFailure(err, 'ファイルの削除', copy, { clock: this.#d.clock });
      });
    }
  }

  /** Daily plans older than the period in which no remaining job appears (the success times stay in dedupe.json). */
  async #oldPlans(now: Date): Promise<string[]> {
    const r = this.#d.retention();
    if (!r.enabled) return [];
    const cutoff = jstDateKey(new Date(now.getTime() - r.posted_data_days * DAY_MS));
    const jobs = new Set(this.#d.store.summaries().map((s) => s.id));
    const out: string[] = [];
    for (const name of await this.#names(this.#d.paths.schedulesDir)) {
      const date = PLAN_FILE.exec(name)?.[1];
      if (date === undefined || date >= cutoff) continue;
      const path = join(this.#d.paths.schedulesDir, name);
      if ((await this.#kind(path)).kind !== 'file') continue;
      let ids: unknown[];
      try {
        const plan = JSON.parse(await fsp.readFile(path, 'utf8')) as { slots?: { job_id?: unknown }[] };
        ids = (plan.slots ?? []).map((s) => s.job_id);
      } catch {
        continue; // a damaged plan is left for the operator
      }
      if (!ids.some((id) => typeof id === 'string' && jobs.has(id))) out.push(path);
    }
    return out;
  }

  /** Old plans, and history.json.corrupt-* files (full texts) whose last write is older than the period. */
  async #pruneOld(now: Date): Promise<number> {
    const plans = await this.#oldPlans(now);
    const limit = now.getTime() - this.#d.retention().posted_data_days * DAY_MS;
    const dataDir = dirname(this.#d.paths.historyFile);
    const prefix = `${basename(this.#d.paths.historyFile)}.corrupt-`;
    const corrupt: string[] = [];
    for (const name of await this.#names(dataDir)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(dataDir, name);
      const st = await this.#fs.lstat(path).catch(() => null);
      if (st?.isFile() && st.mtimeMs < limit) corrupt.push(path);
    }
    for (const path of [...plans, ...corrupt]) {
      await withTransientRetry(() => this.#fs.unlink(path)).catch((err: unknown) => {
        this.#d.logger.warn('CLEANUP_FILE_NOT_REMOVED', `古いファイルを削除できませんでした（次回の整理で再度試します）: ${path}`, { error_code: errorCodeOf(err), path });
      });
    }
    return plans.length;
  }

  #failed(report: CleanupReport, jobId: string, err: unknown): void {
    const message = errorText(err);
    report.failed.push({ job_id: jobId, message: message.slice(0, 2000) });
    if (err instanceof Refusal) {
      this.#d.logger.error('CLEANUP_HALTED', `整理の対象が想定と違うため、ファイルには触れずに止めました（${message}）。job は残しています: ${jobId}`, { job_id: jobId, reason: err.reason, error_code: 'STATE_CORRUPT' });
    } else {
      this.#d.logger.warn('CLEANUP_FAILED', `整理を途中で止めました（次回の整理で同じ対象から続けます。投稿済みの記録は消していません）: ${jobId}（${message}）`, { job_id: jobId, error_code: errorCodeOf(err) });
    }
  }
}

export const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(1);
