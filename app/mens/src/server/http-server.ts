import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError, errorText } from '../shared/errors.js';
import { PROTOCOL_VERSION } from '../shared/protocol/version.js';
import type { Mode } from '../shared/types.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { ControlStore, PairedClient } from '../storage/control-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { RetentionManager } from '../storage/retention.js';
import { ReplayCache, originRefusal, requestSignatureOk, sha256, signResponse, type Principal } from './auth.js';
import type { CoordinatorPort } from './coordinator-port.js';
import { ApiError, toApiError } from './errors.js';
import type { StatusBody } from '../shared/protocol/status.js';
import { clientKey } from './keys.js';
import type { PairingService } from './pairing.js';
import { buildRoutes, matchRoute, type HandlerResult } from './router.js';

// The local API (Plan 3 D1, §6.2): 127.0.0.1 only; Host and Origin rules; body caps; HMAC-signed requests (except health
// and pairing) and HMAC-signed responses; hardening headers on every response; checks in the §6.2 order.

export type ServerState = 'starting' | 'running' | 'stopping' | 'closed';

export interface LocalApiDeps {
  port: number;
  instanceId: string;
  serverNonce: string;
  mode: Mode;
  clock: Clock;
  logger: AppLogger;
  allowedExtensionIds: () => readonly string[];
  master: Uint8Array;
  cliKey: Uint8Array;
  pairedClient: () => PairedClient | null;
  setPairedClient: (c: PairedClient) => Promise<void>;
  pairing: PairingService;
  status: () => Promise<StatusBody>;
  control: ControlStore;
  coordinator: CoordinatorPort;
  /** The current config (automation status, salon labels, allowed origins). */
  config: () => ConfigSnapshot;
  /** <dataRoot>/data/survey. */
  surveyDir: string;
  /** For live-single outlines: their file joins the attempt's evidence_refs. */
  jobs: Pick<JobStore, 'get' | 'update'>;
  /** Plan 4: the 30-day cleanup (RetentionManager); omitted (server tests): 501. */
  maintenance?: Pick<RetentionManager, 'preview' | 'cleanup'>;
  /** Arrival time of an authenticated extension request, recorded outside any lock (P3-R48). */
  noteSeen: (clientId: string, at: Date) => void;
  /** Console only, never the log file (the pairing code). */
  echo: (line: string) => void;
  /** The server's own state (set by createLocalApiServer). */
  state: () => ServerState;
  /** Test seam: listen fails with this errno code. */
  listenErrorCode?: string | undefined;
}

export interface LocalApiServer {
  listen(): Promise<void>;
  /** stopping → coordinator.drain(graceMs) → close. Any number of calls share one closing. */
  close(graceMs: number): Promise<void>;
  readonly state: ServerState;
  /** The bound port (the injected one, or the one the OS chose for 0). */
  readonly port: number;
}

const DEFAULT_BODY_LIMIT = 64 * 1024;
const PORT_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } as const;
const EMPTY_SHA256 = sha256('').toString('hex');
const PROTOCOL_MISMATCH_JA = '拡張機能とツールの版が合いません。npm.cmd run build:extension の後、拡張機能を再読み込みしてください';

export function portInUse(port: number): AppFailure {
  const message = `${port}番ポートを使えません。別のアプリが使っているか、Windows が予約しています（確認: netsh int ipv4 show excludedportrange protocol=tcp）`;
  return new AppFailure(appError('PORT_IN_USE', 'local_api', systemClock, { message, details: { port } }));
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Reads the body up to `limit` bytes; beyond that the rest is drained and null returned (→ 413). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 422 text: the first 5 issue paths only; unknown keys are named only as 「不明な項目があります」. */
function issueText(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((i) => {
    const at = i.path.length === 0 ? '（全体）' : i.path.map(String).join('.').slice(0, 100);
    return i.code === 'unrecognized_keys' ? `${at}: 不明な項目があります` : at;
  });
  return `入力の形式が正しくありません: ${parts.join('、')}`;
}

export function createLocalApiServer(deps: Omit<LocalApiDeps, 'state'>): LocalApiServer {
  let state: ServerState = 'starting';
  const d: LocalApiDeps = { ...deps, state: () => state };
  const routes = buildRoutes(d);
  const replays = new ReplayCache();
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 });
  let closing: Promise<void> | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = req.method ?? '';
    const rawPath = req.url ?? '';
    const headerId = header(req, 'x-request-id');
    let requestId = headerId !== undefined && UUID.test(headerId) ? headerId : null;
    const isCli = header(req, 'x-cli') === '1';
    const claimedClient = header(req, 'x-client-id');
    const origin = header(req, 'origin');
    // Responses are signed with the key of the principal the request names (also refusals), so the caller can trust them.
    const signKey = isCli ? d.cliKey : claimedClient !== undefined && CLIENT_ID.test(claimedClient) ? clientKey(d.master, claimedClient) : null;
    let principal: Principal | 'none' = 'none';
    let template = '-';

    const log = (status: number): void =>
      d.logger.debug('API_REQUEST', `${method} ${template} → ${status}`, { method, route: template, status, duration_ms: Math.round(performance.now() - started), principal });
    const send = (status: number, payload?: Record<string, unknown>): void => {
      const id = requestId ?? randomUUID();
      const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: id, ...payload }), 'utf8');
      const headers: Record<string, string> = { ...HARDENING };
      if (payload !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      if (signKey !== null) headers['X-Signature'] = signResponse(signKey, id, status, body.length === 0 ? EMPTY_SHA256 : sha256(body).toString('hex'));
      res.writeHead(status, headers).end(body);
      log(status);
    };
    const fail = (e: ApiError): void => send(e.status, { code: e.code, message: e.message, retryable: e.retryable });
    const refuse = (status: number, code: ApiError['code'], message: string): void => fail(new ApiError(status, code, message));

    try {
      // 1. Host
      if (header(req, 'host') !== `127.0.0.1:${port()}`) return refuse(403, 'BAD_HOST', '接続先の指定が正しくありません。');
      // CORS preflight: only for an allowed extension origin, never '*'.
      if (method === 'OPTIONS') {
        if (origin === undefined || originRefusal(origin, 'ext', d.allowedExtensionIds()) !== null) return refuse(403, 'FORBIDDEN', '許可していない呼び出し元です。');
        res
          .writeHead(204, {
            ...HARDENING,
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'X-Client-Id, X-Request-Id, X-Signature, Content-Type',
            'Access-Control-Max-Age': '600',
          })
          .end();
        return log(204);
      }
      // 2. method and path
      const url = URL.parse(rawPath, 'http://127.0.0.1');
      const hit = url === null ? null : matchRoute(routes, method, url.pathname);
      if (url === null || hit === null) return refuse(404, 'NOT_FOUND', '見つかりません。');
      const { route, params } = hit;
      template = route.pattern;
      // 3. body cap
      const body = await readBody(req, route.bodyLimit ?? DEFAULT_BODY_LIMIT);
      if (body === null) return refuse(413, 'PAYLOAD_TOO_LARGE', '送られたデータが大きすぎます。');
      // 4. principal
      const now = d.clock.now();
      let clientId: string | null = null;
      if (isCli || claimedClient !== undefined) {
        const signature = header(req, 'x-signature');
        const ok =
          signKey !== null && !(isCli && claimedClient !== undefined) && requestId !== null && signature !== undefined &&
          requestSignatureOk(signKey, { serverNonce: d.serverNonce, requestId, method, pathAndQuery: rawPath, body }, signature) &&
          replays.add(requestId);
        if (!ok) return refuse(401, 'UNAUTHORIZED', '要求の署名を確認できません。');
        principal = isCli ? 'cli' : 'ext';
        if (principal === 'ext') {
          if (d.pairedClient()?.client_id !== claimedClient) {
            return refuse(409, 'STALE_CLIENT', 'この拡張機能の接続は新しい接続に置き換えられました。使うときは、別の PowerShell で npm.cmd run pair を実行して接続し直してください。');
          }
          clientId = claimedClient!;
          d.noteSeen(clientId, now);
        }
      } else if (route.principals.includes('pair')) {
        principal = 'pair';
      } else {
        return refuse(401, 'UNAUTHORIZED', '要求の署名がありません。');
      }
      // 5. Origin, 6. principal allowed here
      if (originRefusal(origin, principal, d.allowedExtensionIds()) !== null) return refuse(403, 'FORBIDDEN', '許可していない呼び出し元です。');
      if (!route.principals.includes(principal)) return refuse(403, 'FORBIDDEN', 'この呼び出し元からは使えません。');
      // 7. Content-Type, 8. JSON + schema
      let parsed: unknown = undefined;
      if (method === 'POST') {
        if (!/^application\/json\s*(;|$)/i.test(header(req, 'content-type') ?? '')) return refuse(422, 'INVALID_REQUEST', 'Content-Type は application/json にしてください。');
        let json: unknown;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          return refuse(422, 'INVALID_REQUEST', 'JSON として読み取れません。');
        }
        if (typeof json === 'object' && json !== null && 'protocol_version' in json && json.protocol_version !== PROTOCOL_VERSION) {
          return refuse(422, 'PROTOCOL_MISMATCH', PROTOCOL_MISMATCH_JA);
        }
        if (requestId === null && typeof json === 'object' && json !== null && 'request_id' in json && typeof json.request_id === 'string' && UUID.test(json.request_id)) {
          requestId = json.request_id;
        }
        if (route.schema !== undefined) {
          const r = route.schema.safeParse(json);
          if (!r.success) return refuse(422, 'INVALID_REQUEST', issueText(r.error));
          if ((r.data as { request_id?: unknown }).request_id !== requestId) return refuse(422, 'INVALID_REQUEST', 'request_id が X-Request-Id と一致しません。');
          parsed = r.data;
        }
      }
      // 9. handler
      const out: HandlerResult = await route.handler({ principal, clientId, params, query: url.searchParams, body: parsed, now, stopping: state !== 'running' });
      if ('stream' in out) {
        const headers: Record<string, string> = { ...HARDENING, 'Content-Type': out.mime, 'Content-Length': String(out.bytes), 'X-Asset-Sha256': out.sha256, 'X-Asset-Bytes': String(out.bytes) };
        if (signKey !== null) headers['X-Signature'] = signResponse(signKey, requestId ?? '', out.status, out.sha256);
        res.writeHead(out.status, headers);
        out.stream.on('error', () => res.destroy()).pipe(res);
        return log(out.status);
      }
      return send(out.status, out.body);
    } catch (err) {
      const e = toApiError(err);
      if (e.status >= 500 && !(err instanceof ApiError)) d.logger.error('API_HANDLER_FAILED', `ローカルAPIの処理でエラーが発生しました（${template}）: ${errorText(err)}`, { route: template, error_code: 'INTERNAL_ERROR' });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      return fail(e);
    }
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => void handle(req, res));
  const port = (): number => {
    const a = server.address();
    return a !== null && typeof a === 'object' ? a.port : d.port;
  };

  return {
    get state() {
      return state;
    },
    get port() {
      return port();
    },
    listen() {
      if (d.listenErrorCode !== undefined) return Promise.reject(PORT_CODES.has(d.listenErrorCode) ? portInUse(d.port) : new Error(d.listenErrorCode));
      return new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => reject(PORT_CODES.has(err.code ?? '') ? portInUse(d.port) : err));
        server.listen(d.port, '127.0.0.1', () => {
          state = 'running';
          resolve();
        });
      });
    },
    close(graceMs) {
      closing ??= (async () => {
        state = 'stopping';
        await d.coordinator.drain(graceMs).catch((err: unknown) => d.logger.error('API_DRAIN_FAILED', `送信結果の待機中にエラーが発生しました: ${errorText(err)}`));
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        });
        state = 'closed';
      })();
      return closing;
    },
  };
}
