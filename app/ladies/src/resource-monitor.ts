import { lstat, readdir, readFile, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from './config/schemas.js';
import type { PreparationHold } from './execution/job-processor.js';
import { logsBytes, pruneLogs, type AppLogger } from './logger.js';
import type { Pressure } from './posting/gates.js';
import type { Clock } from './shared/clock.js';
import { errorCodeOf, errorText } from './shared/errors.js';
import type { ResourcesDto } from './shared/protocol/status.js';
import { formatJst } from './shared/time.js';
import { backupData, pruneBackups } from './storage/backups.js';
import type { DataPaths } from './storage/paths.js';
import type { RetentionManager } from './storage/retention.js';

// Spec 16.6 (Plan 4 Task 2): every 30 s the process memory (RSS), the free disk and the log total are compared with
// settings.resources. Over a limit, new intake, AI preparation and posts stop (reason shown); saving and reconciling go on.
// Once a day (and right after start) the 30-day cleanup, the backup, and the log, backup and cache limits are applied.

const MB = 1_048_576;
const HOUR_MS = 3_600_000;
/** RESOURCE_MEMORY_HIGH this many checks in a row (about 5 minutes) asks for a graceful stop (spec 16.6). */
export const MEMORY_HIGH_STOP_CHECKS = 10;
const TEMPLATE_CACHE = /^[0-9a-f]{64}\.json$/;

export interface ResourceSample {
  rss_mb: number;
  /** null when the free space cannot be read. */
  free_disk_mb: number | null;
}

/** The real sample: this process's RSS and the free space of the drive holding `dir`. */
export async function sampleResources(dir: string): Promise<ResourceSample> {
  const free = await statfs(dir).then(
    (s) => (s.bavail * s.bsize) / MB,
    () => null,
  );
  return { rss_mb: process.memoryUsage.rss() / MB, free_disk_mb: free };
}

export interface ResourceMonitorDeps {
  paths: DataPaths;
  settings: () => Settings;
  clock: Clock;
  logger: AppLogger;
  retention: RetentionManager;
  /** The live poster's stop of new posts. A DISK_FULL it raised itself is cleared only by its own probe write. */
  pressure: { current(): Pressure | null; set(code: Pressure | null): void };
  sample?: () => Promise<ResourceSample>;
  /** Memory stayed over the limit (MEMORY_HIGH_STOP_CHECKS checks): the runtime stops gracefully. */
  onExhausted?: () => void;
}

type Code = 'RESOURCE_MEMORY_HIGH' | 'RESOURCE_DISK_LOW';

const HOLD_JA: Record<Code, string> = {
  RESOURCE_MEMORY_HIGH: 'メモリの使用量が上限を超えているため、新しい取込・文章作成・投稿を止めています',
  RESOURCE_DISK_LOW: 'ディスクの空き（またはログの容量）が足りないため、新しい取込・文章作成・投稿を止めています',
};

export class ResourceMonitor {
  readonly #d: ResourceMonitorDeps;
  #code: Code | null = null;
  #highChecks = 0;
  #nextDaily = Number.NEGATIVE_INFINITY;
  #lastDiskCleanup = Number.NEGATIVE_INFINITY;
  #logsOver = false;
  #sample: ResourceSample | null = null;
  #sizes: { data: number | null; logs: number | null; backups: number | null } = { data: null, logs: null, backups: null };
  #timer: NodeJS.Timeout | null = null;
  #checking: Promise<void> | null = null;

  constructor(d: ResourceMonitorDeps) {
    this.#d = d;
  }

  /** Why new intake, preparation and dry-run dispatch wait now; null when they may run. */
  hold(): PreparationHold | null {
    return this.#code === null ? null : { code: this.#code, message: HOLD_JA[this.#code] };
  }

  /** The status view (spec 16.6: sizes, memory, the next and the last cleanup). */
  view(): ResourcesDto {
    const last = this.#d.retention.last;
    const mb = (bytes: number | null): number | null => (bytes === null ? null : bytes / MB);
    return {
      rss_mb: this.#sample?.rss_mb ?? null,
      free_disk_mb: this.#sample?.free_disk_mb ?? null,
      data_mb: mb(this.#sizes.data),
      logs_mb: mb(this.#sizes.logs),
      backups_mb: mb(this.#sizes.backups),
      pressure: this.#code,
      cleanup_due: this.#d.retention.expiredIds(this.#d.clock.now()).length,
      last_cleanup:
        last === null
          ? null
          : { at_jst: formatJst(new Date(last.at)), cleaned: last.cleaned, freed_mb: Math.round((last.bytes / MB) * 10) / 10, remaining: last.remaining, failed: last.failed.length },
    };
  }

  /** Checks now, then every `intervalMs` (real time). */
  start(intervalMs: number): void {
    if (this.#timer !== null) return;
    const tick = (): void => {
      this.#checking ??= this.check()
        .catch((err: unknown) => this.#d.logger.error('RESOURCE_CHECK_FAILED', `資源の確認でエラーが発生しました（続けます）: ${errorText(err)}`, { error_code: errorCodeOf(err) }))
        .finally(() => (this.#checking = null));
    };
    tick();
    this.#timer = setInterval(tick, intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#checking;
  }

  async check(): Promise<void> {
    const s = this.#d.settings();
    const now = this.#d.clock.now();
    let sample = await this.#take();
    const diskLow = (x: ResourceSample): boolean => x.free_disk_mb !== null && x.free_disk_mb < s.resources.min_free_disk_mb;
    if (now.getTime() >= this.#nextDaily) {
      this.#nextDaily = now.getTime() + s.retention.cleanup_interval_hours * HOUR_MS;
      await this.#daily(now, s);
      sample = await this.#take();
    } else if (diskLow(sample) && now.getTime() - this.#lastDiskCleanup >= HOUR_MS) {
      // Space is recovered only from expired POSTED data, never by removing unresolved data (spec 16.6).
      this.#lastDiskCleanup = now.getTime();
      await this.#cleanup();
      sample = await this.#take();
    }
    await this.#limitLogs(now, s);
    const memoryHigh = sample.rss_mb > s.resources.memory_soft_limit_mb;
    this.#apply(memoryHigh ? 'RESOURCE_MEMORY_HIGH' : diskLow(sample) || this.#logsOver ? 'RESOURCE_DISK_LOW' : null, sample, s);
    this.#highChecks = memoryHigh ? this.#highChecks + 1 : 0;
    if (this.#highChecks === MEMORY_HIGH_STOP_CHECKS) {
      this.#d.logger.error('RESOURCE_MEMORY_EXHAUSTED', 'メモリの使用量が上限を超えた状態が続いたため、処理中の保存を終えてから停止します（自動では再起動しません）。PCを再起動してから起動し直してください。', {
        error_code: 'RESOURCE_MEMORY_HIGH',
        rss_mb: Math.round(sample.rss_mb),
      });
      this.#d.onExhausted?.();
    }
  }

  async #take(): Promise<ResourceSample> {
    this.#sample = await (this.#d.sample ?? (() => sampleResources(this.#d.paths.modeRoot)))();
    return this.#sample;
  }

  #apply(code: Code | null, sample: ResourceSample, s: Settings): void {
    if (code !== this.#code) {
      if (code === 'RESOURCE_MEMORY_HIGH') {
        this.#d.logger.warn('RESOURCE_MEMORY_HIGH', `${HOLD_JA[code]}（使用中 ${Math.round(sample.rss_mb)} MB／上限 ${s.resources.memory_soft_limit_mb} MB）。処理中の保存と照合は続けます。`, {
          error_code: code,
          rss_mb: Math.round(sample.rss_mb),
          limit_mb: s.resources.memory_soft_limit_mb,
        });
      } else if (code === 'RESOURCE_DISK_LOW') {
        this.#d.logger.warn('RESOURCE_DISK_LOW', `${HOLD_JA[code]}（空き ${Math.round(sample.free_disk_mb ?? 0)} MB／必要 ${s.resources.min_free_disk_mb} MB）。30日を過ぎたデータの整理で回復を試みます。未完了のデータは消しません。`, {
          error_code: code,
          free_disk_mb: Math.round(sample.free_disk_mb ?? 0),
          min_free_disk_mb: s.resources.min_free_disk_mb,
        });
      } else this.#d.logger.info('RESOURCE_RECOVERED', '資源の不足が解消したため、新しい取込・文章作成・投稿を再開します。');
      this.#code = code;
    }
    if (this.#d.pressure.current() !== 'DISK_FULL') this.#d.pressure.set(code);
  }

  async #cleanup(): Promise<void> {
    for (;;) {
      const r = await this.#d.retention.cleanup();
      if (r.cleaned === 0 || r.remaining === 0) return;
    }
  }

  /** Cleanup, backup, then the log, backup and cache limits; each part on its own, so one failing does not skip the rest. */
  async #daily(now: Date, s: Settings): Promise<void> {
    const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        this.#d.logger.error('MAINTENANCE_FAILED', `${what}でエラーが発生しました（次回もう一度行います）: ${errorText(err)}`, { error_code: errorCodeOf(err) });
      }
    };
    const { paths, retention, logger } = this.#d;
    await step('30日整理', () => this.#cleanup());
    await step('バックアップ', () =>
      retention.exclusive(async () => {
        const expired = new Set(retention.expiredIds(now));
        if (await backupData(paths, now, (id) => expired.has(id))) logger.info('BACKUP_CREATED', `その日のデータのバックアップを作りました（画像と文章の履歴は含みません）: ${paths.backupsDir}`);
        const b = await pruneBackups(paths, now, { retentionDays: s.retention.backup_retention_days, maxBytes: s.retention.backup_max_mb * MB });
        this.#sizes.backups = b.total;
        if (b.over) logger.warn('BACKUP_LIMIT_EXCEEDED', `最新のバックアップだけで上限（${s.retention.backup_max_mb} MB）を超えています。settings.json の retention.backup_max_mb を見直してください。`);
        if (b.kept_unexpected.length > 0) logger.warn('BACKUP_NOT_REMOVED', `想定外のフォルダやリンクを含むため、古いバックアップを消さずに残しました: ${b.kept_unexpected.join(', ')}`);
      }),
    );
    await step('ログの整理', async () => {
      await pruneLogs(paths.logsDir, now, { retentionDays: s.logs.retention_days, maxTotalBytes: s.resources.max_log_total_mb * MB });
    });
    await step('キャッシュの整理', () => this.#limitCaches(s));
    await step('容量の集計', async () => {
      this.#sizes.data = await dirBytes(paths.modeRoot);
    });
  }

  /** Log total over max_log_total_mb: the oldest closed files go; still over with only today's files → stop (A55). */
  async #limitLogs(now: Date, s: Settings): Promise<void> {
    const cap = s.resources.max_log_total_mb * MB;
    let total = await logsBytes(this.#d.paths.logsDir);
    let over = false;
    if (total > cap) ({ total, over } = await pruneLogs(this.#d.paths.logsDir, now, { retentionDays: s.logs.retention_days, maxTotalBytes: cap }));
    if (over && !this.#logsOver) {
      this.#d.logger.warn('LOG_LIMIT_EXCEEDED', `今日のログだけで上限（${s.resources.max_log_total_mb} MB）を超えたため、新しい処理を止めます。logs フォルダの今日のログを確認してください。`, {
        error_code: 'RESOURCE_DISK_LOW',
        logs_mb: Math.round(total / MB),
      });
    }
    this.#logsOver = over;
    this.#sizes.logs = total;
  }

  /**
   * retention.cache_max_mb over the template and trend caches: old template imports go first, oldest first. The import the
   * tool uses now (last-good.json) is never removed, so preparation can always go on (spec 16.5).
   */
  async #limitCaches(s: Settings): Promise<void> {
    const cap = s.retention.cache_max_mb * MB;
    const { templateCacheDir, trendCacheDir } = this.#d.paths;
    const files = [...(await plainFiles(templateCacheDir)), ...(await plainFiles(trendCacheDir))];
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= cap) return;
    const inUse = await readFile(join(templateCacheDir, 'last-good.json'), 'utf8').then(
      (t) => `${String((JSON.parse(t) as { workbook_sha256?: unknown }).workbook_sha256)}.json`,
      () => null,
    );
    const old = files.filter((f) => f.dir === templateCacheDir && TEMPLATE_CACHE.test(f.name) && f.name !== inUse).sort((a, b) => a.mtime - b.mtime);
    for (const f of old) {
      if (total <= cap) break;
      if (await unlink(join(f.dir, f.name)).then(() => true, () => false)) total -= f.size;
    }
    if (total > cap) this.#d.logger.warn('CACHE_LIMIT_EXCEEDED', `使用中のキャッシュだけで上限（${s.retention.cache_max_mb} MB）を超えています。settings.json の retention.cache_max_mb を見直してください。`);
  }
}

async function plainFiles(dir: string): Promise<{ dir: string; name: string; size: number; mtime: number }[]> {
  const out: { dir: string; name: string; size: number; mtime: number }[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const st = await lstat(join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ dir, name, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** Bytes of the files under `dir`; links and junctions are not followed. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else if (e.isFile()) total += (await lstat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}
