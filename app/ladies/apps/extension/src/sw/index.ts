import '../zod-setup.js';
import { installE2eHooks } from './e2e-hooks.js';
import { createSw } from './orchestrator.js';

// Service worker entry: listeners are registered synchronously at top level; no top-level await, no import().

const sw = createSw({ apiBase: __API_BASE__, origins: __SALONBOARD_ORIGINS__, e2e: __E2E__ });

// The command record must never be readable from content scripts (17-e); the key itself is in IndexedDB.
const restricted = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
const kick = (): void => void restricted.then(() => sw.kick());

chrome.runtime.onStartup.addListener(kick);
chrome.runtime.onInstalled.addListener(kick);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'claim') kick();
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void restricted.then(() => sw.onMessage(msg, sender, sendResponse));
  return true; // answered asynchronously
});

if (__E2E__) installE2eHooks(sw);
