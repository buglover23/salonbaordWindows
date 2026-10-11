import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { createFileLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { CleanupPreviewResponseSchema, CleanupResponseSchema, type CleanupPreview, type CleanupReport } from '../shared/protocol/api.js';
import { withCommandLock, type CommandLockOptions } from '../storage/command-lock.js';
import { DedupeStore } from '../storage/dedupe-store.js';
import { HistoryStore, historyFullTextDays } from '../storage/history-store.js';
import { JobStore } from '../storage/job-store.js';
import { resolveDataPaths } from '../storage/paths.js';
import { CLEANUP_EXCLUSION_JA, RetentionManager, mb } from '../storage/retention.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { run } from './operator.js';

// `cleanup:preview` and `cleanup` (spec 16.5, 18.2). While the tool runs they ask its single writer through the local API;
// otherwise they hold app.lock and run the same RetentionManager. No path can be named: the tool decides what goes.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

async function offline<T>(projectRoot: string, command: string, clock: Clock, lock: CommandLockOptions | undefined, fn: (m: RetentionManager) => Promise<T>): Promise<T> {
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) throw new AppFailure(appError('CONFIG_INVALID', 'cli', clock, { details: { issues: loaded.issues } }));
  const { settings } = loaded.snapshot;
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(
    paths,
    command,
    async () => {
      const logger = createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('cmd'), mode: settings.mode, clock });
      const queue = new SerialQueue();
      const store = await JobStore.open(paths, queue, clock);
      const dedupe = await DedupeStore.load(paths, queue, clock);
      const history = await HistoryStore.load(paths, queue, clock, { mode: settings.mode, fullTextDays: historyFullTextDays(settings.retention), dedupe, logger });
      return fn(new RetentionManager({ paths, store, dedupe, history, clock, logger, retention: () => settings.retention }));
    },
    lock,
  );
}

function previewLines(p: CleanupPreview): string[] {
  const lines = ['30日整理の確認（投稿済みになってから30日を過ぎた、このPCの中の画像・証跡・文章だけが対象です。SALON BOARD の投稿は消しません）:'];
  if (!p.enabled) return [...lines, '  settings.json の retention.enabled が false のため、整理はしません。'];
  lines.push(`  整理する投稿済みの job: ${p.due}件（画像・証跡 ${mb(p.bytes)} MB）`, `  まだ保持期間（${p.days}日）中の投稿済みの job: ${p.waiting}件`);
  if (p.excluded.length > 0) lines.push('  整理しない job（理由）:', ...p.excluded.map((e) => `    - ${CLEANUP_EXCLUSION_JA[e.reason]}: ${e.count}件`));
  lines.push(`  自動では消さない job（投稿待ち・失敗・結果不明など）: ${p.protected_jobs}件`, `  消せる古い日次計画: ${p.schedules}件`);
  return lines;
}

export async function cleanupPreviewCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: { lock?: CommandLockOptions } = {}): Promise<number> {
  if (args.length > 0) {
    io.stderr(`cleanup:preview に指定できない引数です: ${args.join(' ')}`);
    return 1;
  }
  const print = (p: CleanupPreview): number => {
    io.stdout(previewLines(p).join('\n'));
    if (p.enabled && p.due > 0) io.stdout('整理するには npm.cmd run cleanup を実行してください（ツールの動作中は24時間ごとに自動で整理します）。');
    return 0;
  };
  return run(
    io,
    projectRoot,
    async (client) => print(CleanupPreviewResponseSchema.parse((await client.request('GET', '/v1/maintenance/cleanup-preview')).body).preview),
    () => offline(projectRoot, 'cleanup:preview', clock, o.lock, async (m) => print(await m.preview())),
  );
}

/** Runs batches until nothing expired is left or a batch makes no progress. */
async function untilDone(step: () => Promise<CleanupReport>): Promise<CleanupReport> {
  const total: CleanupReport = { cleaned: 0, bytes: 0, remaining: 0, failed: [], schedules: 0, at: '' };
  for (;;) {
    const r = await step();
    Object.assign(total, { cleaned: total.cleaned + r.cleaned, bytes: total.bytes + r.bytes, remaining: r.remaining, schedules: total.schedules + r.schedules, at: r.at });
    total.failed.push(...r.failed);
    if (r.cleaned === 0 || r.remaining === 0) return total;
  }
}

export async function cleanupCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock, o: { lock?: CommandLockOptions } = {}): Promise<number> {
  if (args.length > 0) {
    io.stderr(`cleanup に指定できない引数です（消す場所は指定できません。ツールが期限を確かめて決めます）: ${args.join(' ')}`);
    return 1;
  }
  const print = (r: CleanupReport): number => {
    io.stdout(`30日を過ぎた投稿済みデータを整理しました: ${r.cleaned}件（画像・証跡 ${mb(r.bytes)} MB を削除）。古い日次計画: ${r.schedules}件。残り: ${r.remaining}件。`);
    io.stdout('SALON BOARD の投稿と、重複防止の記録（dedupe.json）はそのまま残しています。');
    if (r.failed.length === 0) return 0;
    io.stdout(`整理できなかった job: ${r.failed.length}件（次回の整理で同じところから続けます。詳しくは logs フォルダのログを確認してください）`);
    for (const f of r.failed.slice(0, 10)) io.stdout(`  - ${f.job_id}: ${f.message}`);
    return 1;
  };
  return run(
    io,
    projectRoot,
    async (client) => print(await untilDone(async () => CleanupResponseSchema.parse((await client.request('POST', '/v1/maintenance/cleanup', {}, 60_000)).body).report)),
    () => offline(projectRoot, 'cleanup', clock, o.lock, async (m) => print(await untilDone(() => m.cleanup()))),
  );
}
