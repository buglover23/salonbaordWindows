import type { MatchKeys, PageProfile } from '../../../../../src/shared/protocol/index.js';
import { queryOne, resolveAll, resolveOne, type Root } from './locate.js';
import { compileRemoteId } from './remote-id.js';
import { normalizeForCompare, nfkcTrim } from './text.js';

// Success and reconcile verification on the post list (D7, §14.2): a title match alone is never enough. An item counts
// when its registration time falls in the match window, or (day-only dates, or no date) when its detail page shows the
// same title and the start of the body.

type ListSpec = NonNullable<PageProfile['success_signals']['list']>;
type DetailSpec = NonNullable<PageProfile['success_signals']['detail']>;

export interface ListItem {
  title: string;
  date_text: string | null;
  /** The item link's path (the navigation guard checks it before any visit). */
  link_path: string | null;
  remote_post_id: string | null;
}

/** Every item of the list; an item whose title, date or link cannot be found exactly once means the page changed. */
export function parseItems(root: Root, item: ListSpec['item'], baseUrl: string): { ok: true; items: ListItem[] } | { ok: false; detail: string } {
  const containers = resolveAll(root, item.container);
  if (!containers.ok) return { ok: false, detail: `list:${containers.reason}` };
  const remote = item.remote_id_pattern === undefined ? null : compileRemoteId(item.remote_id_pattern);
  if (item.remote_id_pattern !== undefined && remote === null) return { ok: false, detail: 'remote_id_pattern' };
  const items: ListItem[] = [];
  for (const c of containers.els) {
    const title = queryOne(c, item.title);
    if (typeof title === 'string') return { ok: false, detail: `list_title:${title}` };
    const date = item.date === undefined ? null : queryOne(c, item.date);
    if (typeof date === 'string') return { ok: false, detail: `list_date:${date}` };
    const link = item.link === undefined ? null : queryOne(c, item.link);
    if (typeof link === 'string') return { ok: false, detail: `list_link:${link}` };
    const href = link?.getAttribute('href') ?? null;
    const url = href === null ? null : URL.parse(href, baseUrl);
    items.push({
      title: nfkcTrim(title.textContent ?? ''),
      // A hidden input can carry the date (the style list's styleLastUpDate, e.g. 20261007215833000).
      date_text: date === null ? null : nfkcTrim((date.tagName === 'INPUT' ? date.getAttribute('value') : date.textContent) ?? ''),
      link_path: url?.pathname ?? null,
      remote_post_id: remote === null || url === null ? null : remote(url.pathname + url.search),
    });
  }
  return { ok: true, items };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const literal = (s: string): string => s.replace(/[.\-/]/g, '\\$&').replace(/ /g, '\\s*');

function validDate(y: number, m: number, d: number): string | null {
  const key = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === key ? key : null;
}

/**
 * A displayed date in the profile's format (YYYY, M/MM, D/DD, H/HH, mm and literal 年月日時分:/- . space), as a JST
 * date and, when the format has hours and minutes, a time. Without a year (「M月D日 H:mm」) the year is the one that puts
 * the date closest to `refDate` (the intent day), so 12月31日 seen on 1 January belongs to the previous year.
 */
export function parseDisplayedDate(text: string, format: string, refDate: string): { date: string; time: string | null } | null {
  const order: string[] = [];
  let source = '';
  let last = 0;
  for (const m of format.matchAll(/YYYY|MM?|DD?|HH?|mm/g)) {
    source += literal(format.slice(last, m.index));
    order.push(m[0][0] ?? '');
    source += m[0] === 'YYYY' ? '(\\d{4})' : m[0] === 'mm' ? '(\\d{2})' : '(\\d{1,2})';
    last = m.index + m[0].length;
  }
  source += literal(format.slice(last));
  const hit = new RegExp(source).exec(nfkcTrim(text));
  if (hit === null) return null;
  const part = (c: string): number | null => {
    const i = order.indexOf(c);
    return i < 0 ? null : Number(hit[i + 1]);
  };
  const [month, day, hour, minute] = [part('M'), part('D'), part('H'), part('m')];
  if (month === null || day === null) return null;
  let date: string | null;
  const year = part('Y');
  if (year !== null) date = validDate(year, month, day);
  else {
    const ref = Date.parse(`${refDate}T00:00:00Z`);
    const y = Number(refDate.slice(0, 4));
    const options = [y - 1, y, y + 1].map((c) => validDate(c, month, day)).filter((k): k is string => k !== null);
    date = options.sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - ref) - Math.abs(Date.parse(`${b}T00:00:00Z`) - ref))[0] ?? null;
  }
  if (date === null) return null;
  if (hour === null || minute === null) return { date, time: null };
  if (hour > 23 || minute > 59) return null;
  return { date, time: `${pad(hour)}:${pad(minute)}` };
}

/** A truncated list title must keep at least this many normalized characters to count. */
const MIN_TRUNCATED = 5;

export interface ListMatch {
  /** Title matches that are not ruled out by their date. */
  candidates: number;
  /** The one item whose time is in the window; null when there is none or more than one. */
  matched: ListItem | null;
  /**
   * Day-only (or undated, or unreadable) title matches of the intent day: each counts only if its detail page matches
   * (detailMatches). The post is identified only when `matched` plus the confirmed ones make exactly one item.
   */
  needs_detail: ListItem[];
}

export function matchItems(items: readonly ListItem[], keys: MatchKeys, spec: Pick<ListSpec['item'], 'date_format' | 'title_may_truncate'>): ListMatch {
  const refDate = keys.intent_date_jst ?? keys.window_start_jst.slice(0, 10);
  const strong: ListItem[] = [];
  const weak: ListItem[] = [];
  for (const item of items) {
    const t = normalizeForCompare(item.title);
    const titleOk = t === keys.normalized_title || (spec.title_may_truncate && [...t].length >= MIN_TRUNCATED && keys.normalized_title.startsWith(t));
    if (!titleOk) continue;
    if (keys.remote_post_id !== null && item.remote_post_id !== null && item.remote_post_id !== keys.remote_post_id) continue;
    const when = item.date_text === null || spec.date_format === undefined ? null : parseDisplayedDate(item.date_text, spec.date_format, refDate);
    if (when !== null && when.time !== null) {
      const at = `${when.date} ${when.time}`;
      if (at >= keys.window_start_jst && at <= keys.window_end_jst) strong.push(item);
    } else if (when === null || when.date === refDate) {
      weak.push(item);
    }
  }
  return {
    candidates: strong.length + weak.length,
    matched: strong.length === 1 ? (strong[0] ?? null) : null,
    needs_detail: strong.length <= 1 ? weak : [],
  };
}

/** The detail page shows exactly the title and starts with the body excerpt (both normalized for comparison). */
export function detailMatches(doc: Document, detail: DetailSpec, keys: MatchKeys): boolean {
  const title = resolveOne(doc, detail.title);
  const body = resolveOne(doc, detail.body);
  return (
    title.ok &&
    body.ok &&
    normalizeForCompare(title.el.textContent ?? '') === keys.normalized_title &&
    normalizeForCompare(body.el.textContent ?? '').startsWith(keys.body_excerpt)
  );
}
