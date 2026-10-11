import type { ZodType } from 'zod';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { AiStage } from '../shared/types.js';

/** What a request shows the model. Images are only ever the prepared ai.jpg (prepare-image.ts), base64 without a data: prefix. */
export type AiContent = { type: 'text'; text: string } | { type: 'image_jpeg_base64'; data: string };

/** Token counts of one call, as the provider bills them (the two cache counts are 0 when nothing was cached). */
export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const ZERO_USAGE: Readonly<AiUsage> = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/**
 * How a failed call is metered (fail closed): one that may have reached the service and run (a timeout, a lost
 * connection or an unreadable answer: no HTTP status, or 408 / 504) counts its whole output limit, as it may be billed.
 */
export function failedCallUsage(error: { code: string; details_redacted: Record<string, unknown> }, maxTokens: number): AiUsage {
  const status = error.details_redacted.status;
  const mayHaveRun = error.code === 'AI_TIMEOUT' || (error.code === 'AI_UNAVAILABLE' && (status === undefined || status === null));
  return { ...ZERO_USAGE, output_tokens: mayHaveRun ? maxTokens : 0 };
}

export interface AiRequest<T> {
  stage: AiStage;
  /** The output must parse with this schema; it is also what the model is constrained to (structured outputs). */
  schema: ZodType<T>;
  /** Stable instructions, sent before everything else so the prefix can be cached. */
  system: string;
  content: AiContent[];
  maxTokens: number;
  /** The job id: the mock derives its output from it; the real provider ignores it. */
  seed?: string | undefined;
  /**
   * Plain facts about the request (e.g. the job's audience) for the mock's responders. Never sent to a real provider
   * and never logged, so it must not be needed for the model's answer.
   */
  meta?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Let the model search the web (Gemini: Google Search grounding; OpenAI: the web_search tool on ai.openai.web_search_model).
   * The answer is then read as JSON text, not constrained output. The other providers (Claude, OpenAI-compatible servers)
   * refuse it with webSearchUnsupported() before any network use.
   */
  webSearch?: boolean | undefined;
}

export interface AiResult<T> {
  value: T;
  usage: AiUsage;
  /** The model that produced the value (with a refusal fallback, not necessarily the one requested). */
  model: string;
  /** webSearch only: up to 10 pages the answer was grounded on (origin + path), when the provider reports them. */
  sources?: string[] | undefined;
}

/** A web search reads pages before it answers, so it waits at least this long whatever ai.timeout_seconds says. */
export const WEB_SEARCH_MIN_TIMEOUT_SECONDS = 300;

/** The per-request timeout in ms: ai.timeout_seconds, at least WEB_SEARCH_MIN_TIMEOUT_SECONDS for a webSearch request. */
export const requestTimeoutMs = (req: Pick<AiRequest<unknown>, 'webSearch'>, timeoutSeconds: number): number =>
  (req.webSearch === true ? Math.max(timeoutSeconds, WEB_SEARCH_MIN_TIMEOUT_SECONDS) : timeoutSeconds) * 1000;

/** The refusal of a webSearch request by a provider that cannot search (CONFIG_INCOMPLETE; nothing is sent). */
export function webSearchUnsupported(provider: string, stage: AiStage, clock: Clock): AppFailure {
  return new AppFailure(
    appError('CONFIG_INCOMPLETE', 'ai', clock, {
      message: 'Web検索は今は Gemini と OpenAI のときだけ使えます（このAIでは検索しません）。',
      retryable: false,
      details: { provider, ai_stage: stage, reason: 'web_search_unsupported' },
    }),
  );
}

/**
 * One structured call. Failures are AppFailures with an AI_* code (spec 15.1); a value is returned only after it parsed
 * with `schema`.
 */
export interface AiProvider {
  /** 'staged': each stage goes to its own provider (.env AI_<STAGE>_*, registry.ts). */
  readonly name: 'mock' | 'anthropic' | 'gemini' | 'openai' | 'openai_compatible' | 'staged';
  structured<T>(req: AiRequest<T>): Promise<AiResult<T>>;
}
