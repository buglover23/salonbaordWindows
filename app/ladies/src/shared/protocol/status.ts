import { z } from 'zod';
import { AUDIENCE_CATEGORIES, MODES, POST_TYPES } from '../types.js';
import { PreflightResultSchema } from './results.js';
import { DateKeySchema, ErrorCodeSchema, IdSchema, RouteKeySchema, withEnvelope } from './version.js';

const count = z.number().int().nonnegative();
const text = z.string().max(2000);
const jst = z.string().max(40);

/** The API / status view of a stop. */
export const StopDtoSchema = z.strictObject({
  scope: z.enum(['salon', 'type', 'route']),
  post_type: z.enum(POST_TYPES).nullable(),
  audience_category: z.enum(AUDIENCE_CATEGORIES).nullable(),
  code: ErrorCodeSchema,
  message: text,
  remedy: text,
  job_id: IdSchema.nullable(),
  raised_at_jst: jst,
  clears_at_jst: jst.nullable(),
});
export type StopDto = z.infer<typeof StopDtoSchema>;

export const ReadinessItemSchema = z.strictObject({ code: ErrorCodeSchema, detail: text });

const reasons = z.array(z.strictObject({ code: z.string().max(60), message_ja: text }));

const perType = z.strictObject({
  target: count,
  done: count,
  reserved: count,
  /** Reserved slots whose job is VERIFY_REQUIRED. */
  unknown: count,
  /** max(0, target − done − reserved − open): what can no longer be posted today (as the CLI's 不足). */
  shortfall: count,
  next_at_jst: jst.nullable(),
  quota: z.strictObject({ remaining: z.number().int().nullable(), limiting_kind: z.string().max(40).nullable(), reason_ja: text.nullable() }),
});

const routeStatus = z.strictObject({
  configured: z.boolean(),
  source: z.enum(['config', 'instruction']).nullable(),
  /** origin + path, query keys only. */
  url_display: z.string().max(500).nullable(),
  screen: z.enum(['verified', 'unverified', 'changed_since_verification', 'missing_profile']),
  first_post: z.enum(['done', 'needs_live_single', 'armed']),
  /** true: an audience this copy does not handle (settings.audiences); the other copy of the tool posts it. */
  not_handled: z.literal(true).optional(),
});

const mb = z.number().nonnegative();
export const ResourcesSchema = z.strictObject({
  rss_mb: mb.nullable(),
  free_disk_mb: mb.nullable(),
  /** The mode's data folder (images, jobs, backups, …), measured once a day. */
  data_mb: mb.nullable(),
  logs_mb: mb.nullable(),
  backups_mb: mb.nullable(),
  pressure: z.enum(['RESOURCE_MEMORY_HIGH', 'RESOURCE_DISK_LOW']).nullable(),
  /** Expired POSTED jobs the next cleanup removes. */
  cleanup_due: count,
  last_cleanup: z.strictObject({ at_jst: jst, cleaned: count, freed_mb: mb, remaining: count, failed: count }).nullable(),
});
export type ResourcesDto = z.infer<typeof ResourcesSchema>;

/** Shared by the CLI and the popup. */
export const StatusDtoSchema = withEnvelope({
  mode: z.enum(MODES),
  paused: z.boolean(),
  pause_reason: text.nullable(),
  checked_at_jst: jst,
  today: DateKeySchema,
  /** §5.5 rows that currently say "no". */
  dispatch: z.strictObject({ post_allowed: z.boolean(), reasons }),
  per_type: z.strictObject({ style: perType, blog: perType }),
  jobs: z.strictObject({ failed: count, verify_required: count, retry_wait: count, blocked: count, ready: count, generating: count }),
  extension: z.strictObject({
    /** An authenticated extension request arrived ≤ 90 s ago. */
    connected: z.boolean(),
    last_seen_jst: jst.nullable(),
    version: z.string().max(40).nullable(),
    logged_in: z.boolean().nullable(),
    tab_state: z.string().max(20).nullable(),
    fingerprint: z.string().max(10).nullable(),
    paired: z.boolean(),
  }),
  stops: z.array(StopDtoSchema),
  recovery_halted: z.array(z.strictObject({ job_id: IdSchema, reason_ja: text })),
  config_rejected: z.array(z.strictObject({ file: z.string().max(200), message: text })),
  readiness: z.strictObject({ global: z.array(ReadinessItemSchema), routes: z.record(RouteKeySchema, z.array(ReadinessItemSchema)) }).nullable(),
  routes: z.record(RouteKeySchema, routeStatus),
  live_single: z.strictObject({ route_key: RouteKeySchema, job_id: IdSchema, armed_at_jst: jst }).nullable(),
  preflight: PreflightResultSchema.nullable(),
  probe: z.strictObject({ armed_until_jst: jst }).nullable(),
  operator_actions: z.array(z.strictObject({ job_id: IdSchema, action_ja: text })),
  /** Includes the ACL, screenshot and upload-format warnings. */
  warnings: z.array(text),
  /** Plan 4 (spec 16.6): what the running tool's resource monitor last saw; null when the tool is not running. */
  resources: ResourcesSchema.nullable().default(null),
});
export type StatusDto = z.infer<typeof StatusDtoSchema>;
/** StatusDto without the envelope (the server adds it). */
export type StatusBody = Omit<StatusDto, 'protocol_version' | 'request_id'>;
