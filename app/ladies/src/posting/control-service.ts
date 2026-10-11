import { DraftSchema, primaryTextOf } from '../ai/draft-schemas.js';
import type { ReadinessItem } from '../config/readiness.js';
import type { EffectiveConfig } from '../content/effective-config.js';
import type { ScheduleStore } from '../execution/schedule-store.js';
import { redactUrl } from '../logger.js';
import { newId } from '../shared/ids.js';
import { POST_TYPE_JA } from '../shared/labels.js';
import type { PreflightTarget } from '../shared/protocol/commands.js';
import type { LiveSinglePreview } from '../shared/protocol/api.js';
import type { PreflightResult, PreflightResultRequest } from '../shared/protocol/results.js';
import type { StopDto } from '../shared/protocol/status.js';
import { ROUTE_KEYS, type RouteKey } from '../shared/protocol/version.js';
import { graphemeSlice } from '../shared/text.js';
import { formatJst, jstDateKey } from '../shared/time.js';
import type { AudienceCategory, PostType } from '../shared/types.js';
import type { UrlPolicy } from '../shared/url-policy.js';
import type { Stop } from '../storage/control-store.js';
import { ApiError } from '../server/errors.js';
import { automationRefusal } from '../server/handlers/probe.js';
import { firstPostState } from './gates.js';
import { otherRoutesFor, resolveRoute } from './profile/route-resolve.js';
import { parseCountedAt, type QuotaResult } from './quota.js';
import type { OpsDeps } from './reconcile.js';
import { stopDto } from './stops.js';
import { assertTransition } from './transitions.js';
import { constraintsHash } from './upload-image.js';

// Pause / resume with stops, the owner's preflight and the live_single arming (plan Task 2c, P3-R4, P3-R35, §11).

export const OPERATOR_PAUSE_JA = '運用者が一時停止しました';
const NO_AUTOMATION_JA = '自動操作の許可が確認できていないため、画面の確認ができません（停止はそのままです）。';

const routeKeyOf = (s: Pick<Stop, 'post_type' | 'audience_category'>): string => `${s.post_type}.${s.audience_category}`;
const split = (k: RouteKey): [PostType, AudienceCategory] => k.split('.') as [PostType, AudienceCategory];

export async function pause(d: Pick<OpsDeps, 'control' | 'logger'>, reason: string): Promise<void> {
  await d.control.setPaused(reason);
  d.logger.info('SYSTEM_PAUSED', `一時停止しました（理由: ${reason}）。`, { reason });
}

/**
 * Clears stops and puts the BLOCKED jobs they held back to READY (bundle failed → processing). A job is tied to a stop by
 * its error code within the stop's scope.
 */
export async function clearStops(d: Pick<OpsDeps, 'stops' | 'store' | 'bundles' | 'logger'>, stops: readonly Stop[], why: string): Promise<void> {
  if (stops.length === 0) return;
  await d.stops.clear(stops.map((s) => s.id), why);
  for (const s of d.store.summaries((x) => x.status === 'BLOCKED' && !x.has_operation)) {
    const tied = stops.some((st) => st.code === s.last_error_code && (st.scope === 'salon' || (st.post_type === s.post_type && (st.scope === 'type' || st.audience_category === s.audience_category))));
    if (!tied) continue;
    const job = await d.store.get(s.id);
    if (job === null || job.status !== 'BLOCKED') continue;
    await d.bundles
      .transition(job.id, job.revision, (j) => {
        assertTransition(j.status, 'READY', { intentRecorded: false });
        return { ...j, status: 'READY', stage: 'ready' };
      })
      .then(() => d.logger.info('JOB_UNBLOCKED', `停止の解除で、保留していた job を投稿待ちに戻しました: ${job.id}`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category }))
      .catch((err: unknown) => d.logger.warn('JOB_NOT_UNBLOCKED', `保留中のjobを投稿待ちに戻せませんでした（次の再開で再度試します）: ${job.id}`, { job_id: job.id, error: String(err) }));
  }
}

/** Routes with an entry URL and a page profile (verified or not): what a preflight can open and check. */
export function preflightTargets(eff: EffectiveConfig, keys: readonly RouteKey[] = ROUTE_KEYS): PreflightTarget[] {
  return keys.flatMap((k) => {
    const [t, a] = split(k);
    const r = eff.routes[t][a];
    const profile = r.page_profile_id === null ? undefined : eff.base.salonboardFields.pages[r.page_profile_id];
    return r.entry_url === null || profile === undefined ? [] : [{ route_key: k, entry_url: r.entry_url, profile, other_routes: otherRoutesFor(eff, k) }];
  });
}

/** Schedules a preflight (owner or resume); the extension takes it at its next claim. 409 when it cannot run. */
export async function schedulePreflight(d: Pick<OpsDeps, 'control' | 'logger' | 'clock'>, eff: EffectiveConfig, keys: readonly RouteKey[], purpose: 'resume' | 'owner'): Promise<string> {
  const refusal = automationRefusal(eff.base.deploymentChecks.automation);
  if (refusal !== null) throw refusal;
  if (eff.base.salon.expected_account_label === null) throw new ApiError(409, 'CONFIG_INCOMPLETE', '店舗名（salon.json の expected_account_label）が未設定のため、画面を確認できません。');
  const pending = d.control.get().pending_preflight;
  if (pending !== null && pending.result === null) throw new ApiError(409, 'BUSY', '画面の確認を実行中です。終わるまでお待ちください（最大5分）。', true);
  const route_keys = preflightTargets(eff, keys).map((t) => t.route_key);
  if (route_keys.length === 0) throw new ApiError(409, 'POST_TARGET_UNCONFIGURED', '確認できる投稿先がありません（投稿先URLと画面設定を確認してください）。');
  const preflight_id = newId('pf');
  await d.control.update(() => ({ pending_preflight: { preflight_id, route_keys, requested_at: d.clock.now().toISOString(), purpose, command_id: null, result: null } }));
  d.logger.info('PREFLIGHT_SCHEDULED', `SALON BOARD の画面の確認を予約しました（入力も登録もしません）: ${route_keys.join('、')}`, { preflight_id, purpose });
  return preflight_id;
}

/** A target passes: no failure signal, the salon and the page identified, every check ok (§2c "applying a preflight result"). */
const passed = (t: PreflightResult['targets'][number] | undefined): boolean =>
  t !== undefined &&
  t.page !== null &&
  t.checks.length > 0 &&
  t.checks.every((c) => c.ok) &&
  !Object.values(t.page.signals).some(Boolean) &&
  t.page.salon_identified === true &&
  t.page.page_identified === true;

/**
 * POST /v1/control/preflight/:id/result. A resume preflight clears the salon stops (except POST_RESULT_UNKNOWN) when every
 * target passed, and each route stop whose route passed; the jobs they held go back to READY. Otherwise the stops stay and
 * the findings show in status.
 */
export async function applyPreflightResult(d: OpsDeps, id: string, req: Pick<PreflightResultRequest, 'preflight_id' | 'command_id' | 'result'>): Promise<{ applied: true }> {
  const p = d.control.get().pending_preflight;
  if (p === null || p.preflight_id !== id || req.preflight_id !== id || req.result.preflight_id !== id || p.command_id !== req.command_id || p.result !== null) {
    throw new ApiError(409, 'STALE_COMMAND', 'この画面の確認の指示は現在のものではありません。');
  }
  await d.control.update((c) => (c.pending_preflight?.preflight_id === id ? { pending_preflight: { ...c.pending_preflight, result: req.result } } : null));
  const ok = (k: string): boolean => passed(req.result.targets.find((t) => t.route_key === k));
  const all = req.result.outcome === 'passed' && p.route_keys.every(ok);
  d.logger[all ? 'info' : 'warn']('PREFLIGHT_FINISHED', all ? 'SALON BOARD の画面を確認しました（問題はありません）。' : 'SALON BOARD の画面の確認で問題が見つかりました（status で内容を確認できます）。', { preflight_id: id, outcome: req.result.outcome, purpose: p.purpose });
  if (p.purpose !== 'resume') return { applied: true };
  const clear = d.stops.active().filter((s) => (s.scope === 'salon' && s.code !== 'POST_RESULT_UNKNOWN' && all) || (s.scope === 'route' && p.route_keys.includes(routeKeyOf(s) as RouteKey) && ok(routeKeyOf(s))));
  await clearStops(d, clear, 'preflight_passed');
  return { applied: true };
}

export interface ResumeContext {
  confirmChecked: boolean;
  /** Null when the tool is not running (offline CLI): no preflight can be scheduled. */
  effective: EffectiveConfig | null;
  /** remainingQuota of the type now (no job excluded, no observed count). */
  quota: (t: PostType) => QuotaResult;
}

/**
 * `resume`: clears the operator pause, then deals with the active stops: a LIMIT_REACHED of a period clears by itself at the
 * boundary, a total/unknown one once a count newer than the stop leaves room; POST_RESULT_UNKNOWN only after the operator
 * checked the screen (--confirm-checked) with nothing unresolved; salon and route stops through a preflight of the
 * configured routes (an unconfigured route never blocks clearing).
 */
export async function resume(d: OpsDeps, x: ResumeContext): Promise<{ paused: false; checking: boolean; pending_stops: StopDto[]; notes: string[] }> {
  const was = d.control.get().paused;
  await d.control.setPaused(null);
  if (was) d.logger.info('RESUMED', '一時停止を解除しました。');
  const notes: string[] = [];
  const clear: Stop[] = [];
  let checking = false;
  const active = d.stops.active();
  const limits = d.config().deploymentChecks.posting_limits;
  for (const s of active.filter((st) => st.scope === 'type')) {
    const t = s.post_type!;
    const l = limits[t];
    const counted = [l.counted_at, l.daily_count?.counted_at ?? null, l.monthly_count?.counted_at ?? null].map(parseCountedAt).some((ms) => ms !== null && ms > Date.parse(s.raised_at));
    if (s.period_key !== null) notes.push(`${POST_TYPE_JA[t]}: ${s.remedy}`);
    else if (counted && x.quota(t).kind === 'ok') clear.push(s);
    else notes.push(`${POST_TYPE_JA[t]}: 残り件数を確認して npm.cmd run checks:record -- count … で記録してから、もう一度 npm.cmd run resume を実行してください。`);
  }
  const unknown = active.filter((s) => s.scope === 'salon' && s.code === 'POST_RESULT_UNKNOWN');
  if (unknown.length > 0) {
    if (d.store.summaries((s) => s.status === 'VERIFY_REQUIRED').length > 0) notes.push('結果不明の投稿があるため、送信の停止は解除しません。先に npm.cmd run reconcile で照合してください。');
    else if (!x.confirmChecked) notes.push('SALON BOARD の画面で同じ投稿が2回登録されていないことを確認してから、npm.cmd run resume -- --confirm-checked を実行してください。');
    else clear.push(...unknown);
  }
  const screen = active.filter((s) => (s.scope === 'salon' && s.code !== 'POST_RESULT_UNKNOWN') || s.scope === 'route');
  if (screen.length > 0) {
    const configured = x.effective === null ? null : preflightTargets(x.effective).map((t) => t.route_key as string);
    const own = screen.filter((s) => s.scope === 'salon' || configured === null || configured.includes(routeKeyOf(s)));
    clear.push(...screen.filter((s) => !own.includes(s)));
    const targets = (configured ?? []).filter((k) => own.some((s) => s.scope === 'salon' || routeKeyOf(s) === k)) as RouteKey[];
    if (own.length === 0) {
      // only stops of routes that are not configured
    } else if (x.effective === null) {
      notes.push('ツールが起動していないため、画面の確認ができません。ツールを起動してから、もう一度 npm.cmd run resume を実行してください。');
    } else if (targets.length === 0) {
      clear.push(...own);
    } else if (automationRefusal(x.effective.base.deploymentChecks.automation) !== null) {
      notes.push(NO_AUTOMATION_JA);
    } else {
      try {
        await schedulePreflight(d, x.effective, targets, 'resume');
        checking = true;
      } catch (err) {
        notes.push(err instanceof ApiError ? err.message : '画面の確認を予約できませんでした。');
      }
    }
  }
  await clearStops(d, clear, 'resume');
  return { paused: false, checking, pending_stops: d.stops.active().map(stopDto), notes };
}

export interface LiveSingleContext {
  effective: EffectiveConfig;
  readiness: { global: ReadinessItem[]; routes: Record<RouteKey, ReadinessItem[]> };
  urlPolicy: UrlPolicy;
  schedules?: Pick<ScheduleStore, 'load'> | undefined;
}

/**
 * POST /v1/control/live-single (P3-R4): confirm:false → the preview of the job the first live post of the route would send
 * (the given one, or the oldest READY job with its upload prepared); confirm:true → arms exactly that job, only while its
 * content and image hashes still equal the preview's.
 */
export async function liveSingle(
  d: OpsDeps,
  req: { route_key: RouteKey; job_id?: string | undefined; confirm: boolean; content_hash?: string | undefined; image_sha256?: string | undefined; now?: boolean | undefined },
  x: LiveSingleContext,
): Promise<{ preview: LiveSinglePreview } | { armed: true; job_id: string; next_slot_at_jst: string | null }> {
  const refuse = (message: string, code: 'STALE_COMMAND' | 'BUSY' | 'CONFIG_INCOMPLETE' = 'STALE_COMMAND'): never => {
    throw new ApiError(409, code, message);
  };
  if (d.mode !== 'live') refuse('本番（settings.json の mode が "live"）のときだけ使えます。', 'CONFIG_INCOMPLETE');
  const key = req.route_key;
  const [t, a] = split(key);
  const item = [...x.readiness.global, ...x.readiness.routes[key]][0];
  if (item !== undefined) throw new ApiError(409, item.code, `本番の準備が終わっていません: ${item.detail}`);
  const control = d.control.get();
  // The same route's armed job may be shown again and moved to now (--now); anything else waits for it to finish.
  const armedHere = control.live_single !== null && control.live_single.route_key === key;
  if (control.live_single !== null && !(armedHere && (!req.confirm || req.now === true))) {
    refuse(`すでに ${control.live_single.route_key} の1件（${control.live_single.job_id}）を本番投稿の予定にしています。終わるまでお待ちください。`, 'BUSY');
  }
  const route = resolveRoute(x.effective, t, a, x.urlPolicy);
  if (!route.ok) return refuse(route.item.detail);
  if (firstPostState(key, control, route.snapshot.profile_hash) === 'done') refuse('この投稿先の初回の本番投稿は済んでいます（live:single は不要です）。');
  const want = constraintsHash(route.profile.image);
  const pick = req.job_id ?? (armedHere ? control.live_single?.job_id : undefined);
  const candidates = d.store
    .summaries((s) => s.status === 'READY' && s.route_key === key && !s.has_operation && s.upload_constraints_hash === want && (pick === undefined || s.id === pick))
    .sort((p, q) => Date.parse(p.created_at) - Date.parse(q.created_at) || (p.id < q.id ? -1 : 1));
  const job = candidates[0] === undefined ? null : await d.store.get(candidates[0].id);
  if (job === null || job.content_hash === null) {
    return refuse(req.job_id === undefined ? 'この投稿先に、投稿の準備ができた job（投稿待ち・画像の準備済み）がありません。' : `${req.job_id} は、この投稿先の投稿の準備ができた job（投稿待ち・画像の準備済み）ではありません。`);
  }
  const draft = DraftSchema.safeParse(job.draft);
  if (!draft.success) return refuse(`${job.id} の下書きを読み取れません。`);
  if (!req.confirm) {
    const categories = t === 'blog' ? [...x.effective.base.categories.blog_categories, ...x.effective.base.categories.style_categories] : x.effective.base.categories.style_categories;
    return {
      preview: {
        route_key: key,
        job_id: job.id,
        title: draft.data.title,
        text_head: graphemeSlice(primaryTextOf(draft.data), 80),
        category_label: categories.find((c) => c.id === draft.data.category_id)?.label ?? draft.data.category_id,
        image_name: job.image.original_name.slice(0, 260),
        route_url_display: redactUrl(route.snapshot.entry_url).slice(0, 500),
        content_hash: job.content_hash,
        image_sha256: job.image.sha256,
      },
    };
  }
  if (req.job_id === undefined || req.content_hash === undefined || req.image_sha256 === undefined) {
    throw new ApiError(422, 'INVALID_REQUEST', '確認した job_id・content_hash・image_sha256 を指定してください。');
  }
  if (job.content_hash !== req.content_hash || job.image.sha256 !== req.image_sha256) refuse('表示した後に内容が変わったため、もう一度 live:single を実行して内容を確認してください。');
  const now = d.clock.now();
  if (armedHere) {
    await d.control.update((c) => (c.live_single?.job_id === job.id ? { live_single: { ...c.live_single, now: true } } : null));
    if (d.control.get().live_single?.job_id !== job.id) refuse('予定している1件と違う内容です。終わるまでお待ちください。', 'BUSY');
    d.logger.info('LIVE_SINGLE_ARMED', `${POST_TYPE_JA[t]}の初回の本番投稿を今すぐ送るように変えました: ${job.id}`, { job_id: job.id, post_type: t, audience_category: a });
    return { armed: true, job_id: job.id, next_slot_at_jst: formatJst(now) };
  }
  await d.control.update((c) => (c.live_single === null ? { live_single: { route_key: key, job_id: job.id, content_hash: job.content_hash!, image_sha256: job.image.sha256, armed_at: now.toISOString(), now: req.now === true } } : null));
  if (d.control.get().live_single?.job_id !== job.id) refuse('すでに別の1件を本番投稿の予定にしています。', 'BUSY');
  d.logger.info('LIVE_SINGLE_ARMED', `${POST_TYPE_JA[t]}の初回の本番投稿として1件だけ予定しました: ${job.id}`, { job_id: job.id, post_type: t, audience_category: a });
  const today = jstDateKey(now);
  const grace = x.effective.schedule.slot_grace_minutes * 60_000;
  const next = (await x.schedules?.load(today))?.slots
    .filter((s) => s.post_type === t && s.state === 'open' && Date.parse(s.scheduled_at) + grace >= now.getTime())
    .sort((p, q) => Date.parse(p.scheduled_at) - Date.parse(q.scheduled_at))[0];
  if (req.now === true) return { armed: true, job_id: job.id, next_slot_at_jst: formatJst(now) };
  return { armed: true, job_id: job.id, next_slot_at_jst: next === undefined ? null : formatJst(new Date(next.scheduled_at)) };
}
