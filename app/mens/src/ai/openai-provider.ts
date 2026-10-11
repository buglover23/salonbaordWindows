import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from 'openai';
import type { ChatCompletionContentPart, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { ResponseCreateParamsNonStreaming, ResponseInputContent } from 'openai/resources/responses/responses';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpenAiEffort, Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, ERROR_MESSAGES_JA, appError, type ErrorCode } from '../shared/errors.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import type { AiStage } from '../shared/types.js';
import { errnoCode } from '../storage/atomic-json.js';
import { aiEnvKey, envPricing, type AiEnvField, type StageAiConfig } from './ai-config.js';
import { AI_SERVICE_INFO } from './ai-services.js';
import { extractJsonText, jsonInstruction, openAiStrictSchema } from './openai-schema.js';
import { outputInvalid, parseJsonOutput, sourcePages, validateOutput } from './output.js';
import { failedCallUsage, requestTimeoutMs, webSearchUnsupported, type AiProvider, type AiRequest, type AiResult, type AiUsage } from './provider.js';
import { transportRetryWait } from './retry-policy.js';
import type { PriceList, UsageMeter } from './usage-meter.js';

// OpenAI and OpenAI-compatible servers through the official `openai` SDK (7.x), Chat Completions (POST
// /chat/completions): the one request shape both accept (github.com/openai/openai-node README; developers.openai.com
// API reference). A web search (OpenAI only) goes through the Responses API (POST /responses) with the web_search tool.
// Everything about the SDK and the wire format is in this file.

/** OpenAI's endpoint, passed explicitly so OPENAI_BASE_URL in the environment cannot send the key elsewhere. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/**
 * OpenAI counts reasoning tokens inside max_completion_tokens, so a stage's own limit (4000 for the analysis) is raised
 * to this; it caps the answer, the bill follows the tokens used. Compatible servers get the stage's limit as
 * max_tokens (the field they commonly read; some refuse limits above the model's). AI_<STAGE>_MAX_TOKENS sets the floor instead.
 */
export const OPENAI_MIN_COMPLETION_TOKENS = 16_384;
/** The floor for a web search: the searched pages' reasoning also counts against max_output_tokens. */
export const OPENAI_MIN_SEARCH_OUTPUT_TOKENS = 32_768;
/** Sent to a local server that needs no key (the SDK refuses to start without one). */
const LOCAL_PLACEHOLDER_KEY = 'local';
// Answers whose finish_reason means "finished"; compatible servers also send null or their own words.
const FINISHED: ReadonlySet<string> = new Set(['stop', 'eos', 'eos_token', 'end_turn']);
// 429 codes that mean money, not pace (developers.openai.com/api/docs/guides/error-codes): waiting does not help.
const BUDGET_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'billing_hard_limit_reached',
]);
// A 400 about these parameters or with these codes is a setting (model, JSON mode), not this one request.
const CONFIG_PARAMS = /^(model|response_format|max_completion_tokens|max_tokens|max_output_tokens|reasoning_effort|reasoning\.effort|tools|temperature|top_p)$/;
const CONFIG_CODES: ReadonlySet<string> = new Set(['model_not_found', 'invalid_model', 'model_not_available', 'unsupported_parameter', 'unsupported_value']);
const MAX_FIELD_LENGTH = 120;

/** The fields of a Chat Completions response the provider reads (the SDK's ChatCompletion fits; tests pass plain objects). */
export interface ChatCompletionLike {
  model?: string | null;
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } | null }[] | null;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; prompt_tokens_details?: { cached_tokens?: number | null } | null } | null;
}

/** A web_search_call's action type; a call without one counts as a search (billed). */
const actionType = (action: unknown): unknown => (action !== null && typeof action === 'object' && 'type' in action ? action.type : 'search');

type Citation = { type?: string; url?: string | null; start_index?: number | null; end_index?: number | null };

/** `text` without the inline citations ("([site](url))") the web_search tool writes into it; a span out of range or not showing its URL is kept. */
export function withoutCitations(text: string, annotations: readonly Citation[]): string {
  const spans = annotations.flatMap((a) =>
    a.type === 'url_citation' && typeof a.url === 'string' && typeof a.start_index === 'number' && typeof a.end_index === 'number' ? [{ url: a.url, start: a.start_index, end: a.end_index }] : [],
  );
  let out = text;
  let limit = text.length;
  // From the end backwards, so the earlier indices still point into the unchanged text; overlaps are cut once.
  for (const { url, start, end } of spans.sort((a, b) => b.start - a.start)) {
    const stop = Math.min(end, limit);
    if (start >= 0 && start < stop && end <= text.length && text.slice(start, end).includes(url)) {
      out = out.slice(0, start) + out.slice(stop);
      limit = start;
    }
  }
  return out;
}

/** The fields of a Responses API response the web search reads (the SDK's Response fits; tests pass plain objects). */
export interface ResponseLike {
  model?: string | null;
  status?: string | null;
  error?: { code?: string | null } | null;
  incomplete_details?: { reason?: string | null } | null;
  output?:
    | {
        type?: string;
        action?: unknown; // web_search_call: { type: 'search' | 'open_page' | 'find_in_page' }; other items differ
        content?: { type?: string; text?: string | null; refusal?: string | null; annotations?: Citation[] | null }[] | null;
      }[]
    | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null; input_tokens_details?: { cached_tokens?: number | null } | null } | null;
}

type RequestOptions = { timeout?: number; maxRetries?: number };

/** The part of the SDK client the provider uses; tests pass a stub, so no test reaches the network. */
export interface OpenAiClientLike {
  chat: { completions: { create(body: ChatCompletionCreateParamsNonStreaming, options?: RequestOptions): Promise<ChatCompletionLike> } };
  responses: { create(body: ResponseCreateParamsNonStreaming, options?: RequestOptions): Promise<ResponseLike> };
}

export type OpenAiMeter = Pick<UsageMeter, 'assertCanCall' | 'recordPriced'>;

/**
 * The real client: the key and endpoint passed explicitly (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_ADMIN_KEY,
 * OPENAI_ORG_ID and OPENAI_PROJECT_ID in the environment are not used), SDK retries off (the app owns and meters them),
 * SDK logging off, timeout in milliseconds. `fetch` replaces the network (tests).
 */
export function createOpenAiClient(o: { apiKey: string | null; baseURL: string | null; timeoutMs: number; fetch?: ClientOptions['fetch'] }): OpenAI {
  return new OpenAI({
    apiKey: o.apiKey ?? LOCAL_PLACEHOLDER_KEY,
    baseURL: o.baseURL ?? OPENAI_BASE_URL,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    timeout: o.timeoutMs,
    maxRetries: 0,
    logLevel: 'off',
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
}

export interface OpenAiProviderDeps {
  client: OpenAiClientLike;
  /** The stage this provider serves (service openai or openai_compatible, model, JSON mode, .env price, variable names for messages). */
  config: StageAiConfig;
  /** Read on every call, so edited timeouts and retries apply without a restart. */
  getSettings: () => Settings;
  meter: OpenAiMeter;
  clock?: Clock;
  logger?: AppLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type Failure = { failure: AppFailure; retryAfterMs?: number | undefined };
type ResponseFormat = ChatCompletionCreateParamsNonStreaming['response_format'];

interface Format {
  system: string;
  responseFormat: ResponseFormat | undefined;
  normalize: (value: unknown) => unknown;
}

interface CallContext {
  stage: AiStage;
  attempt: number;
  maxAttempts: number;
  maxTokens: number;
  /** The model called: the stage's, or ai.openai.web_search_model for a web search. */
  model: string;
  search: boolean;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const clip = (s: string): string => (s.length > MAX_FIELD_LENGTH ? `${s.slice(0, MAX_FIELD_LENGTH - 1)}…` : s);
/** A server-supplied code, parameter or id, only when it looks like one (never free text). */
const ident = (v: unknown): string | null => (typeof v === 'string' && /^[\w.[\]:/-]{1,120}$/.test(v) ? v : null);

/** Cached prompt tokens are inside prompt_tokens and reported apart; completion_tokens includes reasoning tokens (billed as output). */
export function openAiUsage(u: ChatCompletionLike['usage']): AiUsage {
  const prompt = count(u?.prompt_tokens);
  const cached = Math.min(count(u?.prompt_tokens_details?.cached_tokens), prompt);
  return { input_tokens: prompt - cached, output_tokens: count(u?.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

/** Responses API usage: the same split (cached tokens are inside input_tokens; output_tokens includes reasoning). */
export const responsesUsage = (u: ResponseLike['usage']): AiUsage =>
  openAiUsage({ prompt_tokens: u?.input_tokens ?? null, completion_tokens: u?.output_tokens ?? null, prompt_tokens_details: { cached_tokens: u?.input_tokens_details?.cached_tokens ?? null } });

function retryAfterMs(headers: Headers | undefined, now: Date): number | undefined {
  const ms = headers?.get('retry-after-ms')?.trim();
  if (ms != null && /^\d+(\.\d+)?$/.test(ms)) return Number(ms);
  const value = headers?.get('retry-after')?.trim();
  if (value == null || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/**
 * One stage on OpenAI or an OpenAI-compatible server (ruling P2-R17). The answer is constrained as the stage's
 * JSON_MODE says: json_schema (strict, from the Zod schema), json_object (JSON mode, the schema in the instructions) or
 * none (the schema in the instructions, the JSON taken from the text); it is parsed with the Zod schema either way.
 * Images go first as data-URL parts. finish_reason and refusal are looked at before any content is parsed. The SDK's
 * retries are off; AI_TIMEOUT / AI_RATE_LIMIT / AI_UNAVAILABLE are retried up to ai.max_transport_retries, the budget
 * is checked before and every attempt metered (priced from .env AI_<STAGE>_PRICE_IN/OUT, for OpenAI else from
 * settings.json ai.openai.pricing; a compatible server without a price is counted only). OpenAI only: the stage's
 * ai.openai.reasoning_effort is sent when the stage calls its ai.openai.models model (the effort was checked for that
 * model), and a webSearch request goes to ai.openai.web_search_model with the web_search tool.
 */
export class OpenAiProvider implements AiProvider {
  readonly name: 'openai' | 'openai_compatible';
  readonly #d: OpenAiProviderDeps;
  readonly #model: string;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(d: OpenAiProviderDeps) {
    const { service, model } = d.config;
    if ((service !== 'openai' && service !== 'openai_compatible') || model === null) {
      throw new Error('OpenAiProvider needs a stage with service openai or openai_compatible and a model');
    }
    this.name = service;
    this.#d = d;
    this.#model = model;
    this.#clock = d.clock ?? systemClock;
    this.#sleep = d.sleep ?? ((ms) => delay(ms));
    this.#random = d.random ?? Math.random;
  }

  async structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    const search = req.webSearch === true;
    // The web_search tool is OpenAI's own; a compatible server is never asked.
    if (search && this.name !== 'openai') throw webSearchUnsupported(this.name, req.stage, this.#clock);
    const ai = this.#d.getSettings().ai;
    const format = search ? null : this.#format(req);
    const pricing = this.#pricing(ai);
    const maxAttempts = 1 + ai.max_transport_retries;
    // AI_<STAGE>_MAX_TOKENS replaces the floor (OpenAI: OPENAI_MIN_COMPLETION_TOKENS; compatible servers: none); a web
    // search keeps OPENAI_MIN_SEARCH_OUTPUT_TOKENS unless that is larger.
    const maxTokens = search
      ? Math.max(req.maxTokens, OPENAI_MIN_SEARCH_OUTPUT_TOKENS, this.#d.config.maxTokens ?? 0)
      : Math.max(req.maxTokens, this.#d.config.maxTokens ?? (this.name === 'openai' ? OPENAI_MIN_COMPLETION_TOKENS : 0));
    const model = search ? ai.openai.web_search_model : this.#model;
    const options = { timeout: requestTimeoutMs(req, ai.timeout_seconds), maxRetries: 0 };
    for (let attempt = 1; ; attempt++) {
      const ctx: CallContext = { stage: req.stage, attempt, maxAttempts, maxTokens, model, search };
      await this.#d.meter.assertCanCall(this.#clock.now());
      const started = this.#clock.now().getTime();
      let read: () => Promise<AiResult<T>>;
      let metered = false;
      try {
        if (format === null) {
          const response = await this.#d.client.responses.create(this.#searchBody(req, ai, maxTokens), options);
          const transient = this.#failedSearch(response, ctx);
          if (transient !== null) {
            metered = true;
            await this.#meterSearch(response, ctx, pricing, ai.openai.web_search_call_usd);
            throw transient;
          }
          read = () => this.#readSearch(req, response, ctx, started, pricing, ai.openai.web_search_call_usd);
        } else {
          const response = await this.#d.client.chat.completions.create(this.#body(req, format, maxTokens, ai), options);
          read = () => this.#read(req, response, ctx, started, format, pricing);
        }
      } catch (err) {
        const { failure, retryAfterMs: serverWait } = this.#mapError(err, ctx);
        if (!metered) await this.#d.meter.recordPriced(this.#clock.now(), model, failedCallUsage(failure.error, maxTokens), [], pricing);
        const wait = transportRetryWait(failure, serverWait, attempt, maxAttempts, this.#random);
        this.#d.logger?.warn('AI_REQUEST_FAILED', `AIの${AI_STAGE_JA[req.stage]}の呼出しに失敗しました（${attempt}回目）: ${failure.error.message}`, {
          stage: 'ai',
          provider: this.name,
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
      return read();
    }
  }

  /** The .env price of this stage's model over (OpenAI) settings.json ai.openai.pricing; null = no price known (counted only). */
  #pricing(ai: Settings['ai']): PriceList | null {
    const own = this.#d.config.price === null ? null : { [this.#model]: envPricing(this.#d.config.price) };
    return this.name === 'openai' ? { ...ai.openai.pricing, ...own } : own;
  }

  /** The stage's reasoning effort: OpenAI only, and only for the settings model it was checked against (another model may reject it). */
  #effort(ai: Settings['ai'], stage: AiStage): OpenAiEffort | null {
    return this.name === 'openai' && this.#model === ai.openai.models[stage] ? ai.openai.reasoning_effort[stage] : null;
  }

  /** Where the called model is set, for messages. */
  #modelSetting(ctx: CallContext): string {
    if (ctx.search) return 'settings.json の ai.openai.web_search_model';
    // An .env OpenAI stage without a MODEL line takes the settings.json model.
    if (this.#d.config.source === 'settings' || (this.name === 'openai' && this.#d.config.origins.MODEL === undefined)) return `settings.json の ai.openai.models.${ctx.stage}`;
    return `.env の ${this.#key('MODEL')}`;
  }

  /** The .env variable that set `field` for this stage (CHECK may have taken it from GENERATION). */
  #key(field: AiEnvField): string {
    if (field === 'API_KEY') return this.#d.config.keyName ?? aiEnvKey(this.#d.config.stage, 'API_KEY');
    return this.#d.config.origins[field]?.key ?? aiEnvKey(this.#d.config.stage, field);
  }

  get #label(): string {
    return AI_SERVICE_INFO[this.name].label;
  }

  #format<T>(req: AiRequest<T>): Format {
    try {
      if (this.#d.config.jsonMode === 'json_schema') {
        const strict = openAiStrictSchema(req.schema);
        return {
          system: req.system,
          responseFormat: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: strict.schema } },
          normalize: strict.normalize,
        };
      }
      return {
        system: `${req.system}\n\n${jsonInstruction(req.schema)}`,
        responseFormat: this.#d.config.jsonMode === 'json_object' ? { type: 'json_object' } : undefined,
        normalize: (value) => value,
      };
    } catch (err) {
      throw new AppFailure(
        appError('INTERNAL_ERROR', 'ai', this.#clock, {
          message: `AIの出力形式（${AI_STAGE_JA[req.stage]}）を ${this.#label} の JSON Schema に変換できません: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          details: { provider: this.name, ai_stage: req.stage },
        }),
      );
    }
  }

  #body<T>(req: AiRequest<T>, format: Format, maxTokens: number, ai: Settings['ai']): ChatCompletionCreateParamsNonStreaming {
    const effort = this.#effort(ai, req.stage);
    const images = req.content.flatMap((c): ChatCompletionContentPart[] =>
      c.type === 'image_jpeg_base64' ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${c.data}` } }] : [],
    );
    const texts = req.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
    // Images first, then the text that refers to them; text alone as a plain string, which every server accepts.
    const content: string | ChatCompletionContentPart[] = images.length === 0 ? texts.join('\n\n') : [...images, ...texts.map((text): ChatCompletionContentPart => ({ type: 'text', text }))];
    return {
      model: this.#model,
      messages: [
        { role: 'system', content: format.system },
        { role: 'user', content },
      ],
      ...(this.name === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(effort === null ? {} : { reasoning_effort: effort }),
      ...(format.responseFormat === undefined ? {} : { response_format: format.responseFormat }),
    };
  }

  /**
   * The web search request (Responses API): the system text as instructions, the web_search tool, no JSON schema (the
   * prompt asks for JSON, as on Gemini), the web_search effort, nothing stored on OpenAI's side.
   */
  #searchBody<T>(req: AiRequest<T>, ai: Settings['ai'], maxTokens: number): ResponseCreateParamsNonStreaming {
    const content: ResponseInputContent[] = [
      ...req.content.flatMap((c): ResponseInputContent[] => (c.type === 'image_jpeg_base64' ? [{ type: 'input_image', detail: 'auto', image_url: `data:image/jpeg;base64,${c.data}` }] : [])),
      ...req.content.flatMap((c): ResponseInputContent[] => (c.type === 'text' ? [{ type: 'input_text', text: c.text }] : [])),
    ];
    return {
      model: ai.openai.web_search_model,
      instructions: req.system,
      input: [{ role: 'user', content }],
      // Without a location the tool searches as from the United States.
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' } }],
      reasoning: { effort: ai.openai.reasoning_effort.web_search },
      max_output_tokens: maxTokens,
      store: false,
    };
  }

  /** A refusal: the analysis is about the photo alone, so it repeats for the same photo; a text can be regenerated. */
  #refused(stage: AiStage, details: Record<string, unknown>, reason: string): AppFailure {
    if (stage === 'analysis') {
      return outputInvalid(this.#clock, 'AIがこの写真・依頼を安全上の理由で受け付けませんでした。同じ写真では作れないため、別の写真を使ってください。', { ...details, reason }, false);
    }
    return outputInvalid(this.#clock, 'AIが安全上の理由で応答しませんでした。画像や指示の内容を確認してください。', { ...details, reason });
  }

  #truncated(ctx: CallContext, details: Record<string, unknown>): AppFailure {
    return outputInvalid(this.#clock, `AIの出力が上限の長さ（${ctx.maxTokens}トークン）で途切れたため、規定の形式になりませんでした。`, { ...details, reason: 'max_tokens', max_tokens: ctx.maxTokens });
  }

  #completed(stage: AiStage, ctx: CallContext, started: number, usage: AiUsage, model: string): void {
    this.#d.logger?.info('AI_REQUEST_COMPLETED', `AIの${AI_STAGE_JA[stage]}が完了しました（入力${usage.input_tokens}・出力${usage.output_tokens}トークン）。`, {
      stage: 'ai',
      provider: this.name,
      ai_stage: stage,
      model,
      attempt: ctx.attempt,
      duration_ms: this.#clock.now().getTime() - started,
      ...usage,
    });
  }

  /** Metered as the tokens at the search model's price plus `callUsd` per search action the answer shows (at least 1; opening or reading a page is not billed). */
  async #meterSearch(response: ResponseLike, ctx: CallContext, pricing: PriceList | null, callUsd: number): Promise<{ usage: AiUsage; calls: number }> {
    const usage = responsesUsage(response.usage);
    const calls = (response.output ?? []).filter((o) => o.type === 'web_search_call' && actionType(o.action) === 'search').length;
    await this.#d.meter.recordPriced(this.#clock.now(), ctx.model, usage, [], pricing, Math.max(calls, 1) * callUsd);
    return { usage, calls };
  }

  /** A search answered with status failed for a passing reason (HTTP 200): retried like the same HTTP error; null otherwise. */
  #failedSearch(response: ResponseLike, ctx: CallContext): AppFailure | null {
    const code = response.status === 'failed' ? (response.error?.code ?? null) : null;
    const mapped: ErrorCode | null = code === 'server_error' ? 'AI_UNAVAILABLE' : code === 'rate_limit_exceeded' ? 'AI_RATE_LIMIT' : null;
    if (mapped === null) return null;
    const details = { provider: this.name, ai_stage: ctx.stage, model: ctx.model, attempts: ctx.attempt, max_transport_retries: ctx.maxAttempts - 1, status: 200, error_code: code };
    return new AppFailure(appError(mapped, 'ai', this.#clock, { message: `${ERROR_MESSAGES_JA[mapped]}（${ctx.attempt}回試行）`, details }));
  }

  async #readSearch<T>(req: AiRequest<T>, response: ResponseLike, ctx: CallContext, started: number, pricing: PriceList | null, callUsd: number): Promise<AiResult<T>> {
    const { usage, calls } = await this.#meterSearch(response, ctx, pricing, callUsd);
    const output = response.output ?? [];
    const answeredBy = typeof response.model === 'string' && response.model !== '' ? clip(response.model) : ctx.model;
    const details = { provider: this.name, ai_stage: req.stage, model: answeredBy, attempts: ctx.attempt, web_search_calls: calls };

    const parts = output.flatMap((o) => (o.type === 'message' ? (o.content ?? []) : []));
    const incomplete = response.incomplete_details?.reason ?? null;
    if (incomplete === 'max_output_tokens') throw this.#truncated(ctx, details);
    const refused = parts.some((p) => p.type === 'refusal' && typeof p.refusal === 'string' && p.refusal.trim() !== '');
    if (refused || incomplete === 'content_filter') throw this.#refused(req.stage, details, refused ? 'refusal' : 'content_filter');
    const status = response.status ?? null;
    const failedCode = status === 'failed' ? ident(response.error?.code) : null;
    if (failedCode !== null && /image/i.test(failedCode)) {
      const message = `${this.#label}がこの写真を受け付けませんでした（${failedCode}）。同じ写真では作れないため、別の写真を使ってください（どの写真でも続くときは、${this.#modelSetting(ctx)} が画像を読めるモデルか確かめてください）。`;
      throw outputInvalid(this.#clock, message, { ...details, reason: 'failed', status: 'failed', error_code: failedCode }, false);
    }
    if (status !== null && status !== 'completed') {
      const name = ident(status) ?? 'unknown';
      throw outputInvalid(this.#clock, `AIの出力が途中で終わりました（status: ${name}）。`, { ...details, reason: name, status: name });
    }
    const texts = parts.filter((p) => p.type === 'output_text' && typeof p.text === 'string');
    const text = texts.map((p) => withoutCitations(p.text as string, p.annotations ?? [])).join('');
    if (text.trim() === '') throw outputInvalid(this.#clock, 'AIの出力に本文がありませんでした。', { ...details, reason: 'no_text' });
    const value = parseJsonOutput(req.schema, text, this.#clock, details);
    const sources = sourcePages(texts.flatMap((p) => (p.annotations ?? []).flatMap((a) => (a.type === 'url_citation' ? [a.url] : []))));
    this.#completed(req.stage, ctx, started, usage, answeredBy);
    return { value, usage, model: answeredBy, sources };
  }

  async #read<T>(req: AiRequest<T>, response: ChatCompletionLike, ctx: CallContext, started: number, format: Format, pricing: PriceList | null): Promise<AiResult<T>> {
    const usage = openAiUsage(response.usage);
    await this.#d.meter.recordPriced(this.#clock.now(), ctx.model, usage, [], pricing);
    const answeredBy = typeof response.model === 'string' && response.model !== '' ? clip(response.model) : ctx.model;
    const details = { provider: this.name, ai_stage: req.stage, model: answeredBy, attempts: ctx.attempt };

    const choice = response.choices?.[0];
    if (choice == null) throw outputInvalid(this.#clock, 'AIの応答に出力の候補がありませんでした。', { ...details, reason: 'no_choices' });
    const finish = choice.finish_reason ?? null;
    const message = choice.message ?? {};
    if (finish === 'length') throw this.#truncated(ctx, details);
    const refused = typeof message.refusal === 'string' && message.refusal.trim() !== '';
    if (refused || finish === 'content_filter') throw this.#refused(req.stage, details, refused ? 'refusal' : 'content_filter');
    if (finish !== null && !FINISHED.has(finish)) {
      const name = ident(finish) ?? 'unknown';
      throw outputInvalid(this.#clock, `AIの出力が途中で終わりました（finish_reason: ${name}）。`, { ...details, reason: name, finish_reason: name });
    }
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.trim() === '') throw outputInvalid(this.#clock, 'AIの出力に本文がありませんでした。', { ...details, reason: 'no_text' });
    const value = validateOutput(req.schema, format.normalize(this.#json(text, details)), this.#clock, details);
    this.#completed(req.stage, ctx, started, usage, answeredBy);
    return { value, usage, model: answeredBy };
  }

  /** The JSON as sent, else (a compatible server's code fence, or JSON_MODE none) the object taken from the text. */
  #json(text: string, details: Record<string, unknown>): unknown {
    if (this.#d.config.jsonMode !== 'none') {
      try {
        return JSON.parse(text);
      } catch {
        // fall through to the extraction
      }
    }
    const extracted = extractJsonText(text);
    if (extracted !== null) {
      try {
        return JSON.parse(extracted);
      } catch {
        // reported below
      }
    }
    throw outputInvalid(this.#clock, 'AIの出力をJSONとして読み取れませんでした。', { ...details, reason: 'invalid_json', text_length: text.length });
  }

  /** SDK error classes and HTTP status, most specific first; the server's own text is never read or copied. */
  #mapError(err: unknown, ctx: CallContext): Failure {
    const details: Record<string, unknown> = {
      provider: this.name,
      ai_stage: ctx.stage,
      model: ctx.model,
      attempts: ctx.attempt,
      max_transport_retries: ctx.maxAttempts - 1,
    };
    const make = (code: ErrorCode, message: string, extra: { retryable?: boolean; details?: Record<string, unknown> } = {}): AppFailure =>
      new AppFailure(
        appError(code, 'ai', this.#clock, {
          message,
          ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
          details: { ...details, ...extra.details },
        }),
      );
    const transport = (code: ErrorCode, extra: Record<string, unknown> = {}): AppFailure => make(code, `${ERROR_MESSAGES_JA[code]}（${ctx.attempt}回試行）`, { details: extra });

    if (err instanceof AppFailure) return { failure: err };
    if (!(err instanceof APIError)) {
      const what = err instanceof Error ? err.name : typeof err;
      return { failure: make('INTERNAL_ERROR', `AIの呼出し中に想定外のエラーが発生しました（${what}）。`, { retryable: false }) };
    }
    const code = ident(err.code);
    const param = ident(err.param);
    const api = { status: err.status ?? null, error_code: code, param, request_id: ident(err.requestID) };
    const stop = (c: ErrorCode, message: string): Failure => ({ failure: make(c, message, { retryable: false, details: api }) });
    const status = err.status;
    const label = this.#label;
    const compatible = this.name === 'openai_compatible';
    const why = `HTTP ${status ?? '不明'}${code === null ? '' : `、${code}`}`;

    if (err instanceof APIConnectionTimeoutError) return { failure: transport('AI_TIMEOUT', api) };
    if (err instanceof APIUserAbortError) return { failure: transport('AI_UNAVAILABLE', api) };
    if (err instanceof APIConnectionError || status === undefined) {
      // Node's fetch can give up waiting for the response headers before the SDK's own timeout.
      const network = errnoCode(err.cause);
      const timeout = network !== undefined && network.startsWith('UND_ERR_') && network.includes('TIMEOUT');
      return { failure: transport(timeout ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', network === undefined ? api : { ...api, network_code: clip(network) }) };
    }
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError || status === 401 || status === 403) {
      const region = this.name === 'openai' ? '（OpenAI では、地域やプロジェクトの設定で使えないこともあります）' : '';
      return stop('AI_AUTH_ERROR', `${label}のAPIキーが正しくないか、使う権限がありません（${why}）。.env の ${this.#key('API_KEY')} を確かめてから再開してください${region}。`);
    }
    if (status === 402 || (status === 429 && code !== null && BUDGET_CODES.has(code))) {
      const where = this.name === 'openai' ? 'OpenAI の管理画面（https://platform.openai.com/settings/organization/billing）' : '使っているサービスの管理画面';
      return stop('AI_BUDGET_EXCEEDED', `${label}の残高（クレジット）が足りないか、利用額の上限に達したため、AIの処理を止めました（${why}）。${where}で支払いと上限の設定を確認してください。`);
    }
    if (err instanceof RateLimitError || status === 429) {
      const wait = retryAfterMs(err.headers, this.#clock.now());
      return { failure: transport('AI_RATE_LIMIT', wait === undefined ? api : { ...api, retry_after_seconds: Math.ceil(wait / 1000) }), retryAfterMs: wait };
    }
    if (status === 408 || status === 504) return { failure: transport('AI_TIMEOUT', api), retryAfterMs: retryAfterMs(err.headers, this.#clock.now()) };
    if (status >= 500 || status === 409) return { failure: transport('AI_UNAVAILABLE', api), retryAfterMs: retryAfterMs(err.headers, this.#clock.now()) };
    if (status === 404) {
      const url = compatible ? `と ${this.#key('BASE_URL')}（接続先のURL）` : '';
      return stop('CONFIG_INCOMPLETE', `${label}でモデル「${ctx.model}」が見つかりません（HTTP 404）。${this.#modelSetting(ctx)} のモデル名${url}を確認してください。`);
    }
    const jsonHint = `JSON の形式の指定に対応していないモデル・サーバーなら、${this.#key('JSON_MODE')}=json_object（だめなら none）にしてください。`;
    if ((status === 400 || status === 422) && ((param !== null && CONFIG_PARAMS.test(param)) || (code !== null && CONFIG_CODES.has(code)))) {
      const hint = compatible || param === 'response_format' ? jsonHint : '';
      const effort = param !== null && param.startsWith('reasoning') ? 'settings.json の ai.openai.reasoning_effort も確かめてください。' : '';
      return stop('CONFIG_INCOMPLETE', `${label}が設定の値を受け付けませんでした（${why}${param === null ? '' : `、${param}`}）。${this.#modelSetting(ctx)}（モデル名）を確認してください。${effort}${hint}`);
    }
    if ((status === 400 || status === 422) && /image/i.test(`${code ?? ''} ${param ?? ''}`)) {
      return stop('AI_OUTPUT_INVALID', `${label}がこの写真を受け付けませんでした（${why}）。同じ写真では作れないため、別の写真を使ってください（どの写真でも続くときは、${this.#modelSetting(ctx)} が画像を読めるモデルか確かめてください）。`);
    }
    // The remaining 4xx: the request itself was refused, so sending it again cannot help.
    return stop(
      'AI_OUTPUT_INVALID',
      `AIへの要求が受け付けられませんでした（${why}）。同じ表示が続くときは設定の誤りの可能性が高いので、ツールを止めて ${this.#modelSetting(ctx)}（モデル名）と ${this.#key('JSON_MODE')} を確かめ、npm.cmd run ai:test で試してください。${compatible ? jsonHint : ''}`,
    );
  }
}
