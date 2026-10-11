import '../zod-setup.js';
import { setFile } from '../salonboard/engine/fill.js';
import { TIMING, type CsEnv } from './common.js';
import { handleSwMessage, installPageListeners } from './run-post.js';

// Content script entry: announces the document once (cs.ready, no page content) and is otherwise inert until the
// service worker sends a command. DOM work only, no network. When the extension is reloaded this script is orphaned:
// chrome.runtime is gone, so it sends nothing and the click gate never opens.

const alive = (): boolean => {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
};

const env: CsEnv = {
  doc: document,
  send: async (m) => {
    if (!alive()) return null;
    try {
      return (await chrome.runtime.sendMessage(m)) as unknown;
    } catch {
      return null;
    }
  },
  runtimeAlive: alive,
  setFile,
  timing: TIMING,
};

// Only this extension's service worker (no tab) may ask.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!alive() || sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  handleSwMessage(env, raw).then(sendResponse, () => sendResponse(null));
  return true;
});
installPageListeners();

const here = new URL(location.href);
void env.send({
  type: 'cs.ready',
  href_origin: here.origin.slice(0, 200),
  href_path: here.pathname.slice(0, 500),
  query_keys: [...new Set(here.searchParams.keys())].slice(0, 50).map((k) => k.slice(0, 100)),
});
