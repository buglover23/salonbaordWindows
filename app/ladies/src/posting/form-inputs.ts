import { resolveHint, analysisCategories } from '../ai/analyzer.js';
import { DraftSchema, primaryTextOf, renderPrimaryText, type Draft } from '../ai/draft-schemas.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { Job } from '../shared/job-schema.js';
import { CHUNK_BYTES, type FormInputs, type MatchKeys, type OtherRoute, type PostCommand, type RouteSnapshot } from '../shared/protocol/commands.js';
import type { OptionRef, PageProfile } from '../shared/protocol/profile.js';
import { normalizeForCompare } from '../shared/text-normalize.js';
import { graphemeSlice } from '../shared/text.js';
import { formatJst, jstDateKey } from '../shared/time.js';
import { readSidecar } from '../storage/sidecar.js';
import { mappedOption } from './profile/mapped.js';
import { modelInfoOption } from './profile/model-info.js';
import { effectivePlacement, hashtagEntries } from './profile/placement.js';

// What Node hands the extension for one post: the form values (the extension never sees the draft schema) and the keys it
// matches the post list with (spec 14.2, D7).

export type RenderResult = { ok: true; inputs: FormInputs } | { ok: false; message: string };

const MATCH_BEFORE_MS = 2 * 60_000;
const MATCH_AFTER_MS = 30 * 60_000;

const draftOf = (job: Pick<Job, 'draft'>): Draft | null => {
  const d = DraftSchema.safeParse(job.draft);
  return d.success ? d.data : null;
};

/**
 * The form values for `job` on `profile`. A gap the job cannot post with (no option for its category, a `mapped.*` value
 * without an approved option, no staff option) is CONFIG_INCOMPLETE for this job (BLOCKED, never regenerated).
 */
export async function renderFormInputs(job: Job, profile: PageProfile, s: ConfigSnapshot, bundleDir: string): Promise<RenderResult> {
  const draft = draftOf(job);
  if (draft === null) return { ok: false, message: '下書きを読み取れません' };
  const f = profile.fields;
  const placement = effectivePlacement(profile, s.writingRules.hashtag_placement);

  let category_option: FormInputs['category_option'] = null;
  if (f.category !== undefined) {
    const lists = job.post_type === 'blog' ? [s.categories.blog_categories, s.categories.style_categories] : [s.categories.style_categories];
    const value = lists.flat().find((c) => c.id === draft.category_id)?.salonboard_option_value ?? null;
    if (value === null) return { ok: false, message: `カテゴリー「${draft.category_id}」に SALON BOARD で選ぶ選択肢（categories.json の salonboard_option_value）がありません` };
    category_option = { value };
  }
  let staff_option: FormInputs['staff_option'] = null;
  if (f.staff !== undefined) {
    if (s.salon.staff_option_value === null) return { ok: false, message: 'スタッフ（投稿者）の選択肢（salon.json の staff_option_value）が未設定です' };
    staff_option = { value: s.salon.staff_option_value };
  }
  const mapped: Record<string, OptionRef> = {};
  for (const [key, field] of Object.entries(f)) {
    if (!key.startsWith('mapped.')) continue;
    const option = mappedOption(field, job);
    if ('unknown' in option) return { ok: false, message: `${key} に使う画像の解析結果が「不明」か、対応する選択肢がありません` };
    mapped[key] = option;
  }
  const model_info: Record<string, OptionRef> = {};
  for (const [key, field] of Object.entries(f)) {
    if (!key.startsWith('model_info.')) continue;
    const option = modelInfoOption(key, field, job, s.settings.ai.min_required_attribute_confidence);
    if (option !== undefined) model_info[key] = option; // always set: the profile schema requires options.none
  }
  // P2-R15: a treatment checkbox is checked only when the photo's sidecar category_hint names one of its categories; the
  // style page's coupon follows the same confirmed category.
  const treatments: Record<string, boolean> = {};
  const treatmentKeys = Object.keys(f).filter((k) => k.startsWith('treatment.'));
  const couponPage = profile.coupon !== undefined;
  let confirmed: string | undefined;
  if (treatmentKeys.length > 0 || couponPage) {
    const hint = (await readSidecar(bundleDir).catch(() => null))?.category_hint;
    confirmed = hint === undefined ? undefined : resolveHint(hint, analysisCategories(s, job.audience_category))?.id;
  }
  for (const key of treatmentKeys) treatments[key] = confirmed !== undefined && f[key]!.confirmed_by!.includes(confirmed);
  const { coupons } = s.salon;
  const coupon_name = couponPage ? ((confirmed === undefined ? undefined : coupons.by_category[confirmed]) ?? coupons.default) : null;
  return {
    ok: true,
    inputs: {
      title: draft.title,
      menu_text: draft.post_type === 'style' ? draft.menu_text : null,
      primary_text: renderPrimaryText(draft, placement),
      hashtags: placement === 'dedicated_field' ? hashtagEntries(draft.hashtags, profile.hashtag) : null,
      category_option,
      audience_option: job.audience_category,
      staff_option,
      poster_name: s.salon.poster_name,
      mapped,
      model_info,
      treatments,
      coupon_name,
    },
  };
}

/** D7: the keys the extension matches the list with, around the intent (or the unexpected-navigation) time. */
export function matchKeysFor(job: Pick<Job, 'draft' | 'remote_post_id'>, anchorAt: Date, anchor: MatchKeys['anchor'], label: string): MatchKeys {
  const draft = draftOf(job);
  return {
    normalized_title: normalizeForCompare(draft?.title ?? ''),
    body_excerpt: graphemeSlice(normalizeForCompare(draft === null ? '' : primaryTextOf(draft)), 30),
    window_start_jst: formatJst(new Date(anchorAt.getTime() - MATCH_BEFORE_MS)),
    window_end_jst: formatJst(new Date(anchorAt.getTime() + MATCH_AFTER_MS)),
    anchor,
    intent_date_jst: jstDateKey(anchorAt),
    remote_post_id: job.remote_post_id,
    expected_salon_label: label,
  };
}

/** The post command for an attempt that has just started (upload prepared, inputs rendered). */
export function buildPostCommand(
  job: Job,
  x: { route: RouteSnapshot; profile: PageProfile; otherRoutes: OtherRoute[]; inputs: FormInputs; label: string; liveSingle: boolean; isRetry: boolean },
): PostCommand {
  const attempt = job.attempts.at(-1)!;
  const upload = job.upload!;
  return {
    kind: 'post',
    command_id: attempt.command_id,
    job_id: job.id,
    attempt_id: attempt.id,
    post_type: job.post_type,
    audience: job.audience_category,
    is_retry: x.isRetry,
    route: x.route,
    profile: x.profile,
    other_routes: x.otherRoutes,
    inputs: x.inputs,
    image: { file_name: upload.file_name, mime: upload.mime, bytes: upload.bytes, sha256: upload.sha256, chunk_bytes: CHUNK_BYTES },
    salon: { expected_account_label: x.label },
    live_single: x.liveSingle,
  };
}
