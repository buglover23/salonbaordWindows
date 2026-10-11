import { join, resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { ApiCallError, LocalApiClient } from '../server/client.js';
import { pairingCodeLine } from '../server/handlers/system.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { ControlPairResponseSchema } from '../shared/protocol/api.js';

// `npm.cmd run pair` (Plan 3 D1-4): asks the running tool for a new pairing code and prints it here only. The old
// extension keeps working until the new one has finished pairing.

export const NOT_RUNNING_JA = 'ツールが起動していません。npm.cmd start（または起動.bat）で起動してから、もう一度実行してください。';

export async function pairCommand(projectRoot: string, io: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number> {
  const config = await loadConfig(join(projectRoot, 'config'));
  if (!config.ok) throw new AppFailure(appError('CONFIG_INVALID', 'cli', systemClock, { details: { issues: config.issues } }));
  const client = await LocalApiClient.discover(resolve(projectRoot, config.snapshot.settings.data_root));
  if (client === null) {
    io.stderr(NOT_RUNNING_JA);
    return 2;
  }
  try {
    const r = ControlPairResponseSchema.parse((await client.request('POST', '/v1/control/pair')).body);
    io.stdout(pairingCodeLine(r.code));
    io.stdout('拡張機能のポップアップの「接続コード」の欄にこのコードを入力して「送信」を押してください。接続できると、ツールの黒い画面（起動.bat または npm.cmd start）に「確認記号」が出ます。拡張機能の画面にも同じ記号が出ていることを確認してください。');
    io.stdout('新しい接続ができた時点で、それまでの接続は使えなくなります。');
    return 0;
  } catch (err) {
    io.stderr(err instanceof ApiCallError && err.kind === 'refused' ? err.message : 'ツールの応答を確認できませんでした。ツールを起動し直してから、もう一度実行してください。');
    return 2;
  }
}
