import type { EnvSource } from '../config/env-file.js';
import type { ConfigSnapshot } from '../config/loader.js';
import type { Settings } from '../config/schemas.js';
import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure, type AppError, type ErrorCode } from '../shared/errors.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import { AI_STAGES, type Mode } from '../shared/types.js';
import { aiEnvKey, resolveAiConfig, usesEnvStages, type AiConfigResult } from './ai-config.js';
import { AI_SERVICE_INFO } from './ai-services.js';
import { createAiProvider, envUnreadableFailure, usesRealAi, type AiFactoryDeps } from './factory.js';
import type { GeminiMeter } from './gemini-provider.js';
import { MockAiProvider, type MockProviderOptions } from './mock-provider.js';
import { registerDefaultMockResponders } from './mock-responders.js';
import type { AiProvider } from './provider.js';
import { StagedAiProvider } from './registry.js';
import type { UsageMeter } from './usage-meter.js';

// The AI side of the runtime (Plan 2 decisions 1-3, ruling P2-R13): which provider is used, and whether AI work is
// stopped. A stop (budget, daily quota, key, AI settings, a model the API does not know) applies to every job and lasts
// until its cause is gone, by error.code and details (Task 10 integration table): the budget is read from the usage meter
// on every check; a daily quota stop until its resume_at or a change of settings.ai; settings the provider refused
// locally until settings.ai changes; settings the API refused until that provider's block changes; a key or billing
// problem, or a damaged usage file, until a restart (or a switch of provider).

/** 'staged': .env AI_<STAGE>_* values choose a service per stage (ruling P2-R17). */
export type AiProviderKind = AiProvider['name'];

export interface AiStopState {
  code: ErrorCode;
  /** Japanese: why AI work is stopped and what clears it. */
  message: string;
  /** When the stop began (ISO). */
  since: string;
}

/** What a failed AI call means for the job: stop all AI work, wait and try again later, or fail the job. */
export type AiFailureKind = 'stop' | 'wait' | 'fail';

export interface AiServiceDeps {
  getSettings: () => Settings;
  /** The mode the process runs in. */
  mode: Mode;
  meter: GeminiMeter & Pick<UsageMeter, 'summary' | 'recordPriced'>;
  /** .env over the environment, read once at startup (loadAiSetup): the stages and keys are resolved from it. */
  env: EnvSource;
  /** .env could not be read at startup: a real AI is refused (envUnreadableFailure) until a restart reads it. */
  envUnreadable?: boolean;
  /** For the mock's realistic dry-run answers (follows config reloads). */
  getSnapshot: () => ConfigSnapshot;
  clock: Clock;
  logger: AppLogger;
  createClient?: AiFactoryDeps['createClient'];
  sleep?: AiFactoryDeps['sleep'];
  random?: AiFactoryDeps['random'];
  /** Options for the mock (tests inject failures or responders). */
  mock?: Omit<MockProviderOptions, 'clock'>;
  /** Told whenever the stop changes (the runtime records it in runtime-status.json for the read-only status). */
  onStopChange?: (stop: AiStopState | null) => void;
}

const TRANSIENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['AI_TIMEOUT', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE']);
/** Budget refusals the meter works out again on every check (summary().blocked), so they end by themselves. */
const METER_REASONS: ReadonlySet<unknown> = new Set(['monthly_usd', 'daily_usd', 'daily_requests']);
/** Daily quota stops of the Gemini free tier: until details.resume_at, or a change of settings.ai (rpd, tier). */
const QUOTA_REASONS: ReadonlySet<unknown> = new Set(['daily_limit', 'server_daily']);
/** The same failure this many times in a row (no success between) stops AI work: the API or its answers have changed. */
export const BREAKER_LIMIT = 3;
/** Refusals of one photo or text: they say nothing about the API, so the breaker never counts them. */
const CONTENT_REASONS: ReadonlySet<unknown> = new Set(['blocked', 'safety']);

/** The environment variable holding the real provider's API key, or null for the mock / no provider. */
export function apiKeyEnvOf(settings: Settings): string | null {
  const p = settings.ai.provider;
  return p === 'anthropic' || p === 'gemini' ? settings.ai[p].api_key_env : null;
}

/**
 * The provider the settings choose in `mode` (Plan 2 decision 2: dry-run uses the mock unless dry_run_use_real_ai);
 * 'staged' when .env AI_<STAGE>_* values apply (`stages`, ruling P2-R17).
 */
export function providerKindFor(settings: Settings, mode: Mode, stages?: AiConfigResult): AiProviderKind | null {
  const { ai } = settings;
  if (mode === 'dry_run' && !ai.dry_run_use_real_ai) return 'mock';
  if (stages !== undefined && usesEnvStages(stages)) return 'staged';
  return ai.provider;
}

/** For settings.json's single real provider: whether its key is set (never the value) and its variable; null otherwise. */
export function keyStateOf(kind: AiProviderKind | null, stages: AiConfigResult): { keySet: boolean | null; keyEnv: string | null } {
  if (kind !== 'anthropic' && kind !== 'gemini') return { keySet: null, keyEnv: null };
  const s = stages.stages.generation;
  return { keySet: s.apiKey !== null, keyEnv: s.keyName };
}

function readyMessage(provider: AiProvider, settings: Settings, stages: AiConfigResult): string {
  if (provider.name === 'mock') return 'AIは模擬（mock）を使います。費用はかからず、外部には何も送りません。';
  if (provider.name === 'gemini') {
    return `AIは Google Gemini（${settings.ai.gemini.free_tier ? '無料枠' : '有料'}）を使います（モデル: ${settings.ai.gemini.models.analysis ?? '未設定'}）。写真（縮小・情報削除済み）と文章の材料を Google に送ります。`;
  }
  if (provider.name === 'anthropic') {
    return `AIは Anthropic（Claude）を使います（モデル: ${settings.ai.anthropic.models.analysis ?? '未設定'}）。写真（縮小・情報削除済み）と文章の材料を Anthropic に送ります。`;
  }
  const parts = AI_STAGES.map((stage) => {
    const s = stages.stages[stage];
    const service = s.service === null ? '未設定' : s.service === 'mock' ? '模擬（mock）' : AI_SERVICE_INFO[s.service].label;
    return `${AI_STAGE_JA[stage]}: ${service}${s.model === null ? '' : `（${s.model}）`}`;
  });
  const from = AI_STAGES.some((stage) => stages.stages[stage].source === 'env') ? '（.env）' : '';
  return `AIは段階ごとの設定${from}を使います（${parts.join('、')}）。写真（縮小・情報削除済み）と文章の材料をそれぞれのサービスに送ります。`;
}

// OpenAI stages take their models when built (efforts and prices are read on every call).
const providerKey = (s: Settings, mode: Mode): string => JSON.stringify([mode, s.ai.provider, apiKeyEnvOf(s), s.ai.dry_run_use_real_ai, s.ai.timeout_seconds, s.ai.openai.models]);
/** What clears a sticky stop when it changes (a key, billing or damaged-file stop needs a restart, or a switch of provider). */
type ClearOn = 'ai' | 'provider_block' | 'restart';
function clearKey(s: Settings, on: ClearOn): string {
  const p = s.ai.provider;
  if (on === 'ai') return JSON.stringify(s.ai);
  if (on === 'provider_block') return JSON.stringify([p, p === null || p === 'mock' ? null : s.ai[p]]);
  return JSON.stringify([p, apiKeyEnvOf(s)]);
}

export class AiService {
  readonly #d: AiServiceDeps;
  #provider: AiProvider | null = null;
  #providerKey: string | null = null;
  /** Why the provider could not be created (null when it was). */
  #unavailable: AppError | null = null;
  /** A stop raised by a call; cleared when settings.ai changes (or `until` passes). */
  #sticky: { error: AppError; clearOn: ClearOn; key: string; until: number | null; since: string } | null = null;
  #last: AiStopState | null = null;
  /** The breaker, per pipeline step: the signature of the failures in a row since the step last succeeded, and how many. */
  readonly #streaks = new Map<string, { sig: string; count: number }>();

  constructor(d: AiServiceDeps) {
    this.#d = d;
  }

  /** The provider for the current settings, created again when its settings change; null when it cannot be created. */
  provider(): AiProvider | null {
    const settings = this.#d.getSettings();
    const key = providerKey(settings, this.#d.mode);
    if (key === this.#providerKey) return this.#provider;
    this.#providerKey = key;
    this.#provider = null;
    this.#unavailable = null;
    const { clock, logger } = this.#d;
    try {
      const stages = resolveAiConfig(settings.ai, this.#d.env);
      if (this.#d.envUnreadable === true && usesRealAi(settings, this.#d.mode, stages)) throw envUnreadableFailure(clock);
      const provider = createAiProvider(settings, this.#d.mode, {
        meter: this.#d.meter,
        aiConfig: stages,
        getSettings: this.#d.getSettings,
        clock,
        logger,
        ...(this.#d.createClient === undefined ? {} : { createClient: this.#d.createClient }),
        ...(this.#d.sleep === undefined ? {} : { sleep: this.#d.sleep }),
        ...(this.#d.random === undefined ? {} : { random: this.#d.random }),
        ...(this.#d.mock === undefined ? {} : { mock: this.#d.mock }),
      });
      const parts = provider instanceof StagedAiProvider ? Object.values(provider.stages) : [provider];
      for (const mock of new Set(parts.filter((p) => p instanceof MockAiProvider))) registerDefaultMockResponders(mock, this.#d.getSnapshot);
      this.#provider = provider;
      logger.info('AI_PROVIDER_READY', readyMessage(provider, settings, stages), { provider: provider.name });
    } catch (err) {
      if (!(err instanceof AppFailure)) throw err;
      this.#unavailable = err.error;
      logger.error('AI_PROVIDER_UNAVAILABLE', `AIを使えないため、投稿の準備を止めています: ${err.error.message}`, { error_code: err.error.code });
    }
    return this.#provider;
  }

  /** The kind of the provider in use (null while none can be created). */
  get kind(): AiProviderKind | null {
    return this.provider()?.name ?? null;
  }

  /** Why AI work is stopped now, or null. Reads the budget from the meter when the real provider is in use. */
  async stop(now: Date): Promise<AiStopState | null> {
    const provider = this.provider();
    let stop: AiStopState | null = null;
    if (provider === null && this.#unavailable !== null) {
      stop = { code: this.#unavailable.code, message: this.#unavailable.message, since: this.#last?.since ?? now.toISOString() };
    }
    if (stop === null && this.#sticky !== null) {
      const s = this.#sticky;
      if (s.key === clearKey(this.#d.getSettings(), s.clearOn) && (s.until === null || now.getTime() < s.until)) stop = { code: s.error.code, message: s.error.message, since: s.since };
      else this.#sticky = null;
    }
    if (stop === null && provider !== null && provider.name !== 'mock') {
      const blocked = (await this.#d.meter.summary(now)).blocked;
      if (blocked !== null) stop = { code: 'AI_BUDGET_EXCEEDED', message: blocked.message, since: this.#last?.code === 'AI_BUDGET_EXCEEDED' ? this.#last.since : now.toISOString() };
    }
    this.#setLast(stop);
    return stop === null ? null : { ...stop };
  }

  #setLast(stop: AiStopState | null): void {
    const changed = (stop?.code ?? null) !== (this.#last?.code ?? null) || (stop?.message ?? null) !== (this.#last?.message ?? null);
    this.#last = stop;
    if (changed) this.#d.onStopChange?.(stop === null ? null : { ...stop });
  }

  /** The stop the last check found (for status). */
  get lastStop(): AiStopState | null {
    return this.#last === null ? null : { ...this.#last };
  }

  /**
   * Classifies a failed AI call by error.code and details (never the message) and remembers a stop. Stops (the job is held,
   * not failed): AI_BUDGET_EXCEEDED (meter budget: re-read on every check; daily quota: until resume_at or a change of
   * settings.ai; billing 402: until a restart), AI_AUTH_ERROR (restart), the provider's CONFIG_INCOMPLETE (stage 'ai':
   * refused locally → until settings.ai changes; refused by the API, details.status → until that provider's block
   * changes) and a damaged usage file (STATE_CORRUPT, restart). AI_TIMEOUT / AI_RATE_LIMIT / AI_UNAVAILABLE are waits
   * (the pipeline reschedules at details.resume_at); anything else fails the job, until the same provider failure comes
   * BREAKER_LIMIT times in a row in the same `step` (pipeline step): that stops until settings.ai changes (#breaker).
   */
  noteFailure(error: AppError, now: Date, step = ''): AiFailureKind {
    if (TRANSIENT.has(error.code)) return 'wait';
    const d = error.details_redacted;
    let clearOn: ClearOn | null = null;
    let until: number | null = null;
    if (error.code === 'AI_BUDGET_EXCEEDED') {
      if (QUOTA_REASONS.has(d.reason)) {
        clearOn = 'ai';
        const at = typeof d.resume_at === 'string' ? Date.parse(d.resume_at) : Number.NaN;
        until = Number.isNaN(at) ? null : at;
      } else if (!METER_REASONS.has(d.reason)) clearOn = 'restart';
    } else if (error.code === 'AI_AUTH_ERROR' || error.code === 'STATE_CORRUPT') clearOn = 'restart';
    else if (error.code === 'CONFIG_INCOMPLETE' && error.stage === 'ai') {
      // models_exhausted: the API refused every configured model (with or without an HTTP status).
      clearOn = typeof d.status === 'number' || d.reason === 'models_exhausted' ? 'provider_block' : 'ai';
    } else {
      const tripped = this.#breaker(error, step);
      if (tripped === null) return 'fail';
      error = tripped;
      clearOn = 'ai';
    }
    if (clearOn !== null) {
      this.#sticky = { error, clearOn, key: clearKey(this.#d.getSettings(), clearOn), until, since: now.toISOString() };
    }
    this.#setLast({ code: error.code, message: error.message, since: now.toISOString() });
    this.#d.logger.error('AI_STOPPED', `AIの処理を止めました: ${error.message}`, { error_code: error.code });
    return 'stop';
  }

  /**
   * A pipeline step succeeded: its breaker starts counting again. Per step, so the analysis that succeeds for every job
   * does not hide a generation that fails for every job.
   */
  noteSuccess(step = ''): void {
    this.#streaks.delete(step);
  }

  /**
   * Counts a provider failure (stage 'ai') by its signature, code/details.reason (or code/details.status); a refusal of
   * one photo or text is not counted. Returns the stop error once BREAKER_LIMIT came in a row, otherwise null.
   */
  #breaker(error: AppError, step: string): AppError | null {
    const d = error.details_redacted;
    if (error.stage !== 'ai' || CONTENT_REASONS.has(d.reason)) return null;
    // Not retryable and no HTTP status: the API answered but refused this content (e.g. a FINAL finish reason).
    if (error.code === 'AI_OUTPUT_INVALID' && !error.retryable && typeof d.status !== 'number') return null;
    const sig = `${error.code}/${typeof d.reason === 'string' ? d.reason : typeof d.status === 'number' ? d.status : '-'}`;
    const last = this.#streaks.get(step);
    const count = last?.sig === sig ? last.count + 1 : 1;
    if (count < BREAKER_LIMIT) {
      this.#streaks.set(step, { sig, count });
      return null;
    }
    this.#streaks.delete(step);
    const stage = AI_STAGES.find((s) => s === d.ai_stage);
    const env = stage === undefined ? 'AI_<段階>_PROVIDER' : aiEnvKey(stage, 'PROVIDER');
    const api = d.provider === 'gemini' ? 'Gemini' : 'AIサービス';
    return {
      ...error,
      message: `AIの処理が同じ理由（${sig}）で${BREAKER_LIMIT}回続けて失敗したため、止めました。${api}のAPIや応答の形式が変わった可能性があります。npm.cmd run ai:test で確かめ、settings.json のモデル名を変えるか、.env の ${env} で別のAIサービスに切り替えてください。（最後の失敗: ${error.message}）`,
    };
  }
}
