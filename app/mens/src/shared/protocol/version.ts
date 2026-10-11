import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '../errors.js';

// src/shared/protocol is shared by Node and the Chrome extension: it may import only zod, ../types.js, ../errors.js
// (types and enums), ../zod-helpers.js and ../text-normalize.js, never node:* (lint + tests/unit/protocol/purity.test.ts).

export const PROTOCOL_VERSION = 1;
export const ROUTE_KEYS = ['style.mens', 'style.ladies', 'blog.mens', 'blog.ladies'] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];
/** route.adapter_id must equal the profile's post_type. */
export const ADAPTER_IDS = ['style', 'blog'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];
/** salonboard_fields.adapter_version and profile.adapter_version. */
export const ADAPTER_VERSION = '1';

export const API_ONLY_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_HOST',
  'PAYLOAD_TOO_LARGE',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'PROTOCOL_MISMATCH',
  'PAIRING_FAILED',
  'PAIRING_LOCKED',
  'PAIRING_NOT_OPEN',
  'STALE_CLIENT',
  'RATE_LIMITED',
  'WINDOW_CLOSED',
  'PAUSED',
  'NOT_IMPLEMENTED',
  'BUSY',
] as const;
export type ApiErrorCode = ErrorCode | (typeof API_ONLY_CODES)[number];

// ---------------------------------------------------------------- common pieces

export const IdSchema = z.string().min(1).max(100);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** JST minute, 'YYYY-MM-DD HH:mm'. */
export const JstMinuteSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
/** JST date, 'YYYY-MM-DD'. */
export const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const RouteKeySchema = z.enum(ROUTE_KEYS);
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const ApiErrorCodeSchema = z.enum([...ERROR_CODES, ...API_ONLY_CODES]);

/** Every request and response body carries these; request_id equals the X-Request-Id header. */
export const envelope = { protocol_version: z.literal(PROTOCOL_VERSION), request_id: z.uuid() };
/** A strict body with the envelope fields. */
export const withEnvelope = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...envelope, ...shape });

export const ApiErrorBodySchema = withEnvelope({
  code: ApiErrorCodeSchema,
  /** Japanese; no secrets and no raw request keys. */
  message: z.string().max(500),
  retryable: z.boolean(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
