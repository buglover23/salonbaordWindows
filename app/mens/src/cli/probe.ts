import { ApiCallError, LocalApiClient } from '../server/client.js';
import { ProbeResponseSchema } from '../shared/protocol/api.js';
import { NOT_RUNNING_JA } from './pair.js';

// `npm.cmd run probe -- --arm --yes` (owner only, never an agent): lets the extension's 「画像添付の確認」 run for 10
// minutes. It needs automation recorded as permitted; the probe sets a synthetic test image and never clicks register.

type Io = { stdout: (s: string) => void; stderr: (s: string) => void };

export const PROBE_GUIDE_JA = 'SALON BOARD の投稿画面（新しい入力画面）を開き、拡張機能の『画像添付の確認』を押してください。登録ボタンは押しません';

export async function probeCommand(projectRoot: string, args: string[], io: Io): Promise<number> {
  const unknown = args.filter((a) => a !== '--arm' && a !== '--yes');
  if (unknown.length > 0 || !args.includes('--arm')) {
    io.stderr(unknown.length > 0 ? `probe に指定できない引数です: ${unknown.join(' ')}` : '使い方: npm.cmd run probe -- --arm --yes');
    return 1;
  }
  if (!args.includes('--yes')) {
    io.stdout('画像添付の確認を10分間だけ受け付けます。拡張機能がテスト用の画像（灰色の市松模様）を投稿画面の画像の欄に入れ、プレビューが出るかを確かめます。');
    io.stdout('登録ボタンは押しません。テスト用の画像が一時的に SALON BOARD に送られる場合があります。確認後、その画面は登録せずに閉じてください。');
    io.stdout('実行するときは --yes を付けてください: npm.cmd run probe -- --arm --yes');
    return 1;
  }
  const client = await LocalApiClient.forProject(projectRoot);
  if (client === null) {
    io.stderr(NOT_RUNNING_JA);
    return 2;
  }
  try {
    const r = ProbeResponseSchema.parse((await client.request('POST', '/v1/control/probe', { arm: true, confirm: true })).body);
    io.stdout(`画像添付の確認を ${r.expires_at_jst}（日本時間）まで受け付けます。`);
    io.stdout(PROBE_GUIDE_JA);
    return 0;
  } catch (err) {
    if (err instanceof ApiCallError && err.kind === 'refused') {
      io.stderr(err.message);
      return 1;
    }
    io.stderr('ツールの応答を確認できませんでした。ツールを起動し直してから、もう一度実行してください。');
    return 2;
  }
}
