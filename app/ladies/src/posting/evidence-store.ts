import { join, relative, sep } from 'node:path';
import { systemClock } from '../shared/clock.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import type { DataPaths } from '../storage/paths.js';
import { internalFailure } from '../storage/store-errors.js';

/** Ids become folder names: plain names only (no separators, no '..'). */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export type EvidenceName = 'result' | `reconcile-${number}` | 'operator-reconcile';

/**
 * Saves the screen evidence of an attempt as `<modeRoot>/data/evidence/<job>/<attempt>/<name>.json` (P3-R44: not under logs/,
 * so log rotation never removes it) and returns the reference stored in the attempt (relative to modeRoot, '/' separated).
 * The evidence holds only the own post's fields (≤ 4 KiB, validated by the protocol), never page HTML or secrets.
 */
export async function writeEvidence(paths: DataPaths, jobId: string, attemptId: string, name: EvidenceName, data: unknown): Promise<string> {
  if (!SAFE_SEGMENT.test(jobId) || !SAFE_SEGMENT.test(attemptId) || !SAFE_SEGMENT.test(name)) {
    throw internalFailure(systemClock, '証跡の保存先に使えない名前です', { job_id: jobId, attempt_id: attemptId, name });
  }
  const file = join(paths.evidenceDir, jobId, attemptId, `${name}.json`);
  await writeJsonAtomic(file, data);
  return relative(paths.modeRoot, file).split(sep).join('/');
}
