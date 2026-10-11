import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodError, z } from 'zod';
import { validateScheduleCapacity } from '../execution/slots.js';
import type { AppLogger } from '../logger.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError, errorText } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../shared/types.js';
import { createFileExclusive } from '../storage/atomic-json.js';
import { resolveDataPaths } from '../storage/paths.js';
import { applyCountsOverride, countsFileName, parseCountsFile, renderCountsFile, type CountsFileState } from './counts-file.js';
import {
  CONFIG_FILES,
  SCHEMAS,
  type Categories,
  type ConfigKey,
  type DeploymentChecks,
  type Hashtags,
  type Keywords,
  type Salon,
  type SalonboardFields,
  type ScheduleConfig,
  type Settings,
  type TemplateMapping,
  type Trends,
  type WritingRules,
} from './schemas.js';

// Keys keep the snake_case of the files; the property names equal the CONFIG_FILES keys.
export interface ConfigSnapshot {
  settings: Settings;
  deploymentChecks: DeploymentChecks;
  salon: Salon;
  schedule: ScheduleConfig;
  keywords: Keywords;
  hashtags: Hashtags;
  trends: Trends;
  writingRules: WritingRules;
  categories: Categories;
  templateMapping: TemplateMapping;
  salonboardFields: SalonboardFields;
  hash: string;
  /**
   * The counts and coupons file of a copy that handles exactly one audience (settings.audiences): its values are already
   * in `schedule` and `salon` when applied. Absent when the copy handles both audiences.
   */
  countsFile?: CountsFileState;
}

export interface ConfigIssue {
  file: string;
  /** Dotted JSON path inside the file; '' for problems with the whole file. */
  path: string;
  /** Always Japanese (operator-facing). */
  message: string;
}

export type LoadResult = { ok: true; snapshot: ConfigSnapshot } | { ok: false; issues: ConfigIssue[] };

const CONFIG_KEYS = Object.keys(CONFIG_FILES) as ConfigKey[];

// ---------------------------------------------------------------- reading

type ReadOutcome = { ok: true; text: string } | { ok: false; issue: ConfigIssue; retryable: boolean };

async function readConfigText(dir: string, file: string): Promise<ReadOutcome> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, file));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, issue: { file, path: '', message: 'ファイルがありません' }, retryable: false };
    // Locked, permission or similar: the file may be fine a moment later, so the caller should look again.
    return { ok: false, issue: { file, path: '', message: `ファイルを読み込めません: ${code ?? (err instanceof Error ? err.message : String(err))}` }, retryable: true };
  }
  try {
    // A leading UTF-8 BOM (Notepad) is consumed by the decoder; invalid bytes (e.g. an ANSI-saved file) are rejected, not replaced.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, issue: { file, path: '', message: 'UTF-8として読み取れません（文字コードをUTF-8にして保存し直してください）' }, retryable: false };
  }
}

// ---------------------------------------------------------------- issue messages (R12: all Japanese)

type ZodIssue = ZodError['issues'][number];

// File-relative paths of the literal-fixed values (plan decision 3); a mismatch there is "fixed", not "invalid".
// Exported for tests.
export const FIXED_VALUE_PATHS: ReadonlySet<string> = new Set([
  'settings.json:timezone',
  'settings.json:server.host',
  'settings.json:queue.concurrency',
  'settings.json:retry.respect_post_window',
  'settings.json:retention.keep_dedupe_records',
  'schedule.json:timezone',
]);

function isFixedValuePath(file: string, path: string): boolean {
  return FIXED_VALUE_PATHS.has(`${file}:${path}`) || (file === 'salon.json' && path.startsWith('style_defaults.'));
}

// Hiragana, katakana or kanji (incl. extension A and half-width katakana).
const JAPANESE_TEXT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF66-\uFF9F]/;

/** The operator-facing (Japanese) text for one Zod issue. Exported for tests. */
export function describeIssue(file: string, path: string, issue: ZodIssue): string {
  // Refinements in schemas.ts carry Japanese text; one that does not (e.g. a forgotten message) must not leak English.
  if (issue.code === 'custom' && JAPANESE_TEXT.test(issue.message)) return issue.message;
  if (issue.code === 'invalid_value' && isFixedValuePath(file, path)) return 'この値は固定です（変更できません）';
  return `値が不正です: ${issue.message}`;
}

function zodIssues(file: string, error: ZodError): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return { file, path, message: describeIssue(file, path, issue) };
  });
}

// ---------------------------------------------------------------- loading

type Parsed = { [K in ConfigKey]?: z.infer<(typeof SCHEMAS)[K]> };

function assign<K extends ConfigKey>(target: Parsed, key: K, value: Parsed[K]): void {
  target[key] = value;
}

function isComplete(parsed: Parsed): parsed is Required<Parsed> {
  return CONFIG_KEYS.every((key) => parsed[key] !== undefined);
}

// The active snapshot is shared by every consumer for as long as it is the last good config, so nobody may change it.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function crossFileIssues(parsed: Parsed): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const { hashtags, categories, schedule, templateMapping } = parsed;
  // Skipped while no sheet is mapped yet (no workbook configured), so categories may name sheets in advance.
  if (categories && templateMapping && templateMapping.sheet_mappings.length > 0) {
    const known = new Set(templateMapping.sheet_mappings.map((m) => m.category));
    for (const list of ['style_categories', 'blog_categories'] as const) {
      categories[list].forEach((entry, i) => {
        entry.template_categories.forEach((tc, j) => {
          if (known.has(tc)) return;
          issues.push({
            file: 'categories.json',
            path: `${list}.${i}.template_categories.${j}`,
            message: `テンプレートの分類「${tc}」は template_mapping.json の category にありません（使える値: ${[...known].join(', ')}）`,
          });
        });
      });
    }
  }
  if (hashtags && categories) {
    const allowed = new Set<string>([...categories.style_categories, ...categories.blog_categories].map((c) => c.id));
    allowed.add('mens');
    allowed.add('ladies');
    for (const key of Object.keys(hashtags.by_category)) {
      if (allowed.has(key)) continue;
      issues.push({
        file: 'hashtags.json',
        path: `by_category.${key}`,
        message: `カテゴリー「${key}」は categories.json にありません（使えるキー: ${[...allowed].join(', ')}）`,
      });
    }
  }
  if (schedule) {
    for (const message of validateScheduleCapacity(schedule)) issues.push({ file: 'schedule.json', path: '', message });
  }
  if (parsed.salonboardFields) issues.push(...salonboardIssues(parsed.salonboardFields, categories));
  return issues;
}

// Plan 3 (§6.4): every origin a page profile names is an allowed origin, a route names an existing profile, and a
// treatment checkbox names categories of its post type.
function salonboardIssues(f: SalonboardFields, categories: Categories | undefined): ConfigIssue[] {
  const file = 'salonboard_fields.json';
  const issues: ConfigIssue[] = [];
  const allowed = new Set(f.allowed_origins);
  for (const [id, p] of Object.entries(f.pages)) {
    const s = p.success_signals;
    const confirm = p.submit.confirm;
    const origins: [string, string | undefined][] = [
      ['url_match.origin', p.url_match.origin],
      ['submit.confirm.url_match.origin', confirm.kind === 'confirm_page' ? confirm.url_match?.origin : undefined],
      ['success_signals.completion_url_match.origin', s.completion_url_match?.origin],
      ['success_signals.list.url', s.list === null ? undefined : (URL.parse(s.list.url)?.origin ?? '')],
      ['success_signals.list.url_match.origin', s.list?.url_match.origin],
      ['success_signals.detail.url_match.origin', s.detail?.url_match.origin],
      ['publish.url', p.publish === undefined ? undefined : (URL.parse(p.publish.url)?.origin ?? '')],
      ['publish.url_match.origin', p.publish?.url_match.origin],
      ['publish.done_url_match.origin', p.publish?.done_url_match.origin],
    ];
    for (const [path, origin] of origins) {
      if (origin === undefined || allowed.has(origin)) continue;
      const message =
        origin === '' ? 'URLとして読み取れません（https:// から始まる完全なURLを書いてください）' : `接続先 ${origin} は allowed_origins にありません（画面profileの接続先は allowed_origins のどれかにしてください）`;
      issues.push({ file, path: `pages.${id}.${path}`, message });
    }
    if (categories === undefined) continue;
    const known = new Set(categories[p.post_type === 'style' ? 'style_categories' : 'blog_categories'].map((c) => c.id));
    for (const [key, field] of Object.entries(p.fields)) {
      (field.confirmed_by ?? []).forEach((cat, i) => {
        if (!known.has(cat)) issues.push({ file, path: `pages.${id}.fields.${key}.confirmed_by.${i}`, message: `カテゴリー「${cat}」は categories.json にありません` });
      });
    }
  }
  for (const type of POST_TYPES) {
    for (const audience of AUDIENCE_CATEGORIES) {
      const id = f.posting_routes[type][audience].page_profile_id;
      if (id !== null && !Object.hasOwn(f.pages, id)) {
        issues.push({ file, path: `posting_routes.${type}.${audience}.page_profile_id`, message: `画面profile「${id}」が pages にありません` });
      }
    }
  }
  return issues;
}

interface LoadOutcome {
  result: LoadResult;
  /** True when a failure may be transient (read error other than "missing"), so the file should be looked at again. */
  retryable: boolean;
}

async function loadConfigDetailed(configDir: string, replace: Readonly<Record<string, string>> = {}): Promise<LoadOutcome> {
  const reads = await Promise.all(
    CONFIG_KEYS.map((key) => {
      const text = replace[CONFIG_FILES[key]];
      return text === undefined ? readConfigText(configDir, CONFIG_FILES[key]) : { ok: true as const, text };
    }),
  );
  const issues: ConfigIssue[] = [];
  const parsed: Parsed = {};
  const texts = new Map<string, string>();
  let retryable = false;

  CONFIG_KEYS.forEach((key, i) => {
    const file = CONFIG_FILES[key];
    const read = reads[i]!;
    if (!read.ok) {
      issues.push(read.issue);
      retryable ||= read.retryable;
      return;
    }
    texts.set(file, read.text);
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch (err) {
      issues.push({ file, path: '', message: `JSON構文エラー: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const result = SCHEMAS[key].safeParse(json);
    if (result.success) assign(parsed, key, result.data);
    else issues.push(...zodIssues(file, result.error));
  });

  issues.push(...crossFileIssues(parsed));
  // Every file that failed added an issue, so no issues means all 11 parsed (isComplete narrows the type).
  if (issues.length > 0 || !isComplete(parsed)) return { result: { ok: false, issues }, retryable };

  // The counts file never makes the config invalid: a bad one is reported and left out (the JSON values stay).
  const counts = await readCountsFile(configDir, parsed);
  if (counts !== null && counts.state.state === 'applied') {
    parsed.schedule = counts.schedule;
    parsed.salon = counts.salon;
  }

  // File name + BOM-stripped content, concatenated in name order.
  const hash = sha256Hex(
    Object.values(CONFIG_FILES)
      .sort()
      .map((file) => file + texts.get(file))
      .join('') + (counts === null ? '' : `|counts:${counts.state.state}:${counts.text}`),
  );
  const snapshot: ConfigSnapshot = deepFreeze({ ...parsed, hash, ...(counts === null ? {} : { countsFile: counts.state }) });
  // A locked or half-saved counts file is transient like a locked JSON file: the caller keeps its last good config.
  return { result: { ok: true, snapshot }, retryable: counts?.state.state === 'unreadable' };
}

/** The counts file of a one-audience copy: <instruction folder>/件数とクーポン（メンズ）.txt; null for a copy of both audiences. */
function countsFilePath(configDir: string, settings: Settings): string | null {
  const only = settings.audiences?.length === 1 ? settings.audiences[0]! : null;
  return only === null ? null : join(resolveDataPaths(dirname(configDir), settings).instructionsDir, countsFileName(only));
}

async function fileStamp(path: string | null): Promise<string> {
  if (path === null) return '';
  try {
    const s = await stat(path);
    return `|counts:${s.mtimeMs}:${s.size}`;
  } catch (err) {
    return `|counts:${(err as NodeJS.ErrnoException).code ?? 'ERROR'}`;
  }
}

async function readCountsFile(
  configDir: string,
  parsed: Required<Parsed>,
): Promise<{ state: CountsFileState; text: string; schedule: ScheduleConfig; salon: Salon } | null> {
  const path = countsFilePath(configDir, parsed.settings);
  if (path === null) return null;
  const json = { schedule: parsed.schedule, salon: parsed.salon };
  let bytes: Buffer;
  try {
    const before = await fileStamp(path);
    bytes = await readFile(path);
    // Read while the owner was saving (half a file): try again at the next check rather than use it.
    if (before !== (await fileStamp(path)) || !before.endsWith(`:${bytes.length}`)) throw Object.assign(new Error('saving'), { code: 'SAVING' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
    if (code === 'ENOENT') return { state: { path, state: 'missing', issues: [] }, text: '', ...json };
    return { state: { path, state: 'unreadable', issues: [`ファイルを読み込めません: ${code}`] }, text: '', ...json };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { state: { path, state: 'invalid', issues: ['UTF-8として読み取れません（文字コードをUTF-8にして保存し直してください）'] }, text: '', ...json };
  }
  const parsedFile = parseCountsFile(text, parsed.categories, parsed.settings.audiences![0]!);
  const applied = parsedFile.ok ? applyCountsOverride(parsedFile.value, parsed.schedule, parsed.salon) : parsedFile;
  if (!applied.ok) return { state: { path, state: 'invalid', issues: applied.issues }, text, ...json };
  return { state: { path, state: 'applied', issues: [] }, text, schedule: applied.schedule, salon: applied.salon };
}

/**
 * Reads and validates all 11 files, collecting every problem instead of stopping at the first. `replace` (file name →
 * text) validates that text in place of the file, so an edit can be checked against the whole config before it is written.
 */
export async function loadConfig(configDir: string, replace: Readonly<Record<string, string>> = {}): Promise<LoadResult> {
  return (await loadConfigDetailed(configDir, replace)).result;
}

// ---------------------------------------------------------------- ConfigManager (last-good snapshot)

// Detection by {mtimeMs, size} of the 11 files; a missing or unreadable file is part of the signature too.
async function statSignature(configDir: string): Promise<string> {
  const parts = await Promise.all(
    Object.values(CONFIG_FILES).map(async (file) => {
      try {
        const s = await stat(join(configDir, file));
        return `${file}:${s.mtimeMs}:${s.size}`;
      } catch (err) {
        return `${file}:${(err as NodeJS.ErrnoException).code ?? 'ERROR'}`;
      }
    }),
  );
  return parts.join('|');
}

export interface ReloadResult {
  /** The files differ from the last check (not necessarily in a way that changes the active config). */
  changed: boolean;
  /** A new snapshot is now active. */
  applied: boolean;
  /** Why the change was rejected; empty unless it was. */
  issues: ConfigIssue[];
}

export class ConfigManager {
  readonly #configDir: string;
  readonly #logger: AppLogger;
  #snapshot: ConfigSnapshot;
  #seen: string;
  #lastRejected: string | null = null;
  #rejectedIssues: ConfigIssue[] = [];
  #inFlight: Promise<ReloadResult> | null = null;
  #countsWarned: string | null = null;

  private constructor(configDir: string, logger: AppLogger, snapshot: ConfigSnapshot, seen: string) {
    this.#configDir = configDir;
    this.#logger = logger;
    this.#snapshot = snapshot;
    this.#seen = seen;
  }

  /**
   * The first load must succeed: an invalid initial config means the process does not start (spec 5.1).
   * `createCountsFile` (the running tool): in the shared layout, a one-audience copy whose counts file is missing creates
   * it once from the current JSON values (an exclusive create), so the owner finds the values to edit.
   */
  static async init(configDir: string, logger: AppLogger, o: { createCountsFile?: boolean } = {}): Promise<ConfigManager> {
    let seen = await statSignature(configDir); // before reading, so an edit made meanwhile is noticed
    let { result } = await loadConfigDetailed(configDir);
    if (!result.ok) {
      throw new AppFailure(appError('CONFIG_INVALID', 'config', systemClock, { details: { issues: result.issues } }));
    }
    const s = result.snapshot;
    const only = s.settings.audiences?.[0];
    if (o.createCountsFile === true && s.settings.shared_root !== null && s.countsFile?.state === 'missing' && only !== undefined) {
      await createFileExclusive(s.countsFile.path, renderCountsFile(only, s.schedule, s.salon, s.categories)).catch((err: unknown) =>
        logger.warn('COUNTS_FILE_CREATE_FAILED', `${countsFileName(only)} を作れませんでした（config の件数・クーポンで動きます）: ${errorText(err)}`, { stage: 'config' }),
      );
      const again = (await loadConfigDetailed(configDir)).result;
      if (again.ok) result = again;
    }
    seen += await fileStamp(result.snapshot.countsFile?.path ?? null);
    return new ConfigManager(configDir, logger, result.snapshot, seen);
  }

  /**
   * Logs a counts file that is not used (invalid or unreadable) once per distinct problem; the runtime calls it once its
   * log is attached, and every applied reload calls it again.
   */
  reportCountsFile(): void {
    const c = this.#snapshot.countsFile;
    const bad = c !== undefined && (c.state === 'invalid' || c.state === 'unreadable');
    const key = bad ? JSON.stringify(c) : null;
    if (key === this.#countsWarned) return;
    this.#countsWarned = key;
    if (!bad) return;
    this.#logger.warn('COUNTS_FILE_INVALID', `件数とクーポンのファイルに誤りがあるため使わず、config の件数・クーポンで続けます（直して保存すると反映します）: ${c.issues.join('／')}`, {
      stage: 'config',
      file: c.path,
      issues: c.issues,
    });
  }

  get current(): ConfigSnapshot {
    return this.#snapshot;
  }

  /**
   * Why the files on disk are not the active config: the issues of the latest rejected edit, kept until a later check
   * finds valid files (reloadIfChanged reports them only once). Empty when nothing is rejected. A copy.
   */
  get latestRejectedIssues(): ConfigIssue[] {
    return this.#rejectedIssues.map((issue) => ({ ...issue }));
  }

  /** Validates the whole config after a file change and swaps it in only if everything is valid; otherwise keeps the last good one. */
  reloadIfChanged(): Promise<ReloadResult> {
    this.#inFlight ??= this.#reload().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #reload(): Promise<ReloadResult> {
    const signature = (await statSignature(this.#configDir)) + (await fileStamp(this.#snapshot.countsFile?.path ?? null));
    if (signature === this.#seen) return { changed: false, applied: false, issues: [] };

    const { result, retryable } = await loadConfigDetailed(this.#configDir);
    // Remember rejected edits too so one broken file is not re-validated and re-logged on every check;
    // but not when the failure may be transient (e.g. a locked file), which must be looked at again.
    if (!retryable) this.#seen = signature;
    // Counts file unreadable for a moment: keep the last good counts (unless they were unreadable already) and retry.
    if (result.ok && retryable && this.#snapshot.countsFile?.state !== 'unreadable') return { changed: false, applied: false, issues: [] };

    if (!result.ok) {
      this.#rejectedIssues = result.issues;
      const key = JSON.stringify(result.issues);
      if (key !== this.#lastRejected) {
        this.#lastRejected = key;
        this.#logger.warn('CONFIG_RELOAD_REJECTED', '設定ファイルに誤りがあるため、変更を反映せず直前の正常な設定で続けます。', {
          stage: 'config',
          error_code: 'CONFIG_INVALID',
          issues: result.issues,
        });
      }
      return { changed: true, applied: false, issues: result.issues };
    }

    this.#lastRejected = null;
    this.#rejectedIssues = [];
    if (result.snapshot.hash === this.#snapshot.hash) return { changed: true, applied: false, issues: [] };

    const previousHash = this.#snapshot.hash;
    this.#snapshot = result.snapshot;
    this.reportCountsFile();
    this.#logger.info('CONFIG_RELOADED', '設定を再読み込みして反映しました。', {
      stage: 'config',
      config_hash: result.snapshot.hash,
      previous_config_hash: previousHash,
    });
    return { changed: true, applied: true, issues: [] };
  }
}
