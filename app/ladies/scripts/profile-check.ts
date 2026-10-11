import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identifyPage, salonLabelEquals, type IdentifyContext } from '../apps/extension/src/salonboard/engine/identify.js';
import { resolveAll, resolveOne, type LocateFailure } from '../apps/extension/src/salonboard/engine/locate.js';
import { anyOf, evalSignal } from '../apps/extension/src/salonboard/engine/signals.js';
import { loadConfig } from '../src/config/loader.js';
import { otherRoutesFor } from '../src/posting/profile/route-resolve.js';
import { profileHash } from '../src/posting/profile-hash.js';
import { AUTOSUBMIT_ATTR, matchProfileUrl, type LocatorSet, type PageProfile, type Signal, type SurveyCapture } from '../src/shared/protocol/index.js';
import { AUDIENCE_CATEGORIES, type AudienceCategory } from '../src/shared/types.js';
import { readCapture, SURVEY_FILE, surveyDirOf } from '../src/survey/store.js';

// `npm.cmd run profile:check -- --profile <id> --survey <file> [--audience mens|ladies]` (dev, offline): checks a page
// profile against the skeleton of an owner-approved survey with the extension's own engine (P3-R37, P3-R40, P3-R46).
// Exit code 0 only when every check line is OK. jsdom runs no script and loads nothing, so it never contacts any site.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };
type Status = 'OK' | '見つからない' | '複数一致' | '不一致' | '未対応の必須項目' | '自動送信の可能性';
type Check = { status: Status; what: string };

const USAGE = '使い方: npm.cmd run profile:check -- --profile <画面profileのID> --survey <調査結果のファイル名> [--audience mens|ladies]';
const LOCATE: Record<LocateFailure, Status> = { none: '見つからない', multiple: '複数一致', disagree: '不一致', frame: '不一致', invalid: '不一致' };

const require = createRequire(import.meta.url);
type Jsdom = new (html: string, o: { url: string; contentType: string }) => { window: Window & typeof globalThis };
const { JSDOM } = require('jsdom') as { JSDOM: Jsdom };

/** The skeleton as an XHTML document at `url` (the structure exactly as serialized; no script runs, nothing loads). */
export async function skeletonDocument(skeleton: string, url: string): Promise<Document> {
  const { window } = new JSDOM(`<html xmlns="http://www.w3.org/1999/xhtml"><head></head>${skeleton}</html>`, { url, contentType: 'application/xhtml+xml' });
  if (window.document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
  return window.document;
}

/** The captured URL (masked path, query keys); a required query key gets the profile's value, which a capture cannot know. */
function capturedUrl(c: SurveyCapture, p: PageProfile): string {
  const u = new URL(c.page.path || '/', c.page.origin);
  for (const k of c.page.query_keys) u.searchParams.append(k, p.url_match.required_query[k] ?? '');
  return u.href;
}

export function checkProfile(p: PageProfile, c: SurveyCapture, doc: Document, ctx: IdentifyContext): Check[] {
  const out: Check[] = [];
  const locate = (what: string, set: LocatorSet): Element | null => {
    const r = resolveOne(doc, set);
    out.push({ status: r.ok ? 'OK' : LOCATE[r.reason], what });
    return r.ok ? r.el : null;
  };
  const signal = (what: string, s: Signal, want: boolean): void => {
    const r = resolveOne(doc, s.locators);
    if (!r.ok && r.reason !== 'none') out.push({ status: LOCATE[r.reason], what });
    else out.push({ status: evalSignal(doc, s) === want ? 'OK' : want ? '見つからない' : '不一致', what });
  };

  const urlOk = matchProfileUrl(doc.URL, p.url_match).ok;
  out.push({ status: urlOk ? 'OK' : '不一致', what: `URL ${c.page.origin}${c.page.path}（url_match）` });
  const id = identifyPage(p, doc, ctx);
  // The survey masks page text (█), so the shop name cannot be compared offline; preflight compares it on the real page.
  const salonEl = resolveOne(doc, p.salon_identification.locators);
  const masked = salonEl.ok && (salonEl.el.textContent ?? '').includes('█');
  const idOk = id.ok || (masked && id.code === 'WRONG_SALON');
  out.push({ status: idOk ? 'OK' : '不一致', what: `画面の判定 identifyPage${id.ok ? '' : idOk ? '（店舗名は伏せ字のため実画面の確認で判定）' : `（${id.code}${id.detail === null ? '' : ` ${id.detail}`}）`}` });
  p.page_identification.all_of.forEach((s, i) => signal(`page_identification ${i + 1}`, s, true));
  const salon = locate('salon_identification（店舗名）', p.salon_identification.locators);
  if (salon !== null) {
    if (masked) out.push({ status: 'OK', what: '店舗名の表示（調査結果では伏せ字のため、実画面の確認 preflight で照合します）' });
    else out.push({ status: salonLabelEquals(salon.textContent ?? '', ctx.expectedLabel) ? 'OK' : '不一致', what: '店舗名の表示（expected_account_label）' });
  }
  const audience = p.audience_identification[ctx.audience];
  if (p.audience_mode === 'by_page' && audience !== undefined) audience.all_of.forEach((s, i) => signal(`audience_identification.${ctx.audience} ${i + 1}`, s, true));

  const fields = new Map<string, { el: Element; reloads: boolean }>();
  for (const [key, f] of Object.entries(p.fields)) {
    if (key === 'image' && p.image.modal !== undefined) {
      // The uploader dialog adds/shows its file input only after `open` is clicked; the image-attach probe checks the rest.
      locate('image.modal.open（画像アップロード画面を開く場所）', p.image.modal.open);
      continue;
    }
    const el = locate(`fields.${key}`, f.locators);
    if (el !== null) fields.set(key, { el, reloads: f.reloads_page });
  }
  locate('submit（送信ボタン）', p.submit.locators);
  if (p.submit.confirm.kind === 'in_page') locate('submit.confirm（確認ボタン）', p.submit.confirm.locators);
  if (p.poster?.mode === 'display') locate('poster（投稿者の表示）', p.poster.locators);
  if (p.hashtag.add_button !== undefined) locate('hashtag.add_button', p.hashtag.add_button);
  if (p.hashtag.added_items !== undefined) {
    const r = resolveAll(doc, p.hashtag.added_items);
    out.push({ status: r.ok ? 'OK' : LOCATE[r.reason], what: 'hashtag.added_items' });
  }
  if (p.count_display !== undefined) locate('count_display（投稿数の表示）', p.count_display.locators);
  if (c.probe?.preview_appeared === true) out.push({ status: anyOf(doc, p.image.preview) ? 'OK' : '見つからない', what: 'image.preview（画像のプレビュー）' });
  for (const [name, set] of Object.entries(p.failure_signals)) set?.any_of.forEach((s, i) => signal(`failure_signals.${name} ${i + 1}（この画面で出ていないこと）`, s, false));

  // P3-R46: required controls no field covers; P3-R40: handlers that submit, on a field not marked reloads_page.
  const coveredBy = (el: Element): [string, { el: Element; reloads: boolean }] | undefined => [...fields].find(([, f]) => f.el === el || f.el.contains(el));
  for (const control of c.forms.flatMap((f) => f.controls)) {
    if (!control.required || control.type === 'hidden' || control.disabled) continue;
    const el = control.selectors.map((s) => resolveOne(doc, [{ css: s }])).find((r) => r.ok);
    if (el === undefined || !el.ok || coveredBy(el.el) === undefined) out.push({ status: '未対応の必須項目', what: `${control.tag} ${control.name || control.id || control.type}` });
  }
  for (const el of doc.querySelectorAll(`[${AUTOSUBMIT_ATTR}]`)) {
    const hit = coveredBy(el);
    if (hit !== undefined && !hit[1].reloads) out.push({ status: '自動送信の可能性', what: `fields.${hit[0]}（reloads_page が false）` });
  }
  return out;
}

export async function profileCheck(projectRoot: string, args: string[], io: Io): Promise<number> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const profileId = opt('--profile');
  const file = opt('--survey');
  const aud = opt('--audience');
  const known = new Set(['--profile', '--survey', '--audience']);
  const stray = args.filter((a, i) => !known.has(a) && !known.has(args[i - 1] ?? ''));
  if (profileId === undefined || file === undefined || stray.length > 0 || (aud !== undefined && !AUDIENCE_CATEGORIES.includes(aud as AudienceCategory))) {
    io.stderr(USAGE);
    return 1;
  }
  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) {
    io.stderr(`設定ファイルに問題があります: ${config.issues.map((i) => `${i.file} ${i.path}: ${i.message}`).join(' / ')}`);
    return 1;
  }
  const s = config.snapshot;
  const profile = s.salonboardFields.pages[profileId];
  if (profile === undefined) {
    io.stderr(`画面profile「${profileId}」が salonboard_fields.json の pages にありません。`);
    return 1;
  }
  const name = file.endsWith('.json') ? file : `${file}.json`;
  const stored = SURVEY_FILE.test(name) ? await readCapture(await surveyDirOf(projectRoot), name) : null;
  if (stored === null || !stored.ok) {
    io.stderr(stored === null ? `調査結果が見つかりません: ${file}` : `調査結果が使えません（${stored.reason_ja}）: ${name}`);
    return 1;
  }
  if (!stored.approved) {
    io.stderr(`この調査結果はまだ店舗の方の確認が済んでいません。先に npm.cmd run survey:show -- --file ${name} --approve を実行してもらってください。`);
    return 1;
  }
  const audience = (aud as AudienceCategory | undefined) ?? profile.audiences[0]!;
  let doc: Document;
  try {
    doc = await skeletonDocument(stored.capture.skeleton_html, capturedUrl(stored.capture, profile));
  } catch {
    io.stderr(`調査結果の画面の骨組みを読み取れません: ${name}`);
    return 1;
  }
  const routes = { base: s, routes: s.salonboardFields.posting_routes };
  const checks = checkProfile(profile, stored.capture, doc, { expectedLabel: s.salon.expected_account_label ?? '', audience, otherRoutes: otherRoutesFor(routes, `${profile.post_type}.${audience}`) });
  io.stdout(`画面profile「${profileId}」を調査結果 ${name} で確認します（対象: ${audience === 'mens' ? 'メンズ' : 'レディース'}）`);
  if (s.salon.expected_account_label === null) io.stdout('【注意】salon.json の expected_account_label（画面に出る店舗名）が未設定です。');
  if (profile.submit.confirm.kind === 'confirm_page') io.stdout('（確認画面の登録ボタンは、確認画面の調査結果で確認してください）');
  if (stored.capture.probe?.preview_appeared !== true) io.stdout('（画像のプレビューは、画像添付の確認の調査結果で確認します）');
  for (const c of checks) io.stdout(`${c.status}: ${c.what}`);
  const bad = checks.filter((c) => c.status !== 'OK').length;
  // P3-R40/R46: the hash checks:record profile needs is shown only for a clean check.
  if (bad === 0) {
    io.stdout('すべて OK です。');
    io.stdout(`プロファイルの確認記号（hash）: ${profileHash(profile)}`);
  } else io.stdout(`OK でない項目が ${bad} 件あります。画面profileを直してから、もう一度確認してください（確認記号は、すべて OK のときだけ表示します）。`);
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await profileCheck(fileURLToPath(new URL('..', import.meta.url)), process.argv.slice(2), {
    stdout: (l) => process.stdout.write(`${l}\n`),
    stderr: (l) => process.stderr.write(`${l}\n`),
  });
}
