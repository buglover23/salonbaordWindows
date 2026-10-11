import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AnalysisSchema } from '../ai/analysis-schema.js';
import { handledAudiences } from '../config/schemas.js';
import { ERROR_CODES, errorCodeOf, errorText, type ErrorCode } from '../shared/errors.js';
import { INTAKE_STAGE, type Job } from '../shared/job-schema.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../shared/labels.js';
import type { PostType } from '../shared/types.js';
import { unlinkWithRetry } from '../storage/atomic-json.js';
import { bundleRelDir } from '../storage/bundles.js';
import { ApiError } from '../server/errors.js';
import { JOB_STATUS_JA } from '../status.js';
import type { OpsDeps } from './reconcile.js';
import { ABANDON_CAP_PER_DAY } from './timing.js';
import { assertTransition } from './transitions.js';

// `npm.cmd run retry` (spec 15.3, plan Task 2c, P3-R19): one command for content and posting failures. A content failure
// starts again from the image analysis or the text generation (Plan 2); a posting failure that never reached SALON BOARD
// goes back to READY. The bundle moves images/failed → images/processing; attempts are kept. A job that may have been
// sent (VERIFY_REQUIRED) or that is held by a stop (BLOCKED) is never retried here.

export type Restart = 'analysis' | 'generation' | 'posting';
export type RetryDeps = Pick<OpsDeps, 'clock' | 'logger' | 'paths' | 'store' | 'bundles' | 'config'> & {
  /** Online: the processor takes a job back in GENERATING at once. */
  notifyRegeneration?: (id: string) => void;
  /** Offline: why AI work cannot run now (a content retry would only wait); null when it can. */
  contentBlocked?: () => Promise<string | null>;
};

/** Argument-less retry re-queues only these posting failures (never with a budget reset). */
const AUTO_CODES: ReadonlySet<string> = new Set(['UPLOAD_TIMEOUT', 'UPLOAD_FAILED', 'NETWORK_ERROR', 'PAGE_TIMEOUT', 'SUBMIT_FAILED']);
const DUPLICATE: ReadonlySet<string> = new Set(['DUPLICATE_IMAGE', 'ALREADY_POSTED']);
const REGENERATE: ReadonlySet<string> = new Set(['VALIDATION_FAILED', 'DUPLICATE_CONTENT']);

export const RETRY_EXCLUDED_JA = {
  exhausted: '上限到達：個別に --id で再開',
  verify_required: '結果不明：先に reconcile',
  posted: '投稿済み',
  blocked: '停止中：原因を直して resume',
  content: '文章の再生成が必要：--id で個別に',
  duplicate: '同じ画像が投稿済み',
  conflict: '二重登録の可能性：画面を確認',
  other: '原因を確認して --id で個別に',
} as const;

const asCode = (c: string | null | undefined, fallback: ErrorCode): ErrorCode => ((ERROR_CODES as readonly string[]).includes(c ?? '') ? (c as ErrorCode) : fallback);

/** Where a FAILED job starts again: a posting failure → READY; otherwise the analysis (when it cannot be reused) or the text. */
function restartOf(job: Job): Restart {
  const code = job.last_error?.code ?? '';
  if ((job.last_error?.stage === 'posting' || job.last_error?.stage === 'reconcile') && !REGENERATE.has(code)) return 'posting';
  const reanalyze = job.stage === INTAKE_STAGE || job.stage === 'analyze' || code === 'IMAGE_ANALYSIS_UNCERTAIN' || !AnalysisSchema.safeParse(job.analysis).success;
  return reanalyze ? 'analysis' : 'generation';
}

function exhausted(job: Job, maxRetries: number): boolean {
  const code = job.last_error?.code;
  return code === 'RETRY_EXHAUSTED' || job.retry_count >= maxRetries || (code === 'EXTENSION_DISCONNECTED' && (job.pre_intent_abandons?.count ?? 0) >= ABANDON_CAP_PER_DAY);
}

/** Why `job` cannot be retried (Japanese), or null. */
function refusal(d: RetryDeps, job: Job): string | null {
  const id = job.id;
  if (job.status !== 'FAILED') {
    const hint =
      job.status === 'VERIFY_REQUIRED'
        ? `結果不明の投稿は、自動では送り直しません。先に npm.cmd run reconcile -- --id ${id} で照合してください。`
        : job.status === 'BLOCKED'
          ? '停止の原因を直してから npm.cmd run resume を実行してください。'
          : '';
    return `${id} は失敗（FAILED）ではありません（現在: ${JOB_STATUS_JA[job.status]}）。失敗した job だけを再開できます。${hint}`;
  }
  if (job.operation !== null) return `${id} は画像の移動が途中のままです。ツールを一度起動して復旧させてから、もう一度実行してください。`;
  if (job.submission_state !== 'not_started' && job.submission_state !== 'definitely_not_submitted') {
    return `${id} は SALON BOARD に送信された可能性があるため、retry では再開しません（二重投稿を防ぐため）。`;
  }
  if (job.retry_blocked_reason !== null) return `${id} は同じ投稿が2回登録された可能性があるため再開しません。SALON BOARD の画面を確認してください。`;
  if (DUPLICATE.has(job.last_error?.code ?? '')) return `${id} は同じ画像がすでに投稿されているため再開しません。`;
  if (job.last_error?.code === 'IMAGE_INVALID' || job.image.width === null) {
    return `${id} の画像は読み取れなかったため、再開しても準備できません。JPEG または PNG で保存し直した画像を pending の同じ種類のフォルダへ入れてください（新しい投稿として取り込まれます）。`;
  }
  const image = join(d.paths.modeRoot, ...job.image.relative_path.split('/'));
  if (!existsSync(image)) return `${id} の画像が見つかりません（${image}）。画像を戻してから、もう一度実行してください。`;
  return null;
}

async function requeue(d: RetryDeps, job: Job, restart: Restart, resetBudget: boolean): Promise<Job> {
  const now = d.clock.now().toISOString();
  const previous = job.last_error;
  const budget: Partial<Job> = resetBudget
    ? {
        retry_budget_resets: [...job.retry_budget_resets, { at: now, by: 'cli', previous_retry_count: job.retry_count, note: `retry --id（${previous?.code ?? '不明'}）` }],
        retry_count: 0,
        pre_intent_abandons: null,
      }
    : {};
  const moved = await d.bundles.transition(job.id, job.revision, (j): Job => {
    if (restart === 'posting') {
      assertTransition(j.status, 'READY', { intentRecorded: false });
      return { ...j, ...budget, status: 'READY', stage: 'ready', last_error: null, next_retry_at: null };
    }
    const again = restart === 'analysis';
    return {
      ...j,
      ...budget,
      status: again ? 'PENDING' : 'GENERATING',
      stage: again ? INTAKE_STAGE : 'generate',
      analysis: again ? null : j.analysis,
      draft: again ? null : j.draft,
      regeneration_count: 0,
      drift_regenerations: 0,
      last_error: null,
    };
  });
  // failure.json described the failure that is now being retried; it went along with the bundle.
  const stale = join(d.paths.modeRoot, ...bundleRelDir(moved).split('/'), 'failure.json');
  if (existsSync(stale)) await unlinkWithRetry(stale).catch(() => undefined);
  if (restart === 'generation') d.notifyRegeneration?.(job.id);
  const fields = { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: moved.stage, previous_error_code: previous?.code ?? null };
  if (resetBudget) d.logger.info('RETRY_BUDGET_RESET', `再試行の上限に達していた job の回数を戻しました（それまで ${job.retry_count} 回）: ${job.id}`, { ...fields, previous_retry_count: job.retry_count });
  const what = restart === 'posting' ? '投稿待ち' : restart === 'analysis' ? '画像の解析' : '文章の作成';
  d.logger.info('JOB_RETRY_REQUESTED', `失敗した job を${what}から再開できるようにしました: ${job.id}`, fields);
  return moved;
}

/** `retry --id`: 404 / 409 with the reason when the job cannot be retried. An exhausted budget is reset (audited). */
export async function retryOne(d: RetryDeps, id: string): Promise<{ job_id: string; reset_budget: boolean; restart: Restart }> {
  const job = await d.store.get(id);
  if (job === null) throw new ApiError(404, 'NOT_FOUND', `job「${id}」が見つかりません（${d.paths.modeRoot} のデータ。status や images/failed のフォルダ名を確認してください）。`);
  const why = refusal(d, job);
  if (why !== null) throw new ApiError(409, 'STALE_COMMAND', why);
  const restart = restartOf(job);
  if (restart !== 'posting') {
    const blocked = (await d.contentBlocked?.()) ?? null;
    if (blocked !== null) throw new ApiError(409, 'AI_UNAVAILABLE', `今はAIの処理ができないため、再開しても準備は進みません。${blocked}`);
  }
  const reset = restart === 'posting' && exhausted(job, d.config().settings.retry.max_retries);
  await requeue(d, job, restart, reset);
  return { job_id: id, reset_budget: reset, restart };
}

/** Argument-less retry: only posting failures that are safe to send again; every other job is listed with its reason. */
export async function retryEligible(d: RetryDeps): Promise<{ requeued: { job_id: string; reset_budget: false; restart: 'posting' }[]; excluded: { job_id: string; code: ErrorCode; reason_ja: string }[] }> {
  const requeued: { job_id: string; reset_budget: false; restart: 'posting' }[] = [];
  const excluded: { job_id: string; code: ErrorCode; reason_ja: string }[] = [];
  const maxRetries = d.config().settings.retry.max_retries;
  for (const s of d.store.summaries()) {
    if (s.status === 'POSTED') excluded.push({ job_id: s.id, code: 'ALREADY_POSTED', reason_ja: RETRY_EXCLUDED_JA.posted });
    else if (s.status === 'VERIFY_REQUIRED') excluded.push({ job_id: s.id, code: 'POST_RESULT_UNKNOWN', reason_ja: RETRY_EXCLUDED_JA.verify_required });
    else if (s.status === 'BLOCKED') excluded.push({ job_id: s.id, code: asCode(s.last_error_code, 'CONFIG_INCOMPLETE'), reason_ja: RETRY_EXCLUDED_JA.blocked });
    if (s.status !== 'FAILED') continue;
    const job = await d.store.get(s.id);
    if (job === null) continue;
    const code = asCode(job.last_error?.code, 'INTERNAL_ERROR');
    const reason =
      job.retry_blocked_reason !== null
        ? RETRY_EXCLUDED_JA.conflict
        : DUPLICATE.has(code)
          ? RETRY_EXCLUDED_JA.duplicate
          : restartOf(job) !== 'posting'
            ? RETRY_EXCLUDED_JA.content
            : exhausted(job, maxRetries)
              ? RETRY_EXCLUDED_JA.exhausted
              : !AUTO_CODES.has(code) || refusal(d, job) !== null
                ? RETRY_EXCLUDED_JA.other
                : null;
    if (reason !== null) {
      excluded.push({ job_id: job.id, code, reason_ja: reason });
      continue;
    }
    await requeue(d, job, 'posting', false);
    requeued.push({ job_id: job.id, reset_budget: false, restart: 'posting' });
  }
  return { requeued, excluded };
}

// `npm.cmd run redraft`: READY drafts written under older writing settings go back to the text generation (the saved
// analysis is reused, so no analysis AI call) with a fresh regeneration budget. Only jobs never handed to a poster; the
// caller holds the same lock as retry, and each job is read again right before its write (the revision guards the rest).

export type RedraftDeps = RetryDeps & Pick<OpsDeps, 'control'>;
export type RedraftResult = {
  dry: boolean;
  redrafted: { job_id: string; post_type: PostType }[];
  /** Picked up by a poster (or otherwise changed) between the listing and the write: left as it is. */
  skipped: string[];
};

/** Why `job` cannot be redrafted (Japanese), or null. */
function redraftRefusal(d: RedraftDeps, job: Job): string | null {
  const id = job.id;
  const audiences = handledAudiences(d.config().settings);
  if (!audiences.includes(job.audience_category)) return `${id} は${AUDIENCE_JA[job.audience_category]}の job のため、このツール（${audiences.map((a) => AUDIENCE_JA[a]).join('・')}）では作り直しません。`;
  if (job.status !== 'READY') return `${id} は投稿待ち（READY）ではありません（現在: ${JOB_STATUS_JA[job.status]}）。投稿待ちの文章だけを作り直せます。`;
  if (job.operation !== null) return `${id} は画像の移動が途中のままです。ツールを一度起動して復旧させてから、もう一度実行してください。`;
  if (job.attempts.length > 0 || job.attempt_count > 0 || job.submission_state !== 'not_started') return `${id} は一度投稿に回された job のため、作り直しません（二重投稿を防ぐため）。`;
  if (job.schedule_slot_id !== null) return `${id} はいまの投稿枠に割り当て済みのため、作り直しません。`;
  if (d.control.get().live_single?.job_id === id) return `${id} は live:single の初回の投稿に指定されているため、作り直しません。`;
  // Generation reuses the analysis; one it cannot read would only fail the job (A41 restarts it from the analysis instead).
  if (!AnalysisSchema.safeParse(job.analysis).success) return `${id} は保存されている画像解析の結果が今の形式ではないため、作り直しません（ツールの起動中に自動で解析からやり直します）。`;
  return null;
}

export async function redraft(d: RedraftDeps, o: { id: string | null; type: PostType | null; dry: boolean }): Promise<RedraftResult> {
  const targets: Job[] = [];
  if (o.id !== null) {
    const job = await d.store.get(o.id);
    if (job === null) throw new ApiError(404, 'NOT_FOUND', `job「${o.id}」が見つかりません（${d.paths.modeRoot} のデータ。status で job_id を確認してください）。`);
    const why = redraftRefusal(d, job) ?? (o.type !== null && job.post_type !== o.type ? `${o.id} は${POST_TYPE_JA[job.post_type]}の job です（--type ${o.type} と合いません）。` : null);
    if (why !== null) throw new ApiError(409, 'STALE_COMMAND', why);
    targets.push(job);
  } else {
    for (const s of d.store.summaries((x) => x.status === 'READY' && (o.type === null || x.post_type === o.type))) {
      const job = await d.store.get(s.id);
      if (job !== null && redraftRefusal(d, job) === null) targets.push(job);
    }
  }
  const result: RedraftResult = { dry: o.dry, redrafted: [], skipped: [] };
  if (o.dry) return { ...result, redrafted: targets.map((j) => ({ job_id: j.id, post_type: j.post_type })) };
  if (targets.length > 0) {
    const blocked = (await d.contentBlocked?.()) ?? null;
    if (blocked !== null) throw new ApiError(409, 'AI_UNAVAILABLE', `今はAIの処理ができないため、作り直すと投稿待ちの文章が減るだけです（何も変えていません）。${blocked}`);
  }
  for (const listed of targets) {
    const job = await d.store.get(listed.id);
    if (job === null || redraftRefusal(d, job) !== null) {
      result.skipped.push(listed.id);
      continue;
    }
    try {
      await d.bundles.transition(job.id, job.revision, (j): Job => ({ ...j, status: 'GENERATING', stage: 'generate', regeneration_count: 0, drift_regenerations: 0, last_error: null }));
    } catch (err) {
      // Claimed (or otherwise changed) after it was read: leave it alone. Any other failure skips only this job, so the
      // summary still tells what was sent back (a re-run is safe: those jobs are no longer READY).
      if (errorCodeOf(err) !== 'REVISION_CONFLICT') d.logger.warn('JOB_REDRAFT_FAILED', `作り直しに戻せませんでした: ${job.id} ${errorText(err)}`, { job_id: job.id, error_code: errorCodeOf(err) });
      result.skipped.push(job.id);
      continue;
    }
    d.notifyRegeneration?.(job.id);
    d.logger.info('JOB_REDRAFT_REQUESTED', `新しい文章の設定で作り直すため、文章の作成に戻しました: ${job.id}`, { job_id: job.id, post_type: job.post_type, audience_category: job.audience_category, stage: 'generate' });
    result.redrafted.push({ job_id: job.id, post_type: job.post_type });
  }
  const count = (t: PostType): number => result.redrafted.filter((r) => r.post_type === t).length;
  d.logger.info('REDRAFT_SUMMARY', `投稿待ちの文章 ${result.redrafted.length}件を作り直しに戻しました（スタイル ${count('style')}件 / ブログ ${count('blog')}件、見送り ${result.skipped.length}件）。`, {
    redrafted: result.redrafted.length,
    style: count('style'),
    blog: count('blog'),
    skipped: result.skipped.length,
  });
  return result;
}
