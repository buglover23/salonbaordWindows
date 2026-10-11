import { PairStartResponseSchema, PauseResponseSchema, ResumeResponseSchema, StatusDtoSchema, type PopupMessage, type StatusDto } from '../../../../src/shared/protocol/index.js';
import type { ApiClient } from './api-client.js';
import { loadClientKey } from './key-store.js';
import { pair } from './pairing.js';
import { NOT_CONNECTED, probeFromPopup, surveyFromPopup, type SurveyDeps } from './survey-bridge.js';

// Answers the popup (after the message guard). Everything shown is Japanese for the owner (popup/view.ts).

export interface PopupStatus {
  /**
   * not_running: no verified health answer; needs_pairing: no key yet; bad_signature: Node answered but its signature did
   * not verify (treated as absent, D1-3); stale_client: this pairing was replaced; connected: a verified status.
   */
  connection: 'not_running' | 'needs_pairing' | 'bad_signature' | 'stale_client' | 'connected';
  fingerprint: string | null;
  /** The signed StatusDto (the same one `npm.cmd run status` shows); null unless connected. */
  status: StatusDto | null;
  /** The last fetch to 127.0.0.1 got an answer (Chrome's local network access may block it). */
  loopback_ok: boolean;
  /** This build knows the SALON BOARD origin (checks:record origin before build:extension). */
  origins_recorded: boolean;
  /** The SALON BOARD host permission of this build is granted. */
  origins_granted: boolean;
  /** The result give-up warning (rule 9). */
  warning: string | null;
  /** From hello: the survey and probe buttons are disabled otherwise. */
  survey_allowed: boolean;
  probe_allowed: boolean;
}

export type PopupReply = { ok: boolean; message: string } | PopupStatus;

const reply = (ok: boolean, message: string): PopupReply => ({ ok, message });

export async function handlePopup(msg: PopupMessage, api: ApiClient, onPaired: () => void, survey: SurveyDeps): Promise<PopupReply> {
  switch (msg.type) {
    case 'popup.status':
      return status(api, survey);
    case 'popup.survey':
      return surveyFromPopup(msg, survey);
    case 'popup.probe':
      return probeFromPopup(survey);
    case 'popup.pair_start': {
      const r = await api.unsigned('/v1/extension/pair/start', { extension_version: chrome.runtime.getManifest().version }, PairStartResponseSchema);
      if (r.kind === 'ok') return reply(true, 'ツールの黒い画面に接続コードが表示されました。5分以内に入力してください');
      if (r.kind === 'refused' && r.error.code === 'PAIRING_NOT_OPEN') return reply(false, 'すでに接続済みです。つなぎ直すときは、別の PowerShell で npm.cmd run pair を実行し、表示された接続コードを入力してください');
      return reply(false, r.kind === 'refused' ? r.error.message : NOT_CONNECTED);
    }
    case 'popup.pair_code': {
      const r = await pair(api, msg.code, chrome.runtime.id);
      if (!r.ok) return reply(false, r.message);
      onPaired();
      return reply(true, `接続しました。ツールの画面の確認記号が「${r.fingerprint}」と同じか確かめてください`);
    }
    case 'popup.pause': {
      const r = await api.signed('POST', '/v1/control/pause', { reason: '拡張機能から一時停止' }, PauseResponseSchema);
      return r.kind === 'ok' ? reply(true, '一時停止しました') : reply(false, r.kind === 'refused' ? r.error.message : NOT_CONNECTED);
    }
    case 'popup.resume': {
      const r = await api.signed('POST', '/v1/control/resume', {}, ResumeResponseSchema);
      if (r.kind !== 'ok' || r.body === null) return reply(false, r.kind === 'refused' ? r.error.message : NOT_CONNECTED);
      return reply(true, r.body.checking ? '再開の前に画面を確認しています' : '再開しました');
    }
  }
}

async function status(api: ApiClient, survey: SurveyDeps): Promise<PopupStatus> {
  const key = await loadClientKey();
  const warning = ((await chrome.storage.local.get('warning')).warning as string | undefined) ?? null;
  const origins = survey.buildOrigins.map((o) => `${o}/*`);
  const granted = origins.length > 0 && (await chrome.permissions.contains({ origins }).catch(() => false));
  const base = { fingerprint: key?.fingerprint ?? null, status: null, origins_recorded: origins.length > 0, origins_granted: granted, warning, survey_allowed: false, probe_allowed: false };
  if ((await api.health()) === null) return { ...base, connection: 'not_running', loopback_ok: api.loopbackOk };
  if (key === null) return { ...base, connection: 'needs_pairing', loopback_ok: true };
  // Hello first: it carries the store check, so this status already shows a wrong-Chrome login.
  const hello = await survey.hello();
  const s = await api.signed('GET', '/v1/status', null, StatusDtoSchema);
  if (s.kind === 'refused' && s.error.code === 'STALE_CLIENT') return { ...base, connection: 'stale_client', loopback_ok: true };
  if (s.kind === 'unknown' && s.reason === 'bad_signature') return { ...base, connection: 'bad_signature', loopback_ok: true };
  if (s.kind !== 'ok' || s.body === null) return { ...base, connection: 'not_running', loopback_ok: api.loopbackOk };
  return { ...base, connection: 'connected', status: s.body, loopback_ok: true, survey_allowed: hello?.survey_allowed === true, probe_allowed: hello?.probe_allowed === true };
}
