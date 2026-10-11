import { crc32 } from 'node:zlib';
import { Inflate } from 'fflate';

// Minimal read-only ZIP access for OOXML packages: the central directory is read directly, and only the entries the
// caller asks for are decompressed. Sizes come from the central directory but are never trusted: inflating stops as
// soon as the output passes the declared size, and the CRC is checked afterwards.

/** Raised for anything wrong with the package; the message is Japanese and operator-facing. */
export class XlsxFormatError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'XlsxFormatError';
    this.details = details;
  }
}

export interface ZipLimits {
  /** Largest decompressed size of one entry. */
  maxEntryBytes: number;
  /** Largest decompressed size of all extracted entries together. */
  maxTotalBytes: number;
  /** Most entries the central directory may list. */
  maxEntries: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
// Small pushes bound the memory one push can produce (deflate expands at most ~1032x).
const INFLATE_CHUNK = 16 * 1024;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

class Reader {
  readonly #view: DataView;
  readonly length: number;

  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }

  need(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > this.length) {
      throw new XlsxFormatError('ZIPの構造が壊れています（途中で切れている可能性があります）', { offset });
    }
  }

  u16(o: number): number {
    this.need(o, 2);
    return this.#view.getUint16(o, true);
  }

  u32(o: number): number {
    this.need(o, 4);
    return this.#view.getUint32(o, true);
  }

  u64(o: number): number {
    this.need(o, 8);
    const v = this.#view.getBigUint64(o, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new XlsxFormatError('ZIPの構造が壊れています（サイズが不正です）');
    return Number(v);
  }
}

function findEndOfCentralDirectory(r: Reader): number {
  const lowest = Math.max(0, r.length - 22 - U16_MAX);
  for (let i = r.length - 22; i >= lowest; i--) {
    if (r.bytes[i] === 0x50 && r.u32(i) === SIG_EOCD && i + 22 + r.u16(i + 20) <= r.length) return i;
  }
  if (OLE_MAGIC.every((b, i) => r.bytes[i] === b)) {
    throw new XlsxFormatError('古い形式（.xls）か、パスワード付きのExcelファイルです。パスワードを外して .xlsx 形式で保存し直してください');
  }
  throw new XlsxFormatError('Excelの .xlsx 形式（ZIP）ではありません');
}

/** Lists the central directory. Throws XlsxFormatError for anything that is not a sound, unencrypted ZIP. */
export function listZipEntries(bytes: Uint8Array, limits: Pick<ZipLimits, 'maxEntries'>): ZipEntry[] {
  const r = new Reader(bytes);
  const eocd = findEndOfCentralDirectory(r);
  if (r.u16(eocd + 4) !== 0 || r.u16(eocd + 6) !== 0) throw new XlsxFormatError('分割されたZIPには対応していません');
  let count = r.u16(eocd + 10);
  let cdSize = r.u32(eocd + 12);
  let cdOffset = r.u32(eocd + 16);
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || r.u32(locator) !== SIG_EOCD64_LOCATOR) throw new XlsxFormatError('ZIPの構造が壊れています（ZIP64の情報がありません）');
    const eocd64 = r.u64(locator + 8);
    if (r.u32(eocd64) !== SIG_EOCD64) throw new XlsxFormatError('ZIPの構造が壊れています（ZIP64の情報が不正です）');
    count = r.u64(eocd64 + 32);
    cdSize = r.u64(eocd64 + 40);
    cdOffset = r.u64(eocd64 + 48);
  }
  if (count > limits.maxEntries) throw new XlsxFormatError(`ZIP内のファイル数が多すぎます（${count}個、上限 ${limits.maxEntries}個）`);
  r.need(cdOffset, cdSize);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (r.u32(p) !== SIG_CENTRAL) throw new XlsxFormatError('ZIPの構造が壊れています（目録が不正です）');
    const flags = r.u16(p + 8);
    const method = r.u16(p + 10);
    const crc = r.u32(p + 16);
    let compressedSize = r.u32(p + 20);
    let size = r.u32(p + 24);
    const nameLength = r.u16(p + 28);
    const extraLength = r.u16(p + 30);
    const commentLength = r.u16(p + 32);
    let localHeaderOffset = r.u32(p + 42);
    r.need(p + 46, nameLength + extraLength);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLength)).replace(/^\/+/, '');

    // ZIP64 extended information: the fields present are exactly the ones saturated above, in this order.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = r.u16(e);
      const len = r.u16(e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        if (size === U32_MAX) {
          size = r.u64(f);
          f += 8;
        }
        if (compressedSize === U32_MAX) {
          compressedSize = r.u64(f);
          f += 8;
        }
        if (localHeaderOffset === U32_MAX) localHeaderOffset = r.u64(f);
      }
      e += 4 + len;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) throw new XlsxFormatError(`ZIP内に同じ名前のファイルが複数あります: ${name}`);
    seen.add(key);
    entries.push({ name, method, flags, crc32: crc, compressedSize, size, localHeaderOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Tracks the decompressed bytes of one package against the total limit. */
export class ExtractBudget {
  #used = 0;

  constructor(readonly limits: Pick<ZipLimits, 'maxEntryBytes' | 'maxTotalBytes'>) {}

  reserve(entry: ZipEntry): void {
    if (entry.size > this.limits.maxEntryBytes) {
      throw new XlsxFormatError(`展開後のサイズが大きすぎる部品があります: ${entry.name}（${mb(entry.size)}、上限 ${mb(this.limits.maxEntryBytes)}）`, {
        entry: entry.name,
        size: entry.size,
      });
    }
    if (this.#used + entry.size > this.limits.maxTotalBytes) {
      throw new XlsxFormatError(`展開後のサイズの合計が大きすぎます（上限 ${mb(this.limits.maxTotalBytes)}）`, { entry: entry.name });
    }
    this.#used += entry.size;
  }
}

/** Decompresses one entry, never producing more than its declared size (already reserved in `budget`). */
export function extractZipEntry(bytes: Uint8Array, entry: ZipEntry, budget: ExtractBudget): Uint8Array {
  if (entry.flags & 0x1) throw new XlsxFormatError('暗号化されたZIPには対応していません');
  budget.reserve(entry);
  const r = new Reader(bytes);
  const local = entry.localHeaderOffset;
  if (r.u32(local) !== SIG_LOCAL) throw new XlsxFormatError(`ZIPの構造が壊れています: ${entry.name}`);
  const start = local + 30 + r.u16(local + 26) + r.u16(local + 28);
  r.need(start, entry.compressedSize);
  const data = bytes.subarray(start, start + entry.compressedSize);

  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new XlsxFormatError(`ZIPの構造が壊れています（サイズ不一致）: ${entry.name}`);
    out = data;
  } else if (entry.method === 8) {
    out = inflateBounded(data, entry);
  } else {
    throw new XlsxFormatError(`対応していない圧縮方式です（${entry.method}）: ${entry.name}`);
  }
  if (crc32(out) >>> 0 !== entry.crc32 >>> 0) throw new XlsxFormatError(`ZIP内のファイルが壊れています（CRC不一致）: ${entry.name}`);
  return out;
}

function inflateBounded(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  const overflow = new XlsxFormatError(`ZIP内のファイルの実際のサイズが記録と異なります: ${entry.name}`, { entry: entry.name, declared: entry.size });
  const inflater = new Inflate((chunk) => {
    produced += chunk.length;
    if (produced > entry.size) throw overflow;
    chunks.push(chunk);
  });
  try {
    if (data.length === 0) inflater.push(new Uint8Array(0), true);
    for (let o = 0; o < data.length; o += INFLATE_CHUNK) inflater.push(data.subarray(o, o + INFLATE_CHUNK), o + INFLATE_CHUNK >= data.length);
  } catch (err) {
    if (err instanceof XlsxFormatError) throw err;
    throw new XlsxFormatError(`ZIP内のファイルを展開できません（壊れている可能性があります）: ${entry.name}`, { entry: entry.name });
  }
  if (produced !== entry.size) throw overflow;
  const out = new Uint8Array(produced);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
