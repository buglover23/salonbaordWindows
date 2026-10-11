import type { AiConfigResult } from '../ai/ai-config.js';
import type { ConfigSnapshot } from '../config/loader.js';
import { checkLiveReadiness, type ReadinessItem, type ReadinessOptions, type RouteKey } from '../config/readiness.js';
import { handledAudiences, type SalonboardFields, type ScheduleConfig } from '../config/schemas.js';
import { fittedDayCounts, MIN_SLOT_GAP_MINUTES, validateScheduleCapacity, type DayCounts, type PlanSchedule } from '../execution/slots.js';
import { sha256Hex } from '../shared/hash.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type PostType } from '../shared/types.js';
import { effectiveHash, mergeInstructions, type AppliedRef, type BusinessHours, type EffectiveOverlay, type MergeResult } from './instructions/merge.js';
import { CAPACITY_REDUCED_CODE, ROUTE_LABELS, WEEKDAY_KEYS, type InstructionIssue, type ParsedInstruction, type TimeRange, type WeekdayKey } from './instructions/parse.js';
import type { InstructionScanResult } from './instructions/store.js';

// The configuration the tool runs on: config/*.json with the instruction overlay on top (spec 5.10, plan Task 2).
// Everything here is pure; the overlay comes from InstructionManager.scan().

export type RouteSource = 'config' | 'instructions';

export interface EffectiveConfig {
  readonly base: ConfigSnapshot;
  readonly overlay: EffectiveOverlay;
  /**
   * schedule.json with the instruction business hours, closed dates and post window applied; `day_counts` holds the fewer
   * posts of the weekdays those leave too little time for the configured counts (Ruling P2-R11).
   */
  readonly schedule: PlanSchedule;
  /** Removed from every keyword source (manual, Excel, trends) by NFKC exact match. */
  readonly excludedKeywords: readonly string[];
  /**
   * posting_routes with the entry_url overrides from instructions (adapter and page profile stay as configured). The
   * routes of an audience this copy does not handle (settings.audiences) have no entry_url, whatever the files say.
   */
  readonly routes: SalonboardFields['posting_routes'];
  /** The audiences this copy handles (settings.audiences; both when null). */
  readonly audiences: readonly AudienceCategory[];
  readonly routeSources: Readonly<Record<RouteKey, RouteSource>>;
  /** sha256 of the config hash and the overlay hash: changes whenever either does. */
  readonly hash: string;
  /** effectiveHash(overlay), as recorded in data/instructions.json. */
  readonly overlayHash: string;
  /** The priority keywords for one post type × audience (config base, instruction operations, exclusions applied). */
  keywordsFor(type: PostType, audience: AudienceCategory): readonly string[];
  writingPolicies(type: PostType, audience: AudienceCategory): readonly string[];
}

const ROUTE_KEYS = Object.keys(ROUTE_LABELS) as RouteKey[];
const WEEKDAY_JA: Record<WeekdayKey, string> = { '1': '月曜日', '2': '火曜日', '3': '水曜日', '4': '木曜日', '5': '金曜日', '6': '土曜日', '7': '日曜日' };
// A weekday the config gives no business hours for is limited by the post window only.
const UNRESTRICTED: TimeRange = { start: '00:00', end: '23:59' };
// Items one document's value replaces outright; a conflict on them is moot once a higher priority sets them.
const OVERRIDE_ITEM = /^(business_hours\.[1-7]|post_window|routes\.(style|blog)\.(mens|ladies))$/;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The overlay of "no instruction applies": config keywords (deduplicated), nothing else changed. */
export function neutralOverlay(snapshot: ConfigSnapshot): EffectiveOverlay {
  return mergeInstructions(snapshot, [], new Date(0), { allowedOrigins: [] }).effective;
}

/**
 * schedule.json with the overlay applied; counts, grace and active weekdays come from the config, except that a weekday
 * whose windows cannot hold the configured counts with the minimum gap gets them reduced in `day_counts` (Ruling P2-R11:
 * the instructed hours and post window are kept, so nothing is posted outside them). `instructed`:
 * the weekdays whose hours an applied document sets. The overlay carries the config's hours for the other weekdays as they
 * were when it was made, so those are taken from `base` instead (a config edit applies even before the next scan).
 * Omitted: every weekday of the overlay.
 */
export function effectiveSchedule(base: ScheduleConfig, overlay: EffectiveOverlay, instructed?: ReadonlySet<string>): PlanSchedule {
  const set = overlay.business_hours;
  const hours =
    set === undefined
      ? base.business_hours
      : (Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, instructed === undefined || instructed.has(d) ? set[d] : (base.business_hours?.[d] ?? [UNRESTRICTED])])) as BusinessHours);
  const schedule: ScheduleConfig = {
    ...base,
    business_hours: hours === null ? null : (Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, hours[d].map((r) => ({ start: r.start, end: r.end }))])) as BusinessHours),
    post_start: overlay.post_window?.start ?? base.post_start,
    post_end: overlay.post_window?.end ?? base.post_end,
    closed_dates: [...new Set([...base.closed_dates, ...overlay.closed_dates_add])].sort(),
    active_weekdays: [...base.active_weekdays],
  };
  const dayCounts = fittedDayCounts(schedule);
  return Object.keys(dayCounts).length === 0 ? schedule : { ...schedule, day_counts: dayCounts };
}

/** The weekdays (ISO, as strings) whose business hours the applied documents set. */
export function instructedWeekdays(applied: readonly AppliedRef[]): Set<string> {
  return new Set(applied.flatMap((a) => a.items).flatMap((item) => (item.startsWith('business_hours.') ? [item.slice('business_hours.'.length)] : [])));
}

/** `applied`: the documents behind the overlay (scan.applied), so weekdays no document sets follow the current config. */
export function buildEffectiveConfig(snapshot: ConfigSnapshot, overlay: EffectiveOverlay | null, applied?: readonly AppliedRef[]): EffectiveConfig {
  const o: EffectiveOverlay = structuredClone(overlay ?? neutralOverlay(snapshot));
  const overlayHash = effectiveHash(o);
  const configured = snapshot.salonboardFields.posting_routes;
  const routes = structuredClone(configured) as SalonboardFields['posting_routes'];
  const routeSources = {} as Record<RouteKey, RouteSource>;
  const audiences = handledAudiences(snapshot.settings);
  for (const key of ROUTE_KEYS) {
    const [type, audience] = key.split('.') as [PostType, AudienceCategory];
    const url = o.routes[key];
    if (url !== undefined) routes[type][audience].entry_url = url;
    if (!audiences.includes(audience)) routes[type][audience].entry_url = null;
    routeSources[key] = url === undefined ? 'config' : 'instructions';
  }
  const effective: EffectiveConfig = {
    base: snapshot,
    overlay: o,
    schedule: effectiveSchedule(snapshot.schedule, o, applied === undefined ? undefined : instructedWeekdays(applied)),
    excludedKeywords: o.excluded_keywords,
    routes,
    audiences,
    routeSources,
    hash: sha256Hex(`${snapshot.hash}:${overlayHash}`),
    overlayHash,
    keywordsFor: (type, audience) => o.keywords[type][audience],
    writingPolicies: (type, audience) => o.writing_policies[type][audience],
  };
  deepFreeze(o);
  deepFreeze(effective.schedule);
  deepFreeze(routes);
  return Object.freeze(effective);
}

/**
 * The effective configuration for the current config and the latest instruction scan, rebuilt only when one of the two
 * hashes changed.
 */
export class EffectiveConfigSource {
  readonly #config: { readonly current: ConfigSnapshot };
  readonly #instructions: { readonly current: InstructionScanResult | null } | null;
  #cache: { key: string; value: EffectiveConfig } | null = null;

  constructor(config: { readonly current: ConfigSnapshot }, instructions: { readonly current: InstructionScanResult | null } | null) {
    this.#config = config;
    this.#instructions = instructions;
  }

  get current(): EffectiveConfig {
    const snapshot = this.#config.current;
    const scan = this.#instructions?.current ?? null;
    const days = scan === null ? '' : [...instructedWeekdays(scan.applied)].sort().join(',');
    const key = `${snapshot.hash}:${scan?.effective_hash ?? ''}:${days}`;
    if (this.#cache?.key !== key) this.#cache = { key, value: buildEffectiveConfig(snapshot, scan?.overlay ?? null, scan?.applied) };
    return this.#cache.value;
  }
}

// ---------------------------------------------------------------- Rulings P2-R3, P2-R11, P2-R14: slot capacity on the effective schedule

type Blame = 'hours' | 'window';

const at = (file: string, line: number): string => `${file} ${line}行目`;
const describeRanges = (ranges: readonly TimeRange[]): string => (ranges.length === 0 ? '休業' : ranges.map((r) => `${r.start}-${r.end}`).join(', '));

/** The first capacity message for `days` on `schedule` (the Plan 1 rule), or null when they all have room. */
function shortage(schedule: ScheduleConfig, days: readonly number[]): string | null {
  return validateScheduleCapacity({ ...schedule, active_weekdays: [...days] })[0] ?? null;
}

/** The document version behind an applied item (matched by file and content hash: a file may apply twice). */
function contributors(merged: MergeResult, docs: readonly ParsedInstruction[], item: string): ParsedInstruction[] {
  return merged.applied
    .filter((a) => a.items.includes(item))
    .flatMap((a) => docs.filter((d) => d.file === a.file && d.sha256 === a.sha256).slice(0, 1));
}

/**
 * 「火曜日の投稿数をスタイル10→3件、ブログ10→3件」 for the weekdays' reduced counts (weekdays reduced alike named together).
 */
function reductionJa(base: ScheduleConfig, reduced: DayCounts, days: readonly WeekdayKey[]): string {
  const groups = new Map<string, WeekdayKey[]>();
  for (const day of days) {
    const c = reduced[day] ?? { style: base.style_posts_per_day, blog: base.blog_posts_per_day };
    const counts = `スタイル${base.style_posts_per_day}→${c.style}件、ブログ${base.blog_posts_per_day}→${c.blog}件`;
    groups.set(counts, [...(groups.get(counts) ?? []), day]);
  }
  return [...groups].map(([counts, ds]) => `${ds.map((d) => WEEKDAY_JA[d].slice(0, 1)).join('・')}曜日の投稿数を${counts}`).join('に、');
}

/**
 * Rulings P2-R3, P2-R11 and P2-R14: the Plan 1 capacity rule (validateScheduleCapacity: the day's posts must fit with at
 * least the minimum gap) applied to the effective schedule. An instruction whose business hours or post window leave an
 * active weekday too little time for the configured counts gets an INSTRUCTION_CAPACITY_REDUCED issue for that item, whose
 * note says how that day's counts are reduced while the item applies (effectiveSchedule's day_counts). When only the
 * combination of an hours item and the post window is too short, both are named, each issue listing the other side's
 * files in related_files. Used by InstructionManager as its validation hook; the items always apply as written (P2-R14:
 * never invalid, never a fallback), so these issues only report the reduction.
 */
export function scheduleCapacityIssues(base: ConfigSnapshot, docs: readonly ParsedInstruction[], merged: MergeResult): InstructionIssue[] {
  const overlay = merged.effective;
  if (overlay.business_hours === undefined && overlay.post_window === undefined) return [];
  const schedule = effectiveSchedule(base.schedule, overlay);
  const reduced = schedule.day_counts ?? {};
  const keep = (what: string, days: readonly WeekdayKey[]): string =>
    `${what}はこのとおり反映し、${reductionJa(base.schedule, reduced, days)}に減らします（${MIN_SLOT_GAP_MINUTES}分以上の間隔で入る件数です。${what}の外には投稿しません）`;
  const windowDocs = contributors(merged, docs, 'post_window');
  const baseHours = (day: WeekdayKey): TimeRange[] => base.schedule.business_hours?.[day] ?? [UNRESTRICTED];

  const hourIssues: InstructionIssue[] = [];
  // weekday → the hours items blamed together with the window (described, and their files)
  const windowDays = new Map<number, { text: string; file: string }[]>();
  for (const day of [...base.schedule.active_weekdays].sort((a, b) => a - b)) {
    const message = shortage(schedule, [day]);
    if (message === null) continue;
    const key = String(day) as WeekdayKey;
    const hourDocs = contributors(merged, docs, `business_hours.${key}`);
    let blame: Blame[] = hourDocs.length > 0 ? ['hours'] : windowDocs.length > 0 ? ['window'] : [];
    // Only the combination is too short: neither item can be blamed alone, so both are.
    let together = false;
    if (hourDocs.length > 0 && windowDocs.length > 0) {
      const hoursAlone = shortage({ ...schedule, post_start: base.schedule.post_start, post_end: base.schedule.post_end }, [day]) !== null;
      const windowAlone = shortage({ ...schedule, business_hours: { ...schedule.business_hours!, [key]: baseHours(key) } }, [day]) !== null;
      together = !hoursAlone && !windowAlone;
      blame = together ? ['hours', 'window'] : [...(hoursAlone ? ['hours' as const] : []), ...(windowAlone ? ['window' as const] : [])];
    }
    if (blame.includes('hours')) {
      for (const d of hourDocs) {
        const value = d.business_hours[key]!;
        const partner = together ? `と ${windowDocs.map((w) => `${w.file} の投稿時間（${w.post_window!.start}-${w.post_window!.end}）`).join('、')}を合わせる` : 'を反映する';
        const related = together ? windowDocs.map((w) => w.file) : [];
        const text = `この指示（${WEEKDAY_JA[key]}の営業時間 ${describeRanges(value.ranges)}）${partner}と投稿枠が足りません。${message}`;
        hourIssues.push(capacityIssue(d, value.line, `business_hours.${key}`, text, keep('営業時間', [key]), related));
      }
    }
    if (blame.includes('window')) {
      windowDays.set(day, together ? hourDocs.map((d) => ({ text: `${d.file} の${WEEKDAY_JA[key]}の営業時間（${describeRanges(d.business_hours[key]!.ranges)}）`, file: d.file })) : []);
    }
  }

  const windowIssues: InstructionIssue[] = [];
  if (windowDays.size > 0) {
    const days = [...windowDays.keys()];
    const message = validateScheduleCapacity({ ...schedule, active_weekdays: days }).join('');
    const partners = [...windowDays.values()].flat();
    const texts = [...new Set(partners.map((p) => p.text))];
    for (const d of windowDocs) {
      const w = d.post_window!;
      const partner = texts.length > 0 ? `と ${texts.join('、')}を合わせる` : 'を反映する';
      const text = `この指示（投稿時間 ${w.start}-${w.end}）${partner}と投稿枠が足りません。${message}`;
      windowIssues.push(capacityIssue(d, w.line, 'post_window', text, keep('投稿時間', days.map((day) => String(day) as WeekdayKey)), partners.map((p) => p.file)));
    }
  }
  return [...hourIssues, ...windowIssues];
}

function capacityIssue(doc: ParsedInstruction, line: number, item: string, message: string, note: string, related: readonly string[]): InstructionIssue {
  const partners = [...new Set(related)].filter((f) => f !== doc.file).sort();
  return { code: CAPACITY_REDUCED_CODE, file: doc.file, line, item, message: `${at(doc.file, line)}: ${message}`, note, related_files: partners };
}

// ---------------------------------------------------------------- conflicts that have no effect, readiness

/**
 * A same-priority conflict on an item that a document of higher priority sets anyway: it changes nothing, so it is
 * explained rather than counted as a failure. `priorityOf` gives the priority of the conflicting file.
 */
export function isOverriddenConflict(issue: InstructionIssue, applied: readonly AppliedRef[], priorityOf: (file: string) => number | null): boolean {
  if (issue.code !== 'INSTRUCTION_CONFLICT' || issue.item === null || !OVERRIDE_ITEM.test(issue.item)) return false;
  const priority = priorityOf(issue.file);
  return priority !== null && applied.some((a) => a.priority > priority && a.items.includes(issue.item!));
}

/** The priority of a file's document as the scan saw it: its current content, else the version that applied. */
export function priorityLookup(scan: Pick<InstructionScanResult, 'files' | 'applied'>): (file: string) => number | null {
  return (file) => scan.files.find((f) => f.name === file)?.priority ?? scan.applied.find((a) => a.file === file)?.priority ?? null;
}

/**
 * Live readiness on the effective routes (spec 5.11): a URL set by an instruction counts as configured, and an instruction
 * URL that cannot be used now (failed checks or conflicts, with no URL from the files involved in effect) is a readiness
 * item of its route. Not items: problems of documents that have not started yet (upcoming_from), conflicts a higher
 * priority overrides, and items a named file still applies (its last valid content under P2-R2, or the standing file of
 * a conflict settled at a period start); status lists those under the instructions.
 */
export function effectiveReadiness(
  effective: EffectiveConfig,
  scan: Pick<InstructionScanResult, 'issues' | 'applied' | 'files'> | null,
  /** The .env AI stages (loadAiSetup); settings.json alone when omitted. */
  ai?: AiConfigResult,
  opts: Pick<ReadinessOptions, 'now' | 'policy' | 'acceptMockAi'> = {},
): { global: ReadinessItem[]; routes: Record<RouteKey, ReadinessItem[]> } {
  const r = checkLiveReadiness(effective.base, { routes: effective.routes, ai, ...opts });
  if (scan === null) return r;
  const priorityOf = priorityLookup(scan);
  for (const issue of scan.issues) {
    if (issue.code !== 'INSTRUCTION_INVALID' && issue.code !== 'INSTRUCTION_CONFLICT') continue;
    if (issue.upcoming_from !== undefined) continue;
    const key = issue.item?.startsWith('routes.') === true ? (issue.item.slice('routes.'.length) as RouteKey) : null;
    if (key === null || !ROUTE_KEYS.includes(key) || isOverriddenConflict(issue, scan.applied, priorityOf)) continue;
    if (!effective.audiences.includes(key.split('.')[1] as AudienceCategory)) continue;
    const named = new Set([issue.file, ...issue.related_files]);
    if (scan.applied.some((a) => named.has(a.file) && a.items.includes(`routes.${key}`))) continue;
    const note = issue.note === null ? '' : `（${issue.note}）`;
    r.routes[key].push({ code: issue.code, detail: `作業指示書の投稿先URLを反映できません: ${issue.message}${note}` });
  }
  return r;
}

/** All post type × audience pairs, in display order. */
export const CELLS: readonly { type: PostType; audience: AudienceCategory }[] = POST_TYPES.flatMap((type) => AUDIENCE_CATEGORIES.map((audience) => ({ type, audience })));
