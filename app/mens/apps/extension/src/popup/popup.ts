import type { PopupReply, PopupStatus } from '../sw/popup-bridge.js';
import { render, updateButtons } from './view.js';

// The popup (Task 4b): status from the service worker, drawn by view.ts; the buttons ask the SW. Text only, never HTML.

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const ask = (msg: object): Promise<PopupReply | null> => chrome.runtime.sendMessage(msg);

function show(text: string): void {
  el('message').textContent = text;
}

async function refresh(): Promise<void> {
  const s = (await ask({ type: 'popup.status' }).catch(() => null)) as PopupStatus | null;
  if (s === null) return void (el('connection').textContent = '拡張機能の状態を読めませんでした');
  render(document, s);
}

async function act(msg: object): Promise<void> {
  show('処理しています…');
  const r = await ask(msg).catch(() => null);
  show(r !== null && 'message' in r ? r.message : '応答がありませんでした');
  await refresh();
}

function survey(kind: 'form' | 'page'): void {
  const title = el<HTMLInputElement>('known-title').value.trim();
  void act({ type: 'popup.survey', kind, ...(title === '' ? {} : { known_title: title }), confirmed_no_customer_data: true });
}

el('pair-start').addEventListener('click', () => void act({ type: 'popup.pair_start' }));
el('pair-send').addEventListener('click', () => void act({ type: 'popup.pair_code', code: el<HTMLInputElement>('code').value }));
el('pause').addEventListener('click', () => void act({ type: 'popup.pause' }));
el('resume').addEventListener('click', () => void act({ type: 'popup.resume' }));
el('survey-confirm').addEventListener('change', () => updateButtons(document));
el('probe-confirm').addEventListener('change', () => updateButtons(document));
el('survey-form').addEventListener('click', () => survey('form'));
el('survey-page').addEventListener('click', () => survey('page'));
el('probe-run').addEventListener('click', () => void act({ type: 'popup.probe', confirmed_no_register: true }));
// The build names the extension per copy (（メンズ） / （レディース）); the header shows the same name.
document.title = el('title').textContent = chrome.runtime.getManifest().name;
updateButtons(document);
void refresh();
