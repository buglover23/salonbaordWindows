import { z } from 'zod';
import { PhaseSchema, SubmitIntentRequestSchema } from './api.js';
import { MatchKeysSchema, PostCommandSchema, PreflightTargetSchema } from './commands.js';
import { LocatorSetSchema, PageProfileSchema } from './profile.js';
import { EvidenceSchema, PageStateReportSchema, ResultFlagsSchema } from './results.js';
import { SurveyCaptureSchema } from './survey.js';
import { ApiErrorCodeSchema, ErrorCodeSchema, IdSchema } from './version.js';

// SW ↔ content script and popup → SW messages (§6.7). The SW Zod-validates every message before its sender checks.
// No message type can name a URL to fetch.

const command_id = IdSchema;
const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.strictObject({ type: z.literal(type), ...shape });
const readback = SubmitIntentRequestSchema.shape.readback;
const observed_count = SubmitIntentRequestSchema.shape.observed_count;
/**
 * The blog's two-step submit (confirm_page): what the input page read back before its 確認する click, handed by the SW to
 * the confirmation page for its one submit request (the confirmation page has no inputs to read back).
 */
export const CarrySchema = z.strictObject({ readback, observed_count });
export type Carry = z.infer<typeof CarrySchema>;

export const CsMessageSchema = z.discriminatedUnion('type', [
  /** Once per document; no page content. */
  msg('cs.ready', { href_origin: z.string().max(200), href_path: z.string().max(500), query_keys: z.array(z.string().max(100)).max(50) }),
  /**
   * Also the keepalive, at least every 20 s during any wait. Phase 'navigating' announces a page change the CS causes
   * itself (a reloads_page field; the blog's 確認する, with `carry`).
   */
  msg('cs.progress', { command_id, phase: PhaseSchema, mutated: z.literal(true).optional(), carry: CarrySchema.optional() }),
  msg('cs.chunk_request', { command_id, index: z.number().int().nonnegative() }),
  msg('cs.submit_request', { command_id, readback, observed_count }),
  /** The CS waits for clicking_ack before it clicks. */
  msg('cs.clicking', { command_id }),
  msg('cs.clicked', { command_id }),
  msg('cs.click_aborted', { command_id, reason: z.enum(['ttl', 'submit_not_unique', 'submit_disabled', 'runtime_gone', 'navigated']) }),
  msg('cs.report', {
    command_id,
    kind: z.enum(['post_step', 'completion', 'list', 'detail', 'preflight', 'reconcile', 'publish']),
    ok: z.boolean(),
    code: ErrorCodeSchema.nullable(),
    evidence: EvidenceSchema.nullable(),
    page_state: PageStateReportSchema.nullable(),
    flags: ResultFlagsSchema,
    /**
     * Where the SW should go next; it navigates only after its guard. kind 'list' with no candidate yet → the next list
     * page (list.url_match); kind 'list' with one candidate whose detail page must confirm it → its detail link (detail.url_match).
     */
    next_url: z.string().max(2048).optional(),
  }),
  msg('cs.pong', { command_id }),
  msg('cs.survey_result', { capture: SurveyCaptureSchema }),
  /** The page was not captured (or not probed); detail is a schema path or null, never page text. */
  msg('cs.survey_refused', { reason: z.enum(['login_page', 'customer_data', 'too_large', 'invalid', 'probe_image']), detail: z.string().max(100).nullable() }),
  msg('cs.probe_result', { capture: SurveyCaptureSchema }),
]);
export type CsMessage = z.infer<typeof CsMessageSchema>;

/** Sent with tabs.sendMessage({documentId}). */
export const SwMessageSchema = z.discriminatedUnion('type', [
  msg('run_post', { command: PostCommandSchema, carry: CarrySchema.optional() }),
  msg('verify_completion', { command_id, profile: PageProfileSchema, match: MatchKeysSchema, same_document: z.boolean() }),
  msg('verify_list', { command_id, profile: PageProfileSchema, match: MatchKeysSchema, page_index: z.number().int().nonnegative() }),
  msg('verify_detail', { command_id, profile: PageProfileSchema, match: MatchKeysSchema }),
  /** 反映申請 after a proved post: only the first document of the step may click (`may_click`); the landing document only reports. */
  msg('run_publish', { command_id, profile: PageProfileSchema, salon_label: z.string().min(1).max(100), may_click: z.boolean() }),
  msg('run_preflight', { command_id, target: PreflightTargetSchema, salon: z.strictObject({ expected_account_label: z.string().min(1).max(100) }) }),
  msg('run_survey', { kind: z.enum(['form', 'page']), known_title: z.string().max(100).nullable(), salon_label: z.string().max(100).nullable(), poster_name: z.string().max(100).nullable(), strict: z.boolean() }),
  /** The image comes as chunks. */
  msg('run_probe', { probe_id: IdSchema }),
  msg('chunk', { index: z.number().int().nonnegative(), total: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), b64: z.string().max(1_048_576) }),
  z.discriminatedUnion('granted', [
    msg('permission', { granted: z.literal(true), permission_id: IdSchema, ttl_ms_remaining: z.number().int().nonnegative() }),
    msg('permission', { granted: z.literal(false), code: ApiErrorCodeSchema }),
  ]),
  msg('clicking_ack', { command_id }),
  msg('ping', { command_id }),
  msg('abort', { command_id }),
  /** The store name the page shows (answered with { label }), for the wrong-Chrome check of hello. */
  msg('read_salon', { locators: LocatorSetSchema }),
]);
export type SwMessage = z.infer<typeof SwMessageSchema>;

export const PopupMessageSchema = z.discriminatedUnion('type', [
  msg('popup.status', {}),
  msg('popup.pair_start', {}),
  msg('popup.pair_code', { code: z.string().max(20) }),
  msg('popup.pause', {}),
  msg('popup.resume', {}),
  msg('popup.survey', { kind: z.enum(['form', 'page']), known_title: z.string().max(100).optional(), confirmed_no_customer_data: z.literal(true) }),
  msg('popup.probe', { confirmed_no_register: z.literal(true) }),
]);
export type PopupMessage = z.infer<typeof PopupMessageSchema>;
