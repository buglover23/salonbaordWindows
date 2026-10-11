import type { z } from 'zod';
import { errorCodeOf } from '../../shared/errors.js';
import type { SurveyRequestSchema } from '../../shared/protocol/api.js';
import { saveCapture, sanitizeCapture } from '../../survey/store.js';
import { ApiError } from '../errors.js';
import type { LocalApiDeps } from '../http-server.js';
import type { HandlerResult } from '../router.js';
import { automationRefusal, probeAllowed } from './probe.js';

// POST /v1/survey (D9): the owner's 「画面を調査」, the probe result and live-single outlines. Node masks every string
// again (authoritative) before anything is written; the log names the file only, never page content.

type SurveyRequest = z.infer<typeof SurveyRequestSchema>;

export async function saveSurvey(d: LocalApiDeps, body: SurveyRequest, now: Date): Promise<HandlerResult> {
  const automation = d.config().deploymentChecks.automation;
  if (automation.status === 'prohibited') throw new ApiError(403, 'AUTOMATION_NOT_PERMITTED', '自動操作は禁止と記録されているため、画面の調査は受け付けません。');
  const c = body.capture;
  const link = body.link ?? null;
  const bad = (message: string): ApiError => new ApiError(422, 'INVALID_REQUEST', message);
  if ((c.kind === 'probe') !== (c.probe !== null)) throw bad('画像添付の確認の結果と調査の種類が合いません。');
  if ((c.kind === 'probe' || link !== null) && c.mode !== 'strict') throw bad('この調査は厳しい方式（strict）で行う必要があります。');
  if (c.kind === 'probe' && !probeAllowed(d, now)) {
    throw automationRefusal(automation) ?? new ApiError(409, 'STALE_COMMAND', '画像添付の確認は受け付けていません。npm.cmd run probe -- --arm --yes を実行してから10分以内に行ってください。');
  }
  const clean = sanitizeCapture(c);
  if (!clean.ok) throw bad(clean.reason_ja);
  if (link !== null) {
    const job = await d.jobs.get(link.job_id);
    if (job?.attempts.some((a) => a.id === link.attempt_id) !== true) throw new ApiError(404, 'NOT_FOUND', '調査に結び付ける投稿が見つかりません。');
  }
  const name = await saveCapture(d.surveyDir, clean.capture, now, link);
  const saved_as = `data/survey/${name}`;
  if (link !== null) await addEvidenceRef(d, link, saved_as);
  d.logger.info('SURVEY_SAVED', `画面の調査結果を保存しました: ${saved_as}`, { kind: c.kind, mode: c.mode });
  return { status: 201, body: { saved_as } };
}

/** The outline's file joins the attempt's evidence_refs (retried on a concurrent update). */
async function addEvidenceRef(d: LocalApiDeps, link: { job_id: string; attempt_id: string }, ref: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const job = await d.jobs.get(link.job_id);
    if (job === null) return;
    try {
      await d.jobs.update(job.id, job.revision, (j) => ({
        ...j,
        attempts: j.attempts.map((a) => (a.id === link.attempt_id && !a.evidence_refs.includes(ref) ? { ...a, evidence_refs: [...a.evidence_refs, ref] } : a)),
      }));
      return;
    } catch (err) {
      if (errorCodeOf(err) !== 'REVISION_CONFLICT' || tries >= 2) throw err;
    }
  }
}
