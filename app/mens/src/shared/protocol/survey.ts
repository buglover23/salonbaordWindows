import { z } from 'zod';

// A survey capture (D9, P3-R45): a sanitized outline plus a text-masked DOM skeleton of the page the owner had open.
// Untrusted data. The content script masks, and Node masks every string again before storing (Node is authoritative).

// ---------------------------------------------------------------- masking (shared by the content script and Node)

const DASH = '[-‐‑‒–—―ー−]';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = new RegExp(`(?<!\\d)(?:\\d{2,4}${DASH}\\d{2,4}${DASH}\\d{3,4}|\\d{10,11})(?!\\d)`, 'g');
const POSTAL = new RegExp(`〒?(?<!\\d)\\d{3}${DASH}\\d{4}(?!\\d)`, 'g');
// An honorific with the token before it (up to 10 characters; one more space-separated token for 「山田 花子 様」).
// Tokens never contain markup characters, so the same pass is safe on serialized HTML.
const TOKEN = '[^\\s<>"\'&;]{1,10}';
const HONORIFIC_WORD = `${TOKEN}\\s?(?:様|さん|殿|御中|ちゃん|くん)`;
const HONORIFIC = new RegExp(`(?:${TOKEN}\\s+)?${HONORIFIC_WORD}`, 'gu');
// Control and bidi-override characters never reach a terminal or a file.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

const base = (s: string): string => s.normalize('NFKC').replace(CONTROL, '').replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(POSTAL, '[postal]');

/** Emails, phone numbers, postal codes, runs of 6+ digits and honorifics with their name (over-masking is accepted). */
export const maskSensitiveText = (s: string): string => base(s).replace(/\d{6,}/g, '[digits]').replace(HONORIFIC, '[name]');

/** Attribute values follow the text rules (`customer_1234567` → `customer_[digits]`). */
export const maskAttrValue = maskSensitiveText;

/** Per path segment (decoded): the text rules, with runs of 4+ digits as `[n]` (`/reserve/123456/detail` → `/reserve/[n]/detail`). */
export function maskPath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {
        // kept as written
      }
      return base(d).replace(/\d{4,}/g, '[n]').replace(HONORIFIC, '[name]');
    })
    .join('/');
}

/** Phone, email and honorific hits before masking (a page with more than 30 is not captured). */
export const sensitiveHits = (s: string): number => {
  const t = s.normalize('NFKC');
  return (t.match(EMAIL)?.length ?? 0) + (t.match(PHONE)?.length ?? 0) + (t.match(new RegExp(HONORIFIC_WORD, 'gu'))?.length ?? 0);
};
export const MAX_SENSITIVE_HITS = 30;

/** Attributes Node refuses to find in a stored skeleton (the content script's two hint markers excepted). */
export const FORBIDDEN_SKELETON_ATTR = /[\s"'/](aria-label|title|alt|placeholder|on[a-z]+|src|data-(?!survey-(?:inline-confirm|autosubmit)=)[a-z-]+)\s*=/i;
/** The two hint markers the content script puts on elements whose handlers call confirm( or submit( (P3-R40). */
export const INLINE_CONFIRM_ATTR = 'data-survey-inline-confirm';
export const AUTOSUBMIT_ATTR = 'data-survey-autosubmit';

const count = z.number().int().nonnegative();
/** Already masked by the content script; Node masks again. */
const masked = z.string().max(200);
const short = z.string().max(40);
const selectors = z.array(z.string().max(300)).max(5);
const queryKeys = z.array(z.string().max(100)).max(50);
const textKind = z.enum(['date_like', 'number', 'text', 'empty']);
const hints = { inline_confirm_hint: z.boolean(), autosubmit_hint: z.boolean() };

const ControlSchema = z.strictObject({
  tag: z.string().max(20),
  type: z.string().max(30),
  name: masked,
  id: masked,
  classes: z.array(masked).max(3),
  label_text: masked,
  required: z.boolean(),
  maxlength: count.nullable(),
  disabled: z.boolean(),
  hidden: z.boolean(),
  accept: z.string().max(100).optional(),
  multiple: z.boolean().optional(),
  options: z.array(z.strictObject({ value: masked, text: masked, selected: z.boolean() })).max(100).optional(),
  default_checked: z.boolean().optional(),
  ...hints,
  selectors,
});

export const SurveyCaptureSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.enum(['form', 'page', 'probe']),
  mode: z.enum(['owner', 'strict']),
  /** Informational only. */
  captured_local_at: short,
  known_title_used: z.boolean(),
  page: z.strictObject({
    origin: z.string().max(200),
    path: masked,
    query_keys: queryKeys,
    title_text: short,
    character_set: short,
    /** A login page is never captured. */
    has_password_input: z.literal(false),
    iframes: z.array(z.strictObject({ kind: z.enum(['same', 'cross', 'about']) })).max(50),
  }),
  headings: z.array(z.strictObject({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: short, selectors })).max(100),
  forms: z
    .array(
      z.strictObject({
        selectors,
        action_path: masked.nullable(),
        method: z.string().max(10),
        enctype: short,
        accept_charset: short,
        controls: z.array(ControlSchema).max(300),
      }),
    )
    .max(10),
  buttons: z.array(z.strictObject({ text: masked, type: z.string().max(20), selectors, ...hints })).max(100),
  links: z
    .array(
      z.strictObject({
        text_kind: textKind,
        path: masked,
        query_keys: queryKeys,
        selectors,
        in_form: z.boolean(),
        /** In-form links only. */
        text: masked.nullable(),
      }),
    )
    .max(100),
  salon_anchors: z.array(z.strictObject({ selectors, matched: z.enum(['expected_account_label', 'poster_name']) })).max(20),
  known_title_anchors: z.array(z.strictObject({ selectors })).max(20),
  repeated_blocks: z
    .array(
      z.strictObject({
        container_selector: z.string().max(300),
        count,
        sample: z
          .array(
            z.strictObject({
              selector: z.string().max(300),
              tag: z.string().max(20),
              text_kind: textKind,
              text_len: count,
              date_format_guess: z.string().max(30).nullable(),
              /** Only a date-like text, the exact salon label, the exact known title or a table header. */
              text: masked.nullable(),
            }),
          )
          .max(50),
      }),
    )
    .max(5),
  counters: z.array(z.strictObject({ selectors, text: z.string().regex(/^[0-9/]*$/).max(40) })).max(20),
  probe: z
    .strictObject({
      file_input_found: z.enum(['unique', 'none', 'multiple']),
      accepted: z.boolean(),
      native_change_fired: z.boolean(),
      input_event_fired: z.boolean(),
      preview_appeared: z.boolean(),
      preview_ms: count.nullable(),
      upload_error_signal: z.boolean(),
      tab_hidden: z.boolean(),
      files_length_after: count,
    })
    .nullable(),
  /** Sanitized; serialized with XMLSerializer, never assigned back into a page. */
  skeleton_html: z.string().max(600 * 1024),
});
export type SurveyCapture = z.infer<typeof SurveyCaptureSchema>;
