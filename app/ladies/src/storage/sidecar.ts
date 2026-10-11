import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import { errnoCode, withTransientRetry, type FsLike, type RetryOptions } from './atomic-json.js';

/** The optional per-image metadata in a job bundle (spec 6.2); intake carries the pending `<image>.json` here. */
export const SIDECAR_FILE = 'sidecar.json';
export const SIDECAR_NOTES_MAX = 500;
/** Far above any valid sidecar (notes are at most 500 characters); a larger file is refused unread. */
export const SIDECAR_MAX_BYTES = 16 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const codePoints = (s: string): number => [...s].length;

/**
 * Owner-written facts about one photo. `notes` is untrusted data: it reaches the AI only inside a delimited reference
 * block, never as instructions. `target_audience` is free text for the copy (e.g. 20代); one naming mens/ladies is
 * dropped by inspectSidecar, because the folder decides the audience.
 */
export const SidecarSchema = z.strictObject({
  category_hint: text(64).optional(),
  verified_menu_ids: z.array(text(64)).max(20).optional(),
  target_audience: text(50).optional(),
  notes: z
    .string()
    .refine((s) => codePoints(s) <= SIDECAR_NOTES_MAX, { error: `notes は${SIDECAR_NOTES_MAX}文字以内にしてください` })
    .optional(),
});
export type Sidecar = z.infer<typeof SidecarSchema>;

export interface SidecarIgnoredField {
  field: keyof Sidecar;
  /** Fixed Japanese wording; never the field's value. */
  reason: string;
}

/**
 * `reason` is fixed Japanese wording plus schema paths and codes: it never quotes the file's content (parser messages
 * can echo it), so it is safe for logs.
 */
export type SidecarRead =
  | { kind: 'absent' }
  | { kind: 'valid'; sidecar: Sidecar; ignored: readonly SidecarIgnoredField[] }
  | { kind: 'invalid'; reason: string };

export interface SidecarOptions {
  fs?: FsLike & Pick<typeof fsp, 'lstat'>;
  retry?: RetryOptions;
}

// After NFKC, lower case, without spaces and apostrophes ("Men's" → "mens").
const AUDIENCE_WORDS = ['mens', 'ladies', 'ladys', 'メンズ', 'レディース', 'レディス'] as const;
const namesAudience = (s: string): boolean => {
  const key = s.normalize('NFKC').toLowerCase().replace(/[\s'’`]/gu, '');
  return AUDIENCE_WORDS.some((w) => key.includes(w));
};

const ISSUE_JA: Record<string, string> = {
  unrecognized_keys: '知らない項目があります',
  invalid_type: '値の種類が違います',
  too_big: '長すぎるか多すぎます',
  too_small: '空です',
};

function schemaReason(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((i) => {
    const where = i.path.length === 0 ? '(全体)' : i.path.map(String).join('.');
    // Custom issues carry this module's own fixed messages; others are described by code only (no values, no keys).
    const what = i.code === 'custom' ? i.message : (ISSUE_JA[i.code] ?? i.code);
    return `${where}: ${what}`;
  });
  return `内容が規定の形式ではありません（${parts.join('、')}）`;
}

/**
 * Reads `sidecar.json` from a job bundle. Never throws for the file's sake: a missing file is `absent`, anything
 * unusable (bad JSON or schema, not UTF-8, too large, a folder or link, unreadable) is `invalid`, so a broken sidecar
 * can never block the photo. A `target_audience` naming an audience is dropped (listed in `ignored`); the other fields
 * stay usable.
 */
export async function inspectSidecar(bundleDirAbs: string, o: SidecarOptions = {}): Promise<SidecarRead> {
  const fs = o.fs ?? fsp;
  const retry = o.retry ?? {};
  const path = join(bundleDirAbs, SIDECAR_FILE);
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await withTransientRetry(() => fs.lstat(path), retry);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', reason: `ファイル情報を読めません（${errnoCode(err) ?? '不明なエラー'}）` };
  }
  if (!stat.isFile()) return { kind: 'invalid', reason: '通常のファイルではありません（フォルダやリンクは使えません）' };
  if (stat.size > SIDECAR_MAX_BYTES) return { kind: 'invalid', reason: `大きすぎます（${stat.size}バイト、上限${SIDECAR_MAX_BYTES}バイト）` };

  let bytes: Uint8Array;
  try {
    bytes = await withTransientRetry(() => fs.readFile(path), retry);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', reason: `読み込めません（${errnoCode(err) ?? '不明なエラー'}）` };
  }
  let json: unknown;
  try {
    // fatal: an ANSI-saved file is reported, not silently mangled; the decoder drops a leading BOM.
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    return { kind: 'invalid', reason: err instanceof SyntaxError ? 'JSONとして読み取れません' : 'UTF-8として読み取れません' };
  }
  const parsed = SidecarSchema.safeParse(json);
  if (!parsed.success) return { kind: 'invalid', reason: schemaReason(parsed.error) };

  const sidecar: Sidecar = { ...parsed.data };
  const ignored: SidecarIgnoredField[] = [];
  if (sidecar.target_audience !== undefined && namesAudience(sidecar.target_audience)) {
    delete sidecar.target_audience;
    ignored.push({ field: 'target_audience', reason: 'メンズ／レディースは画像を置いたフォルダで決まるため、target_audience では指定できません' });
  }
  return { kind: 'valid', sidecar, ignored };
}

/** Logs what made a sidecar unusable (SIDECAR_INVALID) or which fields were dropped (SIDECAR_FIELD_IGNORED). */
export function logSidecarProblems(logger: AppLogger | undefined, read: SidecarRead, jobId?: string): void {
  const fields = { stage: 'analyze', ...(jobId === undefined ? {} : { job_id: jobId }) };
  if (read.kind === 'invalid') {
    logger?.warn('SIDECAR_INVALID', `${SIDECAR_FILE} を使えないため、無いものとして続けます: ${read.reason}`, fields);
  } else if (read.kind === 'valid') {
    for (const i of read.ignored) {
      logger?.warn('SIDECAR_FIELD_IGNORED', `${SIDECAR_FILE} の ${i.field} を使いません: ${i.reason}`, { ...fields, field: i.field });
    }
  }
}

/** inspectSidecar for callers that only want the facts: problems are logged and an invalid sidecar counts as absent. */
export async function readSidecar(bundleDirAbs: string, o: SidecarOptions & { logger?: AppLogger; jobId?: string } = {}): Promise<Sidecar | null> {
  const r = await inspectSidecar(bundleDirAbs, o);
  logSidecarProblems(o.logger, r, o.jobId);
  return r.kind === 'valid' ? r.sidecar : null;
}
