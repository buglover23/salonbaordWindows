import { z } from 'zod';
import { JOB_STATUSES, MODES, POST_TYPES } from '../types.js';
import { isoUtc } from '../zod-helpers.js';
import { CommandSchema, MatchKeysSchema } from './commands.js';
import { LocatorSetSchema } from './profile.js';
import { ObservedCountSchema, PageStateReportSchema } from './results.js';
import { StopDtoSchema } from './status.js';
import { SurveyCaptureSchema } from './survey.js';
import { ApiErrorCodeSchema, ErrorCodeSchema, IdSchema, RouteKeySchema, Sha256HexSchema, withEnvelope } from './version.js';

// Request and response bodies of the local API (§6.2). Every body carries protocol_version and request_id.

export const PHASES = [
  'navigating',
  'checking_page',
  'uploading',
  'filling',
  'reading_back',
  'awaiting_permission',
  'authorized',
  'clicking',
  'clicked',
  'verifying_completion',
  'verifying_list',
  'reconciling',
  'preflight',
  'probe',
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;
export const HeartbeatDetailSchema = z.enum([
  'page_loading',
  'waiting_signal',
  'uploading_chunk',
  'waiting_preview',
  'filling',
  'reading_back',
  'waiting_permission',
  'verifying',
  'mutated',
]);

const version = z.string().min(1).max(40);
const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);
const extensionId = z.string().regex(/^[a-p]{32}$/);
const jst = z.string().max(40);
const seconds = z.number().int().positive();
const JobStatusSchema = z.enum(JOB_STATUSES);

// ---------------------------------------------------------------- health and pairing

export const HealthResponseSchema = withEnvelope({
  instance_id: IdSchema,
  server_nonce: b64url,
  state: z.enum(['running', 'stopping']),
  mode: z.enum(MODES),
  app_version: version,
  paired: z.boolean(),
});
export const PairStartRequestSchema = withEnvelope({ extension_version: version });
export const PairStartResponseSchema = withEnvelope({ expires_in_seconds: seconds });
export const PairBeginRequestSchema = withEnvelope({ client_nonce: b64url, extension_id: extensionId });
export const PairBeginResponseSchema = withEnvelope({ pairing_id: IdSchema, server_nonce: b64url });
export const PairFinishRequestSchema = withEnvelope({ pairing_id: IdSchema, client_proof: b64url });
export const PairFinishResponseSchema = withEnvelope({ client_id: IdSchema, sealed_key: b64url, server_proof: b64url, fingerprint: z.string().length(4) });
export const ControlPairRequestSchema = withEnvelope({});
/** The CLI prints the code; the old client is revoked when the new one finishes. */
export const ControlPairResponseSchema = withEnvelope({ code: z.string().max(20), expires_in_seconds: seconds });

// ---------------------------------------------------------------- hello, claim, heartbeat

export const HelloRequestSchema = withEnvelope({
  extension_id: extensionId,
  extension_version: version,
  adapter_version: version,
  build: z.enum(['production', 'e2e']),
  instance_seen: IdSchema.nullable(),
  tab: z.strictObject({ state: z.enum(['none', 'loading', 'ready']), url_origin: z.string().max(200).nullable(), url_path: z.string().max(500).nullable() }),
  page: PageStateReportSchema.nullable(),
  /** loopback_ok: the outcome of the last fetch to Node. */
  permissions: z.strictObject({ salonboard_origins_granted: z.boolean(), loopback_ok: z.boolean() }),
  /** The store name an open SALON BOARD tab shows, only when it is not the expected one (this Chrome is the wrong one). */
  salon_shown: z.string().min(1).max(100).nullable().optional(),
});
export type HelloRequest = z.infer<typeof HelloRequestSchema>;

export const HelloResponseSchema = withEnvelope({
  instance_id: IdSchema,
  mode: z.enum(MODES),
  paused: z.boolean(),
  heartbeat_seconds: z.literal(10),
  /** The SW intersects these with its build-time origins. */
  allowed_origins: z.array(z.string().max(200)),
  dispatch: z.strictObject({ post_allowed: z.boolean(), reasons: z.array(z.strictObject({ code: ApiErrorCodeSchema, message_ja: z.string().max(2000) })) }),
  probe_allowed: z.boolean(),
  survey_allowed: z.boolean(),
  client_fingerprint: z.string().length(4),
  stops: z.array(StopDtoSchema),
  /** salon.json expected_account_label and poster_name: the only page texts a survey keeps by exact match (Task 5a). */
  salon_label: z.string().max(100).nullable().default(null),
  poster_name: z.string().max(100).nullable().default(null),
  /** Where the store name is shown (a verified page profile's salon_identification), for the salon_shown check. */
  salon_locators: LocatorSetSchema.nullable().default(null),
});
export type HelloResponse = z.infer<typeof HelloResponseSchema>;

export const ClaimRequestSchema = withEnvelope({ extension_version: version, adapter_version: version, tab_ready: z.boolean() });
/** 204 (no body) when nothing is allowed now. */
export const ClaimResponseSchema = withEnvelope({ instance_id: IdSchema, command: CommandSchema });
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

export const HeartbeatRequestSchema = withEnvelope({ attempt_id: IdSchema.nullable(), command_id: IdSchema, phase: PhaseSchema, detail: HeartbeatDetailSchema.optional() });
export const HeartbeatResponseSchema = withEnvelope({ continue: z.boolean(), paused: z.boolean(), reason_ja: z.string().max(2000).nullable() });

// ---------------------------------------------------------------- submit intent and result

export const SubmitIntentRequestSchema = withEnvelope({
  attempt_id: IdSchema,
  command_id: IdSchema,
  document_ref: IdSchema,
  readback: z.strictObject({
    fields: z.record(z.string().max(60), z.strictObject({ ok: z.boolean(), length: z.number().int().nonnegative().optional() })),
    image_preview: z.boolean(),
    poster_ok: z.boolean(),
    constraint_check_ok: z.boolean(),
    salon_identified: z.literal(true),
    page_identified: z.literal(true),
    audience_identified: z.literal(true),
  }),
  observed_count: z.strictObject({ at_start: ObservedCountSchema.nullable(), before_submit: ObservedCountSchema.nullable() }),
});
export type SubmitIntentRequest = z.infer<typeof SubmitIntentRequestSchema>;

export const PermissionSchema = z.strictObject({ permission_id: IdSchema, attempt_id: IdSchema, command_id: IdSchema, document_ref: IdSchema, ttl_ms: z.number().int().positive().max(60_000) });
export const SubmitIntentResponseSchema = withEnvelope({ permission: PermissionSchema, match: MatchKeysSchema });
export type SubmitIntentResponse = z.infer<typeof SubmitIntentResponseSchema>;

export const ResultResponseSchema = withEnvelope({ job_status: JobStatusSchema, idempotent_replay: z.boolean(), applied: z.boolean() });

export const ReconcileResponseSchema = withEnvelope({
  job_status: JobStatusSchema,
  reconcile_outcome: z.enum(['found', 'not_found', 'ambiguous', 'error', 'registered', 'not_registered']),
});
/** 202 to an operator reconcile without a verdict. */
export const ReconcileScheduledResponseSchema = withEnvelope({ scheduled_at: isoUtc });

// ---------------------------------------------------------------- control

export const PauseRequestSchema = withEnvelope({ reason: z.string().max(100).optional() });
export const PauseResponseSchema = withEnvelope({ paused: z.literal(true) });
/** confirm_checked: the owner checked SALON BOARD for a double registration (clears a POST_RESULT_UNKNOWN stop). */
export const ResumeRequestSchema = withEnvelope({ confirm_checked: z.boolean().optional() });
/** notes: why stops remain (Japanese, shown by the CLI). */
export const ResumeResponseSchema = withEnvelope({
  paused: z.literal(false),
  checking: z.boolean(),
  pending_stops: z.array(StopDtoSchema),
  notes: z.array(z.string().max(500)).max(20).default([]),
});
export const PreflightRequestSchema = withEnvelope({ route_key: z.union([RouteKeySchema, z.literal('configured')]) });
export const PreflightResponseSchema = withEnvelope({ preflight_id: IdSchema });
export const AppliedResponseSchema = withEnvelope({ applied: z.boolean() });

export const LiveSinglePreviewSchema = z.strictObject({
  route_key: RouteKeySchema,
  job_id: IdSchema,
  title: z.string(),
  /** First 80 graphemes. */
  text_head: z.string(),
  category_label: z.string(),
  image_name: z.string().max(260),
  /** origin + path, query keys only. */
  route_url_display: z.string().max(500),
  content_hash: Sha256HexSchema,
  image_sha256: Sha256HexSchema,
});
export type LiveSinglePreview = z.infer<typeof LiveSinglePreviewSchema>;
/** confirm:true re-sends the previewed job id and hashes; it arms only while they still hold. */
export const LiveSingleRequestSchema = withEnvelope({
  route_key: RouteKeySchema,
  job_id: IdSchema.optional(),
  confirm: z.boolean(),
  content_hash: Sha256HexSchema.optional(),
  image_sha256: Sha256HexSchema.optional(),
  /** Send at the next scheduler tick instead of the next slot (the slot is pulled forward). */
  now: z.boolean().optional(),
});
export const LiveSinglePreviewResponseSchema = withEnvelope({ preview: LiveSinglePreviewSchema });
export const LiveSingleArmedResponseSchema = withEnvelope({ armed: z.literal(true), job_id: IdSchema, next_slot_at_jst: jst.nullable() });

export const ProbeRequestSchema = withEnvelope({ arm: z.literal(true), confirm: z.literal(true) });
export const ProbeResponseSchema = withEnvelope({ expires_at_jst: jst });

export const RetryRequestSchema = withEnvelope({ job_id: IdSchema.optional() });
export const RetryResponseSchema = withEnvelope({
  /** restart: where the job starts again (image analysis, text generation, or waiting to post). */
  requeued: z.array(z.strictObject({ job_id: IdSchema, reset_budget: z.boolean(), restart: z.enum(['analysis', 'generation', 'posting']) })),
  excluded: z.array(z.strictObject({ job_id: IdSchema, code: ErrorCodeSchema, reason_ja: z.string().max(2000) })),
});

/** `redraft`: READY drafts never handed to a poster go back to the text generation (dry: only listed). */
export const RedraftRequestSchema = withEnvelope({ job_id: IdSchema.optional(), post_type: z.enum(POST_TYPES).optional(), dry: z.boolean().optional() });
export const RedraftResponseSchema = withEnvelope({
  dry: z.boolean(),
  redrafted: z.array(z.strictObject({ job_id: IdSchema, post_type: z.enum(POST_TYPES) })),
  skipped: z.array(IdSchema),
});

// Plan 4: the 30-day cleanup (spec 16.5). The request names no path: what is removed is decided by the tool alone.
const n = z.number().int().nonnegative();
export const CLEANUP_EXCLUSIONS = ['operation', 'in_flight', 'unresolved', 'unexpected_entry'] as const;
export const CleanupPreviewSchema = z.strictObject({
  enabled: z.boolean(),
  days: n,
  /** Expired POSTED jobs that the next runs remove, and the bytes of their images and evidence. */
  due: n,
  bytes: n,
  /** POSTED jobs still inside the retention period. */
  waiting: n,
  excluded: z.array(z.strictObject({ reason: z.enum(CLEANUP_EXCLUSIONS), count: n })),
  /** Jobs that are not POSTED (never removed automatically). */
  protected_jobs: n,
  /** Daily plans older than the period that no remaining job is in. */
  schedules: n,
});
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;
export const CleanupReportSchema = z.strictObject({
  cleaned: n,
  bytes: n,
  /** Expired jobs left for the next run. */
  remaining: n,
  failed: z.array(z.strictObject({ job_id: IdSchema, message: z.string().max(2000) })),
  schedules: n,
  at: isoUtc,
});
export type CleanupReport = z.infer<typeof CleanupReportSchema>;
export const CleanupRequestSchema = withEnvelope({});
export const CleanupPreviewResponseSchema = withEnvelope({ preview: CleanupPreviewSchema });
export const CleanupResponseSchema = withEnvelope({ report: CleanupReportSchema });

export const SurveyRequestSchema = withEnvelope({
  capture: SurveyCaptureSchema,
  link: z.strictObject({ job_id: IdSchema, attempt_id: IdSchema, kind: z.literal('live-single-outline') }).optional(),
});
export const SurveyResponseSchema = withEnvelope({ saved_as: z.string().max(300) });
