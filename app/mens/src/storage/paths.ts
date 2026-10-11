import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Settings } from '../config/schemas.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../shared/types.js';
import { storageFailure } from './atomic-json.js';

/** All absolute. pendingDir, lockFile, logsDir, templateCacheDir, trendCacheDir, aiUsageDir and instructionsDir are shared by both modes; the rest live under modeRoot. */
export interface DataPaths {
  projectRoot: string;
  /** settings.shared_root, absolute: the folder both copies share (.env, images/pending, 設定, トレンド語); null when not set. */
  sharedRoot: string | null;
  /** data_root in live mode, data_root/dry-run in dry_run mode (plan decision 1). */
  modeRoot: string;
  pendingDir: string;
  processingDir: string;
  failedDir: string;
  postedDir: string;
  jobsDir: string;
  dedupeFile: string;
  schedulesDir: string;
  controlFile: string;
  lockFile: string;
  logsDir: string;
  /** Parsed workbook caches (<sha256>.json); derived from the workbook only, created on first use (spec 3). */
  templateCacheDir: string;
  /** AI usage per JST month (YYYY-MM.json); shared by both modes because real AI calls cost the same in dry-run. Created on first use. */
  aiUsageDir: string;
  /** Imported public-trend records, one <source id>.json per manual CSV source; derived from the CSVs only, created on first use. */
  trendCacheDir: string;
  /** The owner's trend workbooks (<data root>/トレンド語, or <shared root>/トレンド語, outside data/ so the owner finds them): the weekly list and the hand-kept words. Shared by both modes. */
  trendWorkbookDir: string;
  /** The operator's instruction files (spec 5.10): <projectRoot>/instructions (or <shared root>/設定), shared by both modes and never written. */
  instructionsDir: string;
  /** What was read from instructionsDir and the resulting overlay (data/instructions.json), per mode. */
  instructionsFile: string;
  /** Recent posted texts for duplicate and variety checks (data/history.json), per mode (spec 16.5). */
  historyFile: string;
  /** Port and per-run CLI key of the running process (data/local-api.json, Plan 3 D1); next to app.lock, so shared by both modes. */
  localApiFile: string;
  /** The paired extension (data/pairing.json): one pairing for both modes, so switching dry_run ↔ live keeps it. */
  pairingFile: string;
  /** Survey captures (data/survey, D9); shared by both modes, created on first use. */
  surveyDir: string;
  /** Post evidence per job and attempt (data/evidence, P3-R44); per mode, created on first use. */
  evidenceDir: string;
  /** The append-only submit-intent ledger (<modeRoot>/ledger, P3-R38): outside data/, never backed up or restored. Created on first use. */
  ledgerDir: string;
  /** Daily copies of the mode's data JSON (data/backups/YYYY-MM-DD, spec 16.5); per mode, created on first backup. */
  backupsDir: string;
}

/** settings.shared_root as an absolute path; null when this copy keeps everything in its own folder. */
export const sharedRootOf = (projectRoot: string, settings: Pick<Settings, 'shared_root'>): string | null =>
  settings.shared_root === null ? null : resolve(projectRoot, settings.shared_root);

/** The folder of the .env file every reader (and ensureMasterSecret) uses: the shared root, else the project root. */
export const envDirOf = (projectRoot: string, settings: Pick<Settings, 'shared_root'>): string => sharedRootOf(projectRoot, settings) ?? resolve(projectRoot);

export function resolveDataPaths(projectRoot: string, settings: Settings): DataPaths {
  const root = resolve(projectRoot);
  const dataRoot = resolve(root, settings.data_root);
  const modeRoot = settings.mode === 'live' ? dataRoot : join(dataRoot, 'dry-run');
  // Only the owner-facing folders move to the shared root; processing/failed/posted and all data stay per copy.
  const shared = sharedRootOf(root, settings);
  return {
    projectRoot: root,
    sharedRoot: shared,
    modeRoot,
    pendingDir: join(shared ?? dataRoot, 'images', 'pending'),
    processingDir: join(modeRoot, 'images', 'processing'),
    failedDir: join(modeRoot, 'images', 'failed'),
    postedDir: join(modeRoot, 'images', 'posted'),
    jobsDir: join(modeRoot, 'data', 'jobs'),
    dedupeFile: join(modeRoot, 'data', 'dedupe.json'),
    schedulesDir: join(modeRoot, 'data', 'schedules'),
    controlFile: join(modeRoot, 'data', 'control.json'),
    lockFile: join(dataRoot, 'data', 'app.lock'),
    logsDir: join(dataRoot, 'logs'),
    templateCacheDir: join(dataRoot, 'data', 'cache', 'templates'),
    aiUsageDir: join(dataRoot, 'data', 'ai-usage'),
    trendCacheDir: join(dataRoot, 'data', 'cache', 'trends'),
    trendWorkbookDir: join(shared ?? dataRoot, 'トレンド語'),
    instructionsDir: shared === null ? join(root, 'instructions') : join(shared, '設定'),
    instructionsFile: join(modeRoot, 'data', 'instructions.json'),
    historyFile: join(modeRoot, 'data', 'history.json'),
    localApiFile: join(dataRoot, 'data', 'local-api.json'),
    pairingFile: join(dataRoot, 'data', 'pairing.json'),
    surveyDir: join(dataRoot, 'data', 'survey'),
    evidenceDir: join(modeRoot, 'data', 'evidence'),
    ledgerDir: join(modeRoot, 'ledger'),
    backupsDir: join(modeRoot, 'data', 'backups'),
  };
}

/** The prepared upload is named by its actual output format (P1-D7). */
export function uploadFileName(format: 'jpeg' | 'png'): 'upload.jpg' | 'upload.png' {
  return format === 'jpeg' ? 'upload.jpg' : 'upload.png';
}

/**
 * Creates the 4 pending folders, the shared lock/log folders and the current mode's folders; never the other mode's.
 * With a shared root also its 設定 and トレンド語 folders.
 */
export async function ensureDirs(p: DataPaths): Promise<void> {
  const pending = POST_TYPES.flatMap((type) => AUDIENCE_CATEGORIES.map((audience) => join(p.pendingDir, type, audience)));
  const dirs = [
    ...pending,
    dirname(p.lockFile),
    p.logsDir,
    p.processingDir,
    p.failedDir,
    p.postedDir,
    p.jobsDir,
    p.schedulesDir,
    dirname(p.dedupeFile),
    dirname(p.controlFile),
    ...(p.sharedRoot === null ? [] : [p.instructionsDir, p.trendWorkbookDir]),
  ];
  for (const dir of new Set(dirs)) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      throw storageFailure(err, 'フォルダの作成', dir);
    }
  }
}
