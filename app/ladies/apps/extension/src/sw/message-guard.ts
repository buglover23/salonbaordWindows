import { CsMessageSchema, PopupMessageSchema, type CsMessage, type PopupMessage } from '../../../../src/shared/protocol/index.js';
import type { CommandRecord } from './record.js';

export type Guarded = { from: 'cs'; msg: CsMessage; tabId: number; documentId: string } | { from: 'popup'; msg: PopupMessage };

/**
 * §6.7 guard: Zod first, then the sender. Content-script messages need a top frame of a tab on an allowed origin
 * (build origins ∩ hello origins); job messages also need the bound posting document. Popup messages must come from
 * this extension's popup.html and never from a tab (popup.html opened as a page is rejected).
 */
export function guardMessage(raw: unknown, sender: chrome.runtime.MessageSender, origins: readonly string[], record: CommandRecord | null): Guarded | null {
  if (sender.id !== chrome.runtime.id) return null;
  const type = typeof raw === 'object' && raw !== null && 'type' in raw ? raw.type : undefined;
  if (typeof type === 'string' && type.startsWith('popup.')) {
    const p = PopupMessageSchema.safeParse(raw);
    return p.success && sender.tab === undefined && sender.url === chrome.runtime.getURL('popup.html') ? { from: 'popup', msg: p.data } : null;
  }
  const c = CsMessageSchema.safeParse(raw);
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  if (!c.success || tabId === undefined || documentId === undefined || sender.frameId !== 0) return null;
  if (sender.origin === undefined || !origins.includes(sender.origin)) return null;
  if ('command_id' in c.data && (record === null || c.data.command_id !== record.command.command_id || tabId !== record.tab_id || documentId !== record.document_id)) {
    return null;
  }
  return { from: 'cs', msg: c.data, tabId, documentId };
}
