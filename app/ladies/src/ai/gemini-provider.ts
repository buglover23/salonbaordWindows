import { ApiError, ThinkingLevel, type GenerateContentParameters, type Part } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';
import { GEMINI_MAX_OUTPUT_TOKENS, type GeminiThinkingLevel, type Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, ERROR_MESSAGES_JA, appError, type ErrorCode } from '../shared/errors.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import type { AiStage } from '../shared/types.js';
import { errnoCode } from '../storage/atomic-json.js';
import { dailyStopMessage, waitMessage } from './gemini-status.js';
import { geminiResponseSchema } from './gemini-schema.js';
import { extractJsonText } from './openai-schema.js';
import { outputInvalid, sourcePages, validateOutput } from './output.js';
import { failedCallUsage, requestTimeoutMs, type AiProvider, type AiRequest, type AiResult, type AiUsage } from './provider.js';
import type { DailyStopReason, RequestLimit } from './request-quota.js';
import { MAX_RETRY_AFTER_MS, transportRetryWait } from './retry-policy.js';
import type { UsageMeter } from './usage-meter.js';

// The fields of a generateContent response the provider reads (the SDK's GenerateContentResponse fits; tests pass
// plain objects). finishReason and blockReason stay strings: the API adds values the SDK enums do not list yet.
interface SafetyRatingLike {
  category?: string;
  probability?: string;
  blocked?: boolean;
}
export interface GeminiResponseLike {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    safetyRatings?: SafetyRatingLike[];
    /** Google Search grounding (webSearch requests): the pages the answer used. */
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string; safetyRatings?: SafetyRatingLike[] };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

/** The part of the SDK client (GoogleGenAI) the provider uses; tests pass a stub, so no test reaches the network. */
export interface GeminiClientLike {
  models: { generateContent(params: GenerateContentParameters): Promise<GeminiResponseLike> };
}

export type GeminiMeter = Pick<UsageMeter, 'assertCanCall' | 'record' | 'reserveRequest' | 'recordRateLimit' | 'recordUnavailable' | 'clearRateLimit'>;

export interface GeminiProviderDeps {
  client: GeminiClientLike;
  /** Read on every call, so edited models, thinking, limits, timeouts and retries apply without a restart. */
  getSettings: () => Settings;
  meter: GeminiMeter;
  clock?: Clock;
  logger?: AppLogger;
  /** Replaces the real waits (pacing and retries; tests). */
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1) for the backoff jitter (tests). */
  random?: () => number;
}

const THINKING_LEVELS: Record<GeminiThinkingLevel, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** Waiting for room in the per-minute window or for a rest to end is bounded like a server's retry wait. */
const MAX_PACING_WAIT_MS = MAX_RETRY_AFTER_MS;
// Answers that repeat for the same photo and request: regenerating cannot help.
const FINAL_FINISH_REASONS: ReadonlySet<string> = new Set(['PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'SPII', 'BLOCKLIST']);
const FINISH_REASON_NAMES: Readonly<Record<string, string>> = { IMAGE_SAFETY: 'safety', IMAGE_PROHIBITED_CONTENT: 'prohibited_content' };
// Failures that mean Google gave no answer; a call whose last attempt ended with one makes the model rest (noteUnavailable).
const NO_ANSWER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['AI_UNAVAILABLE', 'AI_TIMEOUT']);
// The budget and quota refusals that can end a call before an attempt is sent (assertCanCall, #pace).
const NOT_SENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['AI_BUDGET_EXCEEDED', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE']);
// details.reason of the failures that concern one model only (busy or hanging, stopped for the day, resting, its minute full): the
// call goes on with the next fallback model (ruling P2-R18). The budget's reasons apply to every model and end the call.
const NEXT_MODEL_REASONS: ReadonlySet<unknown> = new Set(['overloaded', 'timeout', 'server_daily', 'daily_limit', 'unavailable', 'rate_limited', 'per_minute']);
// Refusals of the model itself (retired or renamed, not allowed, a request it does not take): the call goes on with the
// next model, and the model is skipped by later calls until settings.ai.gemini changes.
const DEAD_MODEL_REASONS: ReadonlySet<unknown> = new Set(['model_not_found', 'model_forbidden', 'bad_request']);
// The finishReasons that mean the answer was stopped; any other one (missing, or a value the API added) with text is read.
const KNOWN_STOPS: ReadonlySet<string> = new Set(['MAX_TOKENS', 'SAFETY', 'IMAGE_SAFETY', 'RECITATION', ...FINAL_FINISH_REASONS, ...Object.keys(FINISH_REASON_NAMES)]);
const MODEL_PROBLEM_JA: Readonly<Record<string, string>> = {
  model_not_found: '見つかりません（HTTP 404）',
  model_forbidden: '使う権限がありません（HTTP 403）',
  bad_request: '要求を受け付けません（HTTP 400）',
  unreadable_output: '読み取れる答えを返しません',
};
const MAX_LISTED_MODELS = 5;
const MAX_QUOTA_IDS = 3;
const MAX_FIELD_LENGTH = 120;

type Failure = { failure: AppFailure; retryAfterMs?: number | undefined };

/**
 * What the provider learnt about the models under one settings.ai.gemini (its JSON is `key`): the models that refused
 * themselves (skipped) and how far each model's request had to be degraded (1 = no thinking, 2 = also no JSON schema).
 */
type DeadModel = { reason: string; status: number | null; logged: boolean };
interface ModelMemo {
  key: string;
  dead: Map<string, DeadModel>;
  degrade: Map<string, 1 | 2>;
}

interface CallContext {
  stage: AiStage;
  model: string;
  /** The models this call tried before `model` (it is a fallback when non-empty). */
  tried: string[];
  /** A fallback model is left to try. */
  hasNext: boolean;
  attempt: number;
  maxAttempts: number;
  apiKeyEnv: string;
  freeTier: boolean;
  maxOutputTokens: number;
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const clip = (s: string): string => (s.length > MAX_FIELD_LENGTH ? `${s.slice(0, MAX_FIELD_LENGTH - 1)}…` : s);

/** Thinking tokens are billed as output; cached prompt tokens are inside promptTokenCount and reported apart. */
export function geminiUsage(m: GeminiResponseLike['usageMetadata']): AiUsage {
  const prompt = count(m?.promptTokenCount);
  const cached = Math.min(count(m?.cachedContentTokenCount), prompt);
  return {
    input_tokens: prompt - cached + count(m?.toolUsePromptTokenCount),
    output_tokens: count(m?.candidatesTokenCount) + count(m?.thoughtsTokenCount),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

const groundingSources = (m: { groundingChunks?: { web?: { uri?: string } }[] } | undefined): string[] => sourcePages((m?.groundingChunks ?? []).map((c) => c.web?.uri));

/** The category that stopped the answer: the blocked rating, else the most likely one rated HIGH or MEDIUM. */
function stoppedCategory(ratings: readonly SafetyRatingLike[] | undefined): string | null {
  const list = ratings ?? [];
  const pick = list.find((r) => r.blocked === true) ?? list.find((r) => r.probability === 'HIGH') ?? list.find((r) => r.probability === 'MEDIUM');
  return typeof pick?.category === 'string' ? pick.category : null;
}

/** "40s" / "1.5s" (protobuf Duration as JSON) or {seconds, nanos} → milliseconds. */
function durationMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    return m ? Math.round(Number(m[1]) * 1000) : undefined;
  }
  if (isNode(v)) {
    const seconds = Number(v.seconds ?? 0);
    const nanos = Number(v.nanos ?? 0);
    return Number.isFinite(seconds) && Number.isFinite(nanos) ? Math.round(seconds * 1000 + nanos / 1e6) : undefined;
  }
  return undefined;
}

interface GoogleError {
  httpStatus: number;
  /** google.rpc status name (INVALID_ARGUMENT, RESOURCE_EXHAUSTED, …), or null. */
  status: string | null;
  /** ErrorInfo.reason (e.g. API_KEY_INVALID), or null. */
  reason: string | null;
  /** QuotaFailure.violations[].quotaId. */
  quotaIds: string[];
  /** BadRequest.fieldViolations[].field. */
  fields: string[];
  /** RetryInfo.retryDelay. */
  retryDelayMs: number | undefined;
  /** The body was JSON (else only the HTTP status is known). */
  readable: boolean;
}

/**
 * The structured parts of an SDK ApiError (its message is the response body as JSON: {error: google.rpc.Status}, or
 * text around it in other SDK versions; see google/rpc/error_details.proto for the detail types). The server's
 * free-text message is never read.
 */
function readApiError(err: ApiError): GoogleError {
  const msg = err.message;
  let body: unknown;
  for (const text of [msg, msg.slice(msg.indexOf('{'), msg.lastIndexOf('}') + 1)]) {
    try {
      body = JSON.parse(text);
      break;
    } catch {
      body = undefined;
    }
  }
  const error = isNode(body) && isNode(body.error) ? body.error : {};
  const details = Array.isArray(error.details) ? error.details.filter(isNode) : [];
  const ofType = (name: string): Node[] => details.filter((d) => typeof d['@type'] === 'string' && d['@type'].endsWith(`/google.rpc.${name}`));
  const strings = (items: unknown, key: string): string[] =>
    (Array.isArray(items) ? items : []).flatMap((i) => (isNode(i) && typeof i[key] === 'string' ? [i[key]] : []));
  const reason = ofType('ErrorInfo').map((d) => d.reason).find((r): r is string => typeof r === 'string') ?? null;
  return {
    httpStatus: err.status,
    status: typeof error.status === 'string' && /^[A-Z_]+$/.test(error.status) ? error.status : null,
    reason: reason !== null && /^[A-Z0-9_]+$/.test(reason) ? reason : null,
    quotaIds: ofType('QuotaFailure').flatMap((d) => strings(d.violations, 'quotaId')),
    fields: ofType('BadRequest').flatMap((d) => strings(d.fieldViolations, 'field')),
    retryDelayMs: ofType('RetryInfo').map((d) => durationMs(d.retryDelay)).find((ms) => ms !== undefined),
    readable: body !== undefined,
  };
}

/** A violation of the request's settings rather than its content (model, generation_config, system_instruction). */
const isConfigField = (field: string): boolean => /^(model|generation_?config|system_?instruction)(\.|\[|$)/i.test(field);

/**
 * Google Gemini via the official SDK (ruling P2-R13): JSON output constrained by the schema derived from the Zod schema
 * (gemini-schema.ts) and parsed with it, the system prompt as system instruction, the image(s) before the text, the
 * stage's model and thinking from settings.ai.gemini, no sampling parameters. Before each attempt the budget is checked
 * and the request is counted against the model's per-minute and per-day limits (data/ai-usage/request-quota.json):
 * a full minute is waited out (up to 120 s per call), a used-up day stops the model until the Pacific-midnight reset. The SDK's
 * retries are off; AI_TIMEOUT / AI_RATE_LIMIT / AI_UNAVAILABLE are retried up to ai.max_transport_retries, and every
 * attempt is metered. A call that ends without any answer (its retries run out, or the budget or quota ends it first)
 * makes the model rest (1 min, doubling) so a lasting outage does not use up the day's free requests.
 * Ruling P2-R18: when the model is busy (503 UNAVAILABLE: rested at once, not retried), stopped for the day or resting,
 * the same call goes on with the stage's fallback models (ai.gemini.fallback_models), each paced and counted as its own
 * model; the result names the model that answered. A model that refuses itself (404, a 403 that is not the key, a 400
 * left after dropping thinking and then the JSON schema) or gives no readable answer also passes the call on; the refusing
 * ones are skipped until settings.ai.gemini changes (a 400 without details only once another model answered the same
 * request: it may be the photo). A call every model refused ends in one CONFIG_INCOMPLETE naming them.
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  readonly #d: GeminiProviderDeps;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  #memo: ModelMemo = { key: '', dead: new Map(), degrade: new Map() };
  // Warnings given once per process.
  readonly #warned = new Set<string>();

  constructor(d: GeminiProviderDeps) {
    this.#d = d;
    this.#clock = d.clock ?? systemClock;
    this.#sleep = d.sleep ?? ((ms) => delay(ms));
    this.#random = d.random ?? Math.random;
  }

  async structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    const ai = this.#d.getSettings().ai;
    if (ai.provider !== this.name) {
      this.#refuse(req.stage, null, 'AIの提供元（settings.json の ai.provider）の変更は、再起動するまで反映されません。それまで Gemini の呼出しを止めているので、ツールを起動し直してください。');
    }
    const chain = this.#modelsFor(req.stage, ai.gemini);
    const schema = this.#jsonSchema(req);
    const key = JSON.stringify(ai.gemini);
    if (this.#memo.key !== key) this.#memo = { key, dead: new Map(), degrade: new Map() };
    // A web search reads the refused models but keeps what it learns to itself (a throwaway copy, no degrade): the weekly
    // look-up must never demote or lighten the models the posts use.
    const memo = req.webSearch === true ? { key, dead: new Map(this.#memo.dead), degrade: new Map<string, 1 | 2>() } : this.#memo;
    const live = chain.filter(({ model }) => {
      const dead = memo.dead.get(model);
      if (dead !== undefined && !dead.logged) {
        dead.logged = true;
        this.#d.logger?.warn('AI_MODEL_SKIPPED', `Gemini（${model}）は前の呼出しで使えなかった（${MODEL_PROBLEM_JA[dead.reason]}）ため、settings.json の ai.gemini が変わるまで使いません。`, {
          stage: 'ai',
          provider: 'gemini',
          ai_stage: req.stage,
          model,
          reason: dead.reason,
        });
      }
      return dead === undefined;
    });
    const pacing = { waitedMs: 0 };
    // Without an answer the call ends with the last failure that ends by itself (busy, resting), else the last one.
    let kept: AppFailure | null = null;
    let unreadable: AppFailure | null = null;
    // A 400 without details that even the lightest request got: the model refuses it, or the request itself (e.g. a photo
    // Google cannot read, which every model refuses). The model is remembered only once a later model answers; the next
    // model gets one attempt (not the lighter ones), and a second such 400 ends the call: one bad photo must neither use
    // up the day's requests nor stop the models for the next photos.
    let suspect: { model: string; failure: AppFailure } | null = null;
    const deadOf = (reason: string, f: AppFailure): DeadModel => {
      const status = f.error.details_redacted.status;
      return { reason, status: typeof status === 'number' ? status : null, logged: false };
    };
    for (const [i, { model, limit }] of live.entries()) {
      const next = live[i + 1]?.model;
      const tried = chain.slice(0, chain.findIndex((c) => c.model === model)).map((c) => c.model);
      try {
        const result = await this.#call(req, schema, ai, memo, { model, limit, tried, hasNext: next !== undefined, lighten: suspect === null }, pacing);
        if (suspect !== null) memo.dead.set(suspect.model, deadOf('bad_request', suspect.failure));
        return result;
      } catch (err) {
        if (!(err instanceof AppFailure)) throw err;
        const d = err.error.details_redacted;
        if (d.reason === 'bad_request' && !Array.isArray(d.fields)) {
          if (suspect !== null) throw err;
          suspect = { model, failure: err };
        } else if (DEAD_MODEL_REASONS.has(d.reason)) memo.dead.set(model, deadOf(d.reason as string, err));
        else if (d.reason === 'unreadable_output') unreadable = err;
        else if (!NEXT_MODEL_REASONS.has(d.reason)) throw err;
        else if (err.error.retryable || kept?.error.retryable !== true) kept = err;
        if (next === undefined) break;
        this.#d.logger?.info('AI_MODEL_FALLBACK', `AIの${AI_STAGE_JA[req.stage]}で Gemini（${model}）が使えないため、予備のモデル ${next} に切り替えます: ${err.error.message}`, {
          stage: 'ai',
          provider: 'gemini',
          ai_stage: req.stage,
          model,
          next_model: next,
          error_code: err.error.code,
          reason: err.error.details_redacted.reason,
        });
      }
    }
    if (kept !== null) throw kept;
    // An unreadable answer stays AI_OUTPUT_INVALID (regenerated) and an unproven 400 is this request's: neither may stop
    // all AI work (the refusing models are named again by the next call).
    if (unreadable !== null) throw unreadable;
    if (suspect !== null) throw suspect.failure;
    // Every model refused itself.
    const failed = chain.map(({ model }) => ({ model, ...(memo.dead.get(model) ?? { reason: 'unreadable_output', status: null }) }));
    const listed = failed.slice(0, MAX_LISTED_MODELS);
    throw new AppFailure(
      appError('CONFIG_INCOMPLETE', 'ai', this.#clock, {
        message: `AIの${AI_STAGE_JA[req.stage]}で使えるGeminiのモデルがありません（${listed.map((f) => `${clip(f.model)}: ${MODEL_PROBLEM_JA[f.reason]}`).join('、')}）。GeminiのAPIまたはモデルが変わった可能性があります。settings.json の ai.gemini.models / fallback_models を使えるモデル名に変えるか、.env の AI_${req.stage.toUpperCase()}_PROVIDER で別のAIサービスに切り替えてください。`,
        retryable: false,
        details: {
          provider: 'gemini',
          ai_stage: req.stage,
          reason: 'models_exhausted',
          status: failed.flatMap((f) => (f.status === null ? [] : [f.status])).at(-1) ?? null,
          models: listed.map((f) => ({ model: clip(f.model), reason: f.reason })),
        },
      }),
    );
  }

  /** One model's attempts (the app-level retries); `pacing` is shared by every model of the call. */
  async #call<T>(
    req: AiRequest<T>,
    schema: Record<string, unknown>,
    ai: Settings['ai'],
    memo: ModelMemo,
    m: { model: string; limit: RequestLimit | null; tried: string[]; hasNext: boolean; lighten: boolean },
    pacing: { waitedMs: number },
  ): Promise<AiResult<T>> {
    const g = ai.gemini;
    const { model, limit } = m;
    const maxAttempts = 1 + ai.max_transport_retries;
    const maxOutputTokens = Math.min(GEMINI_MAX_OUTPUT_TOKENS, Math.max(req.maxTokens, g.max_output_tokens[req.stage]));
    let unanswered: AppFailure | null = null;
    // A 400 is answered by sending the request again without thinking, then also without the JSON schema (the answer is
    // still parsed with the Zod schema); these attempts are not transport retries.
    let degrade: 0 | 1 | 2 = memo.degrade.get(model) ?? 0;
    let degraded = 0;
    for (let attempt = 1; ; attempt++) {
      const ctx: CallContext = { stage: req.stage, model, tried: m.tried, hasNext: m.hasNext, attempt, maxAttempts, apiKeyEnv: g.api_key_env, freeTier: g.free_tier, maxOutputTokens };
      try {
        await this.#d.meter.assertCanCall(this.#clock.now());
        await this.#pace(ctx, limit, pacing);
      } catch (err) {
        throw await this.#notSent(err, unanswered, ctx);
      }
      const started = this.#clock.now().getTime();
      let response: GeminiResponseLike;
      try {
        response = await this.#d.client.models.generateContent(this.#params(req, ctx, schema, ai, degrade));
      } catch (err) {
        const { failure, retryAfterMs } = await this.#mapError(err, ctx);
        await this.#d.meter.record(this.#clock.now(), model, failedCallUsage(failure.error, maxOutputTokens), [], 'gemini');
        // A busy model is not asked again while a fallback is left: it rests (below) and the next model is tried.
        const reason = failure.error.details_redacted.reason;
        const busy = ctx.hasNext && (reason === 'overloaded' || reason === 'timeout');
        const wait = busy ? null : transportRetryWait(failure, retryAfterMs, attempt - degraded, maxAttempts, this.#random);
        this.#d.logger?.warn('AI_REQUEST_FAILED', `AIの${AI_STAGE_JA[req.stage]}の呼出しに失敗しました（${attempt}回目）: ${failure.error.message}`, {
          stage: 'ai',
          provider: 'gemini',
          ai_stage: req.stage,
          model,
          attempt,
          error_code: failure.error.code,
          retry_in_ms: wait,
          duration_ms: this.#clock.now().getTime() - started,
        });
        // A web search sends no JSON schema, so it has no second lighter request: it goes on to the next model.
        const lighter = degrade === 0 && g.thinking[req.stage] !== null ? 1 : req.webSearch === true ? null : 2;
        if (reason === 'bad_request' && degrade < 2 && m.lighten && lighter !== null) {
          degrade = lighter;
          degraded++;
          unanswered = null;
          const dropped = degrade === 1 ? 'thinking' : 'response_schema';
          this.#d.logger?.warn('AI_REQUEST_DEGRADED', `Gemini（${model}）が要求を受け付けなかったため、${degrade === 1 ? '考える量の指定' : '出力形式（JSON Schema）の指定'}を外して送り直します。`, {
            stage: 'ai',
            provider: 'gemini',
            ai_stage: req.stage,
            model,
            dropped,
          });
          continue;
        }
        const noAnswer = NO_ANSWER_CODES.has(failure.error.code);
        if (wait === null) {
          if (noAnswer) await this.#d.meter.recordUnavailable(model, this.#clock.now(), g.free_tier);
          throw failure;
        }
        unanswered = noAnswer ? failure : null;
        await this.#sleep(wait);
        continue;
      }
      if (degrade !== 0) memo.degrade.set(model, degrade);
      return this.#read(req, response, ctx, started);
    }
  }

  /**
   * What a call ends with when the budget or quota refuses an attempt before it is sent. If the attempt before got no
   * answer, the call ends without one, as when its retries run out: the model rests, and a wait that no longer fits
   * ends the call with that attempt's failure; a stop (the day's limit, the budget) stays the outcome, as it holds the
   * work until it ends. Any other failure (e.g. the quota file) passes as it is.
   */
  async #notSent(err: unknown, unanswered: AppFailure | null, ctx: CallContext): Promise<unknown> {
    if (unanswered === null || !(err instanceof AppFailure) || !NOT_SENT_CODES.has(err.error.code)) return err;
    await this.#d.meter.recordUnavailable(ctx.model, this.#clock.now(), ctx.freeTier);
    return err.error.code === 'AI_BUDGET_EXCEEDED' ? err : unanswered;
  }

  #refuse(stage: AiStage, model: string | null, message: string): never {
    throw new AppFailure(appError('CONFIG_INCOMPLETE', 'ai', this.#clock, { message, retryable: false, details: { provider: 'gemini', ai_stage: stage, model } }));
  }

  /** The stage's model, then its fallback models (each once), with the limits they are paced by. */
  #modelsFor(stage: AiStage, g: Settings['ai']['gemini']): { model: string; limit: RequestLimit | null }[] {
    const own = g.models[stage];
    if (own === null) return this.#refuse(stage, own, `${AI_STAGE_JA[stage]}のモデル名が未設定のため、AIを呼び出せません（settings.json の ai.gemini.models.${stage}）。`);
    return [...new Set([own, ...g.fallback_models[stage]])].map((model) => ({ model, limit: this.#limitFor(stage, model, g) }));
  }

  #limitFor(stage: AiStage, model: string, g: Settings['ai']['gemini']): RequestLimit | null {
    const limit = Object.hasOwn(g.limits, model) ? g.limits[model] : undefined;
    if (g.free_tier && limit === undefined) {
      return this.#refuse(stage, model, `モデル「${model}」の無料枠の上限（1分・1日の回数）が未設定のため、AIを呼び出しません（settings.json の ai.gemini.limits）。`);
    }
    if (!g.free_tier && !Object.hasOwn(g.pricing, model)) {
      return this.#refuse(stage, model, `モデル「${model}」の料金が未設定で利用額を見積もれないため、AIを呼び出しません（settings.json の ai.gemini.pricing）。`);
    }
    return limit === undefined ? null : { rpm: limit.rpm, rpd: limit.rpd };
  }

  #jsonSchema<T>(req: AiRequest<T>): Record<string, unknown> {
    try {
      return geminiResponseSchema(req.schema);
    } catch (err) {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'ai', this.#clock, {
          message: `AIの出力形式（${AI_STAGE_JA[req.stage]}）を Gemini の JSON Schema に変換できません: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          details: { provider: 'gemini', ai_stage: req.stage },
        }),
      );
    }
  }

  /**
   * Counts the attempt against the model's limits, waiting for room; a used-up day throws, and so does a wait that would
   * take this call's pacing past MAX_PACING_WAIT_MS in all (`pacing` is shared by the call's attempts). A resting model
   * is not waited for while a fallback is left (only a full minute is).
   */
  async #pace(ctx: CallContext, limit: RequestLimit | null, pacing: { waitedMs: number }): Promise<void> {
    for (;;) {
      const now = this.#clock.now();
      const d = await this.#d.meter.reserveRequest(ctx.model, limit, now, ctx.freeTier);
      if (d.kind === 'go') return;
      if (d.kind === 'stopped') throw this.#dailyStop(ctx, d.reason, d.until, { requests: d.requests, cap: d.cap });
      const ms = Math.max(1, d.until.getTime() - now.getTime());
      if ((ctx.hasNext && d.reason !== 'per_minute') || pacing.waitedMs + ms > MAX_PACING_WAIT_MS) {
        throw new AppFailure(
          appError(d.reason === 'unavailable' ? 'AI_UNAVAILABLE' : 'AI_RATE_LIMIT', 'ai', this.#clock, {
            message: waitMessage(ctx.model, d.reason, d.until, now),
            retryable: true,
            details: { ...this.#details(ctx), reason: d.reason, resume_at: d.until.toISOString(), retry_after_seconds: Math.ceil(ms / 1000) },
          }),
        );
      }
      const why = d.reason === 'unavailable' ? 'から応答が得られない状態が続いたため' : 'の回数の上限に合わせて';
      this.#d.logger?.info('AI_RATE_PACING', `Gemini（${ctx.model}）${why}${Math.ceil(ms / 1000)}秒待ちます。`, {
        stage: 'ai',
        provider: 'gemini',
        ai_stage: ctx.stage,
        model: ctx.model,
        reason: d.reason,
        wait_ms: ms,
      });
      await this.#sleep(ms);
      pacing.waitedMs += ms;
    }
  }

  #details(ctx: CallContext): Record<string, unknown> {
    return { provider: 'gemini', ai_stage: ctx.stage, model: ctx.model, attempts: ctx.attempt };
  }

  /** AI_BUDGET_EXCEEDED (not retried): the model is stopped until the quota day resets. */
  #dailyStop(ctx: CallContext, reason: DailyStopReason, until: Date, extra: { requests?: number; cap?: number | null } & Record<string, unknown> = {}): AppFailure {
    const now = this.#clock.now();
    return new AppFailure(
      appError('AI_BUDGET_EXCEEDED', 'ai', this.#clock, {
        message: dailyStopMessage({ model: ctx.model, reason, until, now, freeTier: ctx.freeTier, requests: extra.requests, cap: extra.cap }),
        retryable: false,
        details: { ...this.#details(ctx), reason, resume_at: until.toISOString(), ...extra },
      }),
    );
  }

  #params<T>(req: AiRequest<T>, ctx: CallContext, schema: Record<string, unknown>, ai: Settings['ai'], degrade: 0 | 1 | 2): GenerateContentParameters {
    // Images first, then the text that refers to them.
    const parts: Part[] = [
      ...req.content.flatMap((c) => (c.type === 'image_jpeg_base64' ? [{ inlineData: { mimeType: 'image/jpeg', data: c.data } }] : [])),
      ...req.content.flatMap((c) => (c.type === 'text' ? [{ text: c.text }] : [])),
    ];
    const thinking = ai.gemini.thinking[req.stage];
    return {
      model: ctx.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: req.system,
        // Search grounding is refused together with controlled JSON output on several models: the prompt asks for JSON.
        ...(req.webSearch === true
          ? { tools: [{ googleSearch: {} }] }
          : { responseMimeType: 'application/json', ...(degrade === 2 ? {} : { responseJsonSchema: schema }) }),
        maxOutputTokens: ctx.maxOutputTokens,
        // Never both: the API rejects a level together with a budget.
        ...(thinking === null || degrade > 0 ? {} : { thinkingConfig: typeof thinking === 'number' ? { thinkingBudget: thinking } : { thinkingLevel: THINKING_LEVELS[thinking] } }),
        httpOptions: { timeout: requestTimeoutMs(req, ai.timeout_seconds) },
      },
    };
  }

  async #read<T>(req: AiRequest<T>, response: GeminiResponseLike, ctx: CallContext, started: number): Promise<AiResult<T>> {
    const candidate = response.candidates?.[0];
    const texts = (candidate?.content?.parts ?? []).filter((p) => typeof p.text === 'string' && p.thought !== true).map((p) => p.text as string);
    // An answer without usageMetadata is metered at its output limit (fail closed, as a call that may have run).
    const noUsage = response.usageMetadata === undefined && texts.length > 0;
    const usage = noUsage ? { ...geminiUsage(undefined), output_tokens: ctx.maxOutputTokens } : geminiUsage(response.usageMetadata);
    if (noUsage) this.#warnOnce('AI_USAGE_MISSING', 'Geminiの応答に使用量（usageMetadata）が無かったため、出力の上限まで使ったものとして記録します。', ctx);
    const now = this.#clock.now();
    await this.#d.meter.record(now, ctx.model, usage, [], 'gemini');
    await this.#d.meter.clearRateLimit(ctx.model, now);
    const details = this.#details(ctx);
    // No text to read: another model may answer (the call goes on with the next one).
    const unreadable = (message: string, problem: string, extra: Record<string, unknown> = {}): AppFailure =>
      outputInvalid(this.#clock, message, { ...details, ...extra, reason: 'unreadable_output', problem });

    if (candidate === undefined) {
      const block = response.promptFeedback?.blockReason;
      if (block !== undefined) {
        const category = stoppedCategory(response.promptFeedback?.safetyRatings);
        throw outputInvalid(
          this.#clock,
          `AIがこの写真・依頼を安全上の理由で受け付けませんでした（${block}${category === null ? '' : `、${category}`}）。同じ内容では作れないため、別の写真を使ってください。`,
          { ...details, reason: 'blocked', block_reason: block, category },
          false,
        );
      }
      throw unreadable('AIの応答に出力の候補がありませんでした。', 'no_candidates');
    }
    // A known stop is never parsed; any other finishReason (missing, or a value the API added) with text is read and the
    // schema decides.
    const finish = candidate.finishReason;
    if (finish !== undefined && finish !== 'STOP' && (KNOWN_STOPS.has(finish) || texts.length === 0)) {
      throw this.#unfinished(finish, candidate.safetyRatings, response, ctx, details);
    }
    if (texts.length === 0) throw unreadable('AIの出力に本文がありませんでした。', 'no_text');
    if (finish !== 'STOP') {
      const shown = finish === undefined ? 'なし' : clip(finish);
      this.#warnOnce('AI_FINISH_REASON_UNKNOWN', `Geminiの応答の終わり方（finishReason: ${shown}）を知らないため、本文を読んで形式で確かめます。`, ctx, { finish_reason: finish === undefined ? null : clip(finish) }, `finish:${shown}`);
    }
    const text = texts.join('');
    let json: unknown;
    try {
      // A web-search answer is free text: the JSON object may come in a code fence or with a sentence around it.
      json = JSON.parse(req.webSearch === true ? (extractJsonText(text) ?? text) : text);
    } catch {
      throw unreadable('AIの出力をJSONとして読み取れませんでした。', 'invalid_json', { text_length: text.length });
    }
    const value = validateOutput(req.schema, json, this.#clock, details);

    this.#d.logger?.info('AI_REQUEST_COMPLETED', `AIの${AI_STAGE_JA[req.stage]}が完了しました（入力${usage.input_tokens}・出力${usage.output_tokens}トークン）。`, {
      stage: 'ai',
      provider: 'gemini',
      ai_stage: req.stage,
      model: ctx.model,
      model_version: typeof response.modelVersion === 'string' ? clip(response.modelVersion) : null,
      attempt: ctx.attempt,
      duration_ms: this.#clock.now().getTime() - started,
      ...usage,
    });
    if (req.webSearch !== true) return { value, usage, model: ctx.model };
    return { value, usage, model: ctx.model, sources: groundingSources(candidate.groundingMetadata) };
  }

  /** A known stop, or another finishReason without text (unreadable: the next model may answer). */
  #unfinished(
    finish: string,
    ratings: readonly SafetyRatingLike[] | undefined,
    response: GeminiResponseLike,
    ctx: CallContext,
    details: Record<string, unknown>,
  ): AppFailure {
    const reason = FINISH_REASON_NAMES[finish] ?? finish.toLowerCase();
    const base = { ...details, reason, finish_reason: finish };
    if (finish === 'MAX_TOKENS') {
      return outputInvalid(
        this.#clock,
        `AIの出力が上限の長さ（考える分を含めて${ctx.maxOutputTokens}トークン）で途切れたため、規定の形式になりませんでした。続くときは settings.json の ai.gemini.max_output_tokens を増やすか、ai.gemini.thinking を下げてください。`,
        { ...base, max_output_tokens: ctx.maxOutputTokens, thoughts_tokens: count(response.usageMetadata?.thoughtsTokenCount) },
      );
    }
    if (reason === 'safety') {
      const category = stoppedCategory(ratings);
      const head = `AIが安全上の理由で応答を止めました（分類: ${category ?? '不明'}）。`;
      // A stop over the photo repeats for the same photo (the analysis is about nothing else); a text can be regenerated.
      if (finish === 'IMAGE_SAFETY' || ctx.stage === 'analysis') {
        return outputInvalid(this.#clock, `${head}同じ写真では作れないため、別の写真を使ってください。`, { ...base, category }, false);
      }
      return outputInvalid(this.#clock, `${head}画像や指示の内容を確認してください。`, { ...base, category });
    }
    if (FINAL_FINISH_REASONS.has(finish)) {
      return outputInvalid(this.#clock, `AIが利用規約上の理由で応答を止めました（${finish}）。同じ内容では作れないため、別の写真を使ってください。`, base, false);
    }
    if (finish === 'RECITATION') return outputInvalid(this.#clock, 'AIの出力が既存の文章に似すぎていたため止められました。', base);
    return outputInvalid(this.#clock, `AIの出力が途中で終わりました（finishReason: ${clip(finish)}）。`, { ...base, reason: 'unreadable_output', problem: 'no_text', finish_reason: clip(finish) });
  }

  /** A warning given once per process (per `once`). */
  #warnOnce(event: string, message: string, ctx: CallContext, extra: Record<string, unknown> = {}, once = event): void {
    if (this.#warned.has(once)) return;
    this.#warned.add(once);
    this.#d.logger?.warn(event, message, { stage: 'ai', provider: 'gemini', ai_stage: ctx.stage, model: ctx.model, ...extra });
  }

  /** SDK error class and HTTP status, most specific first (never the message text); content never goes into details. */
  async #mapError(err: unknown, ctx: CallContext): Promise<Failure> {
    const details = { ...this.#details(ctx), max_transport_retries: ctx.maxAttempts - 1 };
    const tried = `（${ctx.attempt}回試行）`;
    const make = (code: ErrorCode, message: string, extra: { retryable?: boolean; details?: Record<string, unknown> } = {}): AppFailure =>
      new AppFailure(
        appError(code, 'ai', this.#clock, {
          message,
          ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
          details: { ...details, ...extra.details },
        }),
      );
    const transport = (code: ErrorCode, extra: Record<string, unknown> = {}): AppFailure => make(code, `${ERROR_MESSAGES_JA[code]}${tried}`, { details: extra });

    if (err instanceof AppFailure) return { failure: err };
    if (err instanceof ApiError) {
      const e = readApiError(err);
      if (!e.readable && e.httpStatus >= 400 && e.httpStatus < 600) {
        this.#warnOnce('AI_ERROR_BODY_UNREADABLE', `Geminiのエラー応答（HTTP ${e.httpStatus}）の本文を読み取れなかったため、HTTP の状態だけで判断します。`, ctx, { status: e.httpStatus });
      }
      return this.#mapApiError(e, ctx, make, transport);
    }
    // The SDK aborts fetch at httpOptions.timeout: a DOMException, not an ApiError.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return { failure: transport('AI_TIMEOUT', { reason: 'timeout' }) };
    // Node's fetch reports network failures as TypeError('fetch failed') with the underlying error as cause (often, not
    // always, with a socket code). A TypeError without a cause is a programming error.
    if (err instanceof TypeError && err.cause !== undefined) {
      const code = errnoCode(err.cause);
      const timeout = code !== undefined && code.startsWith('UND_ERR_') && code.includes('TIMEOUT');
      return { failure: transport(timeout ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', { ...(code === undefined ? {} : { network_code: clip(code) }), ...(timeout ? { reason: 'timeout' } : {}) }) };
    }
    if (err instanceof SyntaxError) return { failure: transport('AI_UNAVAILABLE', { cause: 'unreadable_response' }) };
    const what = err instanceof Error ? err.name : typeof err;
    return { failure: make('INTERNAL_ERROR', `AIの呼出し中に想定外のエラーが発生しました（${what}）。`, { retryable: false }) };
  }

  async #mapApiError(
    e: GoogleError,
    ctx: CallContext,
    make: (code: ErrorCode, message: string, extra?: { retryable?: boolean; details?: Record<string, unknown> }) => AppFailure,
    transport: (code: ErrorCode, extra?: Record<string, unknown>) => AppFailure,
  ): Promise<Failure> {
    const api: Record<string, unknown> = { status: e.httpStatus, api_status: e.status, error_reason: e.reason };
    const s = e.httpStatus;
    const stop = (code: ErrorCode, message: string, reason?: string): Failure => ({ failure: make(code, message, { retryable: false, details: { ...api, ...(reason === undefined ? {} : { reason }) } }) });
    const key = ctx.tried.length === 0 ? 'models' : 'fallback_models';

    // Only a key problem stops every model; any other 403 is this model (e.g. not open to this key or region).
    if (s === 401 || (e.reason !== null && e.reason.startsWith('API_KEY_'))) {
      return stop(
        'AI_AUTH_ERROR',
        `GeminiのAPIキーが正しくないか、使えない状態です（HTTP ${s}${e.reason === null ? '' : `、${e.reason}`}）。Google AI Studio でキーを確かめ、.env の ${ctx.apiKeyEnv} を直してから再開してください。`,
      );
    }
    if (s === 403) {
      return stop(
        'CONFIG_INCOMPLETE',
        `Geminiのモデル「${ctx.model}」を使う権限がありません（HTTP 403${e.reason === null ? '' : `、${e.reason}`}）。settings.json の ai.gemini.${key} のモデル名と、Google AI Studio でのキーの利用範囲を確認してください。`,
        'model_forbidden',
      );
    }
    if (s === 429) {
      const now = this.#clock.now();
      const quotaIds = e.quotaIds.slice(0, MAX_QUOTA_IDS).map(clip);
      // Per-day quotas are told apart only by the QuotaFailure id (e.g. ...PerDay...-FreeTier).
      const daily = e.quotaIds.some((id) => /PerDay/i.test(id));
      const rest = await this.#d.meter.recordRateLimit(ctx.model, now, { daily, retryAfterMs: e.retryDelayMs, freeTier: ctx.freeTier });
      if (rest.reason === 'server_daily') return { failure: this.#dailyStop(ctx, 'server_daily', rest.until, { ...api, quota_ids: quotaIds }) };
      const waitMs = Math.max(0, rest.until.getTime() - now.getTime());
      return {
        failure: transport('AI_RATE_LIMIT', { ...api, quota_ids: quotaIds, retry_after_seconds: Math.ceil(waitMs / 1000), resume_at: rest.until.toISOString() }),
        retryAfterMs: waitMs,
      };
    }
    if (s === 402) {
      return stop('AI_BUDGET_EXCEEDED', 'Geminiの前払いクレジットが足りないため、AIの処理を止めました。Google AI Studio で支払いの設定を確認してから、ツールを起動し直してください。');
    }
    if (s === 404) {
      return stop(
        'CONFIG_INCOMPLETE',
        `Geminiのモデル「${ctx.model}」が見つかりません（HTTP 404）。settings.json の ai.gemini.${key} のモデル名またはAPIのバージョン・接続先を確認してください。`,
        'model_not_found',
      );
    }
    if (s === 408 || s === 504) return { failure: transport('AI_TIMEOUT', { ...api, reason: 'timeout' }) };
    if (s === 503 || e.status === 'UNAVAILABLE') {
      // The model is busy (Google's "high demand"): it passes, and another model may well answer meanwhile.
      const others = ctx.tried.length === 0 ? '' : `ほかのモデル（${ctx.tried.join('・')}）も使えませんでした。`;
      const next = ctx.hasNext ? '予備のモデルで試します' : `${others}少し時間をおいてから、もう一度試してください`;
      return { failure: make('AI_UNAVAILABLE', `Gemini（${ctx.model}）が混み合っています（一時的なものです）。${next}（${ctx.attempt}回試行）。`, { details: { ...api, reason: 'overloaded' } }) };
    }
    if (s >= 500 || s === 499) return { failure: transport('AI_UNAVAILABLE', api) };
    if (s === 400 && e.status === 'FAILED_PRECONDITION') {
      return stop('CONFIG_INCOMPLETE', 'このアカウント・地域ではGeminiの無料枠を使えないため、AIを止めました（HTTP 400 FAILED_PRECONDITION）。Google AI Studio で利用の条件と支払いの設定を確認してください。');
    }
    const configFields = e.fields.filter(isConfigField).slice(0, MAX_QUOTA_IDS).map(clip);
    if (s === 400 && configFields.length > 0) {
      return {
        failure: make('CONFIG_INCOMPLETE', `Geminiが設定の値を受け付けませんでした（HTTP 400: ${configFields.join(', ')}）。settings.json の ai.gemini（モデル「${ctx.model}」・thinking など）を確認してください。`, {
          retryable: false,
          details: { ...api, fields: configFields, reason: 'bad_request' },
        }),
      };
    }
    // A 400 naming only the request content (the photo) repeats with any model; any other 400 is this model refusing the
    // request's settings (sent again lighter, then the next model). The remaining 4xx: sending it again cannot help.
    return stop(
      'AI_OUTPUT_INVALID',
      `AIへの要求が受け付けられませんでした（HTTP ${s}、${e.status ?? '種類不明'}）。写真が壊れている・大きすぎるなど、依頼の内容が原因のこともあります。別の写真でも続くときは設定の誤りの可能性が高いので、ツールを止めて settings.json の ai.gemini（モデル・thinking・max_output_tokens など）を確認してください。`,
      s === 400 && e.fields.length === 0 ? 'bad_request' : undefined,
    );
  }
}
