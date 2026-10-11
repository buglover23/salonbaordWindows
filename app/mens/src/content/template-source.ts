import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Categories, TemplateMapping } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError, errorText, type AppError } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import { readJsonFile } from '../storage/atomic-json.js';
import { TemplateLibrary, importIssues, type TemplateLoadOptions } from './templates.js';

// The Excel reference library as the running tool holds it (spec 7.2): loaded at startup, and loaded again only when the
// mapping, the categories or the workbook file (size / modification time) change, so the workbook is read once per
// version. While it cannot be loaded and no last good import exists, generation is held (TEMPLATE_MISSING /
// TEMPLATE_PARSE_ERROR); a last good import keeps generation going with a warning in status.

const LAST_GOOD_FILE = 'last-good.json';

export interface TemplateStatus {
  /** The workbook's absolute path, or null when template_mapping.json names none. */
  file_path: string | null;
  /** Whether the workbook file exists now. */
  found: boolean;
  /** workbook: read from the file; last_good_cache: the last good import of the same file; null: none usable. */
  source: 'workbook' | 'last_good_cache' | null;
  /** When the import in use was made (ISO), null when unknown. */
  imported_at: string | null;
  /** Sheets and columns of that import that do not match the mapping (importIssues); null when unknown. */
  import_issues: number | null;
  /** Why the last good import is in use (TEMPLATE_MISSING / TEMPLATE_PARSE_ERROR); null otherwise. */
  warning: AppError | null;
  /** Why no template is usable (generation is held); null when one is. */
  problem: AppError | null;
}

export interface TemplateSourceDeps {
  mapping: () => TemplateMapping;
  categories: () => Categories;
  /** data/cache/templates. */
  cacheDir: string;
  /** The project root: a relative file_path is resolved against it. */
  baseDir: string;
  logger: AppLogger;
  clock: Clock;
  /** Replaces TemplateLibrary.load (tests). */
  load?: typeof TemplateLibrary.load;
  loadOptions?: Omit<TemplateLoadOptions, 'categories' | 'baseDir'>;
}

/** The workbook path a mapping names (absolute), or null. */
export function workbookPathOf(mapping: TemplateMapping, baseDir: string): string | null {
  return mapping.file_path === null ? null : resolve(baseDir, mapping.file_path);
}

async function fileStamp(path: string | null): Promise<string> {
  if (path === null) return 'none';
  try {
    const s = await stat(path);
    return s.isFile() ? `${s.size}:${s.mtimeMs}` : 'not-file';
  } catch {
    return 'missing';
  }
}

const LastGoodSchema = z.looseObject({ file_path: z.string(), workbook_sha256: z.string(), recorded_at: z.string(), import_issues: z.number().optional() });

/**
 * What can be said about the templates without loading the workbook (read-only `status`): the file is only stat'ed, and
 * the last good import is the pointer written by the last successful load of the same file. Never writes anything.
 */
export async function inspectTemplates(mapping: TemplateMapping, cacheDir: string, baseDir: string, clock: Clock): Promise<TemplateStatus> {
  const path = workbookPathOf(mapping, baseDir);
  const stamp = await fileStamp(path);
  const found = stamp !== 'none' && stamp !== 'missing' && stamp !== 'not-file';
  let lastGood: { recorded_at: string; import_issues?: number | undefined } | null = null;
  try {
    const r = await readJsonFile(join(cacheDir, LAST_GOOD_FILE), LastGoodSchema);
    const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (r.kind === 'ok' && path !== null && same(r.value.file_path, path)) lastGood = r.value;
  } catch {
    lastGood = null;
  }
  const missing = (message: string): AppError => appError('TEMPLATE_MISSING', 'templates', clock, { message });
  if (path === null) {
    return {
      file_path: null,
      found: false,
      source: null,
      imported_at: null,
      import_issues: null,
      warning: null,
      problem: missing('テンプレートのExcelファイルが設定されていません。template_mapping.json の file_path にファイルの場所を書いてください。'),
    };
  }
  const last = { imported_at: lastGood?.recorded_at ?? null, import_issues: lastGood?.import_issues ?? null };
  if (found) return { file_path: path, found, source: lastGood === null ? null : 'workbook', ...last, warning: null, problem: null };
  const notFound = missing(`テンプレートのExcelファイルが見つかりません: ${path}`);
  return lastGood === null
    ? { file_path: path, found, source: null, ...last, warning: null, problem: notFound }
    : { file_path: path, found, source: 'last_good_cache', ...last, warning: notFound, problem: null };
}

export class TemplateSource {
  readonly #d: TemplateSourceDeps;
  #library: TemplateLibrary | null = null;
  #problem: AppError | null = null;
  #key: string | null = null;
  #loadedAt: string | null = null;

  constructor(d: TemplateSourceDeps) {
    this.#d = d;
  }

  /** The library in use (null while none could be loaded). */
  get library(): TemplateLibrary | null {
    return this.#library;
  }

  /** Why generation is held for lack of templates; null when a library is in use. */
  get problem(): AppError | null {
    return this.#library === null ? this.#problem : null;
  }

  get status(): TemplateStatus {
    const lib = this.#library;
    return {
      file_path: lib?.report.file_path ?? workbookPathOf(this.#d.mapping(), this.#d.baseDir),
      found: lib?.source === 'workbook',
      source: lib?.source ?? null,
      imported_at: this.#loadedAt,
      import_issues: lib === null ? null : importIssues(lib.report),
      warning: lib?.warning ?? null,
      problem: this.problem,
    };
  }

  /**
   * Loads the library when the mapping, the categories or the workbook file changed since the last load (or nothing was
   * loaded yet). Never throws: a failure keeps the previous library (if any) and is reported by `problem` / `status`.
   */
  async refresh(): Promise<void> {
    const { mapping, categories, cacheDir, baseDir, logger, clock } = this.#d;
    const m = mapping();
    const c = categories();
    const path = workbookPathOf(m, baseDir);
    const key = sha256Hex(JSON.stringify([m, c, await fileStamp(path)]));
    if (key === this.#key) return;
    this.#key = key;
    try {
      const load = this.#d.load ?? TemplateLibrary.load.bind(TemplateLibrary);
      this.#library = await load(m, cacheDir, logger, clock, { ...this.#d.loadOptions, categories: c, baseDir });
      this.#problem = null;
      this.#loadedAt = clock.now().toISOString();
    } catch (err) {
      const error =
        err instanceof AppFailure
          ? err.error
          : appError('TEMPLATE_PARSE_ERROR', 'templates', clock, { message: `テンプレートを読み込めませんでした（想定外のエラー）: ${errorText(err).slice(0, 200)}` });
      this.#problem = error;
      // A library from an earlier load stays usable only while it was made from the same mapping; otherwise generation waits.
      if (this.#library !== null && this.#library.report.file_path !== path) this.#library = null;
      logger.warn('TEMPLATES_UNAVAILABLE', `${error.message}${this.#library === null ? ' 有効なテンプレートが無いため、文章の生成を保留します。' : ' 前に読み込んだ内容で続けます。'}`, {
        stage: 'templates',
        error_code: error.code,
      });
    }
  }
}
