import * as fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import type { PageProfile } from '../shared/protocol/profile.js';
import { errnoCode, storageFailure, writeFileAtomic } from '../storage/atomic-json.js';
import { uploadFileName } from '../storage/paths.js';
import { internalFailure } from '../storage/store-errors.js';

// Same process-wide libvips settings as image-inspect.ts and prepare-image.ts.
sharp.cache(false);
sharp.concurrency(1);

type ImageConstraints = PageProfile['image'];

export interface PreparedUpload {
  file_name: 'upload.jpg' | 'upload.png';
  mime: 'image/jpeg' | 'image/png';
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  constraints_hash: string;
}

/** Identifies the image constraints an upload was prepared for (job.upload.constraints_hash). */
export function constraintsHash(c: ImageConstraints): string {
  return sha256Hex(JSON.stringify([[...c.formats].sort(), c.max_bytes, c.max_width, c.max_height, c.min_width ?? null, c.min_height ?? null]));
}

const invalid = (message: string, path: string): AppFailure =>
  new AppFailure(appError('IMAGE_INVALID', 'upload', systemClock, { message, retryable: false, details: { path } }));

/**
 * D6: writes the image SALON BOARD gets, next to the bundle's source image, for the page's constraints: rotated by its EXIF
 * orientation, every metadata block (EXIF, GPS, ICC, XMP) stripped, fit inside max_width × max_height (never enlarged); JPEG
 * when the page takes it (quality 90 → 60 in steps of 10 until it fits max_bytes, transparency on white), else PNG. Named by
 * its real format (upload.jpg / upload.png, P1-D7); an upload of the other format is removed. The source is only read.
 * Too small for min_width/min_height or too large for max_bytes → IMAGE_INVALID (never retried).
 */
export async function prepareUploadImage(bundleDirAbs: string, sourceName: string, c: ImageConstraints): Promise<PreparedUpload> {
  if (sourceName === '' || basename(sourceName) !== sourceName || sourceName === '..' || sourceName.startsWith('upload.')) {
    throw internalFailure(systemClock, `投稿用の画像の元にできない名前です: ${sourceName}`, { source: sourceName });
  }
  const source = join(bundleDirAbs, sourceName);
  let input: Buffer;
  try {
    input = await fsp.readFile(source);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new AppFailure(appError('IMAGE_NOT_FOUND', 'upload', systemClock, { message: `投稿用の画像の元ファイルが見つかりません: ${source}`, details: { path: source } }));
    }
    throw storageFailure(err, '画像の読込', source);
  }

  const format = c.formats.includes('jpeg') ? 'jpeg' : 'png';
  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    const base = sharp(input, { failOn: 'error' }).autoOrient().resize({ width: c.max_width, height: c.max_height, fit: 'inside', withoutEnlargement: true });
    if (format === 'png') out = await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    else {
      out = await base.clone().flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
      for (let q = 80; q >= 60 && out.data.length > c.max_bytes; q -= 10) {
        out = await base.clone().flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: q }).toBuffer({ resolveWithObject: true });
      }
    }
  } catch (err) {
    throw invalid(`投稿用の画像を作れませんでした（画像として読み取れません: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}）: ${source}`, source);
  }
  const { width, height } = out.info;
  if (width < (c.min_width ?? 0) || height < (c.min_height ?? 0)) {
    throw invalid(`画像が小さすぎるため、投稿画面の条件（${c.min_width ?? '-'}×${c.min_height ?? '-'}ピクセル以上）を満たせません（${width}×${height}）: ${source}`, source);
  }
  if (out.data.length > c.max_bytes) {
    throw invalid(`画像を投稿画面の容量（${c.max_bytes}バイト）以下にできません: ${source}`, source);
  }

  const fileName = uploadFileName(format);
  await writeFileAtomic(join(bundleDirAbs, fileName), out.data);
  const other = join(bundleDirAbs, uploadFileName(format === 'jpeg' ? 'png' : 'jpeg'));
  await fsp.unlink(other).catch((err: unknown) => {
    if (errnoCode(err) !== 'ENOENT') throw storageFailure(err, '古い投稿用画像の削除', other);
  });
  return {
    file_name: fileName,
    mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    bytes: out.data.length,
    sha256: sha256Hex(out.data),
    width,
    height,
    constraints_hash: constraintsHash(c),
  };
}
