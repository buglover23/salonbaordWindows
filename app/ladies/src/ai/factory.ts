import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, type Fetch } from '@google/genai';
import { envSource } from '../config/env-file.js';
import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import { AI_STAGES, type AiStage, type Mode } from '../shared/types.js';
import { aiEnvKey, resolveAiConfig, usesEnvStages, type AiConfigResult } from './ai-config.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { MockAiProvider, type MockProviderOptions } from './mock-provider.js';
import { createOpenAiClient } from './openai-provider.js';
import type { AiProvider, AiRequest, AiResult } from './provider.js';
import { StagedAiProvider, createStageProvider, type ClientFactories, type StageMeter } from './registry.js';

/** The Gemini API endpoint (the SDK's documented default), pinned so no environment variable can send the key elsewhere. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/';

export interface AiFactoryDeps {
  /** The usage meter (UsageMeter): budget and request counts for every real provider. */
  meter: StageMeter;
  /** The stages from .env and settings.json (loadAiSetup); resolved from `env` alone when omitted. */
  aiConfig?: AiConfigResult;
  /** Where keys are looked up when `aiConfig` is omitted; process.env by default. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replace the real SDK clients (tests). */
  createClient?: ClientFactories['anthropic'];
  createGeminiClient?: ClientFactories['gemini'];
  createOpenAiClient?: ClientFactories['openai'];
  /** Lets a running provider follow config reloads; the given settings are used otherwise. */
  getSettings?: () => Settings;
  clock?: Clock;
  logger?: AppLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Options for the mock (tests inject failures or responders). */
  mock?: Omit<MockProviderOptions, 'clock'>;
}

/** The real SDK client: retries off (the app owns and meters them), timeout in milliseconds. */
export function createAnthropicClient(apiKey: string, timeoutMs: number, baseURL?: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs, ...(baseURL === undefined ? {} : { baseURL }) });
}

/**
 * The real Gemini client: the Gemini API (never Vertex AI, whatever GOOGLE_GENAI_USE_VERTEXAI says) at GEMINI_BASE_URL
 * or the .env BASE_URL (GOOGLE_GEMINI_BASE_URL cannot redirect the key), the key passed explicitly, SDK retries off
 * (attempts: 1; the app owns and meters them), timeout in milliseconds. `apiVersion` (e.g. v1beta) replaces the SDK's
 * default version in the URL. `fetchImpl` replaces the network (tests).
 */
export function createGeminiClient(apiKey: string, timeoutMs: number, fetchImpl?: Fetch, baseUrl: string = GEMINI_BASE_URL, apiVersion?: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: { baseUrl, timeout: timeoutMs, retryOptions: { attempts: 1 }, ...(apiVersion === undefined ? {} : { apiVersion }), ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) },
  });
}

/** Raises every request's output-token limit to AI_<STAGE>_MAX_TOKENS (a reasoning model spends the limit on thinking before it answers). */
class TokenFloorProvider implements AiProvider {
  readonly name: AiProvider['name'];
  readonly #inner: AiProvider;
  readonly #floor: number;

  constructor(inner: AiProvider, floor: number) {
    this.name = inner.name;
    this.#inner = inner;
    this.#floor = floor;
  }

  structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    return this.#inner.structured({ ...req, maxTokens: Math.max(req.maxTokens, this.#floor) });
  }
}

/** The CONFIG_INVALID for .env AI lines that must be fixed first; details.issues name the lines (cli prints them). */
export function aiConfigFailure(r: AiConfigResult, clock: Clock = systemClock): AppFailure {
  return new AppFailure(
    appError('CONFIG_INVALID', 'config', clock, {
      message: 'AIの設定（.env）に誤りがあります。直してからツールを起動し直してください。',
      retryable: false,
      details: { issues: r.issues.map((i) => ({ ...i })) },
    }),
  );
}

/**
 * A real AI must not run on settings.json and the environment alone while .env (where the owner may have chosen another
 * service for privacy) cannot be read: the photos could go to a service the owner did not choose.
 */
export function envUnreadableFailure(clock: Clock = systemClock): AppFailure {
  const message = '.env ファイルを読み取れませんでした（ほかのソフトで開いたままなどの可能性があります）。.env で選んだものと違うAIサービスに写真を送らないよう、AIを使いません。.env を閉じてから、ツールを起動し直してください。';
  return new AppFailure(appError('CONFIG_INVALID', 'config', clock, { message, retryable: false, details: { issues: [{ file: '.env', path: '', message }] } }));
}

/** Whether this run calls a real AI (otherwise the mock answers and .env AI problems are only warnings). */
export function usesRealAi(settings: Settings, mode: Mode, r: AiConfigResult): boolean {
  if (mode === 'dry_run' && !settings.ai.dry_run_use_real_ai) return false;
  return settings.ai.provider !== 'mock' || usesEnvStages(r);
}

const KEY_SOURCES = {
  gemini: 'Google AI Studio（https://aistudio.google.com/）でGoogleアカウントにログインしてAPIキーを作り',
  anthropic: 'Claude Console（https://console.anthropic.com/）でAPIキーを作り',
} as const;

const notChosen = (clock: Clock, mode: Mode, stage?: AiStage): AppFailure =>
  new AppFailure(
    appError('CONFIG_INCOMPLETE', 'ai', clock, {
      message:
        stage === undefined
          ? 'AIの提供元が未設定のため、AIを使えません。settings.json の ai.provider に "gemini"（または "anthropic"・"openai"）を指定してください（dry-run だけなら "mock" でも動きます）。'
          : `${AI_STAGE_JA[stage]}のAIが未設定のため使えません。.env の ${aiEnvKey(stage, 'PROVIDER')}= にサービス名（gemini・claude・openai・openai_compatible）を書いて、ツールを起動し直してください。`,
      retryable: false,
      details: stage === undefined ? { mode } : { mode, ai_stage: stage },
    }),
  );

/**
 * Picks the AI provider (Plan 2 decisions 1-2, rulings P2-R13, P2-R17): the mock in dry-run unless
 * ai.dry_run_use_real_ai is true. With .env AI_<STAGE>_* values or ai.provider "openai", a StagedAiProvider with one
 * adapter per stage (registry.ts); otherwise settings.json ai.provider as before ("mock", Gemini or Anthropic). .env problems are
 * CONFIG_INVALID, an unset provider is never guessed (CONFIG_INCOMPLETE), a missing key is AI_AUTH_ERROR telling where
 * to get one. Keys are only handed to the SDK clients, never logged or stored.
 */
export function createAiProvider(settings: Settings, mode: Mode, deps: AiFactoryDeps): AiProvider {
  const { ai } = settings;
  const clock = deps.clock ?? systemClock;
  const mock = (): AiProvider => new MockAiProvider({ ...deps.mock, clock });
  if (mode === 'dry_run' && !ai.dry_run_use_real_ai) return mock();
  const config = deps.aiConfig ?? resolveAiConfig(ai, envSource(null, deps.env ?? process.env));
  if (config.issues.length > 0) throw aiConfigFailure(config, clock);
  const clients: ClientFactories = {
    anthropic: deps.createClient ?? ((o) => createAnthropicClient(o.apiKey, o.timeoutMs, o.baseURL)),
    gemini: deps.createGeminiClient ?? ((o) => createGeminiClient(o.apiKey, o.timeoutMs, undefined, o.baseUrl, o.apiVersion)),
    openai: deps.createOpenAiClient ?? createOpenAiClient,
  };
  const common = {
    getSettings: deps.getSettings ?? (() => settings),
    meter: deps.meter,
    clock,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  };

  if (usesEnvStages(config) || ai.provider === 'openai') {
    let shared: AiProvider | undefined;
    const unset = (stage: AiStage): AiProvider => ({ name: 'staged', structured: () => Promise.reject(notChosen(clock, mode, stage)) });
    const stages = Object.fromEntries(
      AI_STAGES.map((stage) => {
        const cfg = config.stages[stage];
        if (cfg.service === 'mock') return [stage, (shared ??= mock())];
        if (cfg.service === null) return [stage, unset(stage)];
        const provider = createStageProvider(cfg, { ...common, clients });
        // Claude has no per-call floor of its own; Gemini reads it from the settings overlay and OpenAI in its provider.
        return [stage, cfg.service === 'claude' && cfg.maxTokens !== null ? new TokenFloorProvider(provider, cfg.maxTokens) : provider];
      }),
    ) as Record<AiStage, AiProvider>;
    return new StagedAiProvider(stages);
  }

  if (ai.provider === 'mock') return mock();
  if (ai.provider === null) throw notChosen(clock, mode);
  const provider = ai.provider;
  const keyEnv = ai[provider].api_key_env;
  const apiKey = config.stages.generation.apiKey;
  if (apiKey === null) {
    const free = provider === 'gemini' && ai.gemini.free_tier ? '無料枠ならクレジットカードの登録は要りません。' : '';
    throw new AppFailure(
      appError('AI_AUTH_ERROR', 'ai', clock, {
        message: `AIのAPIキーが見つかりません。${KEY_SOURCES[provider]}、このツールのフォルダにある .env ファイル（無ければ .env.example をコピーして .env という名前にします）に「${keyEnv}=」に続けて書いて保存してください。動いているツールには、起動し直すと反映されます（${free}キーは画面やログには表示しません）。`,
        retryable: false,
        details: { provider, api_key_env: keyEnv },
      }),
    );
  }
  const timeoutMs = ai.timeout_seconds * 1000;
  if (provider === 'gemini') return new GeminiProvider({ client: clients.gemini({ apiKey, timeoutMs, ...(ai.gemini.api_version === null ? {} : { apiVersion: ai.gemini.api_version }) }), ...common });
  return new AnthropicProvider({ client: clients.anthropic({ apiKey, timeoutMs }), ...common });
}
