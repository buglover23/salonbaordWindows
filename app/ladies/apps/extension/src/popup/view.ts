import type { StatusDto } from '../../../../src/shared/protocol/index.js';
import { DRY_RUN_JA } from '../../../../src/shared/types.js';
import type { PopupStatus } from '../sw/popup-bridge.js';

// The popup's picture of the tool (Task 4b), drawn from the signed StatusDto and the extension's own checks. Text only
// (textContent), never HTML. There is deliberately no per-post approval here (A05): posting runs on its own once live.

const CONNECTION: Record<PopupStatus['connection'], string> = {
  not_running: 'ツールに接続していません（起動.bat でツールを起動してください）',
  needs_pairing: '接続が必要です',
  bad_signature: 'ツールの応答を確認できません（署名が一致しません）。下の「接続」から接続し直してください',
  stale_client: 'この拡張機能の接続は新しい接続に置き換えられました。使うときは、別の PowerShell で npm.cmd run pair を実行し、表示された接続コードを下の欄に入力してください',
  connected: '接続済み',
};
const TYPE_LABEL = { style: 'スタイル', blog: 'ブログ' } as const;
const READINESS_SHOWN = 5;

const byId = <T extends HTMLElement = HTMLElement>(doc: Document, id: string): T => {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`popup.html has no #${id}`);
  return el as T;
};

function list(doc: Document, id: string, lines: readonly string[]): void {
  byId(doc, id).replaceChildren(...lines.map((text) => Object.assign(doc.createElement('li'), { textContent: text })));
}

/** 'YYYY-MM-DD HH:mm' as 'HH:mm' today, 'MM/DD HH:mm' on another day. */
const when = (jst: string | null, today: string): string => (jst === null ? 'なし' : jst.startsWith(today) ? jst.slice(11) : `${jst.slice(5, 10).replace('-', '/')} ${jst.slice(11)}`);

function today(dto: StatusDto): string[] {
  return (['style', 'blog'] as const).map((t) => {
    const p = dto.per_type[t];
    return `${TYPE_LABEL[t]}: 成功 ${p.done} ／ 予約 ${p.reserved}（うち結果不明 ${p.unknown}）／ 不足 ${p.shortfall} ／ 次回 ${when(p.next_at_jst, dto.today)}`;
  });
}

const ROUTE_LABEL = (k: keyof StatusDto['routes']): string => `${TYPE_LABEL[k.startsWith('style.') ? 'style' : 'blog']}・${k.endsWith('.mens') ? 'メンズ' : 'レディース'}`;

/** Task 7: the first-post steps (live:single), the operator's tasks and the warnings. */
function notices(dto: StatusDto): string[] {
  const waiting = (Object.keys(dto.routes) as (keyof StatusDto['routes'])[]).filter((k) => {
    const r = dto.routes[k];
    return dto.mode === 'live' && r.configured && r.screen === 'verified' && r.first_post === 'needs_live_single';
  });
  return [
    ...(dto.live_single === null ? [] : [`${ROUTE_LABEL(dto.live_single.route_key)}の初回の本番投稿（1件だけ）を予定しています。終わると一時停止します`]),
    ...waiting.map((k) => `${ROUTE_LABEL(k)}: 初回の本番投稿（npm.cmd run live:single -- --route ${k}）待ち`),
    ...dto.operator_actions.map((a) => a.action_ja),
    ...dto.warnings,
  ];
}

function extension(dto: StatusDto): string {
  const login = dto.extension.logged_in === true ? 'ログイン済み' : dto.extension.logged_in === false ? 'ログインが必要です' : 'ログイン状態は未確認です';
  return `Chrome 拡張機能: ${dto.extension.connected ? '接続中' : '応答なし'} ／ SALON BOARD: ${login}`;
}

/** The survey and probe buttons need Node's permission (hello) and the owner's tick. */
export function updateButtons(doc: Document): void {
  const allowed = (id: string): boolean => byId(doc, id).dataset.allowed === 'true';
  const ticked = (id: string): boolean => byId<HTMLInputElement>(doc, id).checked;
  const survey = !allowed('survey') || !ticked('survey-confirm');
  byId<HTMLButtonElement>(doc, 'survey-form').disabled = survey;
  byId<HTMLButtonElement>(doc, 'survey-page').disabled = survey;
  byId<HTMLButtonElement>(doc, 'probe-run').disabled = !allowed('probe') || !ticked('probe-confirm');
}

export function render(doc: Document, s: PopupStatus): void {
  const dto = s.status;
  const show = (id: string, visible: boolean): void => void (byId(doc, id).hidden = !visible);
  byId(doc, 'connection').textContent = s.connection === 'connected' ? `接続済み（確認記号 ${s.fingerprint ?? '----'}）` : CONNECTION[s.connection];

  show('mode', dto !== null);
  show('today', dto !== null);
  if (dto !== null) {
    const pause = dto.paused ? `・一時停止中${dto.pause_reason === null ? '' : `（${dto.pause_reason}）`}` : '';
    byId(doc, 'mode').textContent = `${dto.mode === 'live' ? '本番' : 'dry-run（SALON BOARDには投稿しません）'}${pause}`;
    list(doc, 'per-type', today(dto));
    const j = dto.jobs;
    byId(doc, 'counts').textContent = `失敗 ${j.failed} ／ 結果不明 ${j.verify_required} ／ 再試行待ち ${j.retry_wait} ／ 保留 ${j.blocked}`;
    byId(doc, 'extension').textContent = extension(dto);
  }

  const stops = dto?.stops.map((x) => `${x.message} ${x.remedy}`) ?? [];
  // dry-run pseudo-posts on its own: the reasons are those of real posting, to fix before going live (as status says).
  // Another store logged in (this extension is in the wrong Chrome): shown first, on its own.
  const wrong = dto?.dispatch.reasons.find((r) => r.code === 'WRONG_SALON')?.message_ja ?? null;
  byId(doc, 'salon-warning').textContent = wrong ?? '';
  show('salon-warning', wrong !== null);
  const reasons = dto?.dispatch.reasons.map((r) => r.message_ja).filter((m) => m !== DRY_RUN_JA && m !== wrong) ?? [];
  byId(doc, 'problems-title').textContent = dto?.mode === 'dry_run' ? '本番にしたときに送信を止める理由' : '止まっている理由';
  const items = dto?.readiness ?? null;
  const readiness = items === null ? [] : [...items.global, ...Object.values(items.routes).flat()].map((i) => i.detail);
  list(doc, 'stops', stops);
  list(doc, 'reasons', reasons);
  list(doc, 'readiness', readiness.slice(0, READINESS_SHOWN));
  show('readiness-more', readiness.length > 0);
  show('problems', stops.length + reasons.length + readiness.length > 0);
  const notes = dto === null ? [] : notices(dto);
  list(doc, 'notes', notes);
  show('notices', notes.length > 0);

  byId(doc, 'warning').textContent = s.warning ?? '';
  show('warning', s.warning !== null);
  show('origin-warning', !s.origins_recorded);
  show('permission-warning', s.origins_recorded && !s.origins_granted);
  show('loopback-warning', !s.loopback_ok);
  // The code field is always there (a code from npm.cmd run pair); 「接続」 only while this extension is not paired.
  const unpaired = s.connection === 'needs_pairing' || s.connection === 'bad_signature' || s.connection === 'stale_client';
  show('pair-new', unpaired);
  show('pair-start', unpaired);
  show('pair-again', !unpaired);
  byId(doc, 'survey').dataset.allowed = String(s.survey_allowed);
  byId(doc, 'probe').dataset.allowed = String(s.probe_allowed);
  show('probe', s.probe_allowed);
  updateButtons(doc);
}
