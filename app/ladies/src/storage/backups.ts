import { copyFile, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { jstDateKey } from '../shared/time.js';
import { storageFailure, writeJsonAtomic } from './atomic-json.js';
import type { DataPaths } from './paths.js';

// Spec 16.5 バックアップ: once a JST day, the mode's data JSON (dedupe.json, control.json, jobs/, schedules/) is copied to
// data/backups/<date>/. Never images, history.json (a full-text cache that can be rebuilt), evidence, surveys or the intent
// ledger (P3-R38: it must outlive any restore). A job past its retention period is not copied, and the cleanup removes a
// job's copies when it removes the job, so a backup never keeps an expired full text.

const DONE_FILE = 'backup-complete.json';
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const SUBDIRS = ['jobs', 'schedules'] as const;

const jsonNames = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();

async function copyIfThere(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw storageFailure(err, 'バックアップの作成', to);
  }
}

/** Today's backup; false when it already exists (complete). `skip(jobId)`: jobs not to copy (expired ones). */
export async function backupData(paths: DataPaths, now: Date, skip: (jobId: string) => boolean): Promise<boolean> {
  const dir = join(paths.backupsDir, jstDateKey(now));
  if ((await lstat(join(dir, DONE_FILE)).catch(() => null))?.isFile()) return false;
  for (const sub of SUBDIRS) await mkdir(join(dir, sub), { recursive: true });
  for (const file of [paths.dedupeFile, paths.controlFile]) await copyIfThere(file, join(dir, basename(file)));
  for (const name of await jsonNames(paths.jobsDir)) {
    if (!skip(name.slice(0, -'.json'.length))) await copyIfThere(join(paths.jobsDir, name), join(dir, 'jobs', name));
  }
  for (const name of await jsonNames(paths.schedulesDir)) await copyIfThere(join(paths.schedulesDir, name), join(dir, 'schedules', name));
  await writeJsonAtomic(join(dir, DONE_FILE), { created_at: now.toISOString() });
  return true;
}

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number };

async function entries(dir: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const st = await lstat(join(dir, name)).catch(() => null);
    if (st !== null) out.push({ name, kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', size: st.size });
  }
  return out;
}

/** The files of one backup (its own files and those of jobs/ and schedules/); null when it holds anything else. */
async function backupFiles(dir: string): Promise<{ path: string; size: number }[] | null> {
  const files: { path: string; size: number }[] = [];
  for (const e of await entries(dir)) {
    if (e.kind === 'file') files.push({ path: join(dir, e.name), size: e.size });
    else if (e.kind === 'dir' && (SUBDIRS as readonly string[]).includes(e.name)) {
      for (const f of await entries(join(dir, e.name))) {
        if (f.kind !== 'file') return null;
        files.push({ path: join(dir, e.name, f.name), size: f.size });
      }
    } else return null;
  }
  return files;
}

/**
 * Removes backups older than `retentionDays`, then the oldest while the total is over `maxBytes`; the newest one always
 * stays (`over`: still over the cap). Only the files a backup is made of are removed, never recursively: a backup that
 * holds anything else (a link, a junction, another folder) is left as it is and named in `kept_unexpected`.
 */
export async function pruneBackups(paths: DataPaths, now: Date, o: { retentionDays: number; maxBytes: number }): Promise<{ removed: number; total: number; over: boolean; kept_unexpected: string[] }> {
  const cutoff = jstDateKey(new Date(now.getTime() - o.retentionDays * 86_400_000));
  const backups: { name: string; files: { path: string; size: number }[] | null; size: number }[] = [];
  for (const e of await entries(paths.backupsDir)) {
    if (e.kind !== 'dir' || !DATE_DIR.test(e.name)) continue;
    const files = await backupFiles(join(paths.backupsDir, e.name));
    backups.push({ name: e.name, files, size: files?.reduce((n, f) => n + f.size, 0) ?? 0 });
  }
  backups.sort((a, b) => (a.name < b.name ? -1 : 1));
  let total = backups.reduce((n, b) => n + b.size, 0);
  let removed = 0;
  const kept: string[] = [];
  for (const b of backups.slice(0, -1)) {
    if (b.name >= cutoff && total <= o.maxBytes) continue;
    if (b.files === null) {
      kept.push(b.name);
      continue;
    }
    const dir = join(paths.backupsDir, b.name);
    for (const f of b.files) await unlink(f.path).catch(() => undefined);
    for (const sub of SUBDIRS) await rmdir(join(dir, sub)).catch(() => undefined);
    if (await rmdir(dir).then(() => true, () => false)) {
      total -= b.size;
      removed++;
    }
  }
  return { removed, total, over: total > o.maxBytes, kept_unexpected: kept };
}

/** Bytes of all backups (status display). */
export async function backupsBytes(paths: DataPaths): Promise<number> {
  let total = 0;
  for (const e of await entries(paths.backupsDir)) {
    if (e.kind === 'dir' && DATE_DIR.test(e.name)) total += (await backupFiles(join(paths.backupsDir, e.name)))?.reduce((n, f) => n + f.size, 0) ?? 0;
  }
  return total;
}
