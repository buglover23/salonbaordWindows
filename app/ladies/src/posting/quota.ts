import type { DeploymentChecks } from '../config/schemas.js';
import { jstDateKey, jstToUtc, parseExportedAt, parseHHmm } from '../shared/time.js';
import type { PostType } from '../shared/types.js';
import type { DedupeRecord } from '../storage/dedupe-store.js';
import type { JobSummary } from '../storage/job-store.js';

export type LimitKind = 'daily' | 'monthly' | 'total' | 'image_capacity';
type Limits = DeploymentChecks['posting_limits'][PostType];

export interface QuotaInputs {
  limits: Limits;
  now: Date;
  /** Our posts of this type: live dedupe records, cleaned ones included (PC-local cleanup never frees quota, A62). */
  oursPosted: { job_id: string; posted_at: string }[];
  /** Jobs of this type whose latest attempt is intent_recorded or unknown, with the intent time. */
  unresolved: { job_id: string; intent_at: string }[];
  /** The job being evaluated (the same rule at claim and at intent). */
  excludeJobId: string | null;
  /** A count read on the screen (count_display), replacing our own count of that kind from its time. */
  observed: { kind: 'total' | 'daily' | 'monthly'; value: number; limit: number | null; at: Date } | null;
}

export type QuotaResult =
  | { kind: 'ok'; remaining: number | null /* null = unlimited */; limiting: LimitKind | null }
  | { kind: 'unknown'; reason_ja: string }
  | { kind: 'reached'; limiting: LimitKind; reason_ja: string; screenEvidence: boolean };

const KIND_JA: Record<LimitKind, string> = { daily: '1日', monthly: '1か月', total: '累計', image_capacity: '画像容量' };
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MINUTE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/;

/** 'YYYY-MM-DD HH:mm' (JST), 'YYYY-MM-DD' (00:00 JST) or ISO 8601 with a zone; null when none of these. */
export function parseCountedAt(text: string | null): number | null {
  if (text === null) return null;
  const m = JST_MINUTE.exec(text);
  try {
    return m ? jstToUtc(m[1]!, parseHHmm(m[2]!)).getTime() : (parseExportedAt(text)?.getTime() ?? null);
  } catch {
    return null;
  }
}

const unknown = (reason_ja: string): QuotaResult => ({ kind: 'unknown', reason_ja });

/**
 * P3-R9: how many more posts of one type fit under the owner's recorded limits, minus the safety margin. Available iff
 * `remaining ≥ 1`. Computed exhaustion is `reached` with screenEvidence false (a slot close, never a stop); only a count read
 * on the screen at or over its limit is screen evidence (LIMIT_REACHED, 1.4-m).
 */
export function remainingQuota(i: QuotaInputs): QuotaResult {
  const { limits, now, observed } = i;
  const configured = (kind: LimitKind): number | null => (limits[kind].status === 'limited' ? (limits[kind] as { value: number }).value : null);

  if (observed !== null) {
    const caps = [observed.limit, configured(observed.kind)].filter((x): x is number => x !== null);
    if (caps.length > 0 && observed.value >= Math.min(...caps)) {
      const cap = Math.min(...caps);
      return { kind: 'reached', limiting: observed.kind, reason_ja: `画面の件数（${observed.value}件）が${KIND_JA[observed.kind]}の上限（${cap}件）に達しています。`, screenEvidence: true };
    }
  }

  const unresolved = i.unresolved.filter((u) => u.job_id !== i.excludeJobId);
  const after = (fromMs: number): number =>
    i.oursPosted.filter((p) => Date.parse(p.posted_at) > fromMs).length + unresolved.filter((u) => Date.parse(u.intent_at) > fromMs).length;
  const unresolvedAfter = (fromMs: number): number => unresolved.filter((u) => Date.parse(u.intent_at) > fromMs).length;

  let best: { remaining: number; kind: LimitKind; cap: number } | null = null;
  for (const kind of ['daily', 'monthly', 'total', 'image_capacity'] as const) {
    const limit = limits[kind];
    if (limit.status === 'unknown') return unknown(`${KIND_JA[kind]}の投稿数の上限が未確認です（checks:record limit で記録してください）`);
    if (limit.status !== 'limited') continue;
    if (limits.safety_margin === null) return unknown('余裕として残す件数（safety_margin）が未記録です（checks:record margin で記録してください）');
    const obs = observed !== null && (observed.kind === kind || (kind === 'image_capacity' && observed.kind === 'total')) ? observed : null;
    let base: number;
    if (kind === 'daily' || kind === 'monthly') {
      if (limits.quota_period_boundary !== 'jst_calendar') {
        return unknown('上限の数え方の区切り（quota_period_boundary）が未記録か、自動計算できない形式です（jst_calendar で記録してください）');
      }
      const periodOf = (ms: number): string => (kind === 'daily' ? jstDateKey(new Date(ms)) : jstDateKey(new Date(ms)).slice(0, 7));
      const current = periodOf(now.getTime());
      const count = kind === 'daily' ? limits.daily_count : limits.monthly_count;
      const countedAt = count === null ? null : parseCountedAt(count.counted_at);
      if (obs !== null) base = obs.value + unresolvedAfter(obs.at.getTime());
      else if (count !== null && countedAt !== null && periodOf(countedAt) === current) base = count.value + after(countedAt);
      else {
        base =
          i.oursPosted.filter((p) => periodOf(Date.parse(p.posted_at)) === current).length +
          unresolved.filter((u) => periodOf(Date.parse(u.intent_at)) === current).length;
      }
    } else {
      if (kind === 'image_capacity' && limit.unit !== '枚') {
        return unknown('画像容量の単位（MBなど）は自動計算できません。枚数で記録するか、対象外（not_applicable）として理由を記録してください');
      }
      const countedAt = parseCountedAt(limits.counted_at);
      if (obs !== null) base = obs.value + unresolvedAfter(obs.at.getTime());
      else if (limits.current_count !== null && countedAt !== null && limits.count_valid_days !== null && now.getTime() - countedAt <= limits.count_valid_days * DAY_MS) {
        base = limits.current_count + after(countedAt);
      } else {
        return unknown('現在の掲載件数が未記録か、記録から日数が経ちすぎています（checks:record count で記録し直してください）');
      }
    }
    const cap = obs?.limit != null ? Math.min(limit.value, obs.limit) : limit.value;
    const remaining = cap - base - limits.safety_margin;
    if (best === null || remaining < best.remaining) best = { remaining, kind, cap };
  }
  if (best === null) return { kind: 'ok', remaining: null, limiting: null };
  if (best.remaining >= 1) return { kind: 'ok', remaining: best.remaining, limiting: best.kind };
  return {
    kind: 'reached',
    limiting: best.kind,
    reason_ja: `計算上、${KIND_JA[best.kind]}の投稿数の上限（${best.cap}件、余裕${limits.safety_margin ?? 0}件を含む）に達するため送信しません。`,
    screenEvidence: false,
  };
}

/** QuotaInputs.oursPosted from dedupe.json: every record of the type, cleaned ones included. */
export function oursPostedFrom(records: readonly DedupeRecord[], type: PostType): QuotaInputs['oursPosted'] {
  return records.filter((r) => r.post_type === type).map((r) => ({ job_id: r.job_id, posted_at: r.posted_at }));
}

/** QuotaInputs.unresolved from the job summaries. */
export function unresolvedFrom(summaries: readonly JobSummary[], type: PostType): QuotaInputs['unresolved'] {
  return summaries
    .filter((s) => s.post_type === type && s.unresolved_post_intent && s.last_intent_at !== null)
    .map((s) => ({ job_id: s.id, intent_at: s.last_intent_at! }));
}
