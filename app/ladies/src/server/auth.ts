import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalRequest, canonicalResponse } from '../shared/protocol/signing.js';

// Authentication of the local API (Plan 3 D1-2, D1-3, D1-5): HMAC-SHA256 signatures in base64url, compared as SHA-256
// digests with timingSafeEqual, a replay cache per server_nonce, and the Host / Origin rules.

/** ext: the paired extension (X-Client-Id); cli: this machine's CLI (X-Cli: 1); pair: unsigned (health and pairing). */
export type Principal = 'ext' | 'cli' | 'pair';

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();
export const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

/** Constant-time equality of two strings of any length (their SHA-256 digests are compared). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** X-Signature of a request: b64url(HMAC(K, "req|" + server_nonce + "|" + request_id + "|" + METHOD + "|" + path_and_query + "|" + hex(sha256(body)))). */
export function requestSignatureOk(key: Uint8Array, p: { serverNonce: string; requestId: string; method: string; pathAndQuery: string; body: Uint8Array }, signature: string): boolean {
  const want = b64url(hmac(key, canonicalRequest({ serverNonce: p.serverNonce, requestId: p.requestId, method: p.method, pathAndQuery: p.pathAndQuery, bodySha256Hex: sha256(p.body).toString('hex') })));
  return safeEqual(want, signature);
}

/** X-Signature of a response: b64url(HMAC(K, "res|" + request_id + "|" + status + "|" + hex(sha256(body)))). */
export function signResponse(key: Uint8Array, requestId: string, status: number, bodySha256Hex: string): string {
  return b64url(hmac(key, canonicalResponse({ requestId, status, bodySha256Hex })));
}

/** null when allowed. ext/pair: absent, or exactly chrome-extension://<allowed id> ("null" counts as present); cli: absent. */
export function originRefusal(origin: string | undefined, principal: Principal, allowedIds: readonly string[]): string | null {
  if (origin === undefined) return null;
  if (principal === 'cli') return 'コマンドからの要求に Origin は付けられません';
  const id = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
  return id !== undefined && allowedIds.includes(id) ? null : '許可していない呼び出し元です';
}

/** The X-Request-Id cache of one server_nonce: an id seen before is a replay. Bounded LRU. */
export class ReplayCache {
  readonly #seen = new Map<string, true>();
  constructor(readonly limit = 4096) {}

  /** false: seen before. Otherwise records it. */
  add(requestId: string): boolean {
    if (this.#seen.has(requestId)) return false;
    this.#seen.set(requestId, true);
    if (this.#seen.size > this.limit) this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }
}
