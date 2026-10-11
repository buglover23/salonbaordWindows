import { join } from 'node:path';
import { loadConfig, type ConfigSnapshot } from '../config/loader.js';
import { createFileLogger, type AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { withCommandLock, type CommandLockOptions } from '../storage/command-lock.js';
import { resolveDataPaths, type DataPaths } from '../storage/paths.js';
import { formatConfigIssue } from '../status.js';
import { TemplateLibrary, type TemplateImportReport } from './templates.js';

// `templates:import`: reads the configured workbook (never writes to it), refreshes the hash cache and prints the
// import report in Japanese (spec 7.2, 19).

const KIND_JA = { category: 'カテゴリー', top_titles: '1000PV超えタイトル', trend_words: '最新トレンド' } as const;
const MAX_LISTED = 20;

export interface TemplatesCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export function formatTemplateReportJa(r: TemplateImportReport): string {
  const lines: string[] = ['テンプレート（Excel）の取込結果'];
  lines.push(`  ファイル: ${r.file_path}`);
  const how = r.source === 'last_good_cache' ? '前回正常に読み込んだ内容（キャッシュ）' : r.parsed ? '新しく解析しました' : '変更が無いため保存済みの解析結果を使用';
  lines.push(`  内容の hash: ${r.workbook_sha256.slice(0, 12)}…（${how}）`);
  lines.push(`  読んだ行: ${r.rows_read} / 使った行: ${r.rows_used} / 取り込まなかった行・セル: ${r.skipped.length}`);
  lines.push('  シート別:');
  for (const s of r.sheets) {
    const parts = [`タイトル ${s.entries}件`];
    if (s.kind === 'category') parts.push(`ハッシュタグ ${s.hashtags}個`);
    if (s.kind === 'trend_words') parts.push(`キーワード ${s.words}個`);
    lines.push(`    ${s.sheet}（${KIND_JA[s.kind]}）: ${parts.join('、')}`);
  }
  lines.push(`  見つからないシート: ${r.sheets_missing.length === 0 ? 'なし' : r.sheets_missing.map((n) => `「${n}」`).join('、')}`);
  lines.push(`  対応表に無いシート（読んでいません）: ${r.sheets_unmapped.length === 0 ? 'なし' : r.sheets_unmapped.map((n) => `「${n}」`).join('、')}`);
  if (r.unknown_columns.length === 0) {
    lines.push('  対応表に無い列: なし');
  } else {
    lines.push('  対応表に無い列（読んでいません。必要なら template_mapping.json に追加してください）:');
    for (const u of r.unknown_columns) lines.push(`    ${u.sheet} ${u.column}列（見出し: ${u.header ?? 'なし'}、値 ${u.cells}個）`);
  }
  if (r.skipped.length > 0) {
    lines.push(`  取り込まなかった行・セル（先頭${Math.min(MAX_LISTED, r.skipped.length)}件）:`);
    for (const s of r.skipped.slice(0, MAX_LISTED)) lines.push(`    ${s.sheet} ${s.column ?? ''}${s.row}行目: ${s.reason}`);
  }
  return lines.join('\n');
}

/**
 * Exit code: 0 the workbook was read; 1 invalid config, or the workbook could not be read (with or without a cache).
 * Holds app.lock while it runs (the running tool reads and writes the same cache): refused while the tool runs.
 */
export async function templatesImportCommand(projectRoot: string, io: TemplatesCliIo, clock: Clock, logger?: AppLogger, lock: CommandLockOptions = {}): Promise<number> {
  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) {
    io.stderr('設定ファイルに誤りがあるため、テンプレートを取り込めません。次の箇所を直して保存してください:');
    for (const issue of config.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const { settings, templateMapping, categories } = config.snapshot;
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(paths, 'templates:import', () => importLocked(projectRoot, io, clock, paths, { settings, templateMapping, categories }, logger), lock);
}

async function importLocked(
  projectRoot: string,
  io: TemplatesCliIo,
  clock: Clock,
  paths: DataPaths,
  c: Pick<ConfigSnapshot, 'settings' | 'templateMapping' | 'categories'>,
  logger?: AppLogger,
): Promise<number> {
  const { settings, templateMapping, categories } = c;
  const log =
    logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('inst'), mode: settings.mode, clock });
  try {
    const library = await TemplateLibrary.load(templateMapping, paths.templateCacheDir, log, clock, { categories, baseDir: projectRoot });
    io.stdout(formatTemplateReportJa(library.report));
    if (library.warning) {
      io.stderr(`【注意】${library.warning.message}`);
      io.stderr('前回正常に読み込んだ内容（キャッシュ）で文章の生成は続けられます。Excelファイルの場所（template_mapping.json の file_path）を確認してください。');
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof AppFailure && (err.error.code === 'TEMPLATE_MISSING' || err.error.code === 'TEMPLATE_PARSE_ERROR')) {
      io.stderr(`テンプレートを取り込めません（${err.error.code}）: ${err.error.message}`);
      io.stderr('有効なキャッシュも無いため、Excelファイルが読めるようになるまで文章の生成は保留されます。');
      return 1;
    }
    throw err;
  }
}
