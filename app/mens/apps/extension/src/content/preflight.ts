import type { ErrorCode } from '../../../../src/shared/errors.js';
import type { PageProfile, PreflightTarget } from '../../../../src/shared/protocol/index.js';
import type { AudienceCategory } from '../../../../src/shared/types.js';
import { findOption } from '../salonboard/engine/fill.js';
import { resolveOne } from '../salonboard/engine/locate.js';
import { evidence, identifyWait, pageState, report, startKeepalive, token, type CsEnv } from './common.js';

// Preflight (P3-R35): steps 1–7 only, read-only. It identifies the page (§5.6), resolves every field of the profile and,
// on a by_field page, finds the audience's option. It never types, uploads, selects or clicks.

/** The first field that would stop a post: a required one missing, any one ambiguous, or the audience option missing. */
function fieldProblem(p: PageProfile, doc: Document, audience: AudienceCategory): { code: ErrorCode; note: string } | null {
  for (const [key, field] of Object.entries(p.fields)) {
    const r = resolveOne(doc, field.locators);
    if (!r.ok) {
      if (r.reason === 'none' && !field.required) continue;
      return { code: 'SALON_BOARD_PAGE_CHANGED', note: token(`field:${key}:${r.reason}`) };
    }
    const ref = field.options?.[audience];
    if (key === 'audience' && p.audience_mode === 'by_field' && (ref === undefined || typeof findOption(r.el, field.kind, ref) === 'string')) {
      return { code: 'POST_TARGET_MISMATCH', note: 'audience_option' };
    }
  }
  return null;
}

export async function runPreflight(env: CsEnv, m: { command_id: string; target: PreflightTarget; salon: { expected_account_label: string } }): Promise<void> {
  const { doc } = env;
  const p = m.target.profile;
  const audience: AudienceCategory = m.target.route_key.endsWith('.mens') ? 'mens' : 'ladies';
  const label = m.salon.expected_account_label;
  const stop = startKeepalive(env.send, m.command_id, () => 'preflight', env.timing.keepalive);
  try {
    const id = await identifyWait(env, p, { expectedLabel: label, otherRoutes: m.target.other_routes, audience });
    const identified = id !== 'other' && id.ok;
    const problem = id === 'other' || id.ok ? fieldProblem(p, doc, audience) : { code: id.code, note: id.detail ?? `row_${id.row}` };
    const page_state = pageState(doc, p, label, identified);
    if (problem === null) await report(env, m.command_id, 'preflight', true, null, null, { page_state });
    else await report(env, m.command_id, 'preflight', false, problem.code, evidence(doc, { notes: [problem.note] }), { page_state });
  } finally {
    stop();
  }
}
