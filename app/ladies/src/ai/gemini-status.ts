import { usedAiModels } from '../config/readiness.js';
import type { Settings } from '../config/schemas.js';
import { effectiveGeminiAi, type AiConfigResult } from './ai-config.js';
import { jstDateKey, jstMinutesOfDay } from '../shared/time.js';
import { dailyCap, type DailyStopReason, type RestReason } from './request-quota.js';
import type { QuotaSummary } from './usage-meter.js';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A JST time for an operator message: "16:00" on the same JST day as `now`, otherwise "10月6日 16:00". */
export function jstResumeText(at: Date, now: Date): string {
  const minutes = jstMinutesOfDay(at);
  const time = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
  const day = jstDateKey(at);
  if (day === jstDateKey(now)) return time;
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  return `${month}月${date}日 ${time}`;
}

const dailyLimitName = (freeTier: boolean): string => (freeTier ? 'Geminiの無料枠の1日の上限' : 'Geminiの1日の利用上限');

/** The message of a model stopped until the quota day resets (also the status line). */
export function dailyStopMessage(o: {
  model: string;
  reason: DailyStopReason;
  until: Date;
  now: Date;
  freeTier: boolean;
  requests?: number | undefined;
  cap?: number | null | undefined;
}): string {
  const head = `${dailyLimitName(o.freeTier)}に達したため、日本時間 ${jstResumeText(o.until, o.now)} 以降に再開します`;
  if (o.reason === 'server_daily') return `${head}（${o.model}: Googleからの応答による）。`;
  const counts = o.requests === undefined || o.cap === undefined || o.cap === null ? '' : `: 本日${o.requests}回、上限${o.cap}回`;
  return `${head}（${o.model}${counts}。settings.json の ai.gemini.limits）。`;
}

const WAIT_REASONS: Record<'per_minute' | RestReason, string> = {
  per_minute: 'の1分あたりの回数の上限のため',
  rate_limited: 'の利用回数の制限（Googleからの応答）のため',
  unavailable: 'から応答が得られない状態が続いたため',
};

/** The message of a model resting after rate-limit answers or calls left without an answer, or until its per-minute window has room. */
export function waitMessage(model: string, reason: 'per_minute' | RestReason, until: Date, now: Date): string {
  return `Gemini（${model}）${WAIT_REASONS[reason]}、日本時間 ${jstResumeText(until, now)} 以降に再開します。`;
}

/**
 * Japanese status lines for the Gemini request limits of the models in use (empty unless a stage uses Gemini): a stop
 * or rest with its JST end, otherwise today's count against the cap and the next reset; plus a note per model whose
 * limits were never checked in Google AI Studio (verified_at null). Like the provider, it judges the day's cap by the
 * current limits and ignores stops recorded on the other tier.
 */
export function geminiQuotaStatusLines(settingsAi: Settings['ai'], summary: QuotaSummary, now: Date, stages?: AiConfigResult): string[] {
  // With .env stages (ruling P2-R17): the Gemini models, tier and limits those stages use.
  const ai = stages === undefined ? settingsAi : effectiveGeminiAi(settingsAi, stages);
  if (ai === null || ai.provider !== 'gemini') return [];
  const g = ai.gemini;
  const lines: string[] = [];
  for (const model of usedAiModels(ai, 'gemini')) {
    const state = summary.models.find((m) => m.model === model) ?? { requests: 0, stop: null };
    const limit = Object.hasOwn(g.limits, model) ? g.limits[model] : undefined;
    const cap = limit === undefined ? null : dailyCap(limit.rpd);
    const stop = state.stop !== null && state.stop.freeTier === g.free_tier ? state.stop : null;
    if (stop?.reason === 'server_daily') {
      lines.push(dailyStopMessage({ model, reason: 'server_daily', until: stop.until, now, freeTier: g.free_tier }));
    } else if (cap !== null && state.requests >= cap) {
      lines.push(dailyStopMessage({ model, reason: 'daily_limit', until: summary.reset_at, now, freeTier: g.free_tier, requests: state.requests, cap }));
    } else if (stop !== null) {
      lines.push(waitMessage(model, stop.reason as RestReason, stop.until, now));
    } else {
      const counts = cap === null ? `本日${state.requests}回` : `本日${state.requests}回／上限${cap}回（1分${limit?.rpm}回まで）`;
      lines.push(`Gemini（${model}）: ${counts}。日本時間 ${jstResumeText(summary.reset_at, now)} に数え直します。`);
    }
    if (limit !== undefined && limit.verified_at === null) {
      lines.push(
        `Gemini（${model}）の上限（1分${limit.rpm}回・1日${limit.rpd}回）は仮の値です。Google AI Studio で確かめて settings.json の ai.gemini.limits を直し、verified_at に確認した日を書いてください。`,
      );
    }
  }
  return lines;
}
