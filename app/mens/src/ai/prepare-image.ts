import * as fsp from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { errnoCode, storageFailure, withTransientRetry, writeFileAtomic, type FsLike, type RetryOptions } from '../storage/atomic-json.js';

// Same process-wide libvips settings as image-inspect.ts (no cached file handles on Windows, predictable memory).
sharp.cache(false);
sharp.concurrency(1);

/** Plan 2 decision 4: the only image ever sent to the AI. */
export const AI_IMAGE_NAME = 'ai.jpg';
export const AI_IMAGE_MAX_EDGE = 1568;
export const AI_IMAGE_QUALITY = 85;

export interface PreparedAiImage {
  /** Absolute path of ai.jpg. */
  path: string;
  /** The file's bytes as base64 (no data: prefix), ready for an image content block. */
  data: string;
  width: number;
  height: number;
  bytes: number;
}

export interface PrepareAiImageOptions {
  /** Refuse to decode larger sources (settings.resources.max_input_pixels); sharp's own limit otherwise. */
  maxInputPixels?: number;
  fs?: FsLike;
  retry?: RetryOptions;
  clock?: Clock;
}

/** First line of a library error, short enough for an operator message. */
function briefly(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * When the file last changed. With `includeChange`, a replacement counts too (ctime): a photo copied over the source keeps
 * its old modification time, but its change time is new.
 */
async function changedAt(path: string, includeChange: boolean): Promise<number | null> {
  try {
    const s = await fsp.stat(path);
    return includeChange ? Math.max(s.mtimeMs, s.ctimeMs) : s.mtimeMs;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw storageFailure(err, 'ファイル情報の読込', path);
  }
}

/** An existing ai.jpg is reused only while it is a readable JPEG within the size limit and carries no EXIF. */
async function reusable(path: string, fs: FsLike, retry: RetryOptions): Promise<PreparedAiImage | null> {
  let bytes: Buffer;
  try {
    bytes = await withTransientRetry(() => fs.readFile(path), retry);
  } catch {
    return null;
  }
  try {
    const meta = await sharp(bytes, { failOn: 'error' }).metadata();
    const { width, height } = meta;
    if (meta.format !== 'jpeg' || width === undefined || height === undefined || meta.exif !== undefined) return null;
    if (Math.max(width, height) > AI_IMAGE_MAX_EDGE) return null;
    return { path, data: bytes.toString('base64'), width, height, bytes: bytes.length };
  } catch {
    return null;
  }
}

/**
 * Writes `ai.jpg` next to the bundle's source image and returns it (Plan 2 decision 4, spec 17): rotated by its EXIF
 * orientation first, long edge at most 1568 px (never enlarged), transparency flattened onto white, sRGB, JPEG quality 85,
 * with all metadata (EXIF, GPS, ICC, XMP) stripped. An ai.jpg written after the source was last modified or replaced is
 * reused. The source is only read.
 * - `sourceRel` is relative to `bundleDirAbs` and must stay inside it (anything else is a caller bug: INTERNAL_ERROR).
 * - Missing source → IMAGE_NOT_FOUND; undecodable → IMAGE_INVALID; write failures → FILE_IO_ERROR / DISK_FULL.
 */
export async function prepareAiImage(bundleDirAbs: string, sourceRel: string, o: PrepareAiImageOptions = {}): Promise<PreparedAiImage> {
  const clock = o.clock ?? systemClock;
  const fs = o.fs ?? fsp;
  const retry = o.retry ?? {};
  const bundle = resolve(bundleDirAbs);
  const source = resolve(bundle, sourceRel);
  const inside = relative(bundle, source);
  if (sourceRel === '' || isAbsolute(sourceRel) || inside === '' || inside.startsWith('..') || isAbsolute(inside) || basename(source).toLowerCase() === AI_IMAGE_NAME) {
    throw new AppFailure(
      appError('INTERNAL_ERROR', 'ai', clock, {
        message: `AI用の画像の元にできないパスが渡されました（bundle の中の元画像を指定してください）: ${sourceRel}`,
        details: { bundle, source_rel: sourceRel },
      }),
    );
  }
  const target = join(dirname(source), AI_IMAGE_NAME);

  const sourceTime = await changedAt(source, true);
  if (sourceTime === null) {
    throw new AppFailure(appError('IMAGE_NOT_FOUND', 'ai', clock, { message: `AIに送る画像の元ファイルが見つかりません: ${source}`, details: { path: source } }));
  }
  const targetTime = await changedAt(target, false);
  if (targetTime !== null && targetTime > sourceTime) {
    const existing = await reusable(target, fs, retry);
    if (existing !== null) return existing;
  }

  let input: Buffer;
  try {
    // Read into memory first: a locked or vanished file is then a file-system error, never blamed on the image.
    input = await withTransientRetry(() => fs.readFile(source), retry);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new AppFailure(appError('IMAGE_NOT_FOUND', 'ai', clock, { message: `AIに送る画像の元ファイルが見つかりません: ${source}`, details: { path: source } }));
    }
    throw storageFailure(err, '画像の読込', source, { clock });
  }

  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    out = await sharp(input, { failOn: 'error', ...(o.maxInputPixels === undefined ? {} : { limitInputPixels: o.maxInputPixels }) })
      .autoOrient()
      .resize({ width: AI_IMAGE_MAX_EDGE, height: AI_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: AI_IMAGE_QUALITY })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new AppFailure(
      appError('IMAGE_INVALID', 'ai', clock, {
        message: `AIに送る画像を作れませんでした（画像として読み取れません: ${briefly(err)}）: ${source}`,
        retryable: false,
        details: { path: source },
      }),
    );
  }
  await writeFileAtomic(target, out.data, fs, retry);
  return { path: target, data: out.data.toString('base64'), width: out.info.width, height: out.info.height, bytes: out.data.length };
}
