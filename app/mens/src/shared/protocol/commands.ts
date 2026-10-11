import { z } from 'zod';
import { AUDIENCE_CATEGORIES, POST_TYPES } from '../types.js';
import { AllOfSchema, OptionRefSchema, PageProfileSchema } from './profile.js';
import { UrlMatchSchema } from './url-match.js';
import { ADAPTER_IDS, DateKeySchema, IdSchema, JstMinuteSchema, RouteKeySchema, Sha256HexSchema } from './version.js';

/** Image transfer chunk: 768 KiB raw (about 1 MiB base64). */
export const CHUNK_BYTES = 786_432;

const url = z.string().max(2048);
const salon = z.strictObject({ expected_account_label: z.string().min(1).max(100) });

export const RouteSnapshotSchema = z.strictObject({
  route_key: RouteKeySchema,
  entry_url: url,
  adapter_id: z.enum(ADAPTER_IDS),
  adapter_version: z.string().max(20),
  page_profile_id: IdSchema,
  profile_hash: Sha256HexSchema,
  profile_verified_at: z.string().max(40),
  source: z.enum(['config', 'instruction']),
});
export type RouteSnapshot = z.infer<typeof RouteSnapshotSchema>;

/** Another route's page, for §5.6 rows 7–9. */
export const OtherRouteSchema = z.strictObject({ route_key: RouteKeySchema, url_match: UrlMatchSchema, page_identification: AllOfSchema });
export type OtherRoute = z.infer<typeof OtherRouteSchema>;

/** Rendered by Node; the extension never sees the draft schema. */
export const FormInputsSchema = z.strictObject({
  title: z.string(),
  menu_text: z.string().nullable(),
  /** stylist_comment or body, tags appended if placement = append. */
  primary_text: z.string(),
  /**
   * Only for placement = dedicated_field: the tags as Node rendered them (with '#' when the profile says so); joined with
   * the profile's separator, or entered one at a time when the profile has hashtag.add_button.
   */
  hashtags: z.array(z.string().min(1).max(100)).max(30).nullable(),
  /** categories.json salonboard_option_value; null when the profile has no fields.category (the real style page has none). */
  category_option: z.strictObject({ value: z.string().min(1) }).nullable(),
  /** Logical; mapped through profile.fields.audience.options. */
  audience_option: z.enum(AUDIENCE_CATEGORIES),
  /** Non-null whenever profile.fields.staff exists. */
  staff_option: z.strictObject({ value: z.string().min(1) }).nullable(),
  /** salon.poster_name, for poster.mode === 'display'. */
  poster_name: z.string(),
  /** 'mapped.<key>' → the option Node chose from the approved map. */
  mapped: z.record(z.string().regex(/^mapped\.[a-z0-9_]{1,30}$/), OptionRefSchema),
  /** 'model_info.<key>' → the radio option Node chose from the photo's analysis (P3-R50); 設定しない (options.none) when unsure. */
  model_info: z.record(z.string().regex(/^model_info\.[a-z0-9_]{1,30}$/), OptionRefSchema),
  /** 'treatment.<key>' → checked; true only when the photo's sidecar category_hint confirms the treatment (P2-R15). */
  treatments: z.record(z.string().regex(/^treatment\.[a-z0-9_]{1,30}$/), z.boolean()),
  /** salon.json coupons, for profile.coupon (the style page's coupon dialog); null = leave the coupon alone. */
  coupon_name: z.string().min(1).max(200).nullable(),
});
export type FormInputs = z.infer<typeof FormInputsSchema>;

export const MatchKeysSchema = z.strictObject({
  normalized_title: z.string(),
  /** First 30 graphemes of normalizeForCompare(primary text). */
  body_excerpt: z.string(),
  window_start_jst: JstMinuteSchema,
  window_end_jst: JstMinuteSchema,
  anchor: z.enum(['intent', 'unexpected_navigation']),
  intent_date_jst: DateKeySchema.nullable(),
  remote_post_id: z.string().max(100).nullable(),
  expected_salon_label: z.string().min(1).max(100),
});
export type MatchKeys = z.infer<typeof MatchKeysSchema>;

export const PostCommandSchema = z.strictObject({
  kind: z.literal('post'),
  command_id: IdSchema,
  job_id: IdSchema,
  attempt_id: IdSchema,
  post_type: z.enum(POST_TYPES),
  audience: z.enum(AUDIENCE_CATEGORIES),
  is_retry: z.boolean(),
  route: RouteSnapshotSchema,
  profile: PageProfileSchema,
  other_routes: z.array(OtherRouteSchema).max(3),
  inputs: FormInputsSchema,
  image: z.strictObject({
    file_name: z.enum(['upload.jpg', 'upload.png']),
    mime: z.enum(['image/jpeg', 'image/png']),
    bytes: z.number().int().positive(),
    sha256: Sha256HexSchema,
    chunk_bytes: z.literal(CHUNK_BYTES),
  }),
  salon,
  live_single: z.boolean(),
});
export type PostCommand = z.infer<typeof PostCommandSchema>;

export const ReconcileCommandSchema = z.strictObject({
  kind: z.literal('reconcile'),
  command_id: IdSchema,
  job_id: IdSchema,
  reconcile_id: IdSchema,
  attempt_id: IdSchema,
  /** The send-time route. */
  route: RouteSnapshotSchema,
  profile: PageProfileSchema,
  match: MatchKeysSchema,
  salon,
});
export type ReconcileCommand = z.infer<typeof ReconcileCommandSchema>;

export const PreflightTargetSchema = z.strictObject({ route_key: RouteKeySchema, entry_url: url, profile: PageProfileSchema, other_routes: z.array(OtherRouteSchema).max(3) });
export type PreflightTarget = z.infer<typeof PreflightTargetSchema>;

export const PreflightCommandSchema = z.strictObject({
  kind: z.literal('preflight'),
  command_id: IdSchema,
  preflight_id: IdSchema,
  targets: z.array(PreflightTargetSchema).min(1).max(4),
  salon,
});
export type PreflightCommand = z.infer<typeof PreflightCommandSchema>;

export const CommandSchema = z.discriminatedUnion('kind', [PostCommandSchema, ReconcileCommandSchema, PreflightCommandSchema]);
export type Command = z.infer<typeof CommandSchema>;
