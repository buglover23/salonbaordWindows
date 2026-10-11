import { open as openFile, stat } from 'node:fs/promises';
import sharp from 'sharp';

// Process-wide libvips settings (spec 16.6). With the cache on, libvips can keep a decoded file open, which on Windows
// would make a later rename of the same folder fail; single-threaded keeps memory predictable on the owner's PC.
sharp.cache(false);
sharp.concurrency(1);

const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
export type InputFormat = keyof typeof MIME_BY_FORMAT;

export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
}

export type InspectResult =
  | { ok: true; format: InputFormat; mime: string; width: number; height: number; bytes: number }
  /** `reason` is Japanese for the owner; `cause` is the image library's own (English) text, for details only. */
  | { ok: false; reason: string; cause?: string };

/** The one fs call the readability probe makes; tests replace it to simulate a locked file. */
export interface InspectDeps {
  open?: typeof openFile;
}

const isInputFormat = (f: string | undefined): f is InputFormat => f !== undefined && Object.hasOwn(MIME_BY_FORMAT, f);

const mbText = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;

const UNREADABLE_JA = '画像として読み取れません（壊れているか、対応していない形式です）';
const UNDECODABLE_JA = '画像の中身を読み取れません（途中で切れているか、壊れています）';

/** First line of a library error, short enough for a log line. */
function briefly(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * Called after sharp failed. sharp reports a file that another process (OneDrive, antivirus) holds exclusively exactly
 * like a file that is not an image ("unsupported image format", no errno), so the file is opened and one byte is read:
 * if that fails, the failure is the file system's (EBUSY, EPERM, EACCES, ENOENT, ...) and is thrown for the caller to
 * retry later instead of being blamed on the image.
 */
async function assertReadable(absPath: string, open: typeof openFile): Promise<void> {
  const handle = await open(absPath, 'r');
  try {
    await handle.read(Buffer.alloc(1), 0, 1, 0);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Judges from the file's bytes (never its name) whether it is a jpeg/png/webp that can really be decoded within the
 * size limits. The size limit is checked before the file is opened, the pixel limit from the header before any decode.
 * An unreadable image is `{ ok: false }`; a file that cannot be opened at all (locked, vanished) throws, because that is
 * a problem with the file system, not with the image.
 */
export async function inspectImage(absPath: string, limits: ImageLimits, deps: InspectDeps = {}): Promise<InspectResult> {
  const open = deps.open ?? openFile;
  const bytes = (await stat(absPath)).size;
  if (bytes > limits.maxBytes) {
    return { ok: false, reason: `ファイルサイズが上限（${mbText(limits.maxBytes)}）を超えています（${mbText(bytes)}）` };
  }

  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    // Header only, so no pixel limit here: the limit is applied below with a clear message, before anything is decoded.
    const meta = await sharp(absPath, { limitInputPixels: false, failOn: 'error' }).metadata();
    ({ format, width, height } = meta);
  } catch (err) {
    await assertReadable(absPath, open);
    return { ok: false, reason: UNREADABLE_JA, cause: briefly(err) };
  }
  if (!isInputFormat(format)) {
    return { ok: false, reason: `この形式（${format ?? '不明'}）には対応していません。JPEG・PNG・WebPのみ取り込めます` };
  }
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    return { ok: false, reason: '画像の大きさを読み取れません' };
  }
  if (width * height > limits.maxPixels) {
    return { ok: false, reason: `画像が大きすぎます（${width}×${height}、上限は${limits.maxPixels}画素）` };
  }

  try {
    // A real (downscaled) decode: the header can be valid while the pixel data is not.
    await sharp(absPath, { limitInputPixels: limits.maxPixels, failOn: 'error' }).resize(32).toBuffer();
  } catch (err) {
    await assertReadable(absPath, open);
    return { ok: false, reason: UNDECODABLE_JA, cause: briefly(err) };
  }
  return { ok: true, format, mime: MIME_BY_FORMAT[format], width, height, bytes };
}
