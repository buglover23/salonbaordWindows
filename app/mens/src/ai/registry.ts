import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import type { AiStage } from '../shared/types.js';
import { aiEnvKey, stageSettings, type StageAiConfig } from './ai-config.js';
import { AI_SERVICE_INFO, type AiService, type JsonMode } from './ai-services.js';
import { AnthropicProvider, type AnthropicClientLike } from './anthropic-provider.js';
import { GeminiProvider, type GeminiClientLike, type GeminiMeter } from './gemini-provider.js';
import { OpenAiProvider, type OpenAiClientLike } from './openai-provider.js';
import type { AiProvider, AiRequest, AiResult } from './provider.js';
import { providerPricing, type PriceList, type UsageMeter } from './usage-meter.js';

// Provider id → what it can do and how its adapter is built for one .env stage (ruling P2-R17). A new
// OpenAI-compatible service needs only .env; a new kind of API needs one adapter file and one entry here.

export interface ServiceCapabilities {
  /** Reads images (required for the analysis stage; resolveAiConfig refuses a stage that cannot). */
  images: boolean;
  /** How the answer is constrained. */
  structured: JsonMode;
}

/** The SDK clients, replaceable in tests. The key is only ever handed to these. */
export interface ClientFactories {
  anthropic(o: { apiKey: string; timeoutMs: number; baseURL?: string }): AnthropicClientLike;
  gemini(o: { apiKey: string; timeoutMs: number; baseUrl?: string; apiVersion?: string }): GeminiClientLike;
  openai(o: { apiKey: string | null; timeoutMs: number; baseURL: string | null }): OpenAiClientLike;
}

/** Everything any adapter asks of the usage meter. */
export type StageMeter = GeminiMeter & Pick<UsageMeter, 'recordPriced'>;

export interface AdapterContext {
  /** settings.json as currently loaded; each adapter lays its stage's .env values over it on every call. */
  getSettings: () => Settings;
  meter: StageMeter;
  clients: ClientFactories;
  clock: Clock;
  logger?: AppLogger | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

interface AdapterEntry {
  capabilities(cfg: StageAiConfig): ServiceCapabilities;
  create(cfg: StageAiConfig, ctx: AdapterContext): AiProvider;
}

/** Calls go to one provider per stage; each keeps its own retries, metering and (Gemini) pacing. */
export class StagedAiProvider implements AiProvider {
  readonly name = 'staged';
  readonly stages: Readonly<Record<AiStage, AiProvider>>;

  constructor(stages: Readonly<Record<AiStage, AiProvider>>) {
    this.stages = stages;
  }

  structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    return this.stages[req.stage].structured(req);
  }
}

/**
 * Adds where the stage's model was set to the Gemini and Claude messages that point at settings.json (a model or
 * setting the service refused), since for a .env stage the model comes from .env.
 */
class EnvStageProvider implements AiProvider {
  readonly name: AiProvider['name'];
  readonly #inner: AiProvider;
  readonly #note: string;

  constructor(inner: AiProvider, note: string) {
    this.name = inner.name;
    this.#inner = inner;
    this.#note = note;
  }

  async structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    try {
      return await this.#inner.structured(req);
    } catch (err) {
      const e = err instanceof AppFailure ? err.error : null;
      if (e !== null && (e.code === 'CONFIG_INCOMPLETE' || (e.code === 'AI_OUTPUT_INVALID' && !e.retryable))) {
        throw new AppFailure({ ...e, message: `${e.message}${this.#note}` });
      }
      throw err;
    }
  }
}

function envNote(cfg: StageAiConfig): string {
  const model = cfg.origins.MODEL;
  if (model === undefined) return `（この段階のサービスは .env の ${cfg.origins.PROVIDER?.key ?? aiEnvKey(cfg.stage, 'PROVIDER')} で指定しています）`;
  return `（この段階のモデルは .env の ${model.key}${model.line === null ? '（環境変数）' : `（${model.line}行目）`} で指定しています）`;
}

const withEnvNote = (p: AiProvider, cfg: StageAiConfig): AiProvider => (cfg.source === 'env' ? new EnvStageProvider(p, envNote(cfg)) : p);

/** The meter for a Gemini or Claude .env stage: priced with the stage's own list (its tier and .env price), whatever settings.json says. */
function pricedMeter(meter: StageMeter, pricing: () => PriceList | null): StageMeter {
  return {
    assertCanCall: (now) => meter.assertCanCall(now),
    record: (now, model, usage, extra) => meter.recordPriced(now, model, usage, extra, pricing()),
    recordPriced: (now, model, usage, extra, list, fee) => meter.recordPriced(now, model, usage, extra, list, fee),
    reserveRequest: (model, limit, now, freeTier) => meter.reserveRequest(model, limit, now, freeTier),
    recordRateLimit: (model, now, info) => meter.recordRateLimit(model, now, info),
    recordUnavailable: (model, now, freeTier) => meter.recordUnavailable(model, now, freeTier),
    clearRateLimit: (model, now) => meter.clearRateLimit(model, now),
  };
}

/** resolveAiConfig refuses a stage without a key, so this is only a guard. */
function keyOf(cfg: StageAiConfig, clock: Clock): string {
  if (cfg.apiKey !== null) return cfg.apiKey;
  throw new AppFailure(
    appError('AI_AUTH_ERROR', 'ai', clock, {
      message: `AIのAPIキーが見つかりません。.env の ${cfg.keyName ?? aiEnvKey(cfg.stage, 'API_KEY')} に書いて保存してください（.env が無ければ .env.example をコピーして .env という名前にします）。動いているツールには、起動し直すと反映されます（キーは画面やログには表示しません）。`,
      retryable: false,
      details: { ai_stage: cfg.stage, api_key_env: cfg.keyName },
    }),
  );
}

const optional = <K extends string>(key: K, value: string | null): Partial<Record<K, string>> => (value === null ? {} : ({ [key]: value } as Record<K, string>));

function common(ctx: AdapterContext, getSettings: () => Settings) {
  return {
    getSettings,
    clock: ctx.clock,
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
    ...(ctx.random === undefined ? {} : { random: ctx.random }),
  };
}

const openAiEntry: AdapterEntry = {
  capabilities: (cfg) => ({ images: AI_SERVICE_INFO[cfg.service as AiService].images, structured: cfg.jsonMode }),
  create: (cfg, ctx) =>
    new OpenAiProvider({
      // OpenAI from settings.json alone (no AI_<STAGE>_* line) is not checked for a key by resolveAiConfig; a local server needs none.
      client: ctx.clients.openai({ apiKey: cfg.service === 'openai' ? keyOf(cfg, ctx.clock) : cfg.apiKey, baseURL: cfg.baseURL, timeoutMs: ctx.getSettings().ai.timeout_seconds * 1000 }),
      config: cfg,
      meter: ctx.meter,
      ...common(ctx, ctx.getSettings),
    }),
};

export const AI_ADAPTERS: Readonly<Record<AiService, AdapterEntry>> = {
  gemini: {
    capabilities: () => ({ images: AI_SERVICE_INFO.gemini.images, structured: 'json_schema' }),
    create: (cfg, ctx) => {
      const getSettings = (): Settings => stageSettings(ctx.getSettings(), cfg);
      const client = ctx.clients.gemini({ apiKey: keyOf(cfg, ctx.clock), timeoutMs: getSettings().ai.timeout_seconds * 1000, ...optional('baseUrl', cfg.baseURL), ...optional('apiVersion', cfg.apiVersion) });
      const meter = pricedMeter(ctx.meter, () => providerPricing(getSettings().ai, 'gemini'));
      return withEnvNote(new GeminiProvider({ client, meter, ...common(ctx, getSettings) }), cfg);
    },
  },
  claude: {
    capabilities: () => ({ images: AI_SERVICE_INFO.claude.images, structured: 'json_schema' }),
    create: (cfg, ctx) => {
      const getSettings = (): Settings => stageSettings(ctx.getSettings(), cfg);
      const client = ctx.clients.anthropic({ apiKey: keyOf(cfg, ctx.clock), timeoutMs: getSettings().ai.timeout_seconds * 1000, ...optional('baseURL', cfg.baseURL) });
      const meter = pricedMeter(ctx.meter, () => providerPricing(getSettings().ai, 'anthropic'));
      return withEnvNote(new AnthropicProvider({ client, meter, ...common(ctx, getSettings) }), cfg);
    },
  },
  openai: openAiEntry,
  openai_compatible: openAiEntry,
};

/** The provider for one stage (already validated by resolveAiConfig). */
export function createStageProvider(cfg: StageAiConfig, ctx: AdapterContext): AiProvider {
  if (cfg.service === null || cfg.service === 'mock') throw new Error(`stage ${cfg.stage} has no service to build`);
  return AI_ADAPTERS[cfg.service].create(cfg, ctx);
}
