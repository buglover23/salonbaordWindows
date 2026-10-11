import { join } from 'node:path';
import { aiConfigStatus, aiConfigStatusLines, type AiConfigStatus } from './ai/ai-config.js';
import { loadAiSetup, type AiSetup } from './ai/ai-setup.js';
import { loadConfig, type ConfigIssue, type ConfigSnapshot } from './config/loader.js';
import { readinessWarnings, type checkLiveReadiness, type ReadinessItem, type RouteKey } from './config/readiness.js';
import {
  buildEffectiveConfig,
  CELLS,
  effectiveReadiness,
  isOverriddenConflict,
  priorityLookup,
  scheduleCapacityIssues,
  type EffectiveConfig,
  type RouteSource,
} from './content/effective-config.js';
import { sortItems } from './content/instructions/merge.js';
import {
  CAPACITY_REDUCED_CODE,
  ROUTE_LABELS,
  WEEKDAY_KEYS,
  type InstructionIssue,
  type InstructionPeriod,
  type InstructionScope,
  type TimeRange,
} from './content/instructions/parse.js';
import { InstructionManager, type InstructionScanResult } from './content/instructions/store.js';
import { webTrendAudiences } from './content/web-trends.js';
import type { CountsFileState } from './config/counts-file.js';
import { handledAudiences, type Settings } from './config/schemas.js';
import { SLOT_STATES, ScheduleStore, type SlotState } from './execution/schedule-store.js';
import { buildDailySlots, countsFor, dayScheduleHash, effectiveWindows, MIN_SLOT_GAP_MINUTES, planRemainingSlots, slotExpiry, type PlanSchedule } from './execution/slots.js';
import { blockingUnresolved } from './execution/scheduler.js';
import { loggerFrom, redactUrl } from './logger.js';
import { DRY_RUN_JA, firstPostState, gateRefusals } from './posting/gates.js';
import { profileHash } from './posting/profile-hash.js';
import { oursPostedFrom, remainingQuota, unresolvedFrom, type QuotaResult } from './posting/quota.js';
import { operatorActions } from './posting/reconcile.js';
import { systemClock, type Clock } from './shared/clock.js';
import { errorText } from './shared/errors.js';
import { AUDIENCE_JA, POST_TYPE_JA } from './shared/labels.js';
import { formatJst, jstDateKey, jstIsoWeekday, jstToUtc } from './shared/time.js';
import { AUDIENCE_CATEGORIES, JOB_STATUSES, POST_TYPES, type AudienceCategory, type JobStatus, type Mode, type PostType } from './shared/types.js';
import { defaultIsPidAlive } from './storage/app-lock.js';
import { RECOVERY_HALT_MESSAGES_JA, type RecoveryHaltReason } from './storage/bundles.js';
import { stopDto } from './posting/stops.js';
import type { PreflightResult } from './shared/protocol/results.js';
import type { ResourcesDto, StatusBody, StopDto } from './shared/protocol/status.js';
import { ControlStore, type ControlState } from './storage/control-store.js';
import { DedupeStore } from './storage/dedupe-store.js';
import { JobStore, type JobSummary } from './storage/job-store.js';
import { envDirOf, resolveDataPaths } from './storage/paths.js';
import { haltCode, readRuntimeStatus, type RuntimeStatus } from './storage/runtime-status.js';
import { SerialQueue } from './storage/serial-queue.js';
import { contentLines, readContentStatus, type ContentStatus } from './status-content.js';

export interface StatusSnapshot {
  mode: Mode;
  paused: boolean;
  pause_reason: string | null;
  /** JST date, YYYY-MM-DD. */
  today: string;
  /** When the snapshot was taken, JST `YYYY-MM-DD HH:mm`. */
  checked_at_jst: string;
  /** false: today's plan file does not exist yet, so `slots` are the ones the schedule would create. */
  plan_exists: boolean;
  /**
   * Today's plan was built for another schedule (instructions or config changed since): the running tool rebuilds its
   * future slots at its next check (a stopped one at its next start), and `slots` already show them that way.
   */
  plan_rebuild_pending: boolean;
  slots: Record<PostType, Record<SlotState, number> & { target: number }>;
  next_slot_at_jst: string | null;
  jobs_by_status: Partial<Record<JobStatus, number>>;
  /** The newest FAILED jobs (at most MAX_FAILED_LISTED): what failed and whether `retry` can take it. */
  failed_jobs: FailedJob[];
  live_readiness: ReturnType<typeof checkLiveReadiness> | null;
  /**
   * Jobs whose interrupted move could not be recovered, so nothing is dispatched (reason: a RecoveryHaltReason).
   * In-process: the running loop's list. Read-only `status`: the list in runtime-status.json.
   */
  recovery_halted: { job_id: string; reason: string }[];
  /** Jobs with an unfinished move or copy that are not (yet) among `recovery_halted`. */
  unfinished_operations: string[];
  /** runtime-status.json (R25): the running process's, or the last run's, dispatch state; null when there is none. */
  runtime_record: RuntimeStatus | null;
  /** Why runtime-status.json could not be read; null otherwise. */
  runtime_record_error: string | null;
  /** The record says running, but its process no longer exists: that run was hard-killed (read-only `status` only). */
  runtime_process_gone: boolean;
  /** The latest config edit that was rejected (the previous valid config stays active). */
  config_issues: ConfigIssue[];
  /** Where the counts and coupons come from in a one-audience copy (件数とクーポン（…）.txt); null when the copy handles both. */
  counts_file?: (CountsFileState & { style: number; blog: number; coupon_default: string | null; coupon_categories: number }) | null;
  /** The instruction folder (spec 5.10): what applies and why something does not; null when it could not be read. */
  instructions: InstructionStatus | null;
  /** Why the instruction folder could not be read; null otherwise. */
  instructions_error: string | null;
  /** The instruction folder's name: 設定 in the shared layout (settings.shared_root); omitted: instructions. */
  instructions_folder?: string;
  /** Plan 2: AI usage and stop, templates, trends, verified menus; null when not gathered. */
  content: ContentStatus | null;
  /** Why the content status could not be gathered; null otherwise. */
  content_error: string | null;
  /** Per AI stage: service, model, masked key, free tier, endpoint (.env and settings.json); null when not read. */
  ai: { config: AiConfigStatus; dry_run_use_real_ai: boolean; consistency_check: Settings['ai']['consistency_check'] } | null;
  /** The stops of new posting kept in control.json (P1-R25 deviation: shown by the offline status too). */
  stops: StopDto[];
  /**
   * Plan 3: the StatusDto body (CLI and popup) as the stores and config show it. The running tool's API replaces dispatch,
   * extension and warnings with its own view.
   */
  dto: StatusBody;
}

/**
 * not_applied: the item is not applied (or runs on the last valid content); reduced: applied with fewer posts that weekday
 * (Ruling P2-R11); upcoming: from a future date; no_effect: overridden.
 */
export type InstructionProblemKind = 'not_applied' | 'reduced' | 'upcoming' | 'no_effect';

export interface InstructionStatus {
  /** When the folder was read (JST YYYY-MM-DD HH:mm). */
  checked_at_jst: string;
  /** runtime: the running tool's latest check; status: read again by the status command itself (nothing written). */
  source: 'runtime' | 'status';
  effective_hash: string;
  /** Files contributing now, with the items they actually set (applied[].items). */
  applied: {
    file: string;
    /** sha256 of the content version shown (the current one when it applies, else the last valid one). */
    sha256: string;
    priority: number;
    period: InstructionPeriod;
    scope: InstructionScope;
    items: string[];
    items_ja: string;
    /** Items taken from the file's last valid content (Ruling P2-R2). */
    last_valid_items: string[];
  }[];
  upcoming: { file: string; start: string | null }[];
  disabled: string[];
  /** Files still being written: their previous content (if any) is used meanwhile. */
  pending: string[];
  /** Per ISO weekday after the overlay; ranges null = no business-hours limit (the post window only). */
  business_hours: { weekday: number; ranges: TimeRange[] | null; files: string[] }[];
  post_window: { start: string; end: string; files: string[] };
  /**
   * Ruling P2-R11: weekdays whose instructed hours / post window cannot hold the configured counts with the minimum gap,
   * with the counts used instead and the files setting those hours or that window.
   */
  reduced_counts: { weekday: number; configured: Record<PostType, number>; counts: Record<PostType, number>; files: string[] }[];
  /** Days from today through the next 13 without any posting window, as the current instructions and config stand. */
  closed_days: { date: string; reason: string }[];
  keywords: { post_type: PostType; audience: AudienceCategory; words: string[]; files: string[] }[];
  excluded_keywords: string[];
  /** Never the URL itself (spec 5.11: secrets are not shown). source null: no URL configured. handled false: settings.audiences leaves it out. */
  routes: { key: RouteKey; source: RouteSource | null; files: string[]; handled?: false }[];
  problems: (InstructionIssue & { kind: InstructionProblemKind })[];
  /** Lines left out (INSTRUCTION_IGNORED_CONTENT); everything else in those files applies. */
  warnings: InstructionIssue[];
}

export interface StatusSources {
  mode: Mode;
  config: ConfigSnapshot;
  jobs: Pick<JobStore, 'summaries' | 'get'>;
  control: Pick<ControlStore, 'get'>;
  /** Our posts, for the remaining quota (live); omitted: none. */
  dedupe?: Pick<DedupeStore, 'records'>;
  schedules: Pick<ScheduleStore, 'load'>;
  clock: Clock;
  recoveryHalted?: readonly { job_id: string; reason: string }[];
  runtimeRecord?: RuntimeStatus | null;
  runtimeRecordError?: string | null;
  /** Probes the pid of a record that says running. Omitted (in-process status: the record is this process's own): not probed. */
  isPidAlive?: (pid: number) => boolean;
  configIssues?: readonly ConfigIssue[];
  /** The latest instruction scan (the running tool's, or one made read-only for this status); omitted: no instructions. */
  instructions?: { scan: InstructionScanResult | null; source: 'runtime' | 'status'; error?: string | null };
  /** Plan 2 content status (AI, templates, trends); omitted: not shown. */
  content?: () => Promise<ContentStatus>;
  /** The AI stages (.env and settings.json); omitted: not shown. */
  ai?: AiSetup;
}

type StatusSlot = { post_type: PostType; state: SlotState; scheduled_at: string; job_id?: string | null };

const byTime = (a: StatusSlot, b: StatusSlot): number => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at);

/**
 * What the next tick will make of the open slots whose time has come (Scheduler, R22, R26): only the latest one still
 * within its grace time and its posting window stays open, every other one is skipped. Shown that way so a stopped tool
 * does not report lost slots as still to come. Nothing is written.
 */
function projectDue(slots: readonly StatusSlot[], now: Date, schedule: PlanSchedule): StatusSlot[] {
  const due = slots.filter((s) => s.state === 'open' && Date.parse(s.scheduled_at) <= now.getTime()).sort(byTime);
  const latest = due[due.length - 1];
  const keep = latest !== undefined && slotExpiry(schedule, latest.scheduled_at, now) === null ? latest : undefined;
  const lost = new Set(due.filter((s) => s !== keep));
  return slots.map((s) => (lost.has(s) ? { ...s, state: 'skipped' } : s));
}

function targetOf(today: string, schedule: PlanSchedule, type: PostType): number {
  if (effectiveWindows(today, schedule).length === 0) return 0;
  return countsFor(today, schedule)[type];
}

// ---------------------------------------------------------------- instructions (spec 5.10: 適用中の指示書 / 反映した値 / 未反映理由)

const CLOSED_DAYS_AHEAD = 14;
const ROUTE_KEYS = Object.keys(ROUTE_LABELS) as RouteKey[];
const WEEKDAY_SHORT: Record<string, string> = { '1': '月', '2': '火', '3': '水', '4': '木', '5': '金', '6': '土', '7': '日' };
const isUnrestricted = (ranges: readonly TimeRange[]): boolean => ranges.length === 1 && ranges[0]!.start === '00:00' && ranges[0]!.end === '23:59';
const cellJa = (type: PostType, audience: AudienceCategory): string => `${POST_TYPE_JA[type]}×${AUDIENCE_JA[audience]}`;

/** Japanese summary of applied items, e.g. 「営業時間（火・水）、臨時休業、検索ワード（スタイル×メンズ）」. */
export function instructionItemsJa(items: readonly string[]): string {
  const has = new Set(items);
  const parts: string[] = [];
  const days = WEEKDAY_KEYS.filter((d) => has.has(`business_hours.${d}`)).map((d) => WEEKDAY_SHORT[d]);
  if (days.length > 0) parts.push(`営業時間（${days.join('・')}）`);
  if (has.has('closed_dates')) parts.push('臨時休業');
  if (has.has('post_window')) parts.push('投稿時間');
  const cells = (prefix: string): string => {
    const hit = CELLS.filter((c) => has.has(`${prefix}.${c.type}.${c.audience}`));
    return hit.length === CELLS.length ? 'すべての投稿' : hit.map((c) => cellJa(c.type, c.audience)).join('、');
  };
  if (CELLS.some((c) => has.has(`keywords.${c.type}.${c.audience}`))) parts.push(`検索ワード（${cells('keywords')}）`);
  if (has.has('excluded_keywords')) parts.push('除外検索ワード');
  if (CELLS.some((c) => has.has(`writing_policies.${c.type}.${c.audience}`))) parts.push(`文章方針（${cells('writing_policies')}）`);
  const routes = ROUTE_KEYS.filter((k) => has.has(`routes.${k}`)).map((k) => ROUTE_LABELS[k]);
  if (routes.length > 0) parts.push(`投稿先URL（${routes.join('、')}）`);
  return parts.join('、');
}

function instructionStatus(scan: InstructionScanResult, source: 'runtime' | 'status', effective: EffectiveConfig, today: string): InstructionStatus {
  const filesWith = (item: string): string[] => [...new Set(scan.applied.filter((a) => a.items.includes(item)).map((a) => a.file))].sort();
  const schedule = effective.schedule;

  const byFile = new Map<string, typeof scan.applied>();
  for (const a of scan.applied) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  const applied = [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, refs]) => {
      const record = scan.files.find((f) => f.name === file);
      const main = refs.find((r) => r.sha256 === record?.sha256) ?? refs[0]!;
      const items = sortItems(refs.flatMap((r) => r.items));
      return {
        file,
        sha256: main.sha256,
        priority: main.priority,
        period: { ...main.period },
        scope: { ...main.scope },
        items,
        items_ja: instructionItemsJa(items),
        last_valid_items: [...(record?.last_valid_in_use?.items ?? [])],
      };
    });

  const businessHours = WEEKDAY_KEYS.map((d) => {
    const files = filesWith(`business_hours.${d}`);
    const ranges = schedule.business_hours?.[d];
    const open = ranges === undefined || (files.length === 0 && isUnrestricted(ranges));
    return { weekday: Number(d), ranges: open ? null : ranges.map((r) => ({ ...r })), files };
  });

  const configured = { style: schedule.style_posts_per_day, blog: schedule.blog_posts_per_day };
  const reducedCounts = WEEKDAY_KEYS.flatMap((d) => {
    const counts = schedule.day_counts?.[d];
    if (counts === undefined) return [];
    const files = [...new Set([...filesWith(`business_hours.${d}`), ...filesWith('post_window')])].sort();
    return [{ weekday: Number(d), configured: { ...configured }, counts: { ...counts }, files }];
  });

  const closedDays: InstructionStatus['closed_days'] = [];
  for (let i = 0; i < CLOSED_DAYS_AHEAD; i++) {
    const date = jstDateKey(jstToUtc(today, i * 24 * 60));
    if (effectiveWindows(date, schedule).length > 0) continue;
    const weekday = String(jstIsoWeekday(date)) as (typeof WEEKDAY_KEYS)[number];
    const hourFiles = filesWith(`business_hours.${weekday}`);
    let reason: string;
    if (effective.overlay.closed_dates_add.includes(date)) reason = `臨時休業（作業指示書: ${filesWith('closed_dates').join('、')}）`;
    else if (effective.base.schedule.closed_dates.includes(date)) reason = '休業日（schedule.json の closed_dates）';
    else if (!schedule.active_weekdays.includes(Number(weekday))) reason = '投稿しない曜日（schedule.json の active_weekdays）';
    else if (schedule.business_hours?.[weekday].length === 0) reason = hourFiles.length > 0 ? `休業（作業指示書: ${hourFiles.join('、')}）` : '休業（schedule.json の business_hours）';
    else reason = '営業時間と投稿時間が重なりません';
    closedDays.push({ date, reason });
  }

  const priorityOf = priorityLookup(scan);
  const problems = scan.issues.map((issue) => {
    const kind: InstructionProblemKind = isOverriddenConflict(issue, scan.applied, priorityOf)
      ? 'no_effect'
      : issue.upcoming_from !== undefined
        ? 'upcoming'
        : issue.code === CAPACITY_REDUCED_CODE
          ? 'reduced'
          : 'not_applied';
    return { ...issue, related_files: [...issue.related_files], kind };
  });

  return {
    checked_at_jst: formatJst(new Date(scan.scanned_at)),
    source,
    effective_hash: scan.effective_hash,
    applied,
    upcoming: scan.files.filter((f) => f.state === 'upcoming').map((f) => ({ file: f.name, start: f.period?.start ?? null })),
    disabled: scan.files.filter((f) => f.state === 'disabled').map((f) => f.name),
    pending: [...scan.pending],
    business_hours: businessHours,
    post_window: { start: schedule.post_start, end: schedule.post_end, files: filesWith('post_window') },
    reduced_counts: reducedCounts,
    closed_days: closedDays,
    keywords: CELLS.map((c) => ({ post_type: c.type, audience: c.audience, words: [...effective.keywordsFor(c.type, c.audience)], files: filesWith(`keywords.${c.type}.${c.audience}`) })),
    excluded_keywords: [...effective.excludedKeywords],
    routes: ROUTE_KEYS.map((key) => {
      const [type, audience] = key.split('.') as [PostType, AudienceCategory];
      const configured = effective.routes[type][audience].entry_url !== null;
      return { key, source: configured ? effective.routeSources[key] : null, files: filesWith(`routes.${key}`), ...(effective.audiences.includes(audience) ? {} : { handled: false as const }) };
    }),
    problems,
    warnings: scan.ignored.map((i) => ({ ...i, related_files: [...i.related_files] })),
  };
}

/** Reads only: never creates a plan, a folder or a file. */
export async function buildStatus(src: StatusSources): Promise<StatusSnapshot> {
  const now = src.clock.now();
  const today = jstDateKey(now);
  const scan = src.instructions?.scan ?? null;
  const effective = buildEffectiveConfig(src.config, scan?.overlay ?? null, scan?.applied);
  const { schedule } = effective;
  const plan = await src.schedules.load(today, src.clock);
  let planned: StatusSlot[];
  let rebuildPending = false;
  if (plan !== null) {
    planned = plan.slots;
    // As Scheduler.replanIfScheduleChanged will leave them: started, finished and due slots kept, the rest planned anew.
    if (plan.schedule_hash !== undefined && plan.schedule_hash !== dayScheduleHash(today, schedule)) {
      const kept = plan.slots.filter((s) => s.state !== 'open' || Date.parse(s.scheduled_at) <= now.getTime());
      try {
        const fresh = planRemainingSlots(today, schedule, kept, now).fresh.map((s) => ({ ...s, state: 'open' as const }));
        planned = [...kept, ...fresh];
        rebuildPending = true;
      } catch {
        // shown as stored
      }
    }
  } else {
    try {
      planned = buildDailySlots(today, schedule).map((s) => ({ ...s, state: 'open' as const }));
    } catch {
      planned = [];
    }
  }
  const slots = projectDue(planned, now, schedule);

  const counts = Object.fromEntries(
    POST_TYPES.map((t) => [t, { ...Object.fromEntries(SLOT_STATES.map((s) => [s, 0])), target: targetOf(today, schedule, t) }]),
  ) as StatusSnapshot['slots'];
  for (const s of slots) counts[s.post_type][s.state] += 1;
  const next = slots.filter((s) => s.state === 'open').sort(byTime)[0];

  const jobsByStatus: Partial<Record<JobStatus, number>> = {};
  const halted = (src.recoveryHalted ?? []).map((h) => ({ ...h }));
  const haltedIds = new Set(halted.map((h) => h.job_id));
  const unfinished: string[] = [];
  const summaries = src.jobs.summaries();
  for (const s of summaries) {
    jobsByStatus[s.status] = (jobsByStatus[s.status] ?? 0) + 1;
    if (s.has_operation && !haltedIds.has(s.id)) unfinished.push(s.id);
  }
  const control = src.control.get();
  const rec = src.runtimeRecord ?? null;
  const processGone = rec !== null && rec.stopped_at === null && src.isPidAlive !== undefined && !src.isPidAlive(rec.pid);
  let content: ContentStatus | null = null;
  let contentError: string | null = null;
  if (src.content !== undefined) {
    try {
      content = await src.content();
    } catch (err) {
      contentError = errorText(err);
    }
  }
  const readiness = src.mode === 'live' ? effectiveReadiness(effective, scan, src.ai?.config, { now }) : null;
  const configIssues = (src.configIssues ?? []).map((i) => ({ ...i }));

  return {
    mode: src.mode,
    paused: control.paused,
    pause_reason: control.pause_reason,
    today,
    checked_at_jst: formatJst(now),
    plan_exists: plan !== null,
    plan_rebuild_pending: rebuildPending,
    slots: counts,
    next_slot_at_jst: next === undefined ? null : formatJst(new Date(next.scheduled_at)),
    jobs_by_status: jobsByStatus,
    failed_jobs: failedJobs(src.jobs),
    live_readiness: readiness,
    recovery_halted: halted,
    unfinished_operations: unfinished,
    runtime_record: rec === null ? null : structuredClone(rec),
    runtime_record_error: src.runtimeRecordError ?? null,
    runtime_process_gone: processGone,
    config_issues: configIssues,
    counts_file:
      src.config.countsFile === undefined
        ? null
        : {
            ...src.config.countsFile,
            issues: [...src.config.countsFile.issues],
            style: src.config.schedule.style_posts_per_day,
            blog: src.config.schedule.blog_posts_per_day,
            coupon_default: src.config.salon.coupons.default,
            coupon_categories: Object.keys(src.config.salon.coupons.by_category).length,
          },
    instructions: scan === null || src.instructions === undefined ? null : instructionStatus(scan, src.instructions.source, effective, today),
    instructions_error: src.instructions?.error ?? null,
    instructions_folder: src.config.settings.shared_root === null ? 'instructions' : '設定',
    content,
    content_error: contentError,
    ai:
      src.ai === undefined
        ? null
        : {
            config: aiConfigStatus(src.ai.config, src.ai.envFile),
            dry_run_use_real_ai: src.config.settings.ai.dry_run_use_real_ai,
            consistency_check: src.config.settings.ai.consistency_check,
          },
    stops: control.stops.map(stopDto),
    dto: await statusDto(src, { now, today, effective, slots, counts, summaries, control, readiness, halted, configIssues, rec }),
  };
}

const OUTSIDE_NOTE_JA = '手動の投稿や他の端末からの投稿は余裕枠でしか考慮していません';

function quotaView(limits: ConfigSnapshot['deploymentChecks']['posting_limits'][PostType], q: QuotaResult): StatusBody['per_type'][PostType]['quota'] {
  if (q.kind === 'unknown') return { remaining: null, limiting_kind: null, reason_ja: q.reason_ja };
  if (q.kind === 'reached') return { remaining: 0, limiting_kind: q.limiting, reason_ja: q.reason_ja };
  // Only our own count of the day or month: posts made outside the tool show through the margin alone (P3-R9).
  const uncounted = (limits.daily.status === 'limited' && limits.daily_count === null) || (limits.monthly.status === 'limited' && limits.monthly_count === null);
  return { remaining: q.remaining, limiting_kind: q.limiting, reason_ja: q.remaining !== null && uncounted ? OUTSIDE_NOTE_JA : null };
}

/** The StatusDto body from the same sources (§6.6). The running tool replaces dispatch, extension and warnings. */
async function statusDto(
  src: StatusSources,
  x: {
    now: Date;
    today: string;
    effective: EffectiveConfig;
    slots: readonly StatusSlot[];
    counts: StatusSnapshot['slots'];
    summaries: readonly JobSummary[];
    control: ControlState;
    readiness: StatusSnapshot['live_readiness'];
    halted: readonly { job_id: string; reason: string }[];
    configIssues: readonly ConfigIssue[];
    rec: RuntimeStatus | null;
  },
): Promise<StatusBody> {
  const { now, effective, control, summaries } = x;
  const config = effective.base;
  const jobStatus = new Map(summaries.map((s) => [s.id, s.status]));
  const n = (st: JobStatus): number => summaries.filter((s) => s.status === st).length;
  const records = src.dedupe?.records() ?? [];
  const perType = (t: PostType): StatusBody['per_type'][PostType] => {
    const c = x.counts[t];
    const mine = x.slots.filter((s) => s.post_type === t);
    const next = mine.filter((s) => s.state === 'open').sort(byTime)[0];
    const limits = config.deploymentChecks.posting_limits[t];
    return {
      target: c.target,
      done: c.done,
      reserved: c.reserved,
      unknown: mine.filter((s) => s.state === 'reserved' && s.job_id != null && jobStatus.get(s.job_id) === 'VERIFY_REQUIRED').length,
      shortfall: Math.max(0, c.target - c.done - c.reserved - c.open),
      next_at_jst: next === undefined ? null : formatJst(new Date(next.scheduled_at)),
      quota:
        src.mode === 'live'
          ? quotaView(limits, remainingQuota({ limits, now, oursPosted: oursPostedFrom(records, t), unresolved: unresolvedFrom(summaries, t), excludeJobId: null, observed: null }))
          : { remaining: null, limiting_kind: null, reason_ja: null },
    };
  };
  const routes = Object.fromEntries(
    ROUTE_KEYS.map((key) => {
      const [t, a] = key.split('.') as [PostType, AudienceCategory];
      const r = effective.routes[t][a];
      const profile = r.page_profile_id === null ? undefined : config.salonboardFields.pages[r.page_profile_id];
      const hash = profile === undefined ? null : profileHash(profile);
      const screen =
        profile === undefined ? 'missing_profile' : profile.verified_at === null || profile.verified_hash === null ? 'unverified' : profile.verified_hash === hash ? 'verified' : 'changed_since_verification';
      return [
        key,
        {
          configured: r.entry_url !== null,
          source: r.entry_url === null ? null : effective.routeSources[key] === 'instructions' ? 'instruction' : 'config',
          url_display: r.entry_url === null ? null : redactUrl(r.entry_url).slice(0, 500),
          screen,
          first_post: firstPostState(key, control, screen === 'verified' ? hash : null),
          ...(effective.audiences.includes(a) ? {} : { not_handled: true as const }),
        },
      ];
    }),
  ) as StatusBody['routes'];
  const refusals = gateRefusals('post', {
    stopping: false,
    mode: src.mode,
    automation: config.deploymentChecks.automation,
    pressure: null,
    refreshFailed: false,
    configRejected: x.configIssues.length > 0,
    halted: x.halted.length > 0,
    paused: control.paused,
    pauseReason: control.pause_reason,
    stops: control.stops,
    readiness: x.readiness?.global ?? [],
    blockingUnresolved: blockingUnresolved(summaries, x.today),
  });
  const probe = control.probe !== null && Date.parse(control.probe.expires_at) > now.getTime() ? { armed_until_jst: formatJst(new Date(control.probe.expires_at)) } : null;
  const ext = x.rec?.extension ?? null;
  return {
    mode: src.mode,
    paused: control.paused,
    pause_reason: control.pause_reason,
    checked_at_jst: formatJst(now),
    today: x.today,
    dispatch: { post_allowed: refusals.length === 0, reasons: refusals.map((r) => ({ code: r.code, message_ja: r.reason_ja })) },
    per_type: { style: perType('style'), blog: perType('blog') },
    jobs: { failed: n('FAILED'), verify_required: n('VERIFY_REQUIRED'), retry_wait: n('RETRY_WAIT'), blocked: n('BLOCKED'), ready: n('READY'), generating: n('GENERATING') },
    // Whether the extension is there now only the running tool knows; this is the last run's record of it.
    extension: {
      connected: false,
      last_seen_jst: ext === null ? null : formatJst(new Date(ext.last_seen_at)),
      version: ext?.extension_version ?? null,
      logged_in: null,
      tab_state: null,
      fingerprint: control.paired_client?.fingerprint ?? null,
      paired: control.paired_client !== null,
    },
    stops: control.stops.map(stopDto),
    recovery_halted: x.halted.map((h) => ({ job_id: h.job_id, reason_ja: RECOVERY_HALT_MESSAGES_JA[h.reason as RecoveryHaltReason] ?? h.reason })),
    config_rejected: x.configIssues.map((i) => ({ file: i.file, message: i.message })),
    readiness: x.readiness,
    routes,
    live_single:
      control.live_single === null ? null : { route_key: control.live_single.route_key, job_id: control.live_single.job_id, armed_at_jst: formatJst(new Date(control.live_single.armed_at)) },
    preflight: control.pending_preflight?.result ?? null,
    probe,
    operator_actions: await operatorActions(src.jobs, src.control),
    warnings: [
      ...readinessWarnings(config),
      ...(probe === null ? [] : [`画像添付の確認を ${probe.armed_until_jst} まで受け付けています。SALON BOARD の投稿画面（新しい入力画面）を開き、拡張機能の「画像添付の確認」を押してください。登録ボタンは押しません。`]),
    ],
    resources: null,
  };
}

export interface FailedJob {
  job_id: string;
  post_type: PostType;
  audience_category: AudienceCategory;
  error_code: string | null;
  /** The first sentence of the error message. */
  reason: string | null;
  /** `npm.cmd run retry` can take it (nothing was submitted and the image could be read). */
  retryable: boolean;
}

const MAX_FAILED_LISTED = 10;

function failedJobs(jobs: Pick<JobStore, 'summaries'>): FailedJob[] {
  return jobs
    .summaries((s) => s.status === 'FAILED')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || (a.id < b.id ? 1 : -1))
    .slice(0, MAX_FAILED_LISTED)
    .map((s) => {
      const message = s.failure?.message ?? null;
      const end = message === null ? -1 : message.indexOf('。');
      return {
        job_id: s.id,
        post_type: s.post_type,
        audience_category: s.audience_category,
        error_code: s.failure?.code ?? null,
        reason: message === null ? null : end >= 0 ? message.slice(0, end + 1) : message,
        retryable: s.never_submitted && !s.has_operation && s.failure?.code !== 'IMAGE_INVALID',
      };
    });
}

export type ReadStatusResult = { ok: true; status: StatusSnapshot } | { ok: false; issues: ConfigIssue[] };

/**
 * The `status` command: reads the config and the data of the configured mode without the lock and without writing
 * anything (no folders are created). The dispatch state comes from runtime-status.json, written by the process that holds
 * the lock (R25); a record that says running is checked against its pid (`isPidAlive`, default: only ESRCH means gone).
 * A damaged data file throws STATE_CORRUPT; a damaged runtime-status.json is only reported.
 */
export async function readStatus(
  projectRoot: string,
  clock: Clock = systemClock,
  opts: { isPidAlive?: (pid: number) => boolean } = {},
): Promise<ReadStatusResult> {
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  const config = loaded.snapshot;
  const paths = resolveDataPaths(projectRoot, config.settings);
  const queue = new SerialQueue(); // required by the stores; nothing here writes
  const jobs = await JobStore.open(paths, queue, clock);
  const control = await ControlStore.load(paths, queue, clock);
  const dedupe = await DedupeStore.load(paths, queue, clock);
  const schedules = new ScheduleStore(paths, queue, clock);
  const runtime = await readRuntimeStatus(paths);
  const runtimeRecord = runtime.kind === 'ok' ? runtime.value : null;
  const runtimeRecordError = runtime.kind === 'corrupt' || runtime.kind === 'unreadable' ? runtime.reason : null;
  // Read again here, without writing data/instructions.json; its last valid contents are used as the running tool would.
  const manager = new InstructionManager({
    dir: paths.instructionsDir,
    recordFile: paths.instructionsFile,
    config: () => config,
    logger: loggerFrom(() => undefined),
    readOnly: true,
    validate: scheduleCapacityIssues,
  });
  let scan: InstructionScanResult | null = null;
  let instructionsError: string | null = null;
  try {
    scan = await manager.scan(clock.now());
  } catch (err) {
    instructionsError = errorText(err);
  }
  // Probed once per pid: the halt display and the AI stop below ask the same question.
  const probe = opts.isPidAlive ?? defaultIsPidAlive;
  const probed = new Map<number, boolean>();
  const isPidAlive = (pid: number): boolean => {
    if (!probed.has(pid)) probed.set(pid, probe(pid));
    return probed.get(pid) === true;
  };
  const running = runtimeRecord !== null && runtimeRecord.stopped_at === null && isPidAlive(runtimeRecord.pid);
  const ai = await loadAiSetup(envDirOf(projectRoot, config.settings), config.settings.ai);
  const status = await buildStatus({
    mode: config.settings.mode,
    config,
    jobs,
    control,
    dedupe,
    schedules,
    clock,
    recoveryHalted: runtimeRecord?.halted ?? [],
    runtimeRecord,
    runtimeRecordError,
    isPidAlive,
    instructions: { scan, source: 'status', error: instructionsError },
    ai,
    content: () =>
      readContentStatus(projectRoot, config, paths, clock, { record: runtimeRecord, running }, ai, webTrendAudiences(buildEffectiveConfig(config, scan?.overlay ?? null, scan?.applied).routes, handledAudiences(config.settings))),
  });
  return { ok: true, status };
}

// ---------------------------------------------------------------- Japanese text

const MODE_JA: Record<Mode, string> = {
  dry_run: 'dry-run（テスト運転。SALON BOARD には何も送信しません）',
  live: '本番（live）',
};
const SLOT_JA: readonly [SlotState, string][] = [
  ['done', '完了'],
  ['reserved', '予約中'],
  ['open', 'これから'],
  ['missed', '欠席'],
  ['skipped', '見送り'],
  ['failed', '失敗'],
];
export const JOB_STATUS_JA: Record<JobStatus, string> = {
  PENDING: '準備待ち',
  ANALYZING: '画像解析中',
  GENERATING: '文章作成中',
  VALIDATING: '検査中',
  READY: '投稿待ち',
  POSTING: '投稿中',
  VERIFYING: '登録確認中',
  POSTED: '投稿済み',
  FAILED: '失敗',
  RETRY_WAIT: '再試行待ち',
  BLOCKED: '保留',
  VERIFY_REQUIRED: '結果不明（要確認）',
};
const ROUTES: readonly [RouteKey, string][] = POST_TYPES.flatMap((t) =>
  AUDIENCE_CATEGORIES.map((a): [RouteKey, string] => [`${t}.${a}`, `${POST_TYPE_JA[t]}・${AUDIENCE_JA[a]}`]),
);

/** One config problem per line: `<file> <path>: <message>` (`<file>: <message>` for the whole file). */
export function formatConfigIssue(i: ConfigIssue): string {
  return i.path === '' ? `${i.file}: ${i.message}` : `${i.file} ${i.path}: ${i.message}`;
}

/** Each job is labelled by its own reason, with the same rule haltCode applies to the whole list. */
function haltLine(h: { job_id: string; reason: string }): string {
  const why = RECOVERY_HALT_MESSAGES_JA[h.reason as RecoveryHaltReason] ?? h.reason;
  if (haltCode([h]) === 'FILE_IO_ERROR') {
    return `  - ${h.job_id}: FILE_IO_ERROR ${why}（エクスプローラー・OneDrive・ウイルス対策ソフトなどが一時的に使用中の可能性があります）`;
  }
  return `  - ${h.job_id}: STATE_CORRUPT ${why}。ファイルには触れていません。`;
}

/** The recorded halt is in force now: the run that wrote it is (as far as can be told) still running. */
function haltInForce(s: StatusSnapshot): boolean {
  const rec = s.runtime_record;
  return rec === null || (rec.stopped_at === null && !s.runtime_process_gone);
}

/** The runtime-status.json line plus, when dispatch is (or was) halted, the jobs and what to do (R25). */
function dispatchLines(s: StatusSnapshot): string[] {
  const rec = s.runtime_record;
  const lines: string[] = [];
  if (s.runtime_record_error !== null) {
    lines.push(`稼働状態の記録（runtime-status.json）を読み取れませんでした: ${s.runtime_record_error}。ログ（logs フォルダ）を確認してください。`);
  } else if (rec === null) {
    lines.push('稼働状態の記録はまだありません（このデータではまだ起動していません）。');
  } else if (rec.stopped_at !== null) {
    lines.push(`前回の稼働は ${formatJst(new Date(rec.stopped_at))} に停止しました。`);
  } else if (s.runtime_process_gone) {
    lines.push(`前回の稼働は強制終了されたようです（${formatJst(new Date(rec.updated_at))} 以降の記録がありません）。`);
  } else {
    lines.push(
      `稼働状態の記録: 動作中（${formatJst(new Date(rec.updated_at))} に更新。ツールを閉じたはずなのにこう表示される場合は、前回は途中で強制終了しています）`,
    );
  }
  const code = haltCode(s.recovery_halted);
  if (code === null) return lines;
  lines.push(
    haltInForce(s)
      ? `【重要】投稿の配布を止めています（${code}）。原因のjob:`
      : `停止時、投稿の配布を止めていました（${code}）。次の起動でも原因が残っていれば配布しません。原因のjob:`,
    ...s.recovery_halted.map(haltLine),
  );
  if (new Set(s.recovery_halted.map((h) => haltCode([h]))).size > 1) {
    lines.push(
      `  ※ 各jobの理由はそれぞれ表示しています。全体の分類は ${code} です（ファイルの読み書きの失敗だけなら FILE_IO_ERROR、それ以外の原因が1件でもあれば STATE_CORRUPT）。`,
    );
  }
  lines.push('  対処: images/failed（dry-run では dry-run/images/failed）とログ（logs フォルダ）で原因を確認し、原因を取り除いてからツールを再起動してください。');
  return lines;
}

function slotLines(s: StatusSnapshot): string[] {
  const lines = [`本日（${s.today}）の投稿枠:`];
  if (!s.plan_exists) lines.push('  ※本日の計画はまだ作られていません（設定から見込んだ枠を表示しています）');
  if (s.plan_rebuild_pending) lines.push('  ※本日の残りの枠は、作業指示書・設定の変更に合わせて次の確認で組み直されます（組み直した後の見込みを表示しています）');
  for (const type of POST_TYPES) {
    const c = s.slots[type];
    const shortfall = Math.max(0, c.target - c.done - c.reserved - c.open);
    const parts = [`目標 ${c.target}`, ...SLOT_JA.map(([state, label]) => `${label} ${c[state]}`), `不足 ${shortfall}`];
    lines.push(`  ${POST_TYPE_JA[type]}: ${parts.join(' / ')}`);
  }
  lines.push('  （欠席: 投稿できる画像が無かった枠 / 見送り: 猶予時間切れなどで使わなかった枠 / 不足: 目標のうち本日はもう投稿できない数）');
  const halted = haltCode(s.recovery_halted) !== null && haltInForce(s);
  const nextNote = halted && s.next_slot_at_jst !== null ? '（投稿の配布を止めているため、このままでは投稿されません）' : '';
  lines.push(`  次回の枠: ${s.next_slot_at_jst ?? '本日の残りの枠はありません'}${nextNote}`);
  return lines;
}

/** Where this copy's counts and coupons come from (one-audience copies only). */
function countsLines(s: StatusSnapshot): string[] {
  const c = s.counts_file ?? null;
  if (c === null) return [];
  const values = `スタイル ${c.style}件・ブログ ${c.blog}件・いつものクーポン ${c.coupon_default === null ? 'なし' : `「${c.coupon_default}」`}・カテゴリー別のクーポン ${c.coupon_categories}件`;
  if (c.state === 'applied') return [`  件数とクーポン: ${c.path} の値（${values}）`];
  if (c.state === 'missing') return [`  件数とクーポン: config フォルダの schedule.json・salon.json の値（${values}。${c.path} はありません）`];
  return [
    `  件数とクーポン: ${c.path} に誤りがあるため使わず、config フォルダの schedule.json・salon.json の値で動いています（${values}）。直して保存してください:`,
    ...c.issues.map((i) => `    - ${i}`),
  ];
}

const SCREEN_JA: Record<StatusBody['routes'][RouteKey]['screen'], string> = {
  verified: '確認済み',
  changed_since_verification: '確認後に変更あり',
  unverified: '未確認',
  missing_profile: 'profileなし',
};
const FIRST_POST_JA: Record<StatusBody['routes'][RouteKey]['first_post'], string> = { done: '済み', needs_live_single: 'live:single 待ち', armed: '実行予約中' };
const PREFLIGHT_OUTCOME_JA: Record<PreflightResult['outcome'], string> = { passed: '問題はありません', failed: '問題が見つかりました', timeout: '時間内に終わりませんでした' };

/** The findings of a screen check (preflight), one line per check. */
export function preflightLines(r: PreflightResult, indent = ''): string[] {
  return [
    `${indent}画面の確認の結果: ${PREFLIGHT_OUTCOME_JA[r.outcome]}（${formatJst(new Date(r.finished_at))}）`,
    ...r.targets.flatMap((t) => t.checks.map((c) => `${indent}  ${ROUTE_LABELS[t.route_key]}: ${c.ok ? 'OK' : 'NG'} ${c.detail_ja}`)),
  ];
}

const hhmm = (jst: string, today: string): string => (jst.startsWith(today) ? jst.slice(11) : jst);

/** Plan 3 (CLI; the popup shows the same StatusDto): whether and where posts go, per type and route, the extension. */
function liveLines(d: StatusBody): string[] {
  const live = d.mode === 'live';
  // dry-run pseudo-posts on its own: what follows is how real posting would stand, not a fault of the dry-run.
  const lines = [live ? 'SALON BOARD への投稿:' : 'SALON BOARD への投稿（いまは dry-run のため送信せず、投稿枠の時刻に擬似投稿します。以下は本番にしたときの状態です）:'];
  const reasons = d.dispatch.reasons.filter((r) => r.message_ja !== DRY_RUN_JA).map((r) => `    - ${r.message_ja}`);
  if (d.dispatch.post_allowed) lines.push('  配布の状態: 投稿できます（投稿枠の時刻に1件ずつ送信します）');
  else if (live) lines.push('  配布の状態: いまは新しい投稿を送信しません。理由:', ...reasons);
  else lines.push(reasons.length === 0 ? '  本番にしたときに送信を止める理由: なし' : '  本番にしたときに送信を止める理由（本番にする前に直します）:', ...reasons);

  lines.push('  本日の投稿:');
  for (const t of POST_TYPES) {
    const p = d.per_type[t];
    const q = p.quota;
    const rest = !live ? '' : ` / 残り件数 ${q.remaining !== null ? `${q.remaining}件` : q.reason_ja === null ? '上限なし' : '不明'}`;
    lines.push(`    ${POST_TYPE_JA[t]}: 成功 ${p.done} / 予約 ${p.reserved}（うち結果不明 ${p.unknown}）/ 不足 ${p.shortfall} / 次回 ${p.next_at_jst === null ? 'なし' : hhmm(p.next_at_jst, d.today)}${rest}`);
    if (live && q.reason_ja !== null) lines.push(`      ※ ${q.reason_ja}`);
  }

  lines.push('  投稿先:');
  for (const [key, label] of ROUTES) {
    const r = d.routes[key];
    if (r.not_handled === true) {
      lines.push(`    ${label}: このツールでは扱いません（もう一方のツールが投稿します。settings.json の audiences）`);
      continue;
    }
    if (!r.configured) {
      lines.push(`    ${label}: 設定なし（${live ? '' : '本番では'}投稿しません）`);
      continue;
    }
    const first = live ? ` / 初回投稿: ${FIRST_POST_JA[r.first_post]}` : '';
    lines.push(`    ${label}: 設定あり（${r.source === 'instruction' ? '指示書' : 'config'}）/ 画面: ${SCREEN_JA[r.screen]}${first} / URL: ${r.url_display ?? '-'}`);
    if (live && r.screen === 'verified' && r.first_post === 'needs_live_single') {
      lines.push(`      → ${label}の初回の本番投稿は、npm.cmd run live:single -- --route ${key} で1件だけ行ってください。`);
    }
  }
  if (d.live_single !== null) {
    lines.push(`  1件だけの本番投稿: ${ROUTE_LABELS[d.live_single.route_key]}の ${d.live_single.job_id}（${d.live_single.armed_at_jst} に予定）。次の投稿枠でこの1件だけを送信し、その後は自動で一時停止します。`);
  }
  if (d.preflight !== null) lines.push(...preflightLines(d.preflight, '  '));

  const e = d.extension;
  if (e.connected) lines.push(`  Chrome拡張: 接続中（最終確認 ${e.last_seen_jst === null ? '-' : hhmm(e.last_seen_jst, d.today)}、確認記号 ${e.fingerprint ?? '----'}）`);
  else if (e.paired) lines.push(`  Chrome拡張: 未接続（最終確認 ${e.last_seen_jst ?? 'なし'}）。Chrome が開いているか確認してください。`);
  else lines.push('  Chrome拡張: 未接続（接続が必要）。ツールの黒い画面（起動.bat または npm.cmd start）に出た接続コードを、拡張機能の「接続」で入力してください（コードが見当たらないときは「接続」を押すと新しいコードが出ます）。');
  const login = e.logged_in === true ? '不要（ログイン済み）' : e.logged_in === false ? '必要。Chrome で SALON BOARD にログインしてください（ツールが自動でログインすることはありません）' : '不明（拡張機能からの報告がありません）';
  lines.push(`  ログイン: ${login}`);

  if (d.operator_actions.length > 0) lines.push('  対応が必要な作業:', ...d.operator_actions.map((a) => `    - ${a.job_id}: ${a.action_ja}`));
  const r = d.readiness;
  if (r !== null) {
    const groups = ([['全体', r.global], ...ROUTES.map(([key, label]) => [label, r.routes[key]])] as [string, ReadinessItem[]][]).filter(([, items]) => items.length > 0);
    if (groups.length === 0) lines.push('  本番の準備で未完了の項目はありません。');
    else {
      lines.push('  本番の準備で未完了の項目（全体の項目が残っている間は本番投稿しません。投稿先の項目は、その投稿先だけを止めます）:');
      for (const [label, items] of groups) lines.push(`    ${label}:`, ...items.map((i) => `      - ${i.code}: ${i.detail}`));
    }
  }
  lines.push(...d.warnings.map((w) => `  【注意】${w}`));
  return lines;
}

const SCOPE_TYPE_JA: Record<InstructionScope['post_type'], string> = { common: '共通', style: 'スタイル', blog: 'ブログ' };
const SCOPE_AUDIENCE_JA: Record<InstructionScope['audience'], string> = { common: '共通', mens: 'メンズ', ladies: 'レディース' };
const WEEKDAY_FULL = (weekday: number): string => `${WEEKDAY_SHORT[String(weekday)]}曜日`;

function periodJa(p: InstructionPeriod): string {
  if (p.start === null && p.end === null) return '指定なし';
  return `${p.start ?? ''}〜${p.end ?? ''}`;
}

const rangesJa = (ranges: readonly TimeRange[]): string => (ranges.length === 0 ? '休業' : ranges.map((r) => `${r.start}-${r.end}`).join(', '));
const fromFiles = (files: readonly string[]): string => (files.length === 0 ? '' : `（${files.join('、')}）`);

function problemLines(title: string, list: readonly (InstructionIssue & { kind: InstructionProblemKind })[], note: (p: InstructionIssue) => string | null): string[] {
  if (list.length === 0) return [];
  const lines = [`  ${title}（${list.length}件）:`];
  for (const p of list) {
    lines.push(`    - ${p.code} ${p.message}`);
    const n = note(p);
    if (n !== null) lines.push(`      → ${n}`);
  }
  return lines;
}

/** Spec 5.10: 適用中の指示書・反映した営業時間と重点語・未反映理由 (URLs are never printed, spec 5.11). */
function instructionLines(s: StatusSnapshot): string[] {
  const lines = [`作業指示書（${s.instructions_folder ?? 'instructions'} フォルダ）:`];
  const i = s.instructions;
  if (i === null) {
    lines.push(s.instructions_error === null ? '  まだ確認できていません。' : `  作業指示書を確認できませんでした: ${s.instructions_error}`);
    return lines;
  }
  const how = i.source === 'runtime' ? '稼働中のツールの確認' : 'status の実行時に読み直した結果です。稼働中のツールには30秒ほどで反映されます';
  lines.push(`  最終確認: ${i.checked_at_jst}（${how}）`, `  実効設定の hash: ${i.effective_hash.slice(0, 8)}（指示書を反映した結果の識別子。${s.mode === 'dry_run' ? 'dry-run/data/instructions.json' : 'data/instructions.json'} に記録）`);
  if (i.applied.length === 0) {
    lines.push('  適用中の指示書: なし（config の設定だけを使っています）');
  } else {
    lines.push('  適用中の指示書:');
    for (const a of i.applied) {
      lines.push(`    - ${a.file}（優先度 ${a.priority}、期間 ${periodJa(a.period)}、対象 ${SCOPE_TYPE_JA[a.scope.post_type]}×${SCOPE_AUDIENCE_JA[a.scope.audience]}、hash ${a.sha256.slice(0, 8)}）: ${a.items_ja}`);
      if (a.last_valid_items.length > 0) lines.push(`      ※ ${instructionItemsJa(a.last_valid_items)}は前回の正しい内容で動作中`);
    }
  }
  if (i.upcoming.length > 0) lines.push(`  これから適用する指示書: ${i.upcoming.map((u) => (u.start === null ? u.file : `${u.file}（${u.start} から）`)).join('、')}`);
  if (i.disabled.length > 0) lines.push(`  無効にしている指示書: ${i.disabled.join('、')}`);
  if (i.pending.length > 0) lines.push(`  書き込み中のため確認を待っている指示書: ${i.pending.join('、')}（それまでは前に読み込んだ内容で動作します）`);

  lines.push('  反映した営業時間:');
  for (const d of i.business_hours) lines.push(`    ${WEEKDAY_FULL(d.weekday)}: ${d.ranges === null ? '指定なし（投稿時間のみ）' : rangesJa(d.ranges)}${fromFiles(d.files)}`);
  lines.push(`  投稿時間: ${i.post_window.start}-${i.post_window.end}${fromFiles(i.post_window.files)}`);
  if (i.reduced_counts.length > 0) {
    lines.push(`  投稿数を減らす曜日（営業時間・投稿時間に${MIN_SLOT_GAP_MINUTES}分以上の間隔で入る件数にしています。営業時間・投稿時間の外には投稿しません）:`);
    for (const d of i.reduced_counts) {
      const counts = `スタイル ${d.configured.style}→${d.counts.style}件、ブログ ${d.configured.blog}→${d.counts.blog}件`;
      lines.push(`    ${WEEKDAY_FULL(d.weekday)}: ${counts}${d.files.length === 0 ? '' : `（作業指示書: ${d.files.join('、')}）`}`);
    }
  }
  if (i.closed_days.length === 0) {
    lines.push(`  今後${CLOSED_DAYS_AHEAD}日間で投稿しない日: なし`);
  } else {
    lines.push(`  今後${CLOSED_DAYS_AHEAD}日間で投稿しない日（いま有効な指示と設定による）:`);
    for (const d of i.closed_days) lines.push(`    - ${d.date}（${WEEKDAY_SHORT[String(jstIsoWeekday(d.date))]}）: ${d.reason}`);
  }
  lines.push('  重点語（投稿の種類×対象ごと）:');
  for (const k of i.keywords) {
    const changed = k.files.length === 0 ? '' : `（作業指示書: ${k.files.join('、')}）`;
    lines.push(`    ${cellJa(k.post_type, k.audience)}: ${k.words.length === 0 ? 'なし' : k.words.join('、')}${changed}`);
  }
  lines.push(`  除外検索ワード: ${i.excluded_keywords.length === 0 ? 'なし' : i.excluded_keywords.join('、')}`);
  lines.push('  投稿先URL（URL そのものは表示しません）:');
  for (const r of i.routes) {
    const where = r.handled === false ? 'このツールでは扱いません' : r.source === null ? '未設定' : r.source === 'instructions' ? `設定あり（作業指示書: ${r.files.join('、')}）` : '設定あり（salonboard_fields.json）';
    lines.push(`    ${ROUTE_LABELS[r.key]}: ${where}`);
  }

  const notApplied = i.problems.filter((p) => p.kind === 'not_applied');
  if (notApplied.length === 0) lines.push('  反映していない指示: なし');
  lines.push(
    ...problemLines('反映していない指示', notApplied, (p) => p.note),
    ...problemLines('投稿数を減らして反映している指示', i.problems.filter((p) => p.kind === 'reduced'), (p) => p.note),
    ...problemLines('これから問題になる指示', i.problems.filter((p) => p.kind === 'upcoming'), (p) => p.note),
    ...problemLines('影響のない競合', i.problems.filter((p) => p.kind === 'no_effect'), () => 'より高い優先度の指示書が適用されているため影響なし'),
  );
  if (i.warnings.length > 0) lines.push(`  読み飛ばした行（${i.warnings.length}件。ほかの指示は反映しています）:`, ...i.warnings.map((w) => `    - ${w.message}`));
  return lines;
}

const RESOURCE_PRESSURE_JA = {
  RESOURCE_MEMORY_HIGH: 'メモリの使用量が多いため、新しい取込・文章作成・投稿を止めています（処理中の保存と照合は続けます）',
  RESOURCE_DISK_LOW: 'ディスクの空き（またはログの容量）が足りないため、新しい取込・文章作成・投稿を止めています（30日を過ぎたデータの整理で回復を試みます）',
} as const;

/** Spec 16.6: sizes, memory, the next and the last cleanup (the running tool only). */
function resourceLines(r: ResourcesDto): string[] {
  const v = (x: number | null): string => (x === null ? '未計測' : `${Math.round(x)} MB`);
  const lines = [
    '資源（30秒ごとに確認）:',
    `  メモリ ${v(r.rss_mb)}／ディスクの空き ${v(r.free_disk_mb)}／データ ${v(r.data_mb)}（ログ ${v(r.logs_mb)}・バックアップ ${v(r.backups_mb)}）`,
  ];
  const last = r.last_cleanup;
  lines.push(
    `  30日整理: 次の整理の対象 ${r.cleanup_due}件。` +
      (last === null ? '前回の整理はまだありません。' : `前回 ${last.at_jst}（${last.cleaned}件・${last.freed_mb} MB を削除、残り ${last.remaining}件${last.failed > 0 ? `、整理できなかった ${last.failed}件` : ''}）`),
  );
  if (r.pressure !== null) lines.push(`  【注意】${RESOURCE_PRESSURE_JA[r.pressure]}`);
  return lines;
}

export function formatStatusJa(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`SALON BOARD 自動投稿ツールの状態（${s.checked_at_jst} 日本時間）`);
  lines.push(`モード: ${MODE_JA[s.mode]}`);
  lines.push(s.paused ? `一時停止中（理由: ${s.pause_reason ?? '記録なし'}）` : '一時停止: なし');
  if (s.stops.length > 0) {
    lines.push('送信を止めている理由（解除は npm.cmd run resume）:');
    for (const st of s.stops) {
      lines.push(`  - ${st.message}（${st.raised_at_jst} から）`, `    対処: ${st.remedy}`);
      if (st.clears_at_jst !== null) lines.push(`    自動で解除: ${st.clears_at_jst}`);
    }
  }
  lines.push(...dispatchLines(s));
  lines.push('', ...slotLines(s), ...countsLines(s), '', ...liveLines(s.dto));

  const jobParts = JOB_STATUSES.filter((st) => (s.jobs_by_status[st] ?? 0) > 0).map((st) => `${JOB_STATUS_JA[st]} ${s.jobs_by_status[st]}`);
  lines.push('', '投稿データ（job）:', `  ${jobParts.length > 0 ? jobParts.join(' / ') : 'まだありません'}`);
  const failedCount = s.jobs_by_status.FAILED ?? 0;
  if (failedCount > 0) {
    const folder = s.mode === 'dry_run' ? 'dry-run/images/failed' : 'images/failed';
    const more = failedCount > s.failed_jobs.length ? `。ほかに${failedCount - s.failed_jobs.length}件` : '';
    lines.push(`  失敗した job（新しい順${more}。詳しい理由は ${folder}/<job_id>/failure.json）:`);
    for (const f of s.failed_jobs) {
      const retry = f.retryable ? ` → 原因を直し、ツールを止めてから npm.cmd run retry -- --id ${f.job_id}` : '';
      lines.push(`    - ${f.job_id}（${POST_TYPE_JA[f.post_type]}・${AUDIENCE_JA[f.audience_category]}）${f.error_code ?? '理由の記録なし'}: ${f.reason ?? ''}${retry}`);
    }
  }
  if ((s.jobs_by_status.VERIFY_REQUIRED ?? 0) > 0) {
    lines.push(
      s.mode === 'dry_run'
        ? '  結果不明のjobは、dry-run の擬似投稿が途中で止まったものです（SALON BOARD には送信していません）。自動では擬似投稿し直しません。'
        : '  結果不明の投稿は、自動では投稿し直しません。SALON BOARD の画面で登録されたかを確認してください。',
    );
  }

  if (s.ai !== null) {
    lines.push('', ...aiConfigStatusLines(s.ai.config, { mode: s.mode, dryRunUsesRealAi: s.ai.dry_run_use_real_ai, consistencyCheck: s.ai.consistency_check }));
  }

  if (s.content !== null) lines.push('', ...contentLines(s.content, s.mode));
  else if (s.content_error !== null) lines.push('', `AI・テンプレート・トレンドの状態を確認できませんでした: ${s.content_error}`);

  lines.push('', ...instructionLines(s));
  if (s.dto.resources !== null) lines.push('', ...resourceLines(s.dto.resources));

  if (s.unfinished_operations.length > 0) {
    lines.push(
      '',
      '画像の移動・コピー・30日整理が終わっていないjob（投稿の配布が止まっている可能性があります。上の「投稿の配布」の表示とログ（logs フォルダ）を確認してください）:',
      ...s.unfinished_operations.map((id) => `  - ${id}: 画像の移動・コピー・整理が途中です`),
    );
  }
  if (s.config_issues.length > 0) {
    lines.push(
      '',
      '最新の設定変更は反映されていません（直前の正常な設定で動いています）。次の箇所を直して保存してください:',
      ...s.config_issues.map((i) => `  - ${formatConfigIssue(i)}`),
    );
  }
  return lines.join('\n');
}
