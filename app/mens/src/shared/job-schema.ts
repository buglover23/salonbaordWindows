import { z } from 'zod';
import { AI_PROVIDERS } from '../config/schemas.js';
import type { Clock } from './clock.js';
import { AppErrorSchema } from './errors.js';
import { newJobId } from './ids.js';
import { RouteSnapshotSchema } from './protocol/commands.js';
import { ResultFlagsSchema } from './protocol/results.js';
import {
  AUDIENCE_CATEGORIES,
  JOB_STATUSES,
  POST_TYPES,
  SUBMISSION_STATES,
  type AudienceCategory,
  type PostType,
} from './types.js';
import { isoUtc } from './zod-helpers.js';

/** The services a draft may come from (AI_PROVIDERS plus the .env-only OpenAI-compatible servers). */
const DRAFT_PROVIDERS = [...AI_PROVIDERS, 'openai_compatible'] as const;

// JSON.stringify drops an undefined value, so it would be saved as a missing key and fail the next read: require null instead.
const storedJson = z.unknown().refine((v) => v !== undefined, { error: '値がありません（未設定は null にしてください）' });

export const AttemptSchema = z.strictObject({
  id: z.string().min(1),
  command_id: z.string().min(1),
  assigned_instance_id: z.string().nullable(),
  claimed_at: isoUtc.nullable(),
  submit_intent_at: isoUtc.nullable(),
  submitted_at: isoUtc.nullable(),
  completed_at: isoUtc.nullable(),
  submission_state: z.enum(SUBMISSION_STATES),
  error: AppErrorSchema.nullable(),
  evidence_refs: z.array(z.string()),
  // Plan 3 (live poster). Defaults keep files written before Plan 3 valid.
  /** The route snapshot taken at claim, persisted again at intent (the send-time route used by reconcile). */
  route: RouteSnapshotSchema.nullable().default(null),
  permission_id: z.string().nullable().default(null),
  client_id: z.string().nullable().default(null),
  flags: ResultFlagsSchema.nullable().default(null),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const JobSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  salon_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
  audience_category: z.enum(AUDIENCE_CATEGORIES),
  resolved_route: z
    .strictObject({
      entry_url: z.string(),
      adapter_id: z.string(),
      page_profile_id: z.string(),
      config_hash: z.string(),
    })
    .nullable(),
  // Paths here are absolute and only meaningful while a move/copy/cleanup is in flight.
  operation: z
    .strictObject({
      kind: z.enum(['move', 'copy', 'cleanup']),
      source_path: z.string().optional(),
      target_path: z.string().optional(),
      target_paths: z.array(z.string()).optional(),
      started_at: isoUtc,
    })
    .nullable(),
  status: z.enum(JOB_STATUSES),
  stage: z.string().min(1),
  // relative_path is relative to the mode root and uses '/' separators.
  image: z.strictObject({
    relative_path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mime: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    // Pixel size from the header (spec 6.1-4); null when the image could not be read (IMAGE_INVALID jobs).
    width: z.number().int().nonnegative().nullable(),
    height: z.number().int().nonnegative().nullable(),
    original_name: z.string(),
  }),
  analysis: storedJson.nullable(),
  draft: storedJson.nullable(),
  content_hash: z.string().nullable(),
  config_hash: z.string().min(1),
  instruction_refs: z.array(z.strictObject({ file_name: z.string(), sha256: z.string() })),
  template_hash: z.string().nullable(),
  trend_source_refs: z.array(z.string()),
  scheduled_at: isoUtc.nullable(),
  schedule_slot_id: z.string().nullable(),
  attempt_count: z.number().int().nonnegative(),
  retry_count: z.number().int().nonnegative(),
  regeneration_count: z.number().int().nonnegative(),
  next_retry_at: isoUtc.nullable(),
  submission_state: z.enum(SUBMISSION_STATES),
  attempts: z.array(AttemptSchema),
  last_error: AppErrorSchema.nullable(),
  remote_post_id: z.string().nullable(),
  remote_post_url: z.string().nullable(),
  posted_at: isoUtc.nullable(),
  verified_at: isoUtc.nullable(),
  created_at: isoUtc,
  updated_at: isoUtc,
  // Plan 3 (live poster). Defaults keep files written before Plan 3 valid.
  /** Automatic reconcile of an unknown result (D7): +2 / +5 / +15 min, then the operator. */
  reconcile: z
    .strictObject({
      attempt_id: z.string(),
      auto_count: z.number().int().nonnegative(),
      next_auto_at: isoUtc.nullable(),
      last_at: isoUtc.nullable(),
      last_outcome: z.enum(['found', 'not_found', 'ambiguous', 'error']).nullable(),
      operator_needed: z.boolean(),
      in_flight_command_id: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Every operator reset of an exhausted retry budget (P3-R19). */
  retry_budget_resets: z
    .array(z.strictObject({ at: isoUtc, by: z.literal('cli'), previous_retry_count: z.number().int().nonnegative(), note: z.string().max(200) }))
    .default([]),
  posted_at_source: z.enum(['screen', 'intent_estimate', 'completion', 'dry_run', 'operator']).nullable().default(null),
  /** The image prepared for the page's constraints (D6); named by its real format. */
  upload: z
    .strictObject({
      file_name: z.enum(['upload.jpg', 'upload.png']),
      mime: z.enum(['image/jpeg', 'image/png']),
      bytes: z.number().int(),
      sha256: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      constraints_hash: z.string(),
      prepared_at: isoUtc,
    })
    .nullable()
    .default(null),
  /** Who wrote the saved draft (P3-R41: live posts only drafts from a real provider). */
  draft_provenance: z
    .strictObject({ provider: z.enum(DRAFT_PROVIDERS), model: z.string().nullable(), prompt_version: z.string().nullable(), generated_at: isoUtc })
    .nullable()
    .default(null),
  /** Returns to GENERATING because the rules changed after the draft was made (P3-R29, max 2). */
  drift_regenerations: z.number().int().nonnegative().default(0),
  /** Pre-intent abandons on one JST day (P3-R49 cap). */
  pre_intent_abandons: z.strictObject({ date_jst: z.string(), count: z.number().int().nonnegative() }).nullable().default(null),
  operator_verdict: z.strictObject({ verdict: z.enum(['registered', 'not_registered']), at: isoUtc, basis: z.string().max(200) }).nullable().default(null),
  retry_blocked_reason: z.enum(['reconcile_conflict']).nullable().default(null),
});
export type Job = z.infer<typeof JobSchema>;

/** The stage of a job waiting in PENDING: given by makeNewJob, and again when an interrupted preparation restarts. */
export const INTAKE_STAGE = 'intake';

export function makeNewJob(p: {
  salon_id: string;
  post_type: PostType;
  audience_category: AudienceCategory;
  image: Job['image'];
  config_hash: string;
  clock: Clock;
}): Job {
  const now = p.clock.now().toISOString();
  return {
    schema_version: 1,
    id: newJobId(p.clock),
    revision: 0,
    salon_id: p.salon_id,
    post_type: p.post_type,
    audience_category: p.audience_category,
    resolved_route: null,
    operation: null,
    status: 'PENDING',
    stage: INTAKE_STAGE,
    image: p.image,
    analysis: null,
    draft: null,
    content_hash: null,
    config_hash: p.config_hash,
    instruction_refs: [],
    template_hash: null,
    trend_source_refs: [],
    scheduled_at: null,
    schedule_slot_id: null,
    attempt_count: 0,
    retry_count: 0,
    regeneration_count: 0,
    next_retry_at: null,
    submission_state: 'not_started',
    attempts: [],
    last_error: null,
    remote_post_id: null,
    remote_post_url: null,
    posted_at: null,
    verified_at: null,
    created_at: now,
    updated_at: now,
    reconcile: null,
    retry_budget_resets: [],
    posted_at_source: null,
    upload: null,
    draft_provenance: null,
    drift_regenerations: 0,
    pre_intent_abandons: null,
    operator_verdict: null,
    retry_blocked_reason: null,
  };
}
