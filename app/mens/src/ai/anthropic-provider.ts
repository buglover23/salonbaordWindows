import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming as BetaCreateParams } from '@anthropic-ai/sdk/resources/beta/messages';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { setTimeout as delay } from 'node:timers/promises';
import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, ERROR_MESSAGES_JA, appError, type ErrorCode } from '../shared/errors.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import type { AiStage } from '../shared/types.js';
import { outputInvalid, parseJsonOutput } from './output.js';
import { ZERO_USAGE, webSearchUnsupported, type AiProvider, type AiRequest, type AiResult, type AiUsage } from './provider.js';
import { transportRetryWait } from './retry-policy.js';
import { structuredOutputSchema } from './structured-schema.js';
import type { MeteredUsage, UsageMeter } from './usage-meter.js';

/** Plan 2 decision 1: refusals are retried server-side on the model Anthropic picks for the refusal category. */
export const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

interface CallOptions {
  /** Milliseconds (the TypeScript SDK's unit). */
  timeout: number;
  /** Always 0: retries belong to the app, so each one is metered and budget-checked. */
  maxRetries: number;
}

/** The part of the SDK client the provider uses; tests pass a stub, so no test ever reaches the network. */
export interface AnthropicClientLike {
  messages: { create(body: MessageCreateParamsNonStreaming, options?: CallOptions): Promise<Message> };
  beta: { messages: { create(body: BetaCreateParams, options?: CallOptions): Promise<BetaMessage> } };
}

export type AiMeter = Pick<UsageMeter, 'assertCanCall' | 'record'>;

export interface AnthropicProviderDeps {
  client: AnthropicClientLike;
  /** Read on every call, so edited models, effort, timeouts and retries apply without a restart. */
  getSettings: () => Settings;
  meter: AiMeter;
  clock?: Clock;
  logger?: AppLogger;
  /** Replaces the real wait between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1) for the backoff jitter (tests). */
  random?: () => number;
}

type Failure = { failure: AppFailure; retryAfterMs?: number | undefined };

interface CallContext {
  stage: AiStage;
  model: string;
  attempt: number;
  apiKeyEnv: string;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The billed tokens of a usage record. A record the API left out or filled with something that is not a count still
 * counts the request (fail closed): an unreadable output count is taken as `maxTokens`, unreadable input or cache counts
 * as 0. `malformed` says whether anything had to be assumed.
 */
function tokens(u: unknown, maxTokens: number): { usage: AiUsage; malformed: boolean } {
  const r = typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : {};
  const input = count(r.input_tokens);
  const output = count(r.output_tokens);
  const optional = (v: unknown): number | null => (v === undefined || v === null ? 0 : count(v));
  const cacheRead = optional(r.cache_read_input_tokens);
  const cacheWrite = optional(r.cache_creation_input_tokens);
  return {
    usage: {
      input_tokens: input ?? 0,
      output_tokens: output ?? maxTokens,
      cache_read_input_tokens: cacheRead ?? 0,
      cache_creation_input_tokens: cacheWrite ?? 0,
    },
    malformed: input === null || output === null || cacheRead === null || cacheWrite === null,
  };
}

/** What a request that may have reached the model is counted as when no usage came back: its whole output budget. */
const assumedUsage = (maxTokens: number): AiUsage => ({ ...ZERO_USAGE, output_tokens: maxTokens });

/** A timeout or a lost connection (no HTTP answer): the request may have reached the model and be billed. */
function mayHaveRun(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // APIConnectionTimeoutError included
  return err instanceof Anthropic.APIError && (err.status === undefined || err.status === 408 || err.type === 'timeout_error');
}

const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
});

/**
 * What one response cost, per model that ran. With a refusal fallback, usage.iterations is the per-attempt record (the
 * top-level usage covers only the attempt that answered); an iteration without a model is the requested model.
 */
function meteredParts(response: Message | BetaMessage, requested: string, maxTokens: number): { parts: MeteredUsage[]; malformed: boolean } {
  const raw: unknown = (response as { usage?: unknown }).usage;
  const iterations = typeof raw === 'object' && raw !== null && 'iterations' in raw ? (raw as { iterations: unknown }).iterations : null;
  const answered = typeof response.model === 'string' && response.model !== '' ? response.model : requested;
  if (Array.isArray(iterations) && iterations.length > 0) {
    let malformed = false;
    const parts = iterations.map((it: unknown) => {
      const model = typeof it === 'object' && it !== null && 'model' in it && typeof it.model === 'string' ? it.model : requested;
      const t = tokens(it, maxTokens);
      malformed ||= t.malformed;
      return { model, usage: t.usage };
    });
    return { parts, malformed };
  }
  const t = tokens(raw, maxTokens);
  return { parts: [{ model: answered, usage: t.usage }], malformed: t.malformed };
}

/** The answer's text: the text blocks after the last fallback switch point (the model that answered), joined. */
function answerText(response: Message | BetaMessage): string | null {
  const blocks: { type: string; text?: string }[] = response.content;
  const lastSwitch = blocks.map((b) => b.type).lastIndexOf('fallback');
  const texts = blocks.slice(lastSwitch + 1).filter((b) => b.type === 'text' && typeof b.text === 'string');
  return texts.length === 0 ? null : texts.map((b) => b.text).join('');
}

function retryAfterMs(headers: Headers | undefined, now: Date): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms != null && /^\d+(\.\d+)?$/.test(ms.trim())) return Number(ms);
  const value = headers?.get('retry-after')?.trim();
  if (value == null || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/**
 * Claude via the official SDK (Plan 2 decision 1): structured outputs (`output_config.format` from the Zod schema),
 * per-stage model and effort sent on every call, thinking left adaptive (never disabled), the stable system prompt first
 * as a block with its own cache breakpoint (cache_control on the system block only, so the per-job text after it is never
 * written to the cache). The SDK's own retries are off; this class retries AI_TIMEOUT / AI_RATE_LIMIT / AI_UNAVAILABLE up
 * to ai.max_transport_retries (2 s, 8 s, +0-20 % jitter, Retry-After honoured up to 120 s), checks the budget before and
 * meters every attempt: failed ones count as requests, and a timeout or a lost connection (the model may have run) is
 * counted at the request's whole output budget.
 * The response is read with create() rather than parse() so stop_reason is looked at before any content is parsed.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly #d: AnthropicProviderDeps;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(d: AnthropicProviderDeps) {
    this.#d = d;
    this.#clock = d.clock ?? systemClock;
    this.#sleep = d.sleep ?? ((ms) => delay(ms));
    this.#random = d.random ?? Math.random;
  }

  async structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    if (req.webSearch === true) throw webSearchUnsupported(this.name, req.stage, this.#clock);
    const settings = this.#d.getSettings().ai;
    if (settings.provider !== this.name) {
      throw new AppFailure(
        appError('CONFIG_INCOMPLETE', 'ai', this.#clock, {
          message: 'AIの提供元（settings.json の ai.provider）の変更は、再起動するまで反映されません。それまで Claude の呼出しを止めているので、ツールを起動し直してください。',
          retryable: false,
          details: { provider: 'anthropic', ai_stage: req.stage },
        }),
      );
    }
    const model = this.#modelFor(req.stage, settings);
    const schema = this.#jsonSchema(req);
    const maxAttempts = 1 + settings.max_transport_retries;
    for (let attempt = 1; ; attempt++) {
      const ctx: CallContext = { stage: req.stage, model, attempt, apiKeyEnv: settings.anthropic.api_key_env };
      await this.#d.meter.assertCanCall(this.#clock.now());
      const started = this.#clock.now().getTime();
      let response: Message | BetaMessage;
      try {
        response = await this.#send(req, model, schema, settings);
      } catch (err) {
        const { failure, retryAfterMs } = this.#mapError(err, ctx, maxAttempts);
        await this.#d.meter.record(this.#clock.now(), model, mayHaveRun(err) ? assumedUsage(req.maxTokens) : { ...ZERO_USAGE }, [], 'anthropic');
        const wait = this.#retryWait(failure, retryAfterMs, attempt, maxAttempts);
        this.#d.logger?.warn('AI_REQUEST_FAILED', `AIの${AI_STAGE_JA[req.stage]}の呼出しに失敗しました（${attempt}回目）: ${failure.error.message}`, {
          stage: 'ai',
          ai_stage: req.stage,
          model,
          attempt,
          error_code: failure.error.code,
          retry_in_ms: wait,
          duration_ms: this.#clock.now().getTime() - started,
        });
        if (wait === null) throw failure;
        await this.#sleep(wait);
        continue;
      }
      return this.#read(req, response, ctx, started);
    }
  }

  #modelFor(stage: AiStage, ai: Settings['ai']): string {
    const model = ai.anthropic.models[stage];
    const refuse = (message: string): never => {
      throw new AppFailure(appError('CONFIG_INCOMPLETE', 'ai', this.#clock, { message, retryable: false, details: { ai_stage: stage, model } }));
    };
    if (model === null) return refuse(`${AI_STAGE_JA[stage]}のモデル名が未設定のため、AIを呼び出せません（settings.json の ai.anthropic.models.${stage}）。`);
    if (!Object.hasOwn(ai.anthropic.pricing, model)) {
      return refuse(`モデル「${model}」の料金が未設定で利用額を見積もれないため、AIを呼び出しません（settings.json の ai.anthropic.pricing）。`);
    }
    return model;
  }

  #jsonSchema<T>(req: AiRequest<T>): Record<string, unknown> {
    try {
      // Only the JSON Schema is sent (enums and consts kept as constraints); the response is validated in #read.
      return structuredOutputSchema(req.schema);
    } catch (err) {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'ai', this.#clock, {
          message: `AIの出力形式（${AI_STAGE_JA[req.stage]}）を JSON Schema に変換できません: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          details: { ai_stage: req.stage },
        }),
      );
    }
  }

  #send<T>(req: AiRequest<T>, model: string, schema: Record<string, unknown>, ai: Settings['ai']): Promise<Message | BetaMessage> {
    // Images first, then the text that refers to them.
    const content = [
      ...req.content.flatMap((c) => (c.type === 'image_jpeg_base64' ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: c.data } }] : [])),
      ...req.content.flatMap((c) => (c.type === 'text' ? [{ type: 'text' as const, text: c.text }] : [])),
    ];
    const body = {
      model,
      max_tokens: req.maxTokens,
      // The breakpoint sits on the stable system block: only that prefix is cached (top-level auto-caching would also
      // write each job's unique text to the cache at 1.25 × the input price).
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content }],
      output_config: { effort: ai.anthropic.effort[req.stage], format: { type: 'json_schema' as const, schema } },
    };
    const options: CallOptions = { timeout: ai.timeout_seconds * 1000, maxRetries: 0 };
    if (ai.anthropic.refusal_fallback) {
      return this.#d.client.beta.messages.create({ ...body, betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' }, options);
    }
    return this.#d.client.messages.create(body, options);
  }

  async #read<T>(req: AiRequest<T>, response: Message | BetaMessage, ctx: CallContext, started: number): Promise<AiResult<T>> {
    const metered = meteredParts(response, ctx.model, req.maxTokens);
    const [first, ...rest] = metered.parts;
    const main = first ?? { model: ctx.model, usage: assumedUsage(req.maxTokens) };
    await this.#d.meter.record(this.#clock.now(), main.model, main.usage, rest, 'anthropic');
    if (metered.malformed) {
      this.#d.logger?.warn('AI_USAGE_MALFORMED', `AIの${AI_STAGE_JA[req.stage]}の応答に使用量が正しく入っていなかったため、多めに見積もって記録しました。`, {
        stage: 'ai',
        ai_stage: req.stage,
        model: ctx.model,
      });
    }
    const usage = rest.reduce((sum, part) => addUsage(sum, part.usage), main.usage);
    const details = { provider: 'anthropic', ai_stage: req.stage, model: response.model, attempts: ctx.attempt };

    if (response.model !== ctx.model) {
      this.#d.logger?.warn('AI_FALLBACK_USED', `AIの${AI_STAGE_JA[req.stage]}で、要求したモデル（${ctx.model}）の代わりに ${response.model} が応答しました。`, {
        stage: 'ai',
        ai_stage: req.stage,
        requested_model: ctx.model,
        model: response.model,
      });
    }
    // stop_reason first: a refused or cut-off answer is never parsed.
    const stop = response.stop_reason;
    if (stop === 'refusal') {
      const category = response.stop_details?.category ?? null;
      throw outputInvalid(this.#clock, `AIが安全上の理由で応答しませんでした（分類: ${category ?? '不明'}）。画像や指示の内容を確認してください。`, {
        ...details,
        reason: 'refusal',
        category,
      });
    }
    if (stop === 'max_tokens') {
      throw outputInvalid(this.#clock, `AIの出力が上限の長さ（${req.maxTokens}トークン）で途切れたため、規定の形式になりませんでした。`, {
        ...details,
        reason: 'max_tokens',
        max_tokens: req.maxTokens,
      });
    }
    if (stop !== 'end_turn' && stop !== 'stop_sequence' && stop !== null) {
      throw outputInvalid(this.#clock, `AIの出力が途中で終わりました（stop_reason: ${stop}）。`, { ...details, reason: stop });
    }
    const text = answerText(response);
    if (text === null) throw outputInvalid(this.#clock, 'AIの出力に本文がありませんでした。', { ...details, reason: 'no_text' });
    const value = parseJsonOutput(req.schema, text, this.#clock, details);

    this.#d.logger?.info('AI_REQUEST_COMPLETED', `AIの${AI_STAGE_JA[req.stage]}が完了しました（入力${usage.input_tokens}・出力${usage.output_tokens}トークン）。`, {
      stage: 'ai',
      ai_stage: req.stage,
      model: response.model,
      attempt: ctx.attempt,
      duration_ms: this.#clock.now().getTime() - started,
      ...usage,
    });
    return { value, usage, model: response.model };
  }

  /** null = do not retry. */
  #retryWait(failure: AppFailure, retryAfter: number | undefined, attempt: number, maxAttempts: number): number | null {
    return transportRetryWait(failure, retryAfter, attempt, maxAttempts, this.#random);
  }

  /** SDK error classes, most specific first (never the message text). Request content never goes into the details. */
  #mapError(err: unknown, ctx: CallContext, maxAttempts: number): Failure {
    const details: Record<string, unknown> = {
      provider: 'anthropic',
      ai_stage: ctx.stage,
      model: ctx.model,
      attempts: ctx.attempt,
      max_transport_retries: maxAttempts - 1,
    };
    const tried = `（${ctx.attempt}回試行）`;
    const make = (code: ErrorCode, message: string, extra: { retryable?: boolean; details?: Record<string, unknown> } = {}): AppFailure =>
      new AppFailure(
        appError(code, 'ai', this.#clock, {
          message,
          ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
          details: { ...details, ...extra.details },
        }),
      );
    const transport = (code: ErrorCode, extra: { details?: Record<string, unknown> } = {}): AppFailure => make(code, `${ERROR_MESSAGES_JA[code]}${tried}`, extra);

    if (err instanceof AppFailure) return { failure: err };
    if (!(err instanceof Anthropic.APIError)) {
      const what = err instanceof Error ? err.name : typeof err;
      return { failure: make('INTERNAL_ERROR', `AIの呼出し中に想定外のエラーが発生しました（${what}）。`, { retryable: false }) };
    }
    const api = { status: err.status ?? null, api_error_type: err.type ?? null, request_id: err.requestID ?? null };

    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return {
        failure: make(
          'AI_AUTH_ERROR',
          `AIのAPIキーが正しくないか、使う権限がありません（HTTP ${err.status}）。.env の ${ctx.apiKeyEnv} を確かめてから再開してください。`,
          { retryable: false, details: api },
        ),
      };
    }
    if (err instanceof Anthropic.RateLimitError) {
      const wait = retryAfterMs(err.headers, this.#clock.now());
      const extra = wait === undefined ? {} : { retry_after_seconds: Math.ceil(wait / 1000) };
      return { failure: transport('AI_RATE_LIMIT', { details: { ...api, ...extra } }), retryAfterMs: wait };
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) return { failure: transport('AI_TIMEOUT', { details: api }) };
    if (err instanceof Anthropic.APIConnectionError) return { failure: transport('AI_UNAVAILABLE', { details: api }) };
    if (err.type === 'timeout_error' || err.status === 408) return { failure: transport('AI_TIMEOUT', { details: api }) };
    if (err.type === 'billing_error' || err.status === 402) {
      return {
        failure: make('AI_BUDGET_EXCEEDED', 'AIのアカウントの残高（クレジット）が足りないため、AIの処理を止めました。Claude Console で支払い設定を確認してから、ツールを起動し直してください。', {
          retryable: false,
          details: api,
        }),
      };
    }
    if (err instanceof Anthropic.InternalServerError || err.status === undefined || err.status >= 500) {
      return { failure: transport('AI_UNAVAILABLE', { details: api }) };
    }
    // A wrong model id or a setting the model does not take fails every request alike: stop all AI work (CONFIG_INCOMPLETE,
    // stage 'ai') until settings.json is fixed, instead of failing job after job.
    if (err instanceof Anthropic.NotFoundError || err.status === 404) {
      return {
        failure: make(
          'CONFIG_INCOMPLETE',
          `AIのモデル「${ctx.model}」が見つかりません（HTTP 404）。settings.json の ai.anthropic.models のモデル名を確認してください。直すまでAIの処理を止めます。`,
          { retryable: false, details: api },
        ),
      };
    }
    if (err instanceof Anthropic.BadRequestError || err.status === 400) {
      return {
        failure: make(
          'CONFIG_INCOMPLETE',
          `AIへの要求が受け付けられませんでした（HTTP 400、${err.type ?? '種類不明'}）。モデル「${ctx.model}」が settings.json の ai.anthropic の設定（models・effort・refusal_fallback など）に対応していない可能性があります。設定を確認してください。直すまでAIの処理を止めます。`,
          { retryable: false, details: api },
        ),
      };
    }
    // The remaining 4xx (e.g. 413 request too large): this request was refused, so sending it again cannot help.
    return {
      failure: make(
        'AI_OUTPUT_INVALID',
        `AIへの要求が受け付けられませんでした（HTTP ${err.status}、${err.type ?? '種類不明'}）。settings.json の ai.anthropic の設定（モデル・refusal_fallback など）を確認してください。`,
        { retryable: false, details: api },
      ),
    };
  }
}
