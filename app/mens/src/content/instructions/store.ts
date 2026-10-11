import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConfigSnapshot } from '../../config/loader.js';
import type { AppLogger } from '../../logger.js';
import type { UrlPolicy } from '../../shared/url-policy.js';
import { systemClock } from '../../shared/clock.js';
import { AppFailure, appError, errorCodeOf, errorText } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import { formatJst, jstToUtc } from '../../shared/time.js';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../../shared/types.js';
import { isoUtc } from '../../shared/zod-helpers.js';
import { errnoCode, readJsonFile, storageFailure, withTransientRetry, writeJsonAtomic } from '../../storage/atomic-json.js';
import type { SerialQueue } from '../../storage/serial-queue.js';
import {
  allowedOriginSet,
  canonical,
  checkRouteUrl,
  effectiveHash,
  hasUnit,
  mergeInstructions,
  periodState,
  selectUnits,
  sortItems,
  unitsOfItem,
  type AppliedRef,
  type EffectiveOverlay,
  type InstructionUnit,
  type MergeResult,
} from './merge.js';
import {
  CACHE_IGNORED_CODE,
  CAPACITY_REDUCED_CODE,
  decodeInstructionBytes,
  IGNORED_CONTENT_CODE,
  INSTRUCTION_SECTIONS,
  isRealDate,
  MAX_INSTRUCTION_FILE_BYTES,
  parseInstructionFile,
  type InstructionIssue,
  type InstructionPeriod,
  type InstructionScope,
  type ParsedInstruction,
} from './parse.js';

// Spec 5.10: only regular .md files directly inside instructions/ are candidates; README.md and *.example.md never are.
// The folder is only ever read. A file is used once its size and mtime have stayed the same for STABLE_MS.
//
// Ruling P2-R2 (spec A39): each file's last content that applied without problems is kept (and persisted in the record
// file). While the current content is invalid, or an edited file conflicts or has an invalid item, that last valid
// content keeps applying for the affected items. Revocation stays immediate: deleting the file, setting 状態: 無効
// (a valid edit) or the end of the last valid content's period removes its effect.

const STABLE_MS = 2000;
// Each round falls back at least one more (file, unit) pair, so the loop ends well before this.
const MAX_FALLBACK_ROUNDS = 50;
// Future period starts checked for conflicts per scan (instruction folders hold a handful of files).
const MAX_FUTURE_STARTS = 64;
export const LAST_VALID_NOTE = '前回の正しい内容で動作中';

export type InstructionFileState = 'active' | 'upcoming' | 'expired' | 'disabled' | 'invalid' | 'pending' | 'unreadable';

export interface LastValid {
  sha256: string;
  parsed: ParsedInstruction;
  /** When this content was first found valid (ISO UTC). */
  valid_at: string;
}

export interface InstructionFileRecord {
  name: string;
  /** sha256 of the file bytes read last; null while nothing has been read yet. */
  sha256: string | null;
  state: InstructionFileState;
  /** The file is changing (or could not be read just now): the last stable content, if any, is used until it settles. */
  pending: boolean;
  /** null unless the current content is enabled and valid. */
  priority: number | null;
  scope: InstructionScope | null;
  period: InstructionPeriod | null;
  /** Everything this file contributes now, from the current and/or the last valid content. */
  applied_items: string[];
  /** Set while the last valid content stands in for the current one (wholly or for some items). */
  last_valid_in_use: { sha256: string; valid_at: string; items: string[] } | null;
  /** Every issue and ignored-content warning that names this file. */
  issues: InstructionIssue[];
}

/** data/instructions.json */
export interface InstructionRecord {
  schema_version: 1;
  scanned_at: string;
  files: InstructionFileRecord[];
  effective: EffectiveOverlay;
  effective_hash: string;
  issues: InstructionIssue[];
  ignored: InstructionIssue[];
  /** Per file name: the last content that applied without problems; read back after a restart. */
  last_valid: Record<string, LastValid>;
}

export interface InstructionScanResult {
  /**
   * The record differs from the previous scan, or on the first scan of this manager from data/instructions.json (it was
   * written to disk unless the manager is read-only).
   */
  changed: boolean;
  /** effective_hash differs from the previous scan's (first scan: from the recorded one, or from "no instructions"). */
  effective_changed: boolean;
  /** When this scan ran (ISO UTC). */
  scanned_at: string;
  overlay: EffectiveOverlay;
  effective_hash: string;
  issues: InstructionIssue[];
  ignored: InstructionIssue[];
  /** One entry per document version that contributed (a file may appear twice: current and last valid content). */
  applied: AppliedRef[];
  files: InstructionFileRecord[];
  /** Files still being written (or briefly unreadable); scan again soon to pick them up. */
  pending: string[];
}

/**
 * Extra checks run on the final merge: slot capacity on the effective schedule (Rulings P2-R11, P2-R14). Each issue names an
 * item the merge applied and describes how it applies (its note). The items always stay applied (Ruling P2-R14: never
 * invalid, never a fallback, whether the file is new, edited or unchanged): the issues only report them and never keep a
 * file from being saved.
 */
export type InstructionValidator = (base: ConfigSnapshot, docs: readonly ParsedInstruction[], merged: MergeResult) => InstructionIssue[];

export interface InstructionManagerDeps {
  /** <projectRoot>/instructions */
  dir: string;
  /** data/instructions.json */
  recordFile: string;
  config: () => ConfigSnapshot;
  logger: AppLogger;
  /** The shared write queue (spec 11.4-1): the record file is written through it when given. */
  queue?: SerialQueue;
  /** Never writes the record file (the read-only status command); its last valid contents are still used. */
  readOnly?: boolean;
  validate?: InstructionValidator;
  /** Replaces the file reader (tests count reads or change a file while it is read). */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Which origins route URLs may use; production when omitted (tests inject theirs through startRuntime, P3-R30). */
  urlPolicy?: UrlPolicy;
}

/** The content of one file that passed the stability check. */
type Accepted = { sha256: string | null; parsed: ParsedInstruction } | { sha256: string | null; invalid: InstructionIssue[] };

interface Entry {
  size: number;
  mtimeMs: number;
  /** When this size/mtime was first observed (injected time). */
  seenAt: number;
  accepted?: Accepted;
}

type Observation = { kind: 'gone' } | { kind: 'pending' } | { kind: 'unreadable'; code: string } | { kind: 'accepted'; accepted: Accepted };

/** One file as seen in this scan. */
interface Source {
  name: string;
  accepted: Accepted | null;
  pending: boolean;
  unreadable: string | null;
  /** The current content when it parsed; null when it is invalid or not read yet. */
  current: ParsedInstruction | null;
  last: LastValid | null;
  /** The current content parsed and differs from the last valid one (or there is none). */
  changed: boolean;
}

// ---------------------------------------------------------------- persisted last-valid cache

const lineNo = z.number().int().positive();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateKey = z.string().refine(isRealDate);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const IssueSchema = z.strictObject({
  code: z.enum(['INSTRUCTION_INVALID', 'INSTRUCTION_CONFLICT', IGNORED_CONTENT_CODE, CACHE_IGNORED_CODE]),
  file: z.string(),
  line: lineNo.nullable(),
  item: z.string().nullable(),
  message: z.string(),
  note: z.string().nullable(),
  related_files: z.array(z.string()),
});

const BusinessHoursSchema = z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.strictObject({ ranges: z.array(z.strictObject({ start: hhmm, end: hhmm })), line: lineNo }));
const PostWindowSchema = z.strictObject({ start: hhmm, end: hhmm, line: lineNo }).nullable();

const ParsedInstructionSchema = z.strictObject({
  file: z.string().min(1),
  sha256,
  state: z.enum(['enabled', 'disabled']),
  priority: z.number().int().min(0).max(100),
  scope: z.strictObject({ post_type: z.enum(['common', ...POST_TYPES]), audience: z.enum(['common', ...AUDIENCE_CATEGORIES]) }),
  period: z.strictObject({ start: dateKey.nullable(), end: dateKey.nullable() }),
  sections: z.partialRecord(z.enum(INSTRUCTION_SECTIONS), lineNo),
  business_hours: BusinessHoursSchema,
  closed_dates: z.array(z.strictObject({ date: dateKey, line: lineNo })),
  post_window: PostWindowSchema,
  keywords: z.strictObject({ op: z.enum(['add', 'replace', 'delete']), words: z.array(z.string().min(1)), line: lineNo }).nullable(),
  excluded_keywords: z.array(z.strictObject({ word: z.string().min(1), line: lineNo })),
  writing_policies: z.array(z.strictObject({ text: z.string().min(1), line: lineNo })),
  routes: z.partialRecord(z.enum(['style.mens', 'style.ladies', 'blog.mens', 'blog.ladies']), z.strictObject({ url: z.string().min(1), line: lineNo })),
  ignored: z.array(IssueSchema),
});

// Only last_valid is read back; the rest of the record is output.
const RecordCacheSchema = z.looseObject({
  schema_version: z.literal(1),
  last_valid: z
    .record(
      z.string(),
      z.strictObject({ sha256, parsed: ParsedInstructionSchema, valid_at: isoUtc }),
    )
    .optional(),
});

// ---------------------------------------------------------------- helpers

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Candidate names: *.md directly in the folder, except README.md, *.example.md and temporary files (case-insensitive). */
export function isInstructionFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') && lower !== 'readme.md' && !lower.endsWith('.example.md') && !name.startsWith('.') && !name.startsWith('~$');
}

function fileIssue(file: string, message: string): InstructionIssue {
  return { code: 'INSTRUCTION_INVALID', file, line: null, item: null, message: `${file}: ${message}`, note: null, related_files: [] };
}

const concerns = (name: string) => (i: InstructionIssue): boolean => i.file === name || i.related_files.includes(name);
const byFileLine = (a: InstructionIssue, b: InstructionIssue): number =>
  compareText(a.file, b.file) || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
const issueKey = (i: InstructionIssue): string => `${i.code}\u0000${i.file}\u0000${i.item ?? ''}\u0000${i.message}`;
/** Compares record bodies by content (key order differs between a fresh parse and one read back from the file). */
const bodyKey = (body: unknown): string => JSON.stringify(canonical(body));
const since = (last: LastValid): string => `${LAST_VALID_NOTE}（${formatJst(new Date(last.valid_at))} に確認した内容）`;

/** Every URL in the content passes checkRouteUrl, so saving it cannot keep a session token or other secret. */
function routesPersistable(doc: ParsedInstruction, allowed: ReadonlySet<string>, policy: UrlPolicy | undefined): boolean {
  return Object.values(doc.routes).every((route) => route === undefined || checkRouteUrl(route.url, allowed, { policy }).ok);
}

/** The last valid content is enabled and has not ended at `at` (so it is, or will be, what applies). */
function lastUsableAt(last: LastValid | null, at: Date): last is LastValid {
  return last !== null && last.parsed.state === 'enabled' && periodState(last.parsed.period, at) !== 'expired';
}

/** What a file whose current content cannot be used is running on. */
function wholeFileNote(s: Source, now: Date): string {
  if (lastUsableAt(s.last, now)) return since(s.last);
  return s.last === null ? 'この指示書はまだ反映していません' : 'この指示書は反映していません';
}

/** What a file that gave way uses for the item: its last valid content (edited file) or nothing. */
function itemNote(s: Source, how: GiveWay, now: Date): string {
  if (how === 'yield') return `${s.name} のこの項目は反映していません（適用開始が遅い指示書が譲ります。${PRIORITY_HINT}）`;
  return lastUsableAt(s.last, now) ? `${s.name} は${since(s.last)}` : `${s.name} のこの項目は反映していません`;
}

/** What an edited file that gives way at `at` will use for the item from that day. */
function futureNote(g: Source, at: Date): string {
  const last = g.last;
  if (last === null) return `${g.name} のこの項目はその日から反映しません`;
  if (last.parsed.state === 'enabled' && periodState(last.parsed.period, at) === 'active') return `${g.name} はその日から前回の正しい内容で動作します`;
  return `${g.name} のこの項目はその日から反映しません（前回の正しい内容はその日には適用期間の外です）`;
}

/** How a file gives way on an item: an edited file falls back to its last valid content; a later-starting one yields. */
type GiveWay = 'fallback' | 'yield';

/** Units a file gives way on, per way (a file absent from a map gives nothing that way). */
interface GiveWays {
  fallback: Map<string, Set<InstructionUnit>>;
  yielded: Map<string, Set<InstructionUnit>>;
}

const PRIORITY_HINT = '期間を区切った指示を優先したいときは、その指示書の優先度を高く（例: 20）してください';

/**
 * Ruling P2-R10: for a conflict on `unit`, the involved files whose own document for that unit starts latest, when the
 * starts differ ([] when they are equal or none has a start). A document without 適用開始 starts at -Infinity.
 */
function laterStarting(involved: Source[], docs: ParsedInstruction[], unit: InstructionUnit): Source[] {
  const startOf = (s: Source): number => {
    const doc = docs.find((d) => d.file === s.name && d.state === 'enabled' && hasUnit(d, unit));
    return doc === undefined || doc.period.start === null ? Number.NEGATIVE_INFINITY : jstToUtc(doc.period.start, 0).getTime();
  };
  const starts = involved.map(startOf);
  const latest = Math.max(...starts);
  if (latest === Number.NEGATIVE_INFINITY || starts.every((x) => x === latest)) return [];
  return involved.filter((_, i) => starts[i] === latest);
}

/** The earliest start (YYYY-MM-DD) when every file named by the issue is enabled but has not started yet; else null. */
function upcomingFrom(issue: InstructionIssue, byName: ReadonlyMap<string, Source>, now: Date): string | null {
  const starts: string[] = [];
  for (const name of [issue.file, ...issue.related_files]) {
    const doc = byName.get(name)?.current ?? null;
    if (doc === null || doc.state !== 'enabled' || doc.period.start === null || periodState(doc.period, now) !== 'upcoming') return null;
    starts.push(doc.period.start);
  }
  return starts.sort()[0] ?? null;
}

/** The period starts (YYYY-MM-DD) after `now` of the enabled documents, earliest first. */
function futureStarts(docs: readonly ParsedInstruction[], now: Date): string[] {
  const t = now.getTime();
  return [...new Set(docs.flatMap((d) => (d.state === 'enabled' && d.period.start !== null ? [d.period.start] : [])))]
    .filter((date) => jstToUtc(date, 0).getTime() > t)
    .sort()
    .slice(0, MAX_FUTURE_STARTS);
}

/**
 * Reads instructions/, merges the documents over the config and records the outcome in data/instructions.json.
 * Revocation (a file disabled, deleted or past its period) takes effect on the next scan regardless of other files.
 */
export class InstructionManager {
  readonly #d: InstructionManagerDeps;
  readonly #readFile: (path: string) => Promise<Uint8Array>;
  readonly #entries = new Map<string, Entry>();
  /** The last stable content per file, used while a newer version is still settling. */
  readonly #lastAccepted = new Map<string, Accepted>();
  /** The last content per file that applied without problems (Ruling P2-R2). */
  readonly #lastValid = new Map<string, LastValid>();
  /** When a file that has a last valid entry was first found missing; the entry goes once it stays away STABLE_MS. */
  readonly #missingSince = new Map<string, number>();
  /** Problems with the saved last valid contents, shown with every result for the lifetime of this manager. */
  readonly #cacheIssues: InstructionIssue[] = [];
  #cacheLoaded = false;
  /** The record body last written (first: the one in data/instructions.json), as canonical JSON; never one whose write failed. */
  #lastKey: string | null = null;
  /** effective_hash of the previous scan (first: the recorded one); null when there is none. */
  #lastHash: string | null = null;
  /** The record body last logged (null: nothing logged by this manager yet). */
  #loggedKey: string | null = null;
  #loggedIssues = new Set<string>();
  #current: InstructionScanResult | null = null;
  #inflight: Promise<InstructionScanResult> | null = null;

  constructor(d: InstructionManagerDeps) {
    this.#d = d;
    this.#readFile = d.readFile ?? ((path) => readFile(path));
  }

  /** The result of the latest completed scan; null before the first one. */
  get current(): InstructionScanResult | null {
    return this.#current;
  }

  /**
   * A call made while a scan is running gets that scan's result. A failure to write the record file is thrown after the
   * result was applied (`current` is the new result); the write is tried again by the next scan.
   */
  scan(now: Date): Promise<InstructionScanResult> {
    if (this.#inflight !== null) return this.#inflight;
    const run = this.#scan(now).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  async #scan(now: Date): Promise<InstructionScanResult> {
    const config = this.#d.config();
    const allowed = allowedOriginSet(config.salonboardFields.allowed_origins, this.#d.urlPolicy);
    if (!this.#cacheLoaded) {
      await this.#loadCache(allowed);
      this.#cacheLoaded = true;
    }
    const t = now.getTime();
    const names = await this.#list();
    const sources: Source[] = [];
    for (const name of names) {
      const obs = await this.#observe(name, t);
      if (obs.kind === 'gone') {
        this.#forgetObservations(name);
        continue;
      }
      const accepted = obs.kind === 'accepted' ? obs.accepted : (this.#lastAccepted.get(name) ?? null);
      const current = accepted !== null && 'parsed' in accepted ? accepted.parsed : null;
      const last = this.#lastValid.get(name) ?? null;
      sources.push({
        name,
        accepted,
        pending: obs.kind !== 'accepted',
        unreadable: obs.kind === 'unreadable' ? obs.code : null,
        current,
        last,
        changed: current !== null && current.sha256 !== last?.sha256,
      });
    }
    const present = new Set(sources.map((s) => s.name));
    for (const name of [...this.#entries.keys()]) if (!present.has(name)) this.#forgetObservations(name);
    this.#expireMissing(present, t);

    const { merged, checked, ways, resolved, yieldKeys, docs } = this.#mergeWithFallback(config, sources, now);
    const { fallback } = ways;

    const knownKeys = new Set([...merged.issues, ...checked].map(issueKey));
    const issues: InstructionIssue[] = [...this.#cacheIssues, ...merged.issues, ...checked];
    for (const { issue, files } of resolved.values()) {
      if (knownKeys.has(issueKey(issue))) continue;
      knownKeys.add(issueKey(issue));
      issues.push({ ...issue, note: [...files].map(([s, how]) => itemNote(s, how, now)).join('。') });
    }
    const starts = futureStarts(docs, now);
    const future = this.#futureConflicts(config, docs, sources, starts, knownKeys);
    issues.push(...future.issues);
    for (const s of sources) {
      if (s.accepted !== null && 'invalid' in s.accepted) issues.push(...s.accepted.invalid.map((i) => ({ ...i, note: wholeFileNote(s, now) })));
      if (s.unreadable !== null) {
        issues.push({
          ...fileIssue(s.name, `読み込めません（${s.unreadable}）。ほかのアプリで開いたままになっていないか確認してください。次の確認で読み直します`),
          note: s.current !== null ? '直前に読み込んだ内容で動作中' : wholeFileNote(s, now),
        });
      }
    }
    // What is saved now is decided first: the reductions ahead are worked out as each file will be on that day.
    const saving = this.#saving(sources, fallback, issues, new Set([...future.keys, ...yieldKeys]), future.blocked, allowed);
    issues.push(...this.#futureShortages(config, sources, saving, starts, now, knownKeys));
    // Problems of documents that have not started yet change nothing now (status lists them as upcoming).
    const byName = new Map(sources.map((s) => [s.name, s]));
    for (const [n, issue] of issues.entries()) {
      const from = issue.upcoming_from === undefined ? upcomingFrom(issue, byName, now) : null;
      if (from !== null) issues[n] = { ...issue, upcoming_from: from, note: `${from} から適用する指示書の問題です（今は影響ありません）。${issue.note ?? ''}` };
    }
    issues.sort(byFileLine);

    const files = sources.map((s) => this.#fileRecord(s, fallback.has(s.name), now, merged.applied, [...issues, ...merged.ignored]));
    this.#promote(sources, saving, now);

    const hash = effectiveHash(merged.effective);
    const lastValid = Object.fromEntries([...this.#lastValid.entries()].sort(([a], [b]) => compareText(a, b)));
    const body = { files, effective: merged.effective, effective_hash: hash, issues, ignored: merged.ignored, last_valid: lastValid };
    const key = bodyKey(body);
    const changed = key !== this.#lastKey;
    const previousHash = this.#lastHash ?? effectiveHash(mergeInstructions(config, [], now, { allowedOrigins: [] }).effective);
    const result: InstructionScanResult = {
      changed,
      effective_changed: hash !== previousHash,
      scanned_at: now.toISOString(),
      overlay: merged.effective,
      effective_hash: hash,
      issues,
      ignored: merged.ignored,
      applied: merged.applied,
      files,
      // Also files gone for less than STABLE_MS: scan again soon to see whether they come back.
      pending: [...files.filter((f) => f.pending).map((f) => f.name), ...this.#missingSince.keys()],
    };
    // Applied before it is saved (fix round 1): the record is the last-valid cache and a report, so a record that cannot be
    // written must not hold back new closures, hours or revocations. #lastKey stays, so the write is tried again next scan.
    this.#current = result;
    this.#lastHash = hash;
    // Logged on the first scan of every manager too, so each session's log shows what it runs on and what is still wrong.
    if (key !== this.#loggedKey) {
      this.#loggedKey = key;
      this.#log(merged.applied, issues, merged.ignored, hash);
    }
    if (changed && this.#d.readOnly !== true) {
      const record: InstructionRecord = { schema_version: 1, scanned_at: now.toISOString(), ...body };
      const write = (): Promise<void> => writeJsonAtomic(this.#d.recordFile, record);
      try {
        await (this.#d.queue === undefined ? write() : this.#d.queue.run(write));
      } catch (err) {
        const message = `作業指示書の内容は反映しましたが、記録（${this.#d.recordFile}）を保存できませんでした。次の確認で保存し直します（${errorText(err)}）`;
        throw new AppFailure(appError(errorCodeOf(err) === 'DISK_FULL' ? 'DISK_FULL' : 'FILE_IO_ERROR', 'instructions', systemClock, { message, details: { path: this.#d.recordFile } }));
      }
    }
    this.#lastKey = key;
    return result;
  }

  /**
   * Merges, then makes the files behind every invalid or conflicting item give way and merges again, until nothing more
   * changes (Rulings P2-R2 and P2-R10):
   * - a conflict between documents whose own periods start on different days is settled by the document that starts
   *   later: it drops the item, whichever file was edited or saved first ("yield");
   * - otherwise (same start, no starts, or an invalid item) every edited file involved takes the item from its last valid
   *   content, or drops it when there is none ("fallback"); an item with no edited file left stays blocked.
   * The validator then runs once on the result. What it names (too little posting time) never gives way (Ruling P2-R14):
   * the item applies as written, new, edited or unchanged, and the effective schedule reduces that weekday's counts
   * instead (P2-R11), so nothing is ever posted outside the instructed hours or post window.
   */
  #mergeWithFallback(config: ConfigSnapshot, sources: Source[], now: Date) {
    const byName = new Map(sources.map((s) => [s.name, s]));
    const ways: GiveWays = { fallback: new Map(), yielded: new Map() };
    const resolved = new Map<string, { issue: InstructionIssue; files: Map<Source, GiveWay> }>();
    const yieldKeys = new Set<string>();
    const opts = { allowedOrigins: config.salonboardFields.allowed_origins, policy: this.#d.urlPolicy };
    const run = (): { docs: ParsedInstruction[]; merged: MergeResult } => {
      const docs = this.#documents(sources, ways);
      return { docs, merged: mergeInstructions(config, docs, now, opts) };
    };
    const give = (issue: InstructionIssue, units: InstructionUnit[], givers: Source[], how: GiveWay): boolean => {
      let added = false;
      for (const s of givers) {
        const map = how === 'fallback' ? ways.fallback : ways.yielded;
        const set = map.get(s.name) ?? new Set<InstructionUnit>();
        const fresh = units.filter((u) => !set.has(u));
        if (fresh.length === 0) continue;
        for (const u of fresh) set.add(u);
        map.set(s.name, set);
        added = true;
        const key = issueKey(issue);
        if (how === 'yield') yieldKeys.add(key);
        const entry = resolved.get(key) ?? { issue, files: new Map<Source, GiveWay>() };
        entry.files.set(s, how);
        resolved.set(key, entry);
      }
      return added;
    };
    let { docs, merged } = run();
    for (let round = 0; round < MAX_FALLBACK_ROUNDS; round++) {
      let added = false;
      for (const issue of merged.issues) {
        const units = unitsOfItem(issue.item);
        if (units.length === 0) continue;
        const involved = [issue.file, ...issue.related_files].flatMap((name) => {
          const s = byName.get(name);
          return s === undefined ? [] : [s];
        });
        const later = issue.code === 'INSTRUCTION_CONFLICT' ? laterStarting(involved, docs, units[0]!) : [];
        if (later.length > 0 ? give(issue, units, later, 'yield') : give(issue, units, involved.filter((s) => s.changed), 'fallback')) added = true;
      }
      if (!added) break;
      ({ docs, merged } = run());
    }
    const checked = this.#d.validate?.(config, docs, merged) ?? [];
    return { merged, checked, ways, resolved, yieldKeys, docs };
  }

  /**
   * Conflicts that begin when an upcoming document's period starts (merging at `now` only compares active documents),
   * reported now with 「YYYY-MM-DD から競合」. When the starts differ, the later-starting document will give way on that
   * day anyway, so nothing is held back. When both start that day, the edited files starting then are not saved as last
   * valid (`blocked`), so on that day they still count as edited and fall back (Ruling P2-R2).
   */
  #futureConflicts(
    config: ConfigSnapshot,
    docs: ParsedInstruction[],
    sources: Source[],
    starts: readonly string[],
    known: Set<string>,
  ): { issues: InstructionIssue[]; keys: Set<string>; blocked: Set<string> } {
    const byName = new Map(sources.map((s) => [s.name, s]));
    const opts = { allowedOrigins: config.salonboardFields.allowed_origins, policy: this.#d.urlPolicy };
    const issues: InstructionIssue[] = [];
    const keys = new Set<string>();
    const blocked = new Set<string>();
    for (const date of starts) {
      const at = jstToUtc(date, 0);
      for (const issue of mergeInstructions(config, docs, at, opts).issues) {
        const key = issueKey(issue);
        const unit = unitsOfItem(issue.item)[0];
        if (issue.code !== 'INSTRUCTION_CONFLICT' || unit === undefined || known.has(key)) continue;
        known.add(key);
        keys.add(key);
        const involved = [issue.file, ...issue.related_files].flatMap((name) => {
          const s = byName.get(name);
          return s === undefined ? [] : [s];
        });
        const yielding = laterStarting(involved, docs, unit);
        let consequence: string;
        if (yielding.length > 0) {
          consequence = yielding.map((g) => `${g.name} のこの項目はその日から反映しません（適用開始が遅い指示書が譲ります）`).join('。');
        } else {
          // Same start: on that day only the edited files give way (P2-R2); an unchanged file's value applies.
          const starting = involved.filter((s) => docs.some((d) => d.file === s.name && d.period.start === date));
          const edited = starting.filter((s) => s.changed);
          for (const g of edited) blocked.add(g.name);
          consequence =
            edited.length > 0
              ? edited.map((g) => futureNote(g, at)).join('。')
              : `その日から ${involved.map((s) => s.name).join(' と ')} のどちらの指示もこの項目には反映しません`;
        }
        issues.push({ ...issue, note: `${date} から競合。${consequence}。${PRIORITY_HINT}`, upcoming_from: date });
      }
    }
    return { issues, keys, blocked };
  }

  /**
   * Weekday counts that a later period start will reduce (「YYYY-MM-DD から投稿枠不足」, Ruling P2-R14), announced exactly as
   * the scan on that day will report them: each start date is merged as that day's scan will merge it, with the files
   * saved now (`saving`) counting as unchanged and every other edited file still falling back on its invalid or
   * conflicting items (that is how the same-start conflicts of all dates hold a file back). A reduction already reported
   * now, or for an earlier start, is not repeated.
   */
  #futureShortages(
    config: ConfigSnapshot,
    sources: Source[],
    saving: ReadonlySet<string>,
    starts: readonly string[],
    now: Date,
    known: Set<string>,
  ): InstructionIssue[] {
    if (this.#d.validate === undefined || starts.length === 0) return [];
    const valid_at = now.toISOString();
    const onTheDay = sources.map((s): Source =>
      s.current !== null && saving.has(s.name) ? { ...s, changed: false, last: { sha256: s.current.sha256, parsed: s.current, valid_at } } : s,
    );
    const issues: InstructionIssue[] = [];
    for (const date of starts) {
      for (const issue of this.#mergeWithFallback(config, onTheDay, jstToUtc(date, 0)).checked) {
        const key = issueKey(issue);
        if (known.has(key)) continue;
        known.add(key);
        issues.push({ ...issue, note: `${date} から投稿枠不足。${issue.note ?? ''}`, upcoming_from: date });
      }
    }
    return issues;
  }

  /** A missing file stops applying at once; its last valid entry is kept for STABLE_MS (editors may delete and re-create). */
  #expireMissing(present: ReadonlySet<string>, t: number): void {
    for (const name of [...this.#lastValid.keys()]) {
      if (present.has(name)) {
        this.#missingSince.delete(name);
        continue;
      }
      const since = this.#missingSince.get(name);
      if (since === undefined || t < since) {
        this.#missingSince.set(name, t);
        continue;
      }
      if (t - since >= STABLE_MS) {
        this.#lastValid.delete(name);
        this.#missingSince.delete(name);
      }
    }
  }

  #documents(sources: Source[], ways: GiveWays): ParsedInstruction[] {
    const docs: ParsedInstruction[] = [];
    for (const s of sources) {
      let own: ParsedInstruction[];
      const units = ways.fallback.get(s.name);
      if (s.current === null) own = s.last !== null ? [{ ...s.last.parsed, ignored: [] }] : [];
      else if (units === undefined) own = [s.current];
      else own = [selectUnits(s.current, units, false), ...(s.last !== null ? [selectUnits(s.last.parsed, units, true)] : [])];
      const drop = ways.yielded.get(s.name);
      docs.push(...(drop === undefined ? own : own.map((d) => selectUnits(d, drop, false))));
    }
    return docs;
  }

  /**
   * The files whose current content becomes their last valid content in this scan: a parsed edit that applies with no
   * invalid or conflicting item, and is not the file that gives way to a conflict at a future period start. Content whose
   * URLs fail the checks is never saved, whatever its period (spec 5.11: no secrets). Nothing is saved while a missing
   * file's entry is in its grace time: its conflicts cannot be checked until it is back or gone for good.
   */
  #saving(
    sources: Source[],
    fallback: Map<string, Set<InstructionUnit>>,
    issues: InstructionIssue[],
    settled: ReadonlySet<string>,
    blocked: ReadonlySet<string>,
    allowed: ReadonlySet<string>,
  ): Set<string> {
    const out = new Set<string>();
    if (this.#missingSince.size > 0) return out;
    // Conflicts settled by the later-start rule (now or at a future start) hold back no file: the same document gives way
    // whatever version of either file is saved. Same-start future conflicts hold back only the files in `blocked`.
    // INSTRUCTION_CAPACITY_REDUCED holds back nothing (Ruling P2-R14): such an item applies as written.
    const blocking = issues.filter((i) => i.code !== IGNORED_CONTENT_CODE && i.code !== CACHE_IGNORED_CODE && i.code !== CAPACITY_REDUCED_CODE && !settled.has(issueKey(i)));
    for (const s of sources) {
      if (!s.changed || s.current === null || fallback.has(s.name) || blocked.has(s.name) || blocking.some(concerns(s.name))) continue;
      if (routesPersistable(s.current, allowed, this.#d.urlPolicy)) out.add(s.name);
    }
    return out;
  }

  #promote(sources: Source[], saving: ReadonlySet<string>, now: Date): void {
    for (const s of sources) {
      if (s.current !== null && saving.has(s.name)) this.#lastValid.set(s.name, { sha256: s.current.sha256, parsed: s.current, valid_at: now.toISOString() });
    }
  }

  #forgetObservations(name: string): void {
    this.#entries.delete(name);
    this.#lastAccepted.delete(name);
  }

  async #loadCache(allowed: ReadonlySet<string>): Promise<void> {
    let result;
    try {
      result = await readJsonFile(this.#d.recordFile, RecordCacheSchema);
    } catch (err) {
      this.#ignoreCache(err instanceof Error ? err.message : String(err));
      return;
    }
    if (result.kind === 'missing') return;
    if (result.kind === 'corrupt') {
      this.#ignoreCache(result.reason);
      return;
    }
    const entries = Object.entries(result.value.last_valid ?? {});
    for (const [name, entry] of entries) {
      if (!isInstructionFileName(name) || entry.parsed.file !== name || entry.parsed.sha256 !== entry.sha256) {
        this.#ignoreCache(`「${name}」の記録が中身と一致しません`);
        return;
      }
    }
    // The first scan compares with what was recorded, so a restart with nothing changed is not reported as a change.
    const v = result.value;
    this.#lastKey = bodyKey({ files: v.files, effective: v.effective, effective_hash: v.effective_hash, issues: v.issues, ignored: v.ignored, last_valid: v.last_valid });
    this.#lastHash = typeof v.effective_hash === 'string' ? v.effective_hash : null;
    for (const [name, entry] of entries) {
      const parsed: ParsedInstruction = entry.parsed;
      if (!routesPersistable(parsed, allowed, this.#d.urlPolicy)) {
        this.#cacheProblem(`「${name}」の前回の正しい内容に使えないURLがあるため、その記録を外しました`);
        continue;
      }
      this.#lastValid.set(name, { sha256: entry.sha256, parsed, valid_at: entry.valid_at });
    }
  }

  #ignoreCache(reason: string): void {
    this.#lastValid.clear();
    this.#cacheProblem(`「前回の正しい内容」の記録を読み取れないため使いません（${reason}）`);
  }

  #cacheProblem(message: string): void {
    const issue: InstructionIssue = {
      code: CACHE_IGNORED_CODE,
      file: '',
      line: null,
      item: null,
      message: `${this.#d.recordFile}: ${message}`,
      note: '各指示書は今の内容だけで判断しています（記録は次の書込で作り直します）',
      related_files: [],
    };
    this.#cacheIssues.push(issue);
    this.#d.logger.warn(CACHE_IGNORED_CODE, `${issue.message}。${issue.note}。`, { stage: 'instructions', file: this.#d.recordFile });
  }

  async #list(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await withTransientRetry(() => readdir(this.#d.dir, { withFileTypes: true }));
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw storageFailure(err, 'instructions フォルダの読込', this.#d.dir);
    }
    // Dirent types come from the entry itself, so links and junctions are not regular files and are never followed.
    return entries
      .filter((e) => e.isFile() && isInstructionFileName(e.name))
      .map((e) => e.name)
      .sort(compareText);
  }

  async #observe(name: string, t: number): Promise<Observation> {
    const path = join(this.#d.dir, name);
    let st: Stats;
    try {
      st = await lstat(path);
    } catch (err) {
      const code = errnoCode(err) ?? 'UNKNOWN';
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'gone' } : { kind: 'unreadable', code };
    }
    if (!st.isFile()) return { kind: 'gone' };
    const known = this.#entries.get(name);
    if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) {
      if (known.accepted !== undefined) return { kind: 'accepted', accepted: known.accepted };
      // A clock set back must not make a file wait for the old time to come round again.
      if (t < known.seenAt) known.seenAt = t;
      if (t - known.seenAt < STABLE_MS) return { kind: 'pending' };
    } else {
      this.#entries.set(name, { size: st.size, mtimeMs: st.mtimeMs, seenAt: t });
      // Last written at least STABLE_MS ago (e.g. at startup): settled already. Otherwise wait for a second look.
      if (t - st.mtimeMs < STABLE_MS) return { kind: 'pending' };
    }
    return this.#read(name, path, st, t);
  }

  async #read(name: string, path: string, st: Stats, t: number): Promise<Observation> {
    if (st.size > MAX_INSTRUCTION_FILE_BYTES) {
      return this.#accept(name, {
        sha256: null,
        invalid: [fileIssue(name, `ファイルが大きすぎます（${Math.ceil(st.size / 1024)} KB）。指示書は ${MAX_INSTRUCTION_FILE_BYTES / 1024} KB までにしてください`)],
      });
    }
    let bytes: Uint8Array;
    let after: Stats;
    try {
      bytes = await this.#readFile(path);
      after = await lstat(path);
    } catch (err) {
      const code = errnoCode(err) ?? 'UNKNOWN';
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'gone' } : { kind: 'unreadable', code };
    }
    if (!after.isFile()) return { kind: 'gone' };
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || bytes.byteLength !== st.size) {
      this.#entries.set(name, { size: after.size, mtimeMs: after.mtimeMs, seenAt: t });
      return { kind: 'pending' };
    }
    const hash = sha256Hex(bytes);
    const decoded = decodeInstructionBytes(bytes);
    if (!decoded.ok) return this.#accept(name, { sha256: hash, invalid: [fileIssue(name, decoded.reason)] });
    const parsed = parseInstructionFile(name, decoded.text, { sha256: hash });
    return this.#accept(name, 'invalid' in parsed ? { sha256: hash, invalid: parsed.invalid } : { sha256: hash, parsed });
  }

  #accept(name: string, accepted: Accepted): Observation {
    const entry = this.#entries.get(name);
    if (entry !== undefined) entry.accepted = accepted;
    this.#lastAccepted.set(name, accepted);
    return { kind: 'accepted', accepted };
  }

  #fileRecord(s: Source, fellBack: boolean, now: Date, applied: AppliedRef[], allIssues: InstructionIssue[]): InstructionFileRecord {
    const refs = applied.filter((a) => a.file === s.name);
    const last = s.last;
    const lastInUse = last !== null && (s.current === null || (s.changed && fellBack));
    const record: InstructionFileRecord = {
      name: s.name,
      sha256: s.accepted?.sha256 ?? null,
      state: s.unreadable !== null ? 'unreadable' : 'pending',
      pending: s.pending,
      priority: null,
      scope: null,
      period: null,
      applied_items: sortItems(refs.flatMap((a) => a.items)),
      last_valid_in_use:
        lastInUse && last !== null
          ? { sha256: last.sha256, valid_at: last.valid_at, items: sortItems(refs.filter((a) => a.sha256 === last.sha256).flatMap((a) => a.items)) }
          : null,
      issues: allIssues.filter(concerns(s.name)).sort(byFileLine),
    };
    if (s.accepted === null) return record;
    if ('invalid' in s.accepted) return { ...record, state: 'invalid' };
    const doc = s.accepted.parsed;
    if (doc.state === 'disabled') return { ...record, state: 'disabled' };
    return { ...record, state: periodState(doc.period, now), priority: doc.priority, scope: { ...doc.scope }, period: { ...doc.period } };
  }

  #log(applied: AppliedRef[], issues: InstructionIssue[], ignored: InstructionIssue[], hash: string): void {
    // A reduction that starts with a later period changes nothing yet (status lists it under これから問題になる指示).
    const reduced = issues.filter((i) => i.code === CAPACITY_REDUCED_CODE && i.upcoming_from === undefined).length;
    const reducedLater = issues.filter((i) => i.code === CAPACITY_REDUCED_CODE && i.upcoming_from !== undefined).length;
    const notApplied = issues.length - reduced - reducedLater;
    const problems = [
      notApplied > 0 ? `、反映していない指示: ${notApplied}件` : '',
      reduced > 0 ? `、投稿数を減らして反映している指示: ${reduced}件` : '',
      reducedLater > 0 ? `、これから投稿数を減らす指示: ${reducedLater}件` : '',
    ].join('');
    this.#d.logger.info('INSTRUCTIONS_UPDATED', `作業指示書を確認しました（反映中の指示書: ${new Set(applied.map((a) => a.file)).size}件${problems}）。`, {
      stage: 'instructions',
      effective_hash: hash,
      applied_files: applied.map((a) => ({ file: a.file, sha256: a.sha256, items: a.items })),
      issue_count: issues.length,
      ignored_count: ignored.length,
    });
    const keys = new Set<string>();
    for (const issue of [...issues, ...ignored]) {
      const key = `${issueKey(issue)}\u0000${issue.note ?? ''}`;
      keys.add(key);
      // Cache problems were logged when they were found.
      if (this.#loggedIssues.has(key) || issue.code === CACHE_IGNORED_CODE) continue;
      const message = issue.note === null ? issue.message : `${issue.message}（${issue.note}）`;
      if (issue.code === IGNORED_CONTENT_CODE) {
        this.#d.logger.info(issue.code, message, { stage: 'instructions', file: issue.file, line: issue.line });
      } else if (issue.code === CAPACITY_REDUCED_CODE) {
        // Not an error: the item applies, with fewer posts that weekday.
        this.#d.logger.warn(issue.code, message, { stage: 'instructions', file: issue.file, line: issue.line });
      } else {
        this.#d.logger.warn(issue.code, message, { stage: 'instructions', error_code: issue.code, file: issue.file, line: issue.line });
      }
    }
    this.#loggedIssues = keys;
  }
}
