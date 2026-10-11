import type { z } from 'zod';
import { ApiErrorBodySchema, canonicalRequest, canonicalResponse, HealthResponseSchema, PROTOCOL_VERSION } from '../../../../src/shared/protocol/index.js';
import type { ApiErrorBody } from '../../../../src/shared/protocol/index.js';
import { b64url, fromB64url, hex, hmac, sameBytes, sha256, utf8 } from './crypto.js';
import type { ClientKey } from './key-store.js';

// The only network call site of the extension (§6.2, D1). Every request except health and pairing is signed, and every
// response signature is verified before any field is read. Anything unverifiable means "Node is not there".

export type ApiResult<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'refused'; status: number; error: ApiErrorBody }
  | { kind: 'unknown'; reason: 'unpaired' | 'network' | 'bad_signature' | 'bad_body' | 'server_error' };

/** Request timeouts (§5.4). submit-intent is never retried. */
export const TIMEOUT_MS = { default: 10_000, claim: 15_000, asset: 20_000, intent: 10_000 } as const;
const ASSET_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Node's loopback API: exactly the build-time base (http://127.0.0.1:<settings.server.port>, or the fixed E2E port 3911
 * in an E2E build); no other URL literal may appear in the SW bundle.
 */
const isApiBase = (base: string): boolean => {
  const u = URL.parse(base);
  return u !== null && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '' && u.origin === base && base === __API_BASE__;
};

interface Raw {
  status: number;
  headers: Headers;
  bytes: Uint8Array<ArrayBuffer>;
}

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
};

export class ApiClient {
  /** The outcome of the last fetch to Node (hello permissions.loopback_ok). */
  loopbackOk = false;
  #nonce: string | null = null;

  constructor(
    private readonly base: string,
    private readonly key: () => Promise<ClientKey | null>,
  ) {
    if (!isApiBase(base)) throw new Error(`接続先が不正です: ${base}`);
  }

  async #send(path: string, init: RequestInit, timeoutMs: number): Promise<Raw | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + path, { ...init, signal: ac.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.loopbackOk = true;
      return { status: res.status, headers: res.headers, bytes };
    } catch {
      this.loopbackOk = false;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Unsigned; gives the server_nonce every signed request needs. */
  async health(): Promise<z.infer<typeof HealthResponseSchema> | null> {
    const r = await this.#send('/v1/health', { method: 'GET', headers: { 'X-Request-Id': crypto.randomUUID() } }, TIMEOUT_MS.default);
    const parsed = r?.status === 200 ? HealthResponseSchema.safeParse(parseJson(r.bytes)) : null;
    this.#nonce = parsed?.success === true ? parsed.data.server_nonce : null;
    return parsed?.success === true ? parsed.data : null;
  }

  /** Pairing only (valid while a pairing window is open); the pairing proofs are the credential. */
  async unsigned<S extends z.ZodType>(path: string, body: object, schema: S): Promise<ApiResult<z.infer<S>>> {
    const requestId = crypto.randomUUID();
    const r = await this.#send(
      path,
      { method: 'POST', headers: { 'X-Request-Id': requestId, 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: requestId, ...body }) },
      TIMEOUT_MS.default,
    );
    return r === null ? { kind: 'unknown', reason: 'network' } : this.#interpret(r, requestId, schema);
  }

  /** A signed JSON request. A 204 gives body null. */
  async signed<S extends z.ZodType>(method: 'GET' | 'POST', path: string, body: object | null, schema: S, timeoutMs: number = TIMEOUT_MS.default): Promise<ApiResult<z.infer<S> | null>> {
    const r = await this.#signedRaw(method, path, body, timeoutMs);
    if ('kind' in r) return r;
    const result = r.raw.status === 204 ? ({ kind: 'ok', status: 204, body: null } as const) : this.#interpret(r.raw, r.requestId, schema);
    if (result.kind !== 'ok') this.#nonce = null; // e.g. Node restarted (new nonce): fetch it again next time
    return result;
  }

  /** GET /v1/jobs/:id/asset: the signature covers the bytes; the size and SHA-256 must match what the command announced. */
  async asset(path: string, expect: { sha256: string; bytes: number }): Promise<Uint8Array<ArrayBuffer> | null> {
    const r = await this.#signedRaw('GET', path, null, TIMEOUT_MS.asset);
    if ('kind' in r || r.raw.status !== 200) return null;
    const { bytes, headers } = r.raw;
    const ok = bytes.length === expect.bytes && bytes.length <= ASSET_MAX_BYTES && headers.get('X-Asset-Sha256') === expect.sha256 && hex(await sha256(bytes)) === expect.sha256;
    return ok ? bytes : null;
  }

  /** The synthetic probe image bundled with the extension (Task 5a); the only non-Node fetch, and only of this file. */
  async probeImage(): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const res = await fetch(chrome.runtime.getURL('probe.jpg'), { cache: 'no-store' });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return res.ok && bytes.length > 0 && bytes.length <= ASSET_MAX_BYTES ? bytes : null;
    } catch {
      return null;
    }
  }

  async #signedRaw(method: 'GET' | 'POST', path: string, body: object | null, timeoutMs: number): Promise<{ raw: Raw; requestId: string } | ApiResult<never>> {
    const k = await this.key();
    if (k === null) return { kind: 'unknown', reason: 'unpaired' };
    if (this.#nonce === null) await this.health();
    const nonce = this.#nonce;
    if (nonce === null) return { kind: 'unknown', reason: 'network' };
    const requestId = crypto.randomUUID();
    const text = body === null ? '' : JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: requestId, ...body });
    const canonical = canonicalRequest({ serverNonce: nonce, requestId, method, pathAndQuery: path, bodySha256Hex: hex(await sha256(utf8(text))) });
    const headers: Record<string, string> = { 'X-Request-Id': requestId, 'X-Client-Id': k.client_id, 'X-Signature': b64url(await hmac(k.key, canonical)) };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const raw = await this.#send(path, method === 'POST' ? { method, headers, body: text } : { method, headers }, timeoutMs);
    const verified = raw !== null && (await this.#verify(k, raw, requestId));
    if (raw === null || !verified) {
      this.#nonce = null;
      return { kind: 'unknown', reason: raw === null ? 'network' : 'bad_signature' };
    }
    return { raw, requestId };
  }

  async #verify(k: ClientKey, raw: Raw, requestId: string): Promise<boolean> {
    const got = raw.headers.get('X-Signature');
    if (got === null) return false;
    try {
      const expected = await hmac(k.key, canonicalResponse({ requestId, status: raw.status, bodySha256Hex: hex(await sha256(raw.bytes)) }));
      return sameBytes(expected, fromB64url(got));
    } catch {
      return false;
    }
  }

  #interpret<S extends z.ZodType>(raw: Raw, requestId: string, schema: S): ApiResult<z.infer<S>> {
    const json = parseJson(raw.bytes);
    const sameRequest = (b: { request_id: string }): boolean => b.request_id === requestId;
    if (raw.status >= 200 && raw.status < 300) {
      const p = schema.safeParse(json);
      return p.success && sameRequest(p.data as { request_id: string }) ? { kind: 'ok', status: raw.status, body: p.data } : { kind: 'unknown', reason: 'bad_body' };
    }
    if ((raw.status >= 400 && raw.status < 500) || raw.status === 503) {
      const e = ApiErrorBodySchema.safeParse(json);
      if (e.success && sameRequest(e.data)) return { kind: 'refused', status: raw.status, error: e.data };
    }
    return { kind: 'unknown', reason: raw.status >= 500 ? 'server_error' : 'bad_body' };
  }
}
