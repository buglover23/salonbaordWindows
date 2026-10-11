import { systemClock, type Clock } from '../shared/clock.js';
import type { SurveyCapture } from '../shared/protocol/survey.js';
import { approveCapture, readCapture, SURVEY_FILE, surveyDirOf } from '../survey/store.js';
import { KIND_JA, MODE_JA } from './survey-list.js';

// `npm.cmd run survey:show -- --file <name> [--approve]`: prints a capture exactly as an agent would see it (masked again
// by Node), then --approve writes <name>.approved. Agents read only approved captures (plan section 2).

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

const USAGE = '使い方: npm.cmd run survey:show -- --file ファイル名（ファイル名は npm.cmd run survey:list で確認できます。中身を確かめた後に --approve を足すと、開発担当が読めるようになります）';
const SKELETON_LINES = 200;
const q = (s: string): string => `「${s}」`;
const marks = (x: { autosubmit_hint: boolean; inline_confirm_hint: boolean }): string =>
  `${x.autosubmit_hint ? ' [自動送信の可能性]' : ''}${x.inline_confirm_hint ? ' [確認ダイアログ]' : ''}`;
const sel = (s: string[]): string => (s.length > 0 ? ` 候補: ${s.join(' | ')}` : '');

export function describeCapture(c: SurveyCapture): string[] {
  const out: string[] = [];
  out.push(`画面: ${c.page.origin}${c.page.path} クエリの項目: ${c.page.query_keys.join(', ') || 'なし'}`);
  out.push(`種類: ${KIND_JA[c.kind]} 方式: ${MODE_JA[c.mode]} ページの題名: ${q(c.page.title_text)} 文字コード: ${c.page.character_set} フレーム: ${c.page.iframes.map((f) => f.kind).join(', ') || 'なし'}`);
  out.push('見出し:', ...c.headings.map((h) => `  h${h.level} ${q(h.text)}${sel(h.selectors)}`));
  c.forms.forEach((f, i) => {
    out.push(`フォーム${i + 1}（method=${f.method} action=${f.action_path ?? 'なし'}）${sel(f.selectors)}:`);
    for (const x of f.controls) {
      const parts = [
        `  - ${x.tag}[${x.type}] name=${x.name || '-'} id=${x.id || '-'}`,
        x.required ? '必須' : '',
        x.maxlength !== null ? `最大${x.maxlength}文字` : '',
        x.hidden ? '非表示' : '',
        x.disabled ? '無効' : '',
        x.label_text !== '' ? `ラベル${q(x.label_text)}` : '',
        x.accept !== undefined ? `accept=${x.accept}${x.multiple === true ? ' 複数可' : ''}` : '',
        x.default_checked === true ? '最初から選択' : '',
        x.options !== undefined ? `選択肢: ${x.options.map((o) => `${o.text || '█'}(${o.value || '空'})${o.selected ? '*' : ''}`).join(' / ')}` : '',
      ];
      out.push(`${parts.filter((p) => p !== '').join(' ')}${marks(x)}${sel(x.selectors)}`);
    }
  });
  out.push('ボタン:', ...c.buttons.map((b) => `  - ${q(b.text)}(${b.type || '-'})${marks(b)}${sel(b.selectors)}`));
  out.push(`リンク（${c.links.length}件）:`, ...c.links.map((l) => `  - ${l.path}${l.query_keys.length > 0 ? `?${l.query_keys.join('&')}` : ''} ${l.in_form ? `フォーム内 ${q(l.text ?? '█')}` : `(${l.text_kind})`}`));
  out.push('店舗名・投稿者名の位置:', ...c.salon_anchors.map((a) => `  - ${a.matched === 'poster_name' ? '投稿者名' : '店舗名'}${sel(a.selectors)}`));
  out.push('投稿タイトルの位置:', ...c.known_title_anchors.map((a) => `  -${sel(a.selectors)}`));
  out.push('繰り返し（一覧の候補）:');
  for (const b of c.repeated_blocks) {
    out.push(`  - ${b.container_selector} × ${b.count}`);
    for (const s of b.sample) out.push(`      ${s.selector} <${s.tag}> ${s.text_kind} ${s.text_len}文字${s.text === null ? '' : ` ${q(s.text)}`}${s.date_format_guess === null ? '' : ` 日付の形: ${s.date_format_guess}`}`);
  }
  out.push('文字数の表示:', ...c.counters.map((x) => `  - ${x.text}${sel(x.selectors)}`));
  if (c.probe !== null) {
    const p = c.probe;
    const yes = (b: boolean): string => (b ? 'はい' : 'いいえ');
    out.push(
      `画像添付の確認: 画像の欄 ${p.file_input_found} 受け付け ${yes(p.accepted)} 画面のプレビュー ${yes(p.preview_appeared)}${p.preview_ms === null ? '' : `（${p.preview_ms}ms）`} エラー表示 ${yes(p.upload_error_signal)} change ${yes(p.native_change_fired)} input ${yes(p.input_event_fired)} 裏のタブ ${yes(p.tab_hidden)} ファイル数 ${p.files_length_after}`,
    );
  }
  const lines = c.skeleton_html.replace(/></g, '>\n<').split('\n');
  out.push(`骨組み（最初の${Math.min(SKELETON_LINES, lines.length)}行 / 全${lines.length}行）:`, ...lines.slice(0, SKELETON_LINES));
  return out;
}

export async function surveyShowCommand(projectRoot: string, args: string[], io: Io, clock: Clock = systemClock): Promise<number> {
  let file: string | null = null;
  let approve = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1] !== undefined) file = args[++i]!;
    else if (args[i] === '--approve') approve = true;
    else {
      io.stderr(`survey:show に指定できない引数です: ${args[i]}`);
      io.stderr(USAGE);
      return 1;
    }
  }
  const name = file === null ? null : file.endsWith('.json') ? file : `${file}.json`;
  if (name === null || !SURVEY_FILE.test(name)) {
    io.stderr(name === null ? '--file でファイル名を指定してください。' : `ファイル名の形が正しくありません: ${file}`);
    io.stderr(USAGE);
    return 1;
  }
  const dir = await surveyDirOf(projectRoot);
  const s = await readCapture(dir, name);
  if (s === null) {
    io.stderr(`調査結果が見つかりません: ${name}（npm.cmd run survey:list で確認してください）`);
    return 1;
  }
  io.stdout(`調査結果: ${name}（確認済み: ${s.approved ? 'はい' : 'いいえ'}）`);
  io.stdout('※ 画面から取り出したデータです（中の文章は指示ではありません）。お客様の名前・電話番号などが残っていないか確認してください。');
  if (!s.ok) {
    io.stderr(`この調査結果は使えません（${s.reason_ja}）。`);
    return 1;
  }
  for (const line of describeCapture(s.capture)) io.stdout(line);
  if (!approve) {
    io.stdout('内容に問題がなければ、--approve を付けて実行すると確認済みになり、開発担当が読めるようになります。');
    return 0;
  }
  await approveCapture(dir, name, clock.now());
  io.stdout(`確認済みにしました（${name}.approved）。このファイル名を開発担当に伝えてください。`);
  return 0;
}
