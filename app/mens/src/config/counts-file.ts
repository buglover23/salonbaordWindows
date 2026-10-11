import { validateScheduleCapacity } from '../execution/slots.js';
import { AUDIENCE_JA } from '../shared/labels.js';
import type { AudienceCategory } from '../shared/types.js';
import type { Categories, Salon, ScheduleConfig } from './schemas.js';

// The owner's per-audience counts and coupons file in the instruction folder (件数とクーポン（メンズ）.txt): plain
// 'key: value' lines that override schedule.json style/blog_posts_per_day and salon.json coupons for the copy of the tool
// that handles that one audience. '.txt', so the instruction loader (*.md only) never reads it. A file with any bad line
// is not used at all (the JSON values stay in force), never half-applied.

const STYLE_KEY = 'スタイルの件数';
const BLOG_KEY = 'ブログの件数';
const DEFAULT_COUPON_KEY = 'いつものクーポン';
const CATEGORY_COUPON_PREFIX = 'クーポン・';
const NONE = 'なし';
const MAX_POSTS = 100; // as schedule.json (postsPerDay)

export const countsFileName = (audience: AudienceCategory): string => `件数とクーポン（${AUDIENCE_JA[audience]}）.txt`;

/** What the file sets; a key it leaves out keeps the JSON value. A category coupon of null removes that category's coupon. */
export interface CountsOverride {
  style?: number;
  blog?: number;
  couponDefault?: string | null;
  byCategory: Record<string, string | null>;
  /** Line numbers of the two counts (for the capacity message). */
  lines?: { style?: number; blog?: number };
}

/** How the counts file stood when the config was read (ConfigSnapshot.countsFile). */
export interface CountsFileState {
  /** Absolute path. */
  path: string;
  /** applied: its values are in the snapshot; missing / invalid / unreadable: the JSON values are. */
  state: 'applied' | 'missing' | 'invalid' | 'unreadable';
  /** Japanese, one per problem (invalid / unreadable only). */
  issues: string[];
}

/** This audience's categories, each id once (the other audience's ids are not usable in this file). */
const myCategories = (c: Categories, audience: AudienceCategory): Categories['style_categories'] =>
  [...c.style_categories, ...c.blog_categories].filter((x, i, all) => x.audiences.includes(audience) && all.findIndex((y) => y.id === x.id) === i);

/** Parses the file text (BOM, CRLF, full-width colon and digits allowed; '#' lines and blank lines skipped). */
export function parseCountsFile(
  text: string,
  categories: Categories,
  audience: AudienceCategory,
): { ok: true; value: CountsOverride } | { ok: false; issues: string[] } {
  const ids = new Set(myCategories(categories, audience).map((c) => c.id));
  const value: CountsOverride = { byCategory: {}, lines: {} };
  const issues: string[] = [];
  const seen = new Set<string>();
  text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .forEach((raw, i) => {
      const at = `${i + 1}行目`;
      const line = raw.normalize('NFKC').trim();
      if (line === '' || line.startsWith('#')) return;
      const colon = line.indexOf(':');
      if (colon < 0) {
        issues.push(`${at}: 「名前: 値」の形で書いてください（例: ${STYLE_KEY}: 10）`);
        return;
      }
      const key = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      if (seen.has(key)) {
        issues.push(`${at}: 「${key}」が2回書かれています（1回だけにしてください）`);
        return;
      }
      seen.add(key);
      if (key === STYLE_KEY || key === BLOG_KEY) {
        const m = /^(\d{1,3})件?$/.exec(v);
        const n = m === null ? NaN : Number(m[1]);
        if (!(n >= 0 && n <= MAX_POSTS)) issues.push(`${at}: ${key}は 0〜${MAX_POSTS} の整数で書いてください（いま: 「${v}」）`);
        else if (key === STYLE_KEY) [value.style, value.lines!.style] = [n, i + 1];
        else [value.blog, value.lines!.blog] = [n, i + 1];
      } else if (key === DEFAULT_COUPON_KEY) {
        if (v === '') issues.push(`${at}: ${key}の名前が空です（使わないときは「${NONE}」と書きます）`);
        else value.couponDefault = v === NONE ? null : v;
      } else if (key.startsWith(CATEGORY_COUPON_PREFIX)) {
        const id = key.slice(CATEGORY_COUPON_PREFIX.length).trim();
        if (!ids.has(id)) issues.push(`${at}: カテゴリー「${id}」は${AUDIENCE_JA[audience]}のカテゴリーにありません（使える名前: ${[...ids].join(', ')}）`);
        else if (v === '') issues.push(`${at}: ${key}の名前が空です（使わないときは「${NONE}」と書きます）`);
        else value.byCategory[id] = v === NONE ? null : v;
      } else {
        issues.push(`${at}: 「${key}」は使えない名前です（${STYLE_KEY}・${BLOG_KEY}・${DEFAULT_COUPON_KEY}・${CATEGORY_COUPON_PREFIX}<カテゴリー>）`);
      }
    });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** schedule.json and salon.json with the file's values; the schedule capacity rule of the config applies unchanged. */
export function applyCountsOverride(
  o: CountsOverride,
  schedule: ScheduleConfig,
  salon: Salon,
): { ok: true; schedule: ScheduleConfig; salon: Salon } | { ok: false; issues: string[] } {
  const next: ScheduleConfig = { ...schedule, style_posts_per_day: o.style ?? schedule.style_posts_per_day, blog_posts_per_day: o.blog ?? schedule.blog_posts_per_day };
  const capacity = validateScheduleCapacity(next);
  if (capacity.length > 0) {
    // Only the two counts can be changed in this file, so name their lines instead of the "widen the hours" advice.
    const where = (key: string, line: number | undefined, n: number): string => (line === undefined ? `${key}（このファイルに無いので config の ${n}）` : `${key}（${line}行目）`);
    const sum = `${where(STYLE_KEY, o.lines?.style, next.style_posts_per_day)}と${where(BLOG_KEY, o.lines?.blog, next.blog_posts_per_day)}の合計が多すぎます`;
    return { ok: false, issues: capacity.map((c) => `${sum}。${c.replace('投稿数を減らすか、投稿時間を広げてください。', '件数を減らしてください。')}`) };
  }
  const byCategory: Record<string, string> = { ...salon.coupons.by_category };
  for (const [id, name] of Object.entries(o.byCategory)) {
    if (name === null) delete byCategory[id];
    else byCategory[id] = name;
  }
  const coupons = { default: o.couponDefault === undefined ? salon.coupons.default : o.couponDefault, by_category: byCategory };
  return { ok: true, schedule: next, salon: { ...salon, coupons } };
}

/** The file as first written from the current JSON values (CRLF and a BOM, for Notepad). */
export function renderCountsFile(audience: AudienceCategory, schedule: ScheduleConfig, salon: Salon, categories: Categories): string {
  const ja = AUDIENCE_JA[audience];
  const mine = myCategories(categories, audience);
  const ids = new Set(mine.map((c) => c.id));
  const lines = [
    `# ${countsFileName(audience)}`,
    `# ${ja}のツールの1日の件数とクーポンです。書き換えて保存すると、30秒ほどで反映されます。`,
    '# 1行に1つ「名前: 値」で書きます。# で始まる行は読みません。',
    '# 誤りがあると、直すまでこのファイルは使わず、前からの設定（config フォルダ）の値で動きます（npm.cmd run status に理由が出ます）。',
    '# クーポンの名前は SALON BOARD に出ているとおりに書きます。「なし」と書くと、そのクーポンは選びません。',
    `# クーポン・<名前> に使える名前: ${mine.map((c) => `${c.id}（${c.label}）`).join('、')}`,
    '',
    `${STYLE_KEY}: ${schedule.style_posts_per_day}`,
    `${BLOG_KEY}: ${schedule.blog_posts_per_day}`,
    `${DEFAULT_COUPON_KEY}: ${salon.coupons.default ?? NONE}`,
    ...Object.entries(salon.coupons.by_category)
      .filter(([id]) => ids.has(id))
      .map(([id, name]) => `${CATEGORY_COUPON_PREFIX}${id}: ${name}`),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
