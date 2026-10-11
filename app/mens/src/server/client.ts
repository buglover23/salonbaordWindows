import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { HealthResponseSchema } from '../shared/protocol/api.js';
import { canonicalRequest } from '../shared/protocol/signing.js';
import { ApiErrorBodySchema, PROTOCOL_VERSION } from '../shared/protocol/version.js';
import { defaultIsPidAlive } from '../storage/app-lock.js';
import { b64url, hmac, safeEqual, sha256, signResponse } from './auth.js';
import { readLocalApiFile } from './keys.js';

// The CLI side of the local API (D1-2, D1-3, §1-14): finds the running tool through data/local-api.json, signs every
// request with the per-run CLI key and acts on an answer only after its signature verified.

/** refused: a verified 4xx / 503 refusal; unknown: no answer, a 5xx, or an answer that does not verify ("Node is not there"). */
export class ApiCallError extends Error {
  constructor(
    readonly kind: 'refused' | 'unknown',
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

interface RawAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** One HTTP request to 127.0.0.1:port with Host set and no Origin. */
function send(port: number, o: { method: string; path: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<RawAnswer> {
  return new Promise((done, fail) => {
    // agent: false — one connection per request, so no pooled socket outlives a restart of the tool.
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method, path: o.path, headers: { Host: `127.0.0.1:${port}`, ...o.headers }, timeout: o.timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end(o.body);
  });
}

export class LocalApiClient {
  readonly #port: number;
  readonly #cliKey: Uint8Array;
  readonly #serverNonce: string;

  constructor(o: { port: number; cliKey: Uint8Array; serverNonce: string }) {
    this.#port = o.port;
    this.#cliKey = o.cliKey;
    this.#serverNonce = o.serverNonce;
  }

  /**
   * The running tool of `dataRoot`, or null when none answers (no file, a dead pid, no health answer). A file that names
   * another data root is refused (STATE_CORRUPT), so a test can never reach the owner's running tool.
   */
  static async discover(dataRoot: string, o: { isPidAlive?: (pid: number) => boolean } = {}): Promise<LocalApiClient | null> {
    const file = await readLocalApiFile(join(dataRoot, 'data', 'local-api.json'));
    if (file.kind !== 'ok') return null;
    const rec = file.value;
    if (resolve(rec.data_root).toLowerCase() !== resolve(dataRoot).toLowerCase()) {
      const message = `data/local-api.json が別のデータの場所（${rec.data_root}）のものなので使いません。`;
      throw new AppFailure(appError('STATE_CORRUPT', 'cli', systemClock, { message }));
    }
    if (!(o.isPidAlive ?? defaultIsPidAlive)(rec.pid)) return null;
    const health = await send(rec.port, { method: 'GET', path: '/v1/health', timeoutMs: 2000 }).catch(() => null);
    if (health?.status !== 200) return null;
    let json: unknown;
    try {
      json = JSON.parse(health.body.toString('utf8'));
    } catch {
      return null;
    }
    const h = HealthResponseSchema.safeParse(json);
    if (!h.success || h.data.instance_id !== rec.instance_id) return null;
    return new LocalApiClient({ port: rec.port, cliKey: Buffer.from(rec.cli_key, 'base64url'), serverNonce: h.data.server_nonce });
  }

  /** discover() for a project folder (its settings.json decides the data root); null when the config cannot be read. */
  static async forProject(projectRoot: string): Promise<LocalApiClient | null> {
    const r = await loadConfig(join(projectRoot, 'config'));
    return r.ok ? LocalApiClient.discover(resolve(projectRoot, r.snapshot.settings.data_root)) : null;
  }

  /** A signed request; resolves only with a verified 2xx answer. */
  async request(method: 'GET' | 'POST', path: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    const body = method === 'POST' ? JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: requestId, ...payload }) : '';
    const signature = b64url(hmac(this.#cliKey, canonicalRequest({ serverNonce: this.#serverNonce, requestId, method, pathAndQuery: path, bodySha256Hex: sha256(body).toString('hex') })));
    const headers: Record<string, string> = { 'X-Request-Id': requestId, 'X-Cli': '1', 'X-Signature': signature };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await send(this.#port, { method, path, headers, body, timeoutMs }).catch(() => {
      throw new ApiCallError('unknown', 'ツールから応答がありません。');
    });
    const got = res.headers['x-signature'];
    if (typeof got !== 'string' || !safeEqual(got, signResponse(this.#cliKey, requestId, res.status, sha256(res.body).toString('hex')))) {
      throw new ApiCallError('unknown', 'ツールの応答を確認できません。');
    }
    let json: unknown = undefined;
    try {
      if (res.body.length > 0) json = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new ApiCallError('unknown', 'ツールの応答を読み取れません。');
    }
    if (res.status >= 400) {
      const e = ApiErrorBodySchema.safeParse(json);
      if (e.success && (res.status < 500 || res.status === 503)) throw new ApiCallError('refused', e.data.message, res.status, e.data.code);
      throw new ApiCallError('unknown', e.success ? e.data.message : 'ツールでエラーが発生しました。', res.status);
    }
    return { status: res.status, body: json };
  }
}
