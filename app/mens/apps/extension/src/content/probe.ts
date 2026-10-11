import { SwMessageSchema, type CsMessage, type SurveyCapture, type SwMessage } from '../../../../src/shared/protocol/index.js';
import { setFile } from '../salonboard/engine/fill.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { hex, sha256 } from '../sw/crypto.js';
import { captureSurvey, refusalOf, type Captured } from './survey/capture.js';

// The upload probe (§18.1, owner-armed): sets the bundled synthetic image on the unique file input of the page's main
// form, waits for a preview and reports. It never clicks, never navigates and never touches another field.

export type ProbeResult = NonNullable<SurveyCapture['probe']>;

export const PREVIEW_TIMEOUT_MS = 60_000;
const ERROR_TEXT = /エラー|失敗|できません/;

/** The form with the most controls. */
function mainForm(doc: Document): HTMLFormElement | null {
  const count = (f: HTMLFormElement): number => f.querySelectorAll('input, select, textarea').length;
  return [...doc.querySelectorAll('form')].sort((a, b) => count(b) - count(a))[0] ?? null;
}

const showsImage = (n: Node): boolean =>
  n.nodeType === 1 && ((n as Element).localName === 'img' || (n as Element).querySelector('img') !== null || /url\(/i.test((n as Element).getAttribute('style') ?? ''));

export async function runProbe(doc: Document, file: File, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<ProbeResult> {
  const form = mainForm(doc);
  const inputs = form === null ? [] : [...form.querySelectorAll<HTMLInputElement>('input[type="file" i]')];
  const report: ProbeResult = {
    file_input_found: 'unique',
    accepted: false,
    native_change_fired: false,
    input_event_fired: false,
    preview_appeared: false,
    preview_ms: null,
    upload_error_signal: false,
    tab_hidden: doc.hidden,
    files_length_after: 0,
  };
  const [input] = inputs;
  if (input === undefined || inputs.length > 1) return { ...report, file_input_found: input === undefined ? 'none' : 'multiple' };

  const seen = { change: false, input: false, preview: false, error: false };
  const onChange = (): void => void (seen.change = true);
  const onInput = (): void => void (seen.input = true);
  input.addEventListener('change', onChange);
  input.addEventListener('input', onInput);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') seen.preview ||= showsImage(r.target);
      for (const n of r.addedNodes) {
        seen.preview ||= showsImage(n);
        seen.error ||= ERROR_TEXT.test(n.textContent ?? '');
      }
    }
  });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
  const started = performance.now();
  const set = setFile(input, file);
  const at = set.ok ? await waitFor(() => (seen.preview || seen.error ? performance.now() : null), { timeoutMs, root: doc.body }) : null;
  observer.disconnect();
  input.removeEventListener('change', onChange);
  input.removeEventListener('input', onInput);
  return {
    ...report,
    accepted: set.ok,
    native_change_fired: seen.change,
    input_event_fired: seen.input,
    preview_appeared: seen.preview,
    preview_ms: seen.preview && at !== null ? Math.round(at - started) : null,
    upload_error_signal: seen.error,
    tab_hidden: doc.hidden,
    files_length_after: input.files?.length ?? 0,
  };
}

// The probe image arrives from the service worker in chunks before run_probe.
const chunks = new Map<number, string>();
let expected: { total: number; sha256: string } | null = null;

export function takeChunk(m: Extract<SwMessage, { type: 'chunk' }>): void {
  if (expected?.sha256 !== m.sha256 || expected.total !== m.total) {
    chunks.clear();
    expected = { total: m.total, sha256: m.sha256 };
  }
  chunks.set(m.index, m.b64);
}

/** The assembled probe image when every chunk arrived and the SHA-256 matches; the buffer is emptied either way. */
export async function probeFile(): Promise<File | null> {
  const e = expected;
  const parts = e === null ? [] : Array.from({ length: e.total }, (_, i) => chunks.get(i));
  chunks.clear();
  expected = null;
  if (e === null || parts.some((p) => p === undefined)) return null;
  const bytes = Uint8Array.from(parts.map((p) => atob(p!)).join(''), (c) => c.charCodeAt(0));
  return hex(await sha256(bytes)) === e.sha256 ? new File([bytes], 'probe.jpg', { type: 'image/jpeg' }) : null;
}

const refused = (c: Extract<Captured, { ok: false }>): CsMessage => ({ type: 'cs.survey_refused', reason: c.reason, detail: c.detail });

/** The answer to a service worker message about the survey or the probe; null for any other message. */
export async function answerSurveyMessage(raw: unknown, doc: Document, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<CsMessage | true | null> {
  const m = SwMessageSchema.safeParse(raw);
  if (!m.success) return null;
  const msg = m.data;
  if (msg.type === 'chunk') {
    takeChunk(msg);
    return true;
  }
  if (msg.type === 'run_survey') {
    const c = captureSurvey(doc, { kind: msg.kind, mode: msg.strict ? 'strict' : 'owner', salonLabel: msg.salon_label, posterName: msg.poster_name, knownTitle: msg.known_title });
    return c.ok ? { type: 'cs.survey_result', capture: c.capture } : refused(c);
  }
  if (msg.type !== 'run_probe') return null;
  const file = await probeFile();
  // Checked before the page is touched.
  const refusal = refusalOf(doc) ?? (file === null ? 'probe_image' : null);
  if (refusal !== null || file === null) return refused({ ok: false, reason: refusal ?? 'probe_image', detail: null });
  const probe = await runProbe(doc, file, timeoutMs);
  const c = captureSurvey(doc, { kind: 'probe', mode: 'strict', salonLabel: null, posterName: null, knownTitle: null, probe });
  return c.ok ? { type: 'cs.probe_result', capture: c.capture } : refused(c);
}
