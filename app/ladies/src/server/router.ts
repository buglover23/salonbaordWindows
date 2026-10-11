import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  ClaimRequestSchema,
  CleanupRequestSchema,
  ControlPairRequestSchema,
  HeartbeatRequestSchema,
  HelloRequestSchema,
  LiveSingleRequestSchema,
  PairBeginRequestSchema,
  PairFinishRequestSchema,
  PairStartRequestSchema,
  PauseRequestSchema,
  PreflightRequestSchema,
  ProbeRequestSchema,
  RedraftRequestSchema,
  ResumeRequestSchema,
  RetryRequestSchema,
  SubmitIntentRequestSchema,
  SurveyRequestSchema,
} from '../shared/protocol/api.js';
import { AutoReconcileRequestSchema, OperatorReconcileRequestSchema, PreflightResultRequestSchema, ResultRequestSchema } from '../shared/protocol/results.js';
import type { Principal } from './auth.js';
import { ApiError } from './errors.js';
import { armProbe } from './handlers/probe.js';
import { saveSurvey } from './handlers/survey.js';
import * as system from './handlers/system.js';
import type { LocalApiDeps } from './http-server.js';

export interface HandlerCtx<B> {
  principal: Principal;
  /** The verified, current client for `ext`; null otherwise. */
  clientId: string | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: B;
  now: Date;
  /** The server is shutting down (new claims and intents get 503). */
  stopping: boolean;
}

/** JSON (the envelope is added by the server), no body (204), or bytes whose SHA-256 the signature covers. */
export type HandlerResult = { status: number; body?: Record<string, unknown> } | { status: 200; stream: Readable; sha256: string; mime: string; bytes: number };

export interface Route {
  method: 'GET' | 'POST';
  /** Segments; ':name' matches one id-like segment. */
  pattern: string;
  principals: readonly Principal[];
  /** Bytes; default 64 KiB. */
  bodyLimit?: number;
  schema?: z.ZodType;
  handler: (ctx: HandlerCtx<unknown>) => Promise<HandlerResult> | HandlerResult;
}

type RouteDef<S extends z.ZodType | undefined> = Omit<Route, 'schema' | 'handler'> & {
  schema?: S;
  handler: (ctx: HandlerCtx<S extends z.ZodType ? z.infer<S> : undefined>) => Promise<HandlerResult> | HandlerResult;
};
const route = <S extends z.ZodType | undefined = undefined>(r: RouteDef<S>): Route => r as unknown as Route;

const EXT: readonly Principal[] = ['ext'];
const CLI: readonly Principal[] = ['cli'];
const PAIR: readonly Principal[] = ['pair'];
const ANY: readonly Principal[] = ['pair', 'ext', 'cli'];
const OPERATOR: readonly Principal[] = ['ext', 'cli'];

const maintenance = (d: LocalApiDeps): NonNullable<LocalApiDeps['maintenance']> => {
  if (d.maintenance === undefined) throw new ApiError(501, 'NOT_IMPLEMENTED', 'この接続口では整理を実行できません。');
  return d.maintenance;
};
const refuseWhileStopping = (ctx: HandlerCtx<unknown>): void => {
  if (ctx.stopping) throw new ApiError(503, 'BUSY', 'ツールを停止しているところです。', true);
};
const ok = (body: Record<string, unknown>): HandlerResult => ({ status: 200, body });

/** The route table (§6.2). Later tasks add their endpoints here. */
export function buildRoutes(d: LocalApiDeps): Route[] {
  const c = d.coordinator;
  return [
    route({ method: 'GET', pattern: '/v1/health', principals: ANY, handler: () => ok(system.health(d)) }),
    route({ method: 'POST', pattern: '/v1/extension/pair/start', principals: PAIR, schema: PairStartRequestSchema, handler: (x) => system.pairStart(d, x.now) }),
    route({ method: 'POST', pattern: '/v1/extension/pair/begin', principals: PAIR, schema: PairBeginRequestSchema, handler: (x) => system.pairBegin(d, x.body, x.now) }),
    route({ method: 'POST', pattern: '/v1/extension/pair/finish', principals: PAIR, schema: PairFinishRequestSchema, handler: (x) => system.pairFinish(d, x.body, x.now) }),
    route({ method: 'POST', pattern: '/v1/control/pair', principals: CLI, schema: ControlPairRequestSchema, handler: (x) => system.controlPair(d, x.now) }),
    route({ method: 'POST', pattern: '/v1/extension/hello', principals: EXT, schema: HelloRequestSchema, handler: async (x) => ok(await system.hello(d, x.clientId!, x.body, x.now)) }),
    route({ method: 'GET', pattern: '/v1/status', principals: OPERATOR, handler: async () => ok(await d.status()) }),
    route({ method: 'POST', pattern: '/v1/control/pause', principals: OPERATOR, schema: PauseRequestSchema, handler: (x) => system.pause(d, x.principal, x.body.reason) }),
    route({ method: 'POST', pattern: '/v1/control/resume', principals: OPERATOR, schema: ResumeRequestSchema, handler: (x) => system.resume(d, x.body.confirm_checked === true) }),
    route({
      method: 'POST',
      pattern: '/v1/jobs/claim',
      principals: EXT,
      schema: ClaimRequestSchema,
      handler: async (x) => {
        refuseWhileStopping(x);
        const r = await c.claim(x.clientId!, x.body);
        return r === null ? { status: 204 } : ok({ instance_id: d.instanceId, command: r.command });
      },
    }),
    route({ method: 'POST', pattern: '/v1/jobs/:id/heartbeat', principals: EXT, schema: HeartbeatRequestSchema, handler: (x) => ok(c.heartbeat(x.clientId!, x.params.id!, x.body)) }),
    route({
      method: 'GET',
      pattern: '/v1/jobs/:id/asset',
      principals: EXT,
      handler: async (x) => ({ status: 200, ...(await c.asset(x.clientId!, x.params.id!, x.query.get('attempt_id') ?? '', x.query.get('command_id') ?? '')) }),
    }),
    route({
      method: 'POST',
      pattern: '/v1/jobs/:id/submit-intent',
      principals: EXT,
      schema: SubmitIntentRequestSchema,
      handler: async (x) => {
        refuseWhileStopping(x);
        return ok(await c.submitIntent(x.clientId!, x.params.id!, x.body));
      },
    }),
    route({ method: 'POST', pattern: '/v1/jobs/:id/result', principals: EXT, schema: ResultRequestSchema, handler: async (x) => ok(await c.result(x.clientId!, x.params.id!, x.body)) }),
    // The extension's automatic reconcile result, or the operator's verdict (cli).
    route({
      method: 'POST',
      pattern: '/v1/jobs/:id/reconcile',
      principals: OPERATOR,
      schema: z.union([AutoReconcileRequestSchema, OperatorReconcileRequestSchema]),
      handler: async (x) => {
        const auto = 'outcome' in x.body;
        if (auto !== (x.principal === 'ext')) throw new ApiError(422, 'INVALID_REQUEST', '入力の形式が正しくありません: 照合の結果は拡張機能から、判定はコマンドから送ってください');
        if ('outcome' in x.body) return ok(await c.reconcileResult(x.clientId!, x.params.id!, x.body));
        return c.operatorReconcile(x.params.id!, x.body);
      },
    }),
    route({ method: 'POST', pattern: '/v1/retry', principals: CLI, schema: RetryRequestSchema, handler: async (x) => ok(await c.retry(x.body.job_id ?? null)) }),
    route({
      method: 'POST',
      pattern: '/v1/redraft',
      principals: CLI,
      schema: RedraftRequestSchema,
      handler: async (x) => ok(await c.redraft({ id: x.body.job_id ?? null, type: x.body.post_type ?? null, dry: x.body.dry ?? false })),
    }),
    route({ method: 'POST', pattern: '/v1/control/preflight', principals: CLI, schema: PreflightRequestSchema, handler: async (x) => ({ status: 202, body: { preflight_id: await c.preflight(x.body.route_key) } }) }),
    route({
      method: 'POST',
      pattern: '/v1/control/preflight/:id/result',
      principals: EXT,
      schema: PreflightResultRequestSchema,
      handler: async (x) => ok(await c.preflightResult(x.clientId!, x.params.id!, x.body)),
    }),
    route({ method: 'POST', pattern: '/v1/control/live-single', principals: CLI, schema: LiveSingleRequestSchema, handler: async (x) => ok(await c.liveSingle(x.body)) }),
    route({
      method: 'POST',
      pattern: '/v1/survey',
      principals: EXT,
      bodyLimit: 1024 * 1024,
      schema: SurveyRequestSchema,
      handler: (x) => {
        refuseWhileStopping(x);
        return saveSurvey(d, x.body, x.now);
      },
    }),
    route({ method: 'POST', pattern: '/v1/control/probe', principals: CLI, schema: ProbeRequestSchema, handler: (x) => armProbe(d, x.now) }),
    // The single writer runs the cleanup; the request names no path (spec 13.2).
    route({ method: 'GET', pattern: '/v1/maintenance/cleanup-preview', principals: CLI, handler: async () => ok({ preview: await maintenance(d).preview() }) }),
    route({
      method: 'POST',
      pattern: '/v1/maintenance/cleanup',
      principals: CLI,
      schema: CleanupRequestSchema,
      handler: async (x) => {
        refuseWhileStopping(x);
        return ok({ report: await maintenance(d).cleanup() });
      },
    }),
  ];
}

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/');
  for (const r of routes) {
    if (r.method !== method) continue;
    const pattern = r.pattern.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const hit = pattern.every((seg, i) => {
      const part = parts[i]!;
      if (!seg.startsWith(':')) return seg === part;
      params[seg.slice(1)] = part;
      return SEGMENT.test(part);
    });
    if (hit) return { route: r, params };
  }
  return null;
}
