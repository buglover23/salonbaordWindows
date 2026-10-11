import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { handledAudiences, type Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, ERROR_MESSAGES_JA, errorCodeOf, errorText } from '../shared/errors.js';
import { sha256File } from '../shared/hash.js';
import { makeNewJob, type Job } from '../shared/job-schema.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type Mode, type PostType } from '../shared/types.js';
import { errnoCode, storageFailure, unlinkWithRetry, withTransientRetry } from './atomic-json.js';
import { bundleRelDir, type BundleMover } from './bundles.js';
import type { DedupeStore } from './dedupe-store.js';
import { writeFailureFile } from './failure-file.js';
import { inspectImage as defaultInspect, type InspectResult } from './image-inspect.js';
import type { JobStore } from './job-store.js';
import type { DataPaths } from './paths.js';
import { SIDECAR_FILE, SIDECAR_MAX_BYTES } from './sidecar.js';

/** imported / failed hold job ids; the rest hold absolute file paths. */
export interface IntakeReport {
  imported: string[];
  failed: string[];
  duplicates: { file: string; existing_job_id: string }[];
  categoryRequired: string[];
  deferred: string[];
}

/** The fs/promises functions the scan calls itself; the real fs/promises satisfies it. */
export type IntakeFs = Pick<typeof fsp, 'stat' | 'opendir'>;

export interface ImageIntakeDeps {
  paths: DataPaths;
  store: JobStore;
  dedupe: DedupeStore;
  bundles: BundleMover;
  settings: () => Settings;
  salonId: string;
  mode: Mode;
  configHash: () => string;
  clock: Clock;
  logger: AppLogger;
  /** Replaces the SHA-256 reader (tests count calls or simulate a locked file). */
  hashFile?: (path: string) => Promise<string>;
  /** Replaces inspectImage (tests simulate a file that gets locked while it is being inspected). */
  inspect?: typeof defaultInspect;
  /** Replaces stat/opendir for the scan (tests simulate unreadable files and folders). */
  fs?: IntakeFs;
}

// Spec 6.1 / plan decision 8: same size and mtime on two observations at least this far apart means the copy has finished.
const STABLE_MS = 2000;
const MAX_FOLDER_DEPTH = 8;
// Windows reports a file held by antivirus, the indexer, OneDrive or a copy in progress as one of these.
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
const IGNORED_FILES: ReadonlySet<string> = new Set(['thumbs.db', 'desktop.ini']);
// Browsers and copy tools write under these names while a file is still arriving; the finished file gets its own name.
const PARTIAL_SUFFIXES: readonly string[] = ['.crdownload', '.part', '.partial', '.download', '.tmp'];
const INVALID_HINT = 'JPEGまたはPNGで保存し直して、もう一度pendingへ入れてください';
const LINK_MESSAGE = 'リンクやショートカットは取り込みません。画像ファイルそのものを入れてください';

/** What the intake remembers about one path, valid only while the file keeps the same size and mtime. */
interface Entry {
  size: number;
  mtimeMs: number;
  /** When this size/mtime was first observed (injected clock). */
  seenAt: number;
  sha256?: string;
  /** Nothing left to do for this exact file: reported as a duplicate, copied (dry-run), or stuck until restart recovery. */
  done: boolean;
  warnedCategory: boolean;
  lastErrorCode?: string;
}

type Observation = { kind: 'gone' } | { kind: 'busy' } | { kind: 'seen'; entry: Entry; stable: boolean };

interface Candidate {
  path: string;
  post_type: PostType;
  audience_category: AudienceCategory;
  /**
   * The photo's sidecar in pending (`<image name without extension>.json` next to it, spec 6.2): its path, 'ambiguous'
   * when several images share that name, or null.
   */
  sidecar: string | 'ambiguous' | null;
}

/** The job (or posted record) an image duplicates; originalName is known only for a job. */
interface Existing {
  id: string;
  originalName: string | null;
  /** The job failed because this image could not be read (IMAGE_INVALID). */
  unreadable?: boolean;
}

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const newEntry = (size: number, mtimeMs: number, seenAt: number): Entry => ({ size, mtimeMs, seenAt, done: false, warnedCategory: false });

function isIgnored(name: string): boolean {
  const n = name.toLowerCase();
  // *.json is reserved for the sidecar files (spec 6.2).
  return IGNORED_FILES.has(n) || n.startsWith('.') || n.startsWith('~$') || n.endsWith('.json') || PARTIAL_SUFFIXES.some((s) => n.endsWith(s));
}

/** A photo's sidecar: `<name>.json` (not hidden, not an Office lock file). */
const isSidecarName = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.endsWith('.json') && !n.startsWith('.') && !n.startsWith('~$') && n.length > '.json'.length;
};

/** The name without its last extension, compared case-insensitively (NTFS). */
const stemOf = (name: string): string => {
  const ext = extname(name);
  return (ext === '' ? name : name.slice(0, -ext.length)).toLowerCase();
};

/** Folder names are matched case-insensitively (NTFS); the path keeps the name as it is on disk. */
function matchFolder<T extends string>(names: readonly T[], actual: string): T | undefined {
  const lower = actual.toLowerCase();
  return names.find((n) => n === lower);
}

/** The folder's entries by name; a folder that is not there (any more) is empty. Other errors are thrown as they are. */
async function readFolder(fs: IntakeFs, dir: string): Promise<Dirent[]> {
  const out: Dirent[] = [];
  try {
    for await (const entry of await fs.opendir(dir)) out.push(entry);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  return out.sort((a, b) => compareNames(a.name, b.name));
}

/** The extension the file is stored under when it could not be read as an image. */
function storedExtension(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
}

/**
 * Scans the 4 pending folders, waits until a copy has finished, then turns each new image into a job and hands the file
 * to BundleMover (spec 6.1). Nothing is ever deleted: an image that is a duplicate, misplaced or locked stays in pending.
 *
 * Reports: `categoryRequired` and `deferred` describe the files as they are now (repeated every scan until fixed);
 * `imported`, `failed` and `duplicates` are events, reported once. A file already handled is remembered per
 * (path, size, mtime) and skipped on later scans without re-reading it (dry-run leaves the original in pending).
 * After a restart in dry-run, such an original (same name as its job's original_name) is logged at info, not reported.
 * Problems that are not about one image (an unreadable file or folder, a link) are logged once per path and code.
 */
export class ImageIntake {
  readonly #d: ImageIntakeDeps;
  readonly #hash: (path: string) => Promise<string>;
  readonly #inspect: typeof defaultInspect;
  readonly #fs: IntakeFs;
  readonly #entries = new Map<string, Entry>();
  /** Codes already logged per path; a path's codes are forgotten once a scan no longer meets the path. */
  readonly #notices = new Map<string, Set<string>>();
  /** Every path met by the scan in progress. */
  #met = new Set<string>();
  #inflight: Promise<IntakeReport> | null = null;

  constructor(d: ImageIntakeDeps) {
    this.#d = d;
    this.#hash = d.hashFile ?? sha256File;
    this.#inspect = d.inspect ?? defaultInspect;
    this.#fs = d.fs ?? fsp;
  }

  /** A call made while a scan is running gets that scan's report instead of starting a second one. */
  scanOnce(): Promise<IntakeReport> {
    if (this.#inflight !== null) return this.#inflight;
    const run = this.#scan().finally(() => {
      this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  async #scan(): Promise<IntakeReport> {
    const settings = this.#d.settings();
    const report: IntakeReport = { imported: [], failed: [], duplicates: [], categoryRequired: [], deferred: [] };
    this.#met = new Set();
    const { candidates, misplaced } = await this.#collect(handledAudiences(settings));

    for (const path of misplaced) await this.#checkMisplaced(path, report);

    let processed = 0;
    for (const c of candidates) {
      this.#met.add(c.path);
      const obs = await this.#observe(c.path);
      if (obs.kind === 'gone') continue;
      if (obs.kind === 'busy') {
        report.deferred.push(c.path);
        continue;
      }
      if (obs.entry.done) continue;
      // A sidecar still being written holds its photo back too, so the two arrive together.
      const sidecarReady = await this.#sidecarSettled(c);
      if (!obs.stable || !sidecarReady || processed >= settings.resources.intake_batch_size) {
        report.deferred.push(c.path);
        continue;
      }
      processed++;
      await this.#intake(c, obs.entry, settings, report);
    }

    // Forget files and problems that left pending (moved by a live import, or removed by the owner).
    for (const path of [...this.#entries.keys()]) if (!this.#met.has(path)) this.#entries.delete(path);
    for (const path of [...this.#notices.keys()]) if (!this.#met.has(path)) this.#notices.delete(path);
    return report;
  }

  async #checkMisplaced(path: string, report: IntakeReport): Promise<void> {
    this.#met.add(path);
    const obs = await this.#observe(path);
    if (obs.kind === 'gone') return;
    report.categoryRequired.push(path);
    if (obs.kind === 'seen' && !obs.entry.warnedCategory) {
      obs.entry.warnedCategory = true;
      this.#d.logger.warn('IMAGE_CATEGORY_REQUIRED', `置き場所が正しくないため取り込みません。${ERROR_MESSAGES_JA.IMAGE_CATEGORY_REQUIRED}（${path}）`, {
        stage: 'intake',
        error_code: 'IMAGE_CATEGORY_REQUIRED',
        file: path,
      });
    }
  }

  /**
   * Files directly inside the 4 folders become candidates; everything else under pending is only reported. The folders of
   * an audience this copy does not handle (settings.audiences) belong to the other copy: left alone, never even listed.
   */
  async #collect(handled: readonly AudienceCategory[]): Promise<{ candidates: Candidate[]; misplaced: string[] }> {
    const root = this.#d.paths.pendingDir;
    const candidates: Candidate[] = [];
    const misplaced: string[] = [];
    for (const top of await this.#listPending(root)) {
      const topPath = join(root, top.name);
      const topKind = this.#kindOf(top, topPath);
      if (topKind === 'file') misplaced.push(topPath);
      if (topKind !== 'dir') continue;
      const type = matchFolder(POST_TYPES, top.name);
      if (type === undefined) {
        await this.#collectFiles(topPath, misplaced, 1);
        continue;
      }
      for (const mid of await this.#listPending(topPath)) {
        const midPath = join(topPath, mid.name);
        const midKind = this.#kindOf(mid, midPath);
        if (midKind === 'file') misplaced.push(midPath);
        if (midKind !== 'dir') continue;
        const audience = matchFolder(AUDIENCE_CATEGORIES, mid.name);
        if (audience === undefined) {
          await this.#collectFiles(midPath, misplaced, 1);
          continue;
        }
        if (!handled.includes(audience)) continue;
        const sidecars = new Map<string, string>();
        const images: Candidate[] = [];
        for (const leaf of await this.#listPending(midPath)) {
          const leafPath = join(midPath, leaf.name);
          if (isSidecarName(leaf.name)) {
            if (leaf.isFile()) sidecars.set(stemOf(leaf.name), leafPath);
            continue;
          }
          const leafKind = this.#kindOf(leaf, leafPath);
          if (leafKind === 'file') images.push({ path: leafPath, post_type: type, audience_category: audience, sidecar: null });
          else if (leafKind === 'dir') await this.#collectFiles(leafPath, misplaced, 1);
        }
        for (const image of images) {
          const stem = stemOf(basename(image.path));
          const sidecar = sidecars.get(stem);
          if (sidecar === undefined) continue;
          const sharing = images.filter((other) => stemOf(basename(other.path)) === stem).length;
          image.sidecar = sharing > 1 ? 'ambiguous' : sidecar;
        }
        candidates.push(...images);
      }
    }
    const rank = (c: Candidate): number => POST_TYPES.indexOf(c.post_type) * AUDIENCE_CATEGORIES.length + AUDIENCE_CATEGORIES.indexOf(c.audience_category);
    candidates.sort((a, b) => rank(a) - rank(b) || compareNames(a.path, b.path));
    return { candidates, misplaced };
  }

  /** pending itself and the 4 category folders: a listing error stops this scan (the caller logs it). */
  async #listPending(dir: string): Promise<Dirent[]> {
    try {
      return await readFolder(this.#fs, dir);
    } catch (err) {
      throw storageFailure(err, 'pendingフォルダの読込', dir, { clock: this.#d.clock });
    }
  }

  /** Every file below `dir`, for reporting only. A folder that cannot be listed is logged once and skipped; nothing is touched. */
  async #collectFiles(dir: string, out: string[], depth: number): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH) return;
    this.#met.add(dir);
    let entries: Dirent[];
    try {
      entries = await readFolder(this.#fs, dir);
    } catch (err) {
      const code = errnoCode(err) ?? 'UNKNOWN';
      if (this.#firstNotice(dir, code)) {
        this.#d.logger.warn(
          'IMAGE_INTAKE_FAILED',
          `pending内のフォルダを読み取れないため、中のファイルを確認できません（${code}）。フォルダのアクセス権を確認してください: ${dir}`,
          { stage: 'intake', error_code: 'FILE_IO_ERROR', errno: code, folder: dir },
        );
      }
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      const kind = this.#kindOf(e, path);
      if (kind === 'file') out.push(path);
      else if (kind === 'dir') await this.#collectFiles(path, out, depth + 1);
    }
  }

  /** 'skip': an ignored name, or a link / junction / other non-regular entry (that is logged once per path). */
  #kindOf(e: Dirent, path: string): 'file' | 'dir' | 'skip' {
    if (isIgnored(e.name)) return 'skip';
    if (e.isFile()) return 'file';
    if (e.isDirectory()) return 'dir';
    if (this.#firstNotice(path, 'link')) {
      this.#d.logger.info('INTAKE_LINK_IGNORED', `${LINK_MESSAGE}: ${path}`, { stage: 'intake', file: path });
    }
    return 'skip';
  }

  /** true the first time `code` is met for `path` while the path stays in pending. */
  #firstNotice(path: string, code: string): boolean {
    this.#met.add(path);
    let codes = this.#notices.get(path);
    if (codes === undefined) {
      codes = new Set();
      this.#notices.set(path, codes);
    }
    if (codes.has(code)) return false;
    codes.add(code);
    return true;
  }

  #now(): number {
    return this.#d.clock.now().getTime();
  }

  /** Records what the file looks like now. `stable`: unchanged since an observation at least STABLE_MS ago. */
  async #observe(path: string): Promise<Observation> {
    let st: Stats;
    try {
      st = await this.#fs.stat(path);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'gone' };
      this.#noticeUnreadable(path, code ?? 'UNKNOWN');
      return { kind: 'busy' };
    }
    if (!st.isFile()) return { kind: 'gone' };
    // Each observation is stamped when it is made: a long scan must not make a file look older than it is.
    const now = this.#now();
    const known = this.#entries.get(path);
    if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) {
      // A clock set back must not make a file wait for the old time to come round again.
      if (now < known.seenAt) known.seenAt = now;
      return { kind: 'seen', entry: known, stable: now - known.seenAt >= STABLE_MS };
    }
    const entry = newEntry(st.size, st.mtimeMs, now);
    this.#entries.set(path, entry);
    return { kind: 'seen', entry, stable: false };
  }

  #noticeUnreadable(path: string, code: string): void {
    if (!this.#firstNotice(path, code)) return;
    this.#d.logger.warn(
      'IMAGE_INTAKE_FAILED',
      `ファイルの状態を確認できないため、取り込みを保留しています（${code}）。アクセス権や、ほかのアプリが使用中でないかを確認してください: ${path}`,
      { stage: 'intake', error_code: 'FILE_IO_ERROR', errno: code, file: path },
    );
  }

  async #intake(c: Candidate, entry: Entry, settings: Settings, report: IntakeReport): Promise<void> {
    const d = this.#d;
    try {
      // Hashed before the size limit is checked, on purpose: an oversize file still becomes a FAILED job, and JobSchema
      // requires its SHA-256. The entry keeps the hash, so the file is read once however many scans it takes.
      const sha256 = (entry.sha256 ??= await this.#hash(c.path));
      const existing = await this.#findExisting(c.post_type, sha256, settings);
      if (existing !== undefined) {
        entry.done = true;
        this.#reportExisting(c, existing, report);
        return;
      }

      const inspected = await this.#inspect(c.path, {
        maxBytes: settings.resources.max_input_file_mb * 1024 * 1024,
        maxPixels: settings.resources.max_input_pixels,
      });
      if (!(await this.#unchanged(c.path, entry))) {
        report.deferred.push(c.path);
        return;
      }

      const stored = await d.bundles.importFile(this.#newJob(c, entry, sha256, inspected), c.path, d.mode === 'live' ? 'move' : 'copy');
      // Live: the file has left pending, so a file dropped there again (even an identical one) is judged afresh.
      if (d.mode === 'live') this.#entries.delete(c.path);
      else entry.done = true;
      if (inspected.ok) {
        this.#reportImported(c, stored, report);
        await this.#carrySidecar(c, stored);
      } else {
        await this.#reportInvalid(c, stored, inspected.cause, report);
        this.#sidecarLeft(c, stored.id, '画像を取り込めなかったため');
      }
    } catch (err) {
      this.#onFailure(err, c, entry, report);
    }
  }

  /** The photo's sidecar is complete: absent, ambiguous (not carried), or unchanged for STABLE_MS. */
  async #sidecarSettled(c: Candidate): Promise<boolean> {
    if (c.sidecar === null) return true;
    if (c.sidecar === 'ambiguous') {
      if (this.#firstNotice(c.path, 'sidecar-ambiguous')) {
        this.#d.logger.warn(
          'SIDECAR_AMBIGUOUS',
          `同じ名前（拡張子違い）の画像が複数あるため、補足ファイル（.json）がどの画像のものか決められません。補足ファイルは使わずに取り込みます。画像の名前を変えて、それぞれに同じ名前の .json を置いてください: ${c.path}`,
          { stage: 'intake', file: c.path },
        );
      }
      return true;
    }
    this.#met.add(c.sidecar);
    const obs = await this.#observe(c.sidecar);
    if (obs.kind === 'gone') {
      c.sidecar = null;
      return true;
    }
    return obs.kind === 'seen' && obs.stable;
  }

  /**
   * Copies the photo's pending sidecar into its new bundle as sidecar.json (spec 6.2); live mode then removes the pending
   * one (the photo left pending too), dry-run leaves it like the photo. Never fails the import: a sidecar that cannot be
   * carried stays where it is and is logged (the photo is analyzed without it).
   */
  async #carrySidecar(c: Candidate, job: Job): Promise<void> {
    const source = c.sidecar;
    if (source === null || source === 'ambiguous') return;
    const { logger, paths, mode, clock } = this.#d;
    const fields = { stage: 'intake', job_id: job.id, file: source };
    try {
      const info = await withTransientRetry(() => fsp.lstat(source));
      if (!info.isFile()) {
        logger.warn('SIDECAR_NOT_CARRIED', `補足ファイルが通常のファイルではないため使いません（pending に残しています）: ${source}`, fields);
        return;
      }
      if (info.size > SIDECAR_MAX_BYTES) {
        logger.warn('SIDECAR_NOT_CARRIED', `補足ファイルが大きすぎるため使いません（${info.size}バイト、上限${SIDECAR_MAX_BYTES}バイト。pending に残しています）: ${source}`, fields);
        return;
      }
      const target = join(paths.modeRoot, ...bundleRelDir(job, clock).split('/'), SIDECAR_FILE);
      await withTransientRetry(() => fsp.copyFile(source, target, fsConstants.COPYFILE_EXCL));
      if (mode === 'live') {
        try {
          await unlinkWithRetry(source);
        } catch (err) {
          logger.warn('SIDECAR_LEFT_IN_PENDING', `補足ファイルを写真と一緒に取り込みましたが、pending から消せませんでした（${errnoCode(err) ?? '不明なエラー'}）。不要なので削除してください: ${source}`, fields);
        }
      }
      logger.info('SIDECAR_CARRIED', `補足ファイルを写真と一緒に取り込みました: ${source}`, { ...fields, mode });
    } catch (err) {
      logger.warn('SIDECAR_NOT_CARRIED', `補足ファイルを写真と一緒に取り込めませんでした（${errnoCode(err) ?? errorText(err)}）。写真は補足ファイル無しで処理します: ${source}`, fields);
    }
  }

  /** A photo that was not imported as a postable job leaves its sidecar in pending (logged once per photo). */
  #sidecarLeft(c: Candidate, jobId: string | null, why: string): void {
    if (c.sidecar === null || c.sidecar === 'ambiguous' || !this.#firstNotice(c.sidecar, 'sidecar-left')) return;
    this.#d.logger.warn('SIDECAR_LEFT_IN_PENDING', `${why}、補足ファイルは pending に残しています（不要なら削除してください）: ${c.sidecar}`, {
      stage: 'intake',
      file: c.sidecar,
      ...(jobId === null ? {} : { job_id: jobId }),
    });
  }

  /** The file must still be the one that was hashed and inspected when it is handed over; otherwise it is observed afresh. */
  async #unchanged(path: string, entry: Entry): Promise<boolean> {
    const current = await this.#fs.stat(path);
    if (current.size === entry.size && current.mtimeMs === entry.mtimeMs) return true;
    this.#entries.set(path, newEntry(current.size, current.mtimeMs, this.#now()));
    return false;
  }

  /** The new job, placed in its bundle: PENDING for a readable image, FAILED (IMAGE_INVALID) otherwise. */
  #newJob(c: Candidate, entry: Entry, sha256: string, inspected: InspectResult): Job {
    const d = this.#d;
    const originalName = basename(c.path);
    const base = makeNewJob({
      salon_id: d.salonId,
      post_type: c.post_type,
      audience_category: c.audience_category,
      image: {
        relative_path: 'unplaced',
        sha256,
        mime: inspected.ok ? inspected.mime : 'application/octet-stream',
        bytes: entry.size,
        width: inspected.ok ? inspected.width : null,
        height: inspected.ok ? inspected.height : null,
        original_name: originalName,
      },
      config_hash: d.configHash(),
      clock: d.clock,
    });
    const job: Job = inspected.ok
      ? base
      : {
          ...base,
          status: 'FAILED',
          stage: 'intake',
          // The message is the owner's (Japanese only); the image library's own text stays in the details.
          last_error: appError('IMAGE_INVALID', 'intake', d.clock, {
            message: `画像を取り込めませんでした。理由: ${inspected.reason}。${INVALID_HINT}。`,
            details: {
              reason: inspected.reason,
              original_name: originalName,
              ...(inspected.cause === undefined ? {} : { cause: inspected.cause }),
            },
          }),
        };
    const ext = inspected.ok ? (inspected.format === 'jpeg' ? 'jpg' : inspected.format) : storedExtension(originalName);
    return { ...job, image: { ...job.image, relative_path: `${bundleRelDir(job, d.clock)}/source.${ext}` } };
  }

  #reportExisting(c: Candidate, existing: Existing, report: IntakeReport): void {
    const { logger, mode } = this.#d;
    const fields = { stage: 'intake', post_type: c.post_type, audience_category: c.audience_category, existing_job_id: existing.id, file: c.path };
    // R30: dry-run copies, so after a restart its own originals are still in pending; that is not a duplicate drop.
    if (mode === 'dry_run' && existing.originalName === basename(c.path)) {
      if (existing.unreadable === true) {
        logger.info('INTAKE_ALREADY_FAILED', `読み取れなかった画像です（${existing.id}。理由は dry-run/images/failed の failure.json）。保存し直したら、この画像と差し替えてください: ${c.path}`, fields);
        return;
      }
      logger.info('INTAKE_ALREADY_IMPORTED', `取込済み（dry-run では元の画像を pending に残します）: ${c.path}`, fields);
      return;
    }
    report.duplicates.push({ file: c.path, existing_job_id: existing.id });
    logger.warn(
      'DUPLICATE_DETECTED',
      `同じ画像がすでに登録されているため、新しい投稿は作りません（既存のjob: ${existing.id}）。画像は元の場所に残しています: ${c.path}`,
      { ...fields, error_code: 'DUPLICATE_IMAGE' },
    );
    this.#sidecarLeft(c, null, '同じ画像がすでに登録されているため');
  }

  #reportImported(c: Candidate, stored: Job, report: IntakeReport): void {
    report.imported.push(stored.id);
    this.#d.logger.info('JOB_IMPORTED', `画像を取り込みました: ${c.path}`, {
      job_id: stored.id,
      stage: 'intake',
      post_type: c.post_type,
      audience_category: c.audience_category,
      file: c.path,
      original_name: stored.image.original_name,
      image_sha256: stored.image.sha256,
      width: stored.image.width,
      height: stored.image.height,
      mode: this.#d.mode,
    });
  }

  async #reportInvalid(c: Candidate, stored: Job, cause: string | undefined, report: IntakeReport): Promise<void> {
    const d = this.#d;
    report.failed.push(stored.id);
    d.logger.warn('IMAGE_INVALID', `${stored.last_error?.message ?? '画像を取り込めませんでした'}（${c.path}）`, {
      job_id: stored.id,
      stage: 'intake',
      post_type: c.post_type,
      audience_category: c.audience_category,
      error_code: 'IMAGE_INVALID',
      file: c.path,
      ...(cause === undefined ? {} : { cause }),
    });
    try {
      await writeFailureFile(d.paths, stored, d.clock);
    } catch (err) {
      // The FAILED job itself is already saved; failure.json is only a readable copy.
      const message = errorText(err);
      d.logger.error('FAILURE_FILE_FAILED', `failure.json を書けませんでした（jobは失敗として保存済みです）: ${message}`, {
        job_id: stored.id,
        stage: 'intake',
        error_code: errorCodeOf(err),
      });
    }
  }

  /** Locked → try again next scan; vanished → forget; anything else is logged once and the file stays where it is. */
  #onFailure(err: unknown, c: Candidate, entry: Entry, report: IntakeReport): void {
    const d = this.#d;
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR' || (err instanceof AppFailure && err.error.code === 'IMAGE_NOT_FOUND')) {
      this.#entries.delete(c.path);
      return;
    }
    report.deferred.push(c.path);
    if (code !== undefined && TRANSIENT_CODES.has(code)) return;

    const failure =
      err instanceof AppFailure
        ? err.error
        : appError('INTERNAL_ERROR', 'intake', d.clock, { message: `画像の取り込み中に想定外のエラーが発生しました: ${String(err)}` });
    if (entry.lastErrorCode !== failure.code) {
      entry.lastErrorCode = failure.code;
      d.logger.error('IMAGE_INTAKE_FAILED', `画像を取り込めませんでした（元のファイルは移動していません）: ${c.path}。${failure.message}`, {
        stage: 'intake',
        post_type: c.post_type,
        audience_category: c.audience_category,
        error_code: failure.code,
        file: c.path,
      });
    }
    // A job whose transfer was cut short already exists with its operation; importing again would make a second one.
    // It is finished by the startup recovery, so this file is left alone until then.
    const sha256 = entry.sha256;
    if (sha256 !== undefined && d.store.summaries((s) => s.has_operation && s.post_type === c.post_type && s.image_sha256 === sha256).length > 0) {
      entry.done = true;
    }
  }

  /**
   * The job (or posted record) of this salon that this image duplicates, per plan decision 6 and the spec 6.1 key
   * (image hash, post type, salon). Summaries carry no salon, so a job is read in full only when its hash matches.
   */
  async #findExisting(type: PostType, sha256: string, settings: Settings): Promise<Existing | undefined> {
    const { store, dedupe, salonId } = this.#d;
    const types = settings.duplicates.allow_same_image_across_types ? [type] : [type, ...POST_TYPES.filter((t) => t !== type)];
    for (const t of types) {
      for (const s of store.summaries((x) => x.post_type === t && x.image_sha256 === sha256)) {
        const job = await store.get(s.id);
        if (job !== null && job.salon_id === salonId) {
          return { id: job.id, originalName: job.image.original_name, unreadable: job.status === 'FAILED' && job.last_error?.code === 'IMAGE_INVALID' };
        }
      }
      const record = dedupe.findByImage(t, sha256, salonId);
      if (record !== undefined) return { id: record.job_id, originalName: null };
    }
    return undefined;
  }
}
