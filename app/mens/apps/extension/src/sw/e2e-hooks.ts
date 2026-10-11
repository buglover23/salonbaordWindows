import type { Sw } from './orchestrator.js';
import { loadRecord } from './record.js';

/** E2E build only (__E2E__): the Playwright harness drives the SW through self.__e2e (globalThis in the SW). Tree-shaken from production. */
export function installE2eHooks(sw: Sw): void {
  Object.assign(globalThis, {
    __e2e: {
      kick: () => sw.kick(),
      record: () => loadRecord(),
      // popup.html opened as a tab is rejected by the message guard, so E2E pairs here.
      pair: (code: string) => sw.pair(code),
      dropNextResult: () => void (sw.hooks.dropNextResult = true),
      duplicateNextResult: () => void (sw.hooks.duplicateNextResult = true),
      duplicateNextCommand: () => void (sw.hooks.duplicateNextCommand = true),
      reloadExtension: () => chrome.runtime.reload(),
    },
  });
}
