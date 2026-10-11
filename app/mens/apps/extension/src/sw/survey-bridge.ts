import { CsMessageSchema, SurveyResponseSchema } from '../../../../src/shared/protocol/index.js';
import type { CsMessage, HelloResponse, PopupMessage } from '../../../../src/shared/protocol/index.js';
import type { ApiClient } from './api-client.js';
import { chunkOf } from './asset-cache.js';
import { hex, sha256 } from './crypto.js';

// The popup's 「画面を調査」 and 「画像添付の確認（登録しません）」 (Task 5a). Both act only on the owner's active tab when
// it shows an allowed SALON BOARD origin (build origins ∩ hello origins), only as far as Node's hello allows, and post
// the result to /v1/survey. Neither navigates or clicks; the probe sets one synthetic image and waits for a preview.

export interface SurveyDeps {
  api: ApiClient;
  /** A fresh, signed hello (null: Node is not there). */
  hello: () => Promise<HelloResponse | null>;
  buildOrigins: readonly string[];
  /** A post, reconcile or preflight command is in flight (one command at a time, the probe included). */
  busy: () => Promise<boolean>;
}

type Reply = { ok: boolean; message: string };
const reply = (ok: boolean, message: string): Reply => ({ ok, message });

export const NOT_CONNECTED = 'ツールに接続できません。ツールが起動しているか確認してください';
const NO_ANSWER = '画面から応答がありません。SALON BOARD の画面を再読み込みしてから、もう一度押してください';
const REFUSAL_JA: Record<Extract<CsMessage, { type: 'cs.survey_refused' }>['reason'], string> = {
  login_page: 'ログイン画面は調査しません',
  customer_data: 'お客様の情報が表示されている可能性があるため調査しません',
  too_large: '画面が大きすぎるため調査できません（開発担当に相談してください）',
  invalid: '調査結果を作れませんでした（画面の形式が想定外です。開発担当に相談してください）',
  probe_image: 'テスト用の画像を用意できませんでした。拡張機能を再読み込みしてから、もう一度押してください',
};

async function activeTab(deps: SurveyDeps, h: HelloResponse): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Without the tabs permission the URL is visible only on the host-permission origins.
  const origin = tab?.url === undefined ? undefined : URL.parse(tab.url)?.origin;
  const allowed = deps.buildOrigins.filter((o) => h.allowed_origins.includes(o));
  return tab?.id !== undefined && origin !== undefined && allowed.includes(origin) ? tab.id : null;
}
const WRONG_TAB = 'SALON BOARD の画面（設定した接続先）を開いたタブで、拡張機能のボタンを押してください';

/** The content script's answer → POST /v1/survey → the saved file name for the owner. */
async function save(deps: SurveyDeps, answer: unknown, expected: 'cs.survey_result' | 'cs.probe_result', done: string): Promise<Reply> {
  const m = CsMessageSchema.safeParse(answer);
  if (!m.success) return reply(false, NO_ANSWER);
  if (m.data.type === 'cs.survey_refused') return reply(false, REFUSAL_JA[m.data.reason]);
  if (m.data.type !== expected) return reply(false, NO_ANSWER);
  const r = await deps.api.signed('POST', '/v1/survey', { capture: m.data.capture }, SurveyResponseSchema);
  if (r.kind === 'ok' && r.body !== null) return reply(true, `${done}: ${r.body.saved_as.replaceAll('/', '\\')}（開発担当に渡す前に npm.cmd run survey:show で内容を確認してください）`);
  return reply(false, r.kind === 'refused' ? r.error.message : NOT_CONNECTED);
}

export async function surveyFromPopup(msg: Extract<PopupMessage, { type: 'popup.survey' }>, deps: SurveyDeps): Promise<Reply> {
  const h = await deps.hello();
  if (h === null) return reply(false, NOT_CONNECTED);
  if (!h.survey_allowed) return reply(false, '自動操作は禁止と記録されているため、画面の調査はできません');
  const tabId = await activeTab(deps, h);
  if (tabId === null) return reply(false, WRONG_TAB);
  const run = { type: 'run_survey', kind: msg.kind, known_title: msg.known_title ?? null, salon_label: h.salon_label, poster_name: h.poster_name, strict: false };
  const answer: unknown = await chrome.tabs.sendMessage(tabId, run, { frameId: 0 }).catch(() => null);
  return save(deps, answer, 'cs.survey_result', '調査結果を保存しました');
}

export async function probeFromPopup(deps: SurveyDeps): Promise<Reply> {
  const h = await deps.hello();
  if (h === null) return reply(false, NOT_CONNECTED);
  if (!h.probe_allowed) {
    return reply(false, '画像添付の確認は、ツールの動作中に別の PowerShell で npm.cmd run probe -- --arm --yes を実行してから10分以内に使えます（自動操作の許可の記録も必要です）');
  }
  if (await deps.busy()) return reply(false, '投稿の処理中のため、今は確認できません。しばらくしてからもう一度押してください');
  const tabId = await activeTab(deps, h);
  if (tabId === null) return reply(false, WRONG_TAB);
  const bytes = await deps.api.probeImage();
  if (bytes === null) return reply(false, REFUSAL_JA.probe_image);
  const digest = hex(await sha256(bytes));
  for (let index = 0; ; index++) {
    const chunk = chunkOf(bytes, index, digest);
    if (chunk === null) break;
    const ok = await chrome.tabs.sendMessage(tabId, chunk, { frameId: 0 }).then((r: unknown) => r === true, () => false);
    if (!ok) return reply(false, NO_ANSWER);
  }
  const answer: unknown = await chrome.tabs.sendMessage(tabId, { type: 'run_probe', probe_id: crypto.randomUUID() }, { frameId: 0 }).catch(() => null);
  const r = await save(deps, answer, 'cs.probe_result', '画像添付の確認の結果を保存しました');
  return r.ok ? reply(true, `${r.message} この画面は登録せずに閉じてください`) : r;
}
