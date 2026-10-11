import type { DeploymentChecks } from '../../config/schemas.js';
import { formatJst } from '../../shared/time.js';
import { ApiError } from '../errors.js';
import type { LocalApiDeps } from '../http-server.js';
import type { HandlerResult } from '../router.js';

// The upload probe gate (§18.1, §5.5): the owner arms it with `npm.cmd run probe -- --arm --yes` for 10 minutes, and only
// while automation is recorded as permitted with its evidence and date (R11). The popup button follows hello.probe_allowed.

export const PROBE_ARM_MS = 10 * 60_000;

/** Why automatic work on SALON BOARD is not allowed now (409), or null when automation is permitted with evidence and a date. */
export function automationRefusal(a: DeploymentChecks['automation']): ApiError | null {
  if (a.status === 'prohibited') return new ApiError(409, 'AUTOMATION_NOT_PERMITTED', '自動操作は禁止と記録されているため、この操作はできません。');
  if (a.status !== 'permitted' || a.evidence === null || a.checked_at === null) {
    return new ApiError(
      409,
      'EXTERNAL_REQUIREMENT_UNVERIFIED',
      '自動操作の許可が確認できていません。許可の根拠と確認日を npm.cmd run checks:record -- automation で記録してから実行してください。',
    );
  }
  return null;
}

/** The probe may run now: automation permitted, armed by the owner within the last 10 minutes, server not stopping. */
export function probeAllowed(d: LocalApiDeps, now: Date): boolean {
  const armed = d.control.get().probe;
  return d.state() === 'running' && automationRefusal(d.config().deploymentChecks.automation) === null && armed !== null && now.getTime() < Date.parse(armed.expires_at);
}

/** POST /v1/control/probe (cli): arms the probe for 10 minutes. */
export async function armProbe(d: LocalApiDeps, now: Date): Promise<HandlerResult> {
  const refusal = automationRefusal(d.config().deploymentChecks.automation);
  if (refusal !== null) throw refusal;
  const expires = new Date(now.getTime() + PROBE_ARM_MS);
  await d.control.update(() => ({ probe: { armed_at: now.toISOString(), expires_at: expires.toISOString() } }));
  d.logger.info('PROBE_ARMED', `画像添付の確認を ${formatJst(expires)} まで受け付けます（登録ボタンは押しません）。`);
  return { status: 200, body: { expires_at_jst: formatJst(expires) } };
}
