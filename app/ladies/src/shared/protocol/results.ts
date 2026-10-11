import { z } from 'zod';
import { isoUtc } from '../zod-helpers.js';
import { ErrorCodeSchema, IdSchema, JstMinuteSchema, RouteKeySchema, withEnvelope } from './version.js';

const count = z.number().int().nonnegative();
const path = z.string().max(500);
/** Own post content only. */
const excerpt = z.string().max(60);

export const ObservedCountSchema = z.strictObject({ kind: z.enum(['total', 'daily', 'monthly']), value: count, limit: count.nullable() });
export type ObservedCount = z.infer<typeof ObservedCountSchema>;

/** No page text except the matched own-salon label. */
export const PageStateReportSchema = z.strictObject({
  url_origin: z.string().max(200).nullable(),
  url_path: path.nullable(),
  query_keys: z.array(z.string().max(100)).max(50),
  signals: z.strictObject({ login: z.boolean(), mfa: z.boolean(), captcha: z.boolean(), account_error: z.boolean(), limit_reached: z.boolean() }),
  salon_identified: z.boolean().nullable(),
  page_identified: z.boolean().nullable(),
  profile_id: z.string().max(100).nullable(),
  observed_count: ObservedCountSchema.nullable(),
});
export type PageStateReport = z.infer<typeof PageStateReportSchema>;

const EVIDENCE_MAX_BYTES = 4096;

export const EvidenceSchema = z
  .strictObject({
    page_url_path: path,
    completion: z.strictObject({ matched: z.boolean(), same_document: z.boolean(), signal_index: count.nullable(), excerpt: excerpt.nullable() }).nullable(),
    salon: z.array(z.strictObject({ page: z.enum(['completion', 'list', 'detail']), identified: z.boolean() })).max(10),
    list: z
      .strictObject({
        pages_checked: count,
        all_pages: z.boolean(),
        candidates: count,
        matched: z
          .strictObject({ title_excerpt: excerpt, date_text: z.string().max(40).nullable(), remote_post_id: z.string().max(100).nullable(), detail_url_path: path.nullable() })
          .nullable(),
      })
      .nullable(),
    rejection: z
      .strictObject({ kind: z.enum(['submit_rejected', 'limit_reached', 'upload_error']), client_side_only: z.boolean(), excerpt: excerpt.nullable(), navigated: z.boolean() })
      .nullable(),
    /** Fixed English tokens, e.g. 'click_aborted:ttl', 'readback_mismatch:title'. */
    notes: z.array(z.string().regex(/^[a-z0-9_.:-]{1,60}$/)).max(20),
  })
  .refine((e) => new TextEncoder().encode(JSON.stringify(e)).length <= EVIDENCE_MAX_BYTES, '証跡が大きすぎます（4 KiB まで）');
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ResultFlagsSchema = z.strictObject({ mutated: z.boolean(), unexpected_navigation: z.boolean(), inferred_click: z.boolean() });
export type ResultFlags = z.infer<typeof ResultFlagsSchema>;

const observed = z.strictObject({ registered_at_text: z.string().max(40).nullable() }).nullable();

export const ResultRequestSchema = withEnvelope({
  attempt_id: IdSchema,
  command_id: IdSchema,
  outcome: z.enum(['submitted', 'posted', 'not_registered', 'unknown']),
  code: ErrorCodeSchema.nullable(),
  stage: z.string().max(40).nullable(),
  evidence: EvidenceSchema.nullable(),
  observed,
  flags: ResultFlagsSchema,
  /** Honoured only if a future profile signal provides it (P3-R12). */
  retry_after_seconds: z.number().int().nonnegative().max(86_400).optional(),
});
export type ResultRequest = z.infer<typeof ResultRequestSchema>;

export const AutoReconcileRequestSchema = withEnvelope({
  reconcile_id: IdSchema,
  command_id: IdSchema,
  outcome: z.enum(['found', 'not_found', 'ambiguous', 'error']),
  evidence: EvidenceSchema,
  observed,
});
export type AutoReconcileRequest = z.infer<typeof AutoReconcileRequestSchema>;

/** https, no user info, no query values (only keys), no fragment. The allowed origin is checked by Node. */
const remotePostUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    const u = URL.parse(s);
    return u !== null && u.protocol === 'https:' && u.username === '' && u.password === '' && u.hash === '' && [...u.searchParams.values()].every((v) => v === '');
  }, '投稿のURLは https:// で始まり、? 以降に値を含まない形で書いてください');

export const OperatorReconcileRequestSchema = withEnvelope({
  verdict: z.enum(['registered', 'not_registered']).optional(),
  /** Required with a verdict. */
  basis: z.string().min(1).max(200).optional(),
  remote_post_url: remotePostUrl.optional(),
  registered_at_jst: JstMinuteSchema.optional(),
}).refine((r) => (r.verdict === undefined) === (r.basis === undefined), { error: '判定（verdict）と根拠（basis）は一緒に指定してください', path: ['basis'] });
export type OperatorReconcileRequest = z.infer<typeof OperatorReconcileRequestSchema>;

export const PreflightResultSchema = z.strictObject({
  preflight_id: IdSchema,
  finished_at: isoUtc,
  outcome: z.enum(['passed', 'failed', 'timeout']),
  targets: z
    .array(
      z.strictObject({
        route_key: RouteKeySchema,
        page: PageStateReportSchema.nullable(),
        checks: z
          .array(z.strictObject({ check: z.enum(['url', 'login', 'page', 'salon', 'audience', 'fields', 'submit', 'count']), ok: z.boolean(), detail_ja: z.string().max(200) }))
          .max(20),
      }),
    )
    .max(4),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export const PreflightResultRequestSchema = withEnvelope({ preflight_id: IdSchema, command_id: IdSchema, result: PreflightResultSchema });
export type PreflightResultRequest = z.infer<typeof PreflightResultRequestSchema>;
