import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { createFileLogger, type AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { newId } from '../shared/ids.js';
import { formatConfigIssue } from '../status.js';
import { withCommandLock, type CommandLockOptions } from './command-lock.js';
import { DedupeStore } from './dedupe-store.js';
import { HistoryStore, historyFullTextDays } from './history-store.js';
import { JobStore } from './job-store.js';
import { resolveDataPaths } from './paths.js';
import { SerialQueue } from './serial-queue.js';

// `npm.cmd run history:rebuild` (spec 11.4-5, 16.5): rebuilds data/history.json of the configured mode from the POSTED jobs
// (and dedupe.json for posts whose job is gone). history.json is only a cache for the duplicate and variety checks; the
// jobs stay the source of truth. Holds app.lock (refused while the tool runs).

export interface HistoryCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function historyRebuildCommand(projectRoot: string, io: HistoryCliIo, clock: Clock, o: { lock?: CommandLockOptions; logger?: AppLogger } = {}): Promise<number> {
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) {
    io.stderr('設定ファイルに誤りがあるため、投稿履歴を作り直せません。次の箇所を直して保存してください:');
    for (const issue of loaded.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const { settings } = loaded.snapshot;
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(
    paths,
    'history:rebuild',
    async () => {
      const logger = o.logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('cmd'), mode: settings.mode, clock });
      const queue = new SerialQueue();
      const jobs = await JobStore.open(paths, queue, clock);
      const dedupe = await DedupeStore.load(paths, queue, clock);
      const history = await HistoryStore.load(paths, queue, clock, { mode: settings.mode, fullTextDays: historyFullTextDays(settings.retention), dedupe, logger });
      const issue = history.loadIssue;
      const report = await history.rebuildFromJobs(jobs, dedupe);
      logger.info('HISTORY_REBUILT', `投稿履歴（history.json）を作り直しました（全文 ${report.entries}件・hash のみ ${report.hashes}件）。`, { ...report });
      io.stdout(`投稿履歴（${paths.historyFile}）を投稿済みの job から作り直しました。`);
      io.stdout(`  全文を持つ記録: ${report.entries}件（直近 100件まで、保持期間内のもの）`);
      io.stdout(`  hash だけの記録: ${report.hashes}件`);
      if (report.skipped > 0) io.stdout(`  下書きを読み取れなかった投稿済みの job: ${report.skipped}件（履歴には入れていません）`);
      if (issue !== null) io.stdout(`  壊れていた元のファイルは ${issue.moved_to} に移しました（原因: ${issue.reason}）。`);
      return 0;
    },
    o.lock,
  );
}
