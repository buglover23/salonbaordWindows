import { join } from 'node:path';
import { AiService } from '../ai/ai-service.js';
import { loadAiSetup } from '../ai/ai-setup.js';
import { UsageMeter } from '../ai/usage-meter.js';
import { loadConfig, type ConfigSnapshot } from '../config/loader.js';
import { handledAudiences } from '../config/schemas.js';
import { createFileLogger, loggerFrom, type AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { newId } from '../shared/ids.js';
import { AUDIENCE_JA } from '../shared/labels.js';
import { formatJst } from '../shared/time.js';
import { formatConfigIssue } from '../status.js';
import { withCommandLock, type CommandLockOptions } from '../storage/command-lock.js';
import { envDirOf, resolveDataPaths, type DataPaths } from '../storage/paths.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { buildEffectiveConfig, scheduleCapacityIssues } from './effective-config.js';
import { InstructionManager } from './instructions/store.js';
import { TrendLibrary, type TrendImportReport, type TrendSourceReport, type TrendStatus } from './trends.js';
import { fetchWebTrends, webTrendAudiences, webTrendsStatusLine } from './web-trends.js';

// `trends:refresh`: imports the manual Google Trends CSVs listed in config/trends.json (they are only read, never changed)
// and prints the result in Japanese (spec 8.4). It never connects to Google or any other site.
// `trends:web`: the weekly web look-up (web-trends.ts) run by hand; it asks the AI to search the web.

const MAX_LISTED = 20;
const DATA_KIND_JA = { interest_over_time: '時系列（関心度の推移）', related_queries: '関連クエリ' } as const;

export interface TrendsCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const jst = (iso: string | null): string => (iso === null ? 'なし' : `${formatJst(new Date(iso))}（日本時間）`);

function sourceLines(s: TrendSourceReport): string[] {
  const how =
    s.status === 'imported'
      ? '新しく解析しました'
      : s.status === 'cached'
        ? '変更が無いため保存済みの取込結果を使用'
        : s.using_previous_import
          ? '取り込めませんでした（前回の取込結果を使用）'
          : '取り込めませんでした';
  const lines = [`  ■ ${s.id}（${s.data_kind}: ${DATA_KIND_JA[s.data_kind]}）`];
  lines.push(`    ファイル: ${s.file_path}${s.file_missing ? '（見つかりません）' : ''}`);
  lines.push(`    出典: ${s.source_url}`);
  lines.push(`    内容の hash: ${s.file_sha256 === null ? 'なし' : `${s.file_sha256.slice(0, 12)}…`}（${how}）`);
  if (s.retrieved_at !== null) lines.push(`    書き出し日時: ${jst(s.retrieved_at)} / 期限: ${jst(s.expires_at)}${s.expired ? '【期限切れ】' : ''}`);
  const parts = [`読んだ語 ${s.items_read}`, `除外語で除いた語 ${s.excluded.length}`, `取り込まなかった行 ${s.skipped.length}`];
  lines.push(`    取り込んだ語: ${s.records}件（${parts.join('、')}）`);
  if (s.excluded.length > 0) lines.push(`    除外語で除いた語: ${s.excluded.slice(0, MAX_LISTED).join('、')}${s.excluded.length > MAX_LISTED ? ' ほか' : ''}`);
  if (s.skipped.length > 0) {
    lines.push(`    取り込まなかった行（先頭${Math.min(MAX_LISTED, s.skipped.length)}件）:`);
    for (const k of s.skipped.slice(0, MAX_LISTED)) lines.push(`      ${k.line === null ? '' : `行${k.line} `}${k.keyword === null ? '' : `「${k.keyword}」 `}${k.reason}`);
  }
  return lines;
}

export function formatTrendReportJa(report: TrendImportReport, status: TrendStatus, validRecords: number): string {
  const lines = ['公開トレンド（手動CSV）の取込結果'];
  if (!report.enabled) {
    lines.push('  config/trends.json の enabled が false のため、トレンドは取り込みません。');
  } else if (report.sources.length === 0) {
    lines.push('  取り込む手動CSVの取込元がありません。config/trends.json の sources に manual_import を追加してください（手順: references/trends/README.md）。');
  } else {
    lines.push(`  取込元: ${report.sources.length}件`);
    for (const s of report.sources) lines.push(...sourceLines(s));
  }
  if (status.state === 'valid') {
    lines.push(`  状態: ${status.label}（有効な語 ${validRecords}件）`);
  } else if (status.state === 'expired') {
    lines.push(`  状態: ${status.label}（取り込んだ内容は期限切れです。Google トレンドからCSVを書き出し直し、config/trends.json の exported_at を更新してください）`);
  } else {
    lines.push(`  状態: ${status.label}`);
  }
  lines.push(
    report.sources.length > 0
      ? '  ※ このツールは Google トレンドへ自動で接続しません。手動で書き出して置いたCSVを読み取っただけです（「最新のトレンド」を自動取得したものではありません）。'
      : '  ※ このツールは Google トレンドへ自動で接続しません（基本版では、手動で書き出したCSVだけを取り込みます）。',
  );
  return lines.join('\n');
}

/**
 * Exit code: 0 imported (or nothing to import); 1 invalid config, or a source's CSV could not be used. Holds app.lock
 * while it runs (the running tool imports into the same cache): refused while the tool runs.
 */
export async function trendsRefreshCommand(projectRoot: string, io: TrendsCliIo, clock: Clock, logger?: AppLogger, lock: CommandLockOptions = {}): Promise<number> {
  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) {
    io.stderr('設定ファイルに誤りがあるため、トレンドを取り込めません。次の箇所を直して保存してください:');
    for (const issue of config.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const paths = resolveDataPaths(projectRoot, config.snapshot.settings);
  return withCommandLock(paths, 'trends:refresh', () => refreshLocked(projectRoot, io, clock, paths, config.snapshot, logger), lock);
}

async function refreshLocked(projectRoot: string, io: TrendsCliIo, clock: Clock, paths: DataPaths, snapshot: ConfigSnapshot, logger?: AppLogger): Promise<number> {
  const { settings, trends, keywords, categories } = snapshot;
  const log =
    logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('inst'), mode: settings.mode, clock });
  const library = new TrendLibrary({ cacheDir: paths.trendCacheDir, baseDir: projectRoot, logger: log, clock });
  const now = clock.now();
  const report = await library.importConfigured({ trends, keywords, categories }, now);
  io.stdout(formatTrendReportJa(report, library.status(now), library.validRecords(now).length));

  let failed = false;
  for (const s of report.sources) {
    if (s.error === null) continue;
    failed = true;
    // The message says what is wrong, whether the previous import is still used, and the command to run next.
    io.stderr(`【取り込めませんでした】${s.id}（${s.error.code}）: ${s.error.message}`);
  }
  return failed ? 1 : 0;
}

/**
 * `trends:web`: the weekly web look-ups of men's and then women's hair trend words (only the audiences with a posting
 * route, see webTrendAudiences), run now (the running tool does them by itself every Sunday). Uses the AI the settings
 * choose for this mode (dry-run: the mock unless dry_run_use_real_ai) and counts each request like any other. Exit code: 0 all looked up; 1 invalid config, switched off or a look-up
 * failed. Holds app.lock: refused while the tool runs.
 */
export async function trendsWebCommand(projectRoot: string, io: TrendsCliIo, clock: Clock, lock: CommandLockOptions = {}): Promise<number> {
  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) {
    io.stderr('設定ファイルに誤りがあるため、トレンド語を調べられません。次の箇所を直して保存してください:');
    for (const issue of config.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const snapshot = config.snapshot;
  const { settings, trends } = snapshot;
  if (!trends.enabled || !trends.web_search.enabled) {
    io.stderr('config/trends.json の enabled または web_search.enabled が false のため、Web検索でトレンド語を調べません。');
    return 1;
  }
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(
    paths,
    'trends:web',
    async () => {
      const logger = createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('cmd'), mode: settings.mode, clock });
      const setup = await loadAiSetup(envDirOf(projectRoot, settings), settings.ai);
      const meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue: new SerialQueue(), getSettings: () => settings, clock });
      const ai = new AiService({
        getSettings: () => settings,
        mode: settings.mode,
        meter,
        env: setup.env,
        envUnreadable: setup.envFile === 'unreadable',
        getSnapshot: () => snapshot,
        clock,
        logger,
      });
      // Like the running tool: only the audiences with a posting route (config plus the instruction URLs), both when none.
      const manager = new InstructionManager({ dir: paths.instructionsDir, recordFile: paths.instructionsFile, config: () => snapshot, logger: loggerFrom(() => undefined), readOnly: true, validate: scheduleCapacityIssues });
      const scan = await manager.scan(clock.now()).catch(() => null);
      let code = 0;
      for (const audience of webTrendAudiences(buildEffectiveConfig(snapshot, scan?.overlay ?? null, scan?.applied).routes, handledAudiences(snapshot.settings))) {
        io.stdout(`Web検索で${AUDIENCE_JA[audience]}ヘアのトレンド語を調べています（AIを1回使います）…`);
        const result = await fetchWebTrends({ ai, snapshot: () => snapshot, cacheDir: paths.trendCacheDir, workbookDir: paths.trendWorkbookDir, clock, logger }, audience);
        io.stdout(webTrendsStatusLine(result, true, clock.now(), audience));
        if (result.last_error !== null) code = 1;
        else if (result.words.length > 0) io.stdout(`  ${result.words.map((w) => w.word).join('、')}`);
      }
      return code;
    },
    lock,
  );
}
