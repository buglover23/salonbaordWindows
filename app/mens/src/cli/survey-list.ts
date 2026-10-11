import type { SurveyCapture } from '../shared/protocol/survey.js';
import { listCaptures, surveyDirOf } from '../survey/store.js';

// `npm.cmd run survey:list` (read-only): the survey captures in data\survey, with what the owner checks before approving.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

export const KIND_JA: Record<SurveyCapture['kind'], string> = { form: '入力画面', page: '完了・一覧の画面', probe: '画像添付の確認' };
export const MODE_JA: Record<SurveyCapture['mode'], string> = { owner: '通常', strict: '厳しい方式（自動）' };
const MASKED = /\[(?:email|phone|postal|digits|n|name|salon\?)\]/g;

/** 'YYYYMMDD-HHmmss-…' → 'YYYY-MM-DD HH:mm:ss'. */
export const fileTimeJst = (name: string): string => name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*$/, '$1-$2-$3 $4:$5:$6');

/** Controls and buttons whose handlers may submit the form or ask for a confirmation. */
export function hintCounts(c: SurveyCapture): { autosubmit: number; confirm: number } {
  const all = [...c.forms.flatMap((f) => f.controls), ...c.buttons];
  return { autosubmit: all.filter((x) => x.autosubmit_hint).length, confirm: all.filter((x) => x.inline_confirm_hint).length };
}

export async function surveyListCommand(projectRoot: string, args: string[], io: Io): Promise<number> {
  if (args.length > 0) {
    io.stderr(`survey:list に指定できない引数です: ${args.join(' ')}`);
    return 1;
  }
  const dir = await surveyDirOf(projectRoot);
  const all = await listCaptures(dir);
  if (all.length === 0) {
    io.stdout(`画面の調査結果はまだありません（${dir}）。拡張機能の「画面を調査」で作れます。`);
    return 0;
  }
  io.stdout(`画面の調査結果（${dir}）: ${all.length}件`);
  for (const s of all) {
    io.stdout(`- ${s.name}`);
    if (!s.ok) {
      io.stdout(`    この調査結果は使えません（${s.reason_ja}）。確認済み: ${s.approved ? 'はい' : 'いいえ'}`);
      continue;
    }
    const c = s.capture;
    const h = hintCounts(c);
    const notes = [h.autosubmit > 0 ? `自動送信の可能性 ${h.autosubmit}件` : '', h.confirm > 0 ? `確認ダイアログ ${h.confirm}件` : ''].filter((x) => x !== '');
    io.stdout(`    日時: ${fileTimeJst(s.name)}（日本時間） 画面: ${c.page.origin}${c.page.path} 種類: ${KIND_JA[c.kind]} 方式: ${MODE_JA[c.mode]}`);
    io.stdout(
      `    入力欄: ${c.forms.reduce((n, f) => n + f.controls.length, 0)} 伏せ字: ${JSON.stringify(c).match(MASKED)?.length ?? 0} 注意: ${notes.join('・') || 'なし'} 確認済み: ${s.approved ? 'はい' : 'いいえ'}`,
    );
  }
  io.stdout('内容は npm.cmd run survey:show -- --file ファイル名 で確認できます（確認後に --approve を付けると開発担当が読めるようになります）。');
  return 0;
}
