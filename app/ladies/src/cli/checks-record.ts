import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { loadConfig, type ConfigSnapshot } from '../config/loader.js';
import type { DeploymentChecksSchema, PostingLimit, SalonboardFieldsSchema } from '../config/schemas.js';
import { buildEffectiveConfig } from '../content/effective-config.js';
import { InstructionManager } from '../content/instructions/store.js';
import { loggerFrom, redactUrl } from '../logger.js';
import { profileHash } from '../posting/profile-hash.js';
import { entryUrlSha256, verifiedProfile } from '../posting/profile/route-resolve.js';
import type { Clock } from '../shared/clock.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../shared/labels.js';
import { formatJst, jstDateKey, parseExportedAt } from '../shared/time.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type PostType } from '../shared/types.js';
import { PRODUCTION_URL_POLICY } from '../shared/url-policy.js';
import { writeFileAtomic } from '../storage/atomic-json.js';
import { resolveDataPaths } from '../storage/paths.js';
import { formatConfigIssue } from '../status.js';

// `npm.cmd run checks:record` (Plan 3 Task 5c, P3-R5, P3-R37): the owner records what they confirmed (automation
// permission, limits, counts, login conditions, the origin, profile and route verification) in config/. Each edit is
// validated with the whole config before an atomic write, and the change is shown. Agents never run it (plan section 2).

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };
type Checks = z.input<typeof DeploymentChecksSchema>;
type Fields = z.input<typeof SalonboardFieldsSchema>;
type Edit = { file: 'deployment_checks.json'; apply: (d: Checks) => void; after?: string } | { file: 'salonboard_fields.json'; apply: (f: Fields) => void; after?: string };
interface Ctx {
  o: Options;
  s: ConfigSnapshot;
  now: Date;
  today: string;
  projectRoot: string;
}

const CMD = 'npm.cmd run checks:record --';
export const RECORDED_JA = '記録しました。稼働中のツールには次の確認（30秒以内、または次の投稿の直前）で反映されます';
const LIMITS = [
  ['daily', '1日'],
  ['monthly', '1か月'],
  ['total', '累計'],
  ['image_capacity', '画像容量'],
] as const;
// Every command line shown is valid PowerShell as it stands (no unquoted | < > [ ]): the owner copies it and replaces the
// Japanese placeholders, which the checks below refuse if left in.
const AUTH_CMD = `${CMD} auth --checked-at YYYY-MM-DD --mfa "<なし/SMS/アプリ等>" --session "<期限の記載・再ログインの頻度>" --concurrent "<同時ログインの制限の記載、または 記載なし>"`;
const ORIGIN_CMD = `${CMD} origin --url "<ログイン後のアドレス欄のURL>"`;
const PROFILE_CMD = `${CMD} profile --id 画面profileの名前 --hash "<profile:check が表示した確認記号>"`;
const routeCmd = (type: PostType, audience: AudienceCategory): string => `${CMD} route --type ${type} --audience ${audience} --verified true`;
const USAGE = [
  '使い方（本番投稿の前提を記録します。オーナーが自分で確かめた内容だけを記録してください。日本語の部分と YYYY-MM-DD は、確かめた内容に書き換えます）:',
  `  ${CMD} show                     記録されている内容と、まだ記録していない項目の記録のしかたを表示します`,
  '  自動操作の可否（--status は permitted（許可）・prohibited（禁止）・unknown（未確認）のどれか）:',
  `    ${CMD} automation --status permitted --evidence "<文書名・版/確認日・該当箇所 または 運営回答の要約>" --checked-at YYYY-MM-DD`,
  '  投稿数の上限（--type は style・blog、--kind は daily・monthly・total・image_capacity のどれか）:',
  `    ${CMD} limit --type style --kind daily --status limited --value 上限の数 --unit 件 --source "<出典>" --checked-at YYYY-MM-DD`,
  `    上限が無いとき: ${CMD} limit --type style --kind daily --status unlimited --source "<出典>" --checked-at YYYY-MM-DD`,
  `    当てはまらないとき: ${CMD} limit --type style --kind image_capacity --status not_applicable --reason "<理由>"`,
  '  記録した件数（--kind は total・daily・monthly のどれか。--at は数えた日本時間で、省くと今の時刻）:',
  `    ${CMD} count --type style --kind total --value 件数 --at "YYYY-MM-DD HH:mm"`,
  '  上限まで残しておく件数（--valid-days は累計の件数を使える日数で、省けます）:',
  `    ${CMD} margin --type style --value 残す件数 --valid-days 日数`,
  `  1日・1か月の区切り: ${CMD} boundary --type style --value jst_calendar`,
  `  ログイン・認証: ${AUTH_CMD}`,
  `  接続先: ${ORIGIN_CMD}`,
  '  画面profileの確認（画面に無い欄を確認したときは --poster-absent YYYY-MM-DD や --model-info-absent YYYY-MM-DD を足します）:',
  `    ${PROFILE_CMD}`,
  '  投稿先の確認（--type は style・blog、--audience は mens・ladies。未確認に戻すときは --verified false）:',
  `    ${routeCmd('style', 'mens')}`,
];

class InputError extends Error {}
function fail(message: string): never {
  throw new InputError(message);
}

/** `--name value` pairs. Options the command did not read are refused by done(), so nothing typed is silently dropped. */
class Options {
  readonly #values = new Map<string, string>();
  readonly #used = new Set<string>();
  readonly #sub: string;

  constructor(sub: string, args: readonly string[]) {
    this.#sub = sub;
    for (let i = 0; i < args.length; i += 2) {
      const arg = args[i]!;
      if (!arg.startsWith('--')) fail(`checks:record ${sub} に指定できない引数です: ${arg}`);
      if (this.#values.has(arg.slice(2))) fail(`${arg} が2回指定されています`);
      const value = args[i + 1]?.trim();
      if (value === undefined || value === '' || value.startsWith('--')) fail(`${arg} の値を指定してください`);
      this.#values.set(arg.slice(2), value);
    }
  }

  get(name: string): string | undefined {
    this.#used.add(name);
    return this.#values.get(name);
  }

  need(name: string): string {
    return this.get(name) ?? fail(`--${name} を指定してください`);
  }

  oneOf<T extends string>(name: string, list: readonly T[]): T {
    const value = this.need(name);
    return list.find((v) => v === value) ?? fail(`--${name} には ${list.join('・')} のどれかを指定してください`);
  }

  done(context = ''): void {
    const extra = [...this.#values.keys()].find((k) => !this.#used.has(k));
    if (extra !== undefined) fail(`checks:record ${this.#sub}${context || ' '}に指定できない引数です: --${extra}`);
  }
}

function dateOf(name: string, value: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || parseExportedAt(value) === null) fail(`--${name} は実在する日付を YYYY-MM-DD の形で指定してください（例: ${today}）`);
  if (value > today) fail(`--${name} に未来の日付は指定できません（今日は ${today} です）`);
  return value;
}

function intOf(name: string, value: string, min: 0 | 1): number {
  const n = /^\d{1,9}$/.test(value) ? Number(value) : -1;
  return n >= min ? n : fail(`--${name} には${min}以上の整数を指定してください`);
}

/** 'YYYY-MM-DD HH:mm' in JST, not after now. */
function minuteOf(value: string, now: Date): string {
  const m = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const day = m === null ? null : parseExportedAt(m[1]!);
  if (m === null || day === null) fail('--at は日本時間の YYYY-MM-DD HH:mm の形で指定してください（例: 2026-10-12 10:00）');
  if (day.getTime() + (Number(m[2]) * 60 + Number(m[3])) * 60_000 > now.getTime()) fail(`--at に未来の日時は指定できません（今は ${formatJst(now)} です）`);
  return value;
}

const postType = (o: Options): PostType => o.oneOf('type', POST_TYPES);
const checksEdit = (apply: (d: Checks) => void): Edit => ({ file: 'deployment_checks.json', apply });

const HANDLERS: Record<string, (c: Ctx) => Edit | Promise<Edit>> = {
  automation({ o, today }) {
    const status = o.oneOf('status', ['permitted', 'prohibited', 'unknown'] as const);
    const evidence = o.get('evidence') ?? null;
    const at = o.get('checked-at');
    const checkedAt = at === undefined ? null : dateOf('checked-at', at, today);
    // R11: a permission is recorded only with its evidence and the date it was confirmed.
    if (status === 'permitted' && (evidence === null || checkedAt === null)) fail('自動操作を許可（permitted）と記録するには、根拠（--evidence）と確認日（--checked-at）が必要です');
    o.done();
    return checksEdit((d) => {
      d.automation = { status, evidence, checked_at: checkedAt };
    });
  },

  limit({ o, today }) {
    const type = postType(o);
    const kind = o.oneOf('kind', LIMITS.map(([k]) => k));
    const status = o.oneOf('status', ['limited', 'unlimited', 'not_applicable', 'unknown'] as const);
    const sourced = () => ({ source: o.need('source'), checked_at: dateOf('checked-at', o.need('checked-at'), today) });
    const limit: PostingLimit =
      status === 'limited'
        ? { status, value: intOf('value', o.need('value'), 0), unit: o.need('unit'), ...sourced() }
        : status === 'unlimited'
          ? { status, ...sourced() }
          : status === 'not_applicable'
            ? { status, reason: o.need('reason') }
            : { status };
    o.done(`（--status ${status}）`);
    return checksEdit((d) => {
      d.posting_limits[type][kind] = limit;
    });
  },

  count({ o, now }) {
    const type = postType(o);
    const kind = o.oneOf('kind', ['total', 'daily', 'monthly'] as const);
    const value = intOf('value', o.need('value'), 0);
    const at = o.get('at');
    const countedAt = at === undefined ? formatJst(now) : minuteOf(at, now);
    o.done();
    return checksEdit((d) => {
      const l = d.posting_limits[type];
      if (kind === 'total') {
        l.current_count = value;
        l.counted_at = countedAt;
      } else l[kind === 'daily' ? 'daily_count' : 'monthly_count'] = { value, counted_at: countedAt };
    });
  },

  margin({ o }) {
    const type = postType(o);
    const margin = intOf('value', o.need('value'), 0);
    const days = o.get('valid-days');
    const validDays = days === undefined ? null : intOf('valid-days', days, 1);
    o.done();
    return checksEdit((d) => {
      d.posting_limits[type].safety_margin = margin;
      if (validDays !== null) d.posting_limits[type].count_valid_days = validDays;
    });
  },

  boundary({ o }) {
    const type = postType(o);
    if (o.need('value') !== 'jst_calendar') {
      fail('--value に指定できるのは jst_calendar（日本時間の暦日・暦月で数える）だけです。SALON BOARD の数え方が違うときは記録せず、開発担当に知らせてください');
    }
    o.done();
    return checksEdit((d) => {
      d.posting_limits[type].quota_period_boundary = 'jst_calendar';
    });
  },

  auth({ o, today }) {
    const authentication = {
      checked_at: dateOf('checked-at', o.need('checked-at'), today),
      mfa_mode: o.need('mfa'),
      session_expiry_policy: o.need('session'),
      concurrent_sessions: o.need('concurrent'),
    };
    o.done();
    return checksEdit((d) => {
      d.authentication = authentication;
    });
  },

  origin({ o }) {
    // Only the origin is kept: the path and the query (which may hold a session value) are never stored or shown.
    const url = URL.parse(o.need('url'));
    if (url === null) fail('--url は使えません: URLとして読み取れません（アドレス欄のURLを https:// から全部コピーしてください）');
    const reason = PRODUCTION_URL_POLICY.checkOrigin(url.origin);
    if (reason !== null) fail(`--url は使えません: ${reason}`);
    o.done();
    return {
      file: 'salonboard_fields.json',
      apply: (f) => {
        f.allowed_origins = [url.origin];
      },
      after: '次に npm.cmd run build:extension を実行し、chrome://extensions で拡張機能を再読み込みしてください',
    };
  },

  profile({ o, s, today }) {
    const id = o.need('id');
    const hash = o.need('hash').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) fail('--hash には profile:check が表示した確認記号（64桁）を指定してください');
    const page = Object.hasOwn(s.salonboardFields.pages, id) ? s.salonboardFields.pages[id] : undefined;
    if (page === undefined) fail(`画面profile「${id}」は salonboard_fields.json の pages にありません`);
    const optionalDate = (name: string): string | undefined => {
      const v = o.get(name);
      return v === undefined ? undefined : dateOf(name, v, today);
    };
    const posterAbsent = optionalDate('poster-absent');
    const modelInfoAbsent = optionalDate('model-info-absent');
    o.done();
    // P3-R37: the owner's check counts only for the content profile:check hashed.
    if (hash !== profileHash(page)) fail('画面設定が確認後に変更されています。profile:check をやり直してください');
    return {
      file: 'salonboard_fields.json',
      apply: (f) => {
        const p = f.pages[id]!;
        p.verified_at = today;
        p.verified_hash = hash;
        if (posterAbsent !== undefined || modelInfoAbsent !== undefined) {
          const was = page.owner_attestations;
          p.owner_attestations = { poster_absent_on: posterAbsent ?? was.poster_absent_on, model_info_absent_on: modelInfoAbsent ?? was.model_info_absent_on };
        }
      },
    };
  },

  async route({ o, s, now, today, projectRoot }) {
    const type = postType(o);
    const audience = o.oneOf('audience', AUDIENCE_CATEGORIES);
    const verified = o.oneOf('verified', ['true', 'false'] as const) === 'true';
    o.done();
    if (!verified) {
      return checksEdit((d) => {
        d.page_routes_verified[type][audience] = false;
      });
    }
    const label = `${POST_TYPE_JA[type]}・${AUDIENCE_JA[audience]}`;
    const target = await effectiveRoute(projectRoot, s, now, type, audience);
    const url = target.entry_url;
    if (url === null) fail(`${label}の投稿先URLが未設定です（salonboard_fields.json の posting_routes.${type}.${audience}.entry_url、または instructions フォルダの 投稿先URL設定.md）`);
    const id = target.page_profile_id;
    const profile = verifiedProfile(s, id);
    if (id === null || profile === null) {
      fail(`${label}の画面profile（${id ?? '未設定'}）は確認済みではありません。先に ${CMD} profile --id ${id ?? '画面profileの名前'} --hash "<profile:check が表示した確認記号>" を実行してください`);
    }
    // P3-R37: bound to the profile content and to the URL the tool would open now (config plus instructions).
    const record = { verified: true as const, profile_id: id, profile_hash: profileHash(profile), entry_url_sha256: entryUrlSha256(url), entry_url_display: redactUrl(url), checked_at: today };
    return checksEdit((d) => {
      d.page_routes_verified[type][audience] = record;
    });
  },
};

/** The route as the running tool sees it: config/ with the instruction URL overlay, read without writing anything. */
async function effectiveRoute(projectRoot: string, s: ConfigSnapshot, now: Date, type: PostType, audience: AudienceCategory) {
  const paths = resolveDataPaths(projectRoot, s.settings);
  const manager = new InstructionManager({ dir: paths.instructionsDir, recordFile: paths.instructionsFile, config: () => s, logger: loggerFrom(() => undefined), readOnly: true });
  const scan = await manager.scan(now);
  return buildEffectiveConfig(s, scan.overlay, scan.applied).routes[type][audience];
}

/** One line per changed leaf ("a.b: before → after"); objects are compared key by key, anything else as a whole. */
function diffLines(a: unknown, b: unknown, path: string): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObject(a) && isObject(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffLines(a[k], b[k], path === '' ? k : `${path}.${k}`));
  const show = (v: unknown): string => (v === undefined ? '（なし）' : JSON.stringify(v));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path}: ${show(a)} → ${show(b)}`];
}

async function write(configDir: string, edit: Edit, io: Io): Promise<number> {
  const path = join(configDir, edit.file);
  const raw = await readFile(path, 'utf8');
  // The file as written (defaults stay implicit); a Notepad BOM is dropped.
  const before: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const after = structuredClone(before);
  (edit.apply as (json: unknown) => void)(after);
  const changes = diffLines(before, after, '');
  if (changes.length === 0) {
    io.stdout('記録済みの内容と同じため、変更はありません。');
    return 0;
  }
  const text = `${JSON.stringify(after, null, 2)}\n`;
  const check = await loadConfig(configDir, { [edit.file]: text });
  if (!check.ok) {
    io.stderr('記録すると設定に誤りが出るため、記録しませんでした（次の箇所）:');
    for (const issue of check.issues) io.stderr(`  ${formatConfigIssue(issue)}`);
    return 1;
  }
  io.stdout(`${join('config', edit.file)} を次のとおり変更します:`);
  for (const line of changes) io.stdout(`  ${line}`);
  await writeFileAtomic(path, text);
  io.stdout(RECORDED_JA);
  if (edit.after !== undefined) io.stdout(edit.after);
  return 0;
}

function limitJa(l: PostingLimit): string {
  switch (l.status) {
    case 'unknown':
      return '未確認';
    case 'unlimited':
      return `上限なし（出典: ${l.source}、確認日: ${l.checked_at}）`;
    case 'limited':
      return `上限 ${l.value}${l.unit}（出典: ${l.source}、確認日: ${l.checked_at}）`;
    case 'not_applicable':
      return `対象外（理由: ${l.reason}）`;
  }
}

const AUTOMATION_JA = { unknown: '未確認', permitted: '許可', prohibited: '禁止' } as const;

function showLines(s: ConfigSnapshot): string[] {
  const d = s.deploymentChecks;
  const f = s.salonboardFields;
  const lines = ['本番投稿の前提として記録されている内容（config フォルダの deployment_checks.json と salonboard_fields.json）:'];
  const a = d.automation;
  lines.push(`自動操作の可否: ${AUTOMATION_JA[a.status]}${a.status === 'unknown' ? '' : `（根拠: ${a.evidence ?? '未記録'}、確認日: ${a.checked_at ?? '未記録'}）`}`);
  if (a.status === 'unknown' || (a.status === 'permitted' && (a.evidence === null || a.checked_at === null))) {
    lines.push(`  → 確認したら（禁止と確認したときは --status prohibited）: ${CMD} automation --status permitted --evidence "<文書名・版/確認日・該当箇所 または 運営回答の要約>" --checked-at YYYY-MM-DD`);
  }
  const au = d.authentication;
  lines.push(
    au.checked_at === null
      ? 'ログイン・認証: 未記録'
      : `ログイン・認証: 確認日 ${au.checked_at}、2段階認証: ${au.mfa_mode ?? '未記録'}、ログインの期限: ${au.session_expiry_policy ?? '未記録'}、同時ログインの制限: ${au.concurrent_sessions ?? '未記録'}`,
  );
  if (au.checked_at === null || au.concurrent_sessions === null) lines.push(`  → ${AUTH_CMD}`);
  lines.push(`接続先（allowed_origins）: ${f.allowed_origins.length === 0 ? '未記録' : f.allowed_origins.join('、')}`);
  if (f.allowed_origins.length === 0) lines.push(`  → ${ORIGIN_CMD}`);

  const count = (c: { value: number; counted_at: string | null } | null): string => (c === null ? 'なし' : `${c.value}件（${c.counted_at ?? '日時なし'} 時点）`);
  const unit = (v: number | null, u: string): string => (v === null ? '未記録' : `${v}${u}`);
  for (const type of POST_TYPES) {
    const l = d.posting_limits[type];
    lines.push(`${POST_TYPE_JA[type]}の投稿数の上限:`);
    for (const [kind, label] of LIMITS) lines.push(`  ${label}: ${limitJa(l[kind])}`);
    lines.push(
      `  記録した件数: 累計 ${count(l.current_count === null ? null : { value: l.current_count, counted_at: l.counted_at })}、1日 ${count(l.daily_count)}、1か月 ${count(l.monthly_count)}`,
    );
    lines.push(`  上限まで残しておく件数: ${unit(l.safety_margin, '件')}、累計の件数を使える日数: ${unit(l.count_valid_days, '日')}、1日・1か月の区切り: ${l.quota_period_boundary ?? '未記録'}`);
    if (LIMITS.some(([kind]) => l[kind].status === 'unknown') || l.safety_margin === null) {
      lines.push(`  → 上限（--kind は daily・monthly・total・image_capacity のどれか。上限が無いときは --status unlimited）: ${CMD} limit --type ${type} --kind daily --status limited --value 上限の数 --unit 件 --source "<出典>" --checked-at YYYY-MM-DD`);
      lines.push(`  → 件数（--kind は total・daily・monthly のどれか）: ${CMD} count --type ${type} --kind total --value 件数`);
      lines.push(`  → 上限まで残しておく件数: ${CMD} margin --type ${type} --value 残す件数`);
      lines.push(`  → 1日・1か月の区切り: ${CMD} boundary --type ${type} --value jst_calendar`);
    }
  }

  const pages = Object.entries(f.pages);
  lines.push(pages.length === 0 ? '画面profile: まだありません（開発担当が画面の調査結果から作ります）' : '画面profile:');
  for (const [id, page] of pages) {
    const state =
      page.verified_at === null ? '未確認' : verifiedProfile(s, id) === null ? '確認後に変更があります（profile:check と checks:record profile をやり直してください）' : `確認済み（${page.verified_at}）`;
    lines.push(`  ${id}（${POST_TYPE_JA[page.post_type]}・${page.audiences.map((x) => AUDIENCE_JA[x]).join('・')}）: ${state}`);
  }
  lines.push('投稿先の確認:');
  const todo: string[] = [];
  for (const type of POST_TYPES) {
    for (const audience of AUDIENCE_CATEGORIES) {
      const r = d.page_routes_verified[type][audience];
      const label = `${POST_TYPE_JA[type]}・${AUDIENCE_JA[audience]}`;
      if (typeof r === 'boolean') todo.push(`  → 続けて ${label}: ${routeCmd(type, audience)}`);
      const state = r === false ? '未確認' : r === true ? '確認済み（古い形式です。checks:record route で記録し直してください）' : `確認済み（${r.checked_at}、画面profile ${r.profile_id}、${r.entry_url_display}）`;
      lines.push(`  ${label}: ${state}`);
    }
  }
  if (todo.length > 0) lines.push(`  → 画面を確認したら、画面profileごとに: ${PROFILE_CMD}`, ...todo);
  return lines;
}

export async function checksRecordCommand(projectRoot: string, args: readonly string[], io: Io, clock: Clock): Promise<number> {
  const [sub = '', ...rest] = args;
  try {
    if (sub !== 'show' && !Object.hasOwn(HANDLERS, sub)) fail(`checks:record の後に、次のどれかを指定してください: show・${Object.keys(HANDLERS).join('・')}`);
    const o = new Options(sub, rest);
    const configDir = join(projectRoot, 'config');
    const loaded = await loadConfig(configDir);
    if (!loaded.ok) {
      io.stderr('設定ファイルに誤りがあるため、記録できません。次の箇所を直して保存してください:');
      for (const issue of loaded.issues) io.stderr(`  ${formatConfigIssue(issue)}`);
      return 1;
    }
    if (sub === 'show') {
      o.done();
      for (const line of showLines(loaded.snapshot)) io.stdout(line);
      return 0;
    }
    const now = clock.now();
    const edit = await HANDLERS[sub]!({ o, s: loaded.snapshot, now, today: jstDateKey(now), projectRoot });
    return await write(configDir, edit, io);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    io.stderr(err.message);
    // npm keeps --options for itself when the "--" after the script name is missing.
    if (sub !== '' && !rest.some((a) => a.startsWith('--'))) io.stderr('npm.cmd run checks:record の後ろに -- を付けたか確認してください（例: npm.cmd run checks:record -- automation --status …）。');
    for (const line of USAGE) io.stderr(line);
    return 1;
  }
}
