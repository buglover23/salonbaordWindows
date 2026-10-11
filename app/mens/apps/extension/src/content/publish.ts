import { matchProfileUrl, type PageProfile } from '../../../../src/shared/protocol/index.js';
import { resolveOne } from '../salonboard/engine/locate.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { evidence, excerpt, pageReady, report, startKeepalive, token, type CsEnv } from './common.js';
import { state } from './guard.js';
import { salonOn } from './verify.js';

// 反映申請 (profile.publish) after a proved post. Best effort: the SW ends the post as posted whatever is reported here;
// the notes ('published', or 'publish_failed:<why>') are for the owner's log. The click is allowed once, in the first
// document of the step (may_click); the document the page lands on after it only reports.

export async function runPublish(env: CsEnv, o: { command_id: string; profile: PageProfile; salon_label: string; may_click: boolean }): Promise<void> {
  const { doc } = env;
  const publish = o.profile.publish;
  const send = (ok: boolean, ...notes: string[]): Promise<unknown> => report(env, o.command_id, 'publish', ok, null, evidence(doc, { notes }));
  const fail = (why: string): Promise<unknown> => send(false, `publish_failed:${why}`);
  const stop = startKeepalive(env.send, o.command_id, () => 'verifying_list', env.timing.keepalive);
  try {
    await pageReady(env);
    if (publish === undefined) return void (await fail('no_profile'));
    if (!matchProfileUrl(doc.URL, o.may_click ? publish.url_match : publish.done_url_match).ok) return void (await fail('url'));
    const salon = await salonOn(env, o.profile, o.salon_label);
    if (salon !== true) return void (await fail(salon === null ? 'salon' : 'wrong_salon'));
    if (!o.may_click) return void (await send(true, 'published', `h1:${token((excerpt(doc.querySelector('h1')) ?? '').slice(0, 40))}`));
    const button = resolveOne(doc, publish.button);
    if (!button.ok) return void (await fail(`button_${button.reason}`));
    const el = button.el as HTMLButtonElement;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return void (await fail('button_disabled'));
    if (state.leaving || !env.runtimeAlive()) return;
    el.click();
    // The page navigates away (this script ends with it and the SW handles the landing document); staying means it did not.
    if ((await waitFor(() => state.leaving, { timeoutMs: env.timing.field, root: doc })) === true) return;
    await fail('no_navigation');
  } finally {
    stop();
  }
}
