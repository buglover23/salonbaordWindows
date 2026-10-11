import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { loadConfig, type ConfigIssue } from '../config/loader.js';
import type { Settings } from '../config/schemas.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, errorCodeOf, errorText, type ErrorCode } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import { AI_STAGES, type AiStage } from '../shared/types.js';
import { acquireAppLock, type AppLock } from '../storage/app-lock.js';
import { envDirOf, resolveDataPaths } from '../storage/paths.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { aiEnvKey } from './ai-config.js';
import { AI_SERVICE_INFO } from './ai-services.js';
import { loadAiSetup } from './ai-setup.js';
import { createAiProvider, type AiFactoryDeps } from './factory.js';
import type { AiContent, AiProvider } from './provider.js';
import { UsageMeter } from './usage-meter.js';

// `npm run ai:test` (ruling P2-R17): one tiny real request per stage in use, on the owner's own command. It holds
// app.lock (so it never runs beside the tool) and counts the requests in data/ai-usage like any other call. Nothing is
// posted and no queue or job is touched. Every stage gets a generated 64x64 solid-colour JPEG (as in production, where all three stages receive the photo), never a photo.

export interface AiTestIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export type AiTestDeps = Pick<AiFactoryDeps, 'createClient' | 'createGeminiClient' | 'createOpenAiClient' | 'sleep'> & {
  env?: Readonly<Record<string, string | undefined>>;
  lock?: (lockFile: string) => Promise<AppLock>;
};

const Ok = z.strictObject({ ok: z.boolean() });
const SYSTEM = 'This is a connection test. Answer with the JSON object {"ok": true} and nothing else.';

const HINTS: Partial<Record<ErrorCode, string>> = {
  AI_AUTH_ERROR: 'キーが違うか、使えない状態です。サービスの画面でキーをコピーし直して .env に貼り、保存してからもう一度試してください。',
  CONFIG_INCOMPLETE: 'モデル名（MODEL）か接続先（BASE_URL）が違う可能性があります。サービスの説明にあるモデル名と見比べてください。',
  CONFIG_INVALID: '.env の書き方を直してください（上の行番号を見てください）。',
  AI_RATE_LIMIT: '回数の上限に達しています。少し時間をおいてから試してください。',
  AI_BUDGET_EXCEEDED: '1日の回数・予算・残高の上限に達しています。翌日まで待つか、サービスの管理画面で支払いと上限を確かめてください。',
  AI_UNAVAILABLE: 'AIのサービスに接続できませんでした。インターネット接続と接続先（BASE_URL）を確かめ、少し時間をおいて試してください。',
  AI_TIMEOUT: '時間内に答えが返りませんでした。少し時間をおいて試してください（パソコン内のAIなら起動しているか確かめてください）。',
  AI_OUTPUT_INVALID: 'AIにはつながりましたが、答えが決まった形になりませんでした。openai_compatible なら JSON_MODE=json_object（だめなら none）を試してください。',
};
// AI_UNAVAILABLE with an HTTP answer (e.g. 503 busy) or a model resting after one: not a connection problem.
const BUSY_HINT = 'サービス側が混み合っているか、一時的に答えられない状態です。数分おいてから、もう一度試してください。';

function hintFor(err: unknown): string {
  const code = errorCodeOf(err);
  const d = err instanceof AppFailure ? err.error.details_redacted : {};
  if (code === 'AI_UNAVAILABLE' && (typeof d.status === 'number' || d.reason !== undefined)) return BUSY_HINT;
  return HINTS[code] ?? 'ログ（logs フォルダ）を確認してください。';
}

async function testImage(): Promise<string> {
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 196, g: 128, b: 96 } } }).jpeg().toBuffer();
  return jpeg.toString('base64');
}

function printIssues(io: AiTestIo, heading: string, issues: readonly ConfigIssue[]): void {
  io.stderr(heading);
  for (const i of issues) io.stderr(`  - ${i.path === '' ? i.file : `${i.file} ${i.path}`}: ${i.message}`);
}

/** No transport retries: one request per stage. */
const testSettings = (s: Settings): Settings => ({ ...s, ai: { ...s.ai, max_transport_retries: 0 } });

/** Returns the exit code: 0 every stage answered, 1 a stage failed or nothing to test, 2 the tool is running. */
export async function aiTestCommand(projectRoot: string, io: AiTestIo, clock: Clock = systemClock, deps: AiTestDeps = {}): Promise<number> {
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) {
    printIssues(io, '設定ファイルに誤りがあるため、AIを試せません。次の箇所を直して保存してください:', loaded.issues);
    return 1;
  }
  const settings = testSettings(loaded.snapshot.settings);
  const setup = await loadAiSetup(envDirOf(projectRoot, settings), settings.ai, deps.env);
  for (const w of setup.config.warnings) io.stderr(`【注意】${w.file} ${w.path}: ${w.message}`);
  if (setup.config.issues.length > 0) {
    printIssues(io, 'AIの設定（.env）に誤りがあるため、AIを試せません。次の箇所を直して保存してください:', setup.config.issues);
    return 1;
  }

  const stages = AI_STAGES.filter((s) => s !== 'check' || settings.ai.consistency_check !== 'off');
  const toTest: AiStage[] = [];
  let failed = false;
  io.stdout('AIの接続テスト（各段階で小さな依頼を1回ずつ送ります。投稿はしません）:');
  for (const stage of stages) {
    const cfg = setup.config.stages[stage];
    if (cfg.service === null) {
      io.stdout(`  ${AI_STAGE_JA[stage]}: 未設定です。.env の ${aiEnvKey(stage, 'PROVIDER')}= にサービス名を書いてください。`);
      failed = true;
    } else if (cfg.service === 'mock') {
      io.stdout(`  ${AI_STAGE_JA[stage]}: mock（仮のAI）のため試しません。`);
    } else {
      toTest.push(stage);
    }
  }
  if (toTest.length === 0) return 1;

  const paths = resolveDataPaths(projectRoot, settings);
  let lock: AppLock;
  try {
    lock = await (deps.lock ?? ((lockFile) => acquireAppLock({ lockFile, instanceId: newId('aitest') })))(paths.lockFile);
  } catch (err) {
    if (errorCodeOf(err) !== 'LOCK_CONFLICT') throw err;
    io.stderr('ツールが動いている間は ai:test を使えません。ツールを止めて（Ctrl+C）から、もう一度実行してください。');
    return 2;
  }
  try {
    const meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue: new SerialQueue(), getSettings: () => settings, clock });
    let provider: AiProvider;
    try {
      provider = createAiProvider(settings, 'live', { meter, aiConfig: setup.config, clock, ...deps });
    } catch (err) {
      io.stdout(`  失敗（${errorCodeOf(err)}）: ${errorText(err)}`);
      if (errorCodeOf(err) === 'AI_AUTH_ERROR') io.stdout('    → 書いて保存したら、もう一度 npm.cmd run ai:test を実行してください。');
      return 1;
    }
    const image = await testImage();
    for (const stage of toTest) {
      const cfg = setup.config.stages[stage];
      const label = cfg.service === null || cfg.service === 'mock' ? '' : AI_SERVICE_INFO[cfg.service].label;
      const content: AiContent[] = [{ type: 'text', text: 'Connection test. Reply {"ok": true}.' }];
      content.push({ type: 'image_jpeg_base64', data: image });
      try {
        const r = await provider.structured({ stage, schema: Ok, system: SYSTEM, content, maxTokens: 1024 });
        // Ruling P2-R18: a Gemini fallback model answered.
        const fallback = cfg.service === 'gemini' && r.model !== cfg.model ? ' ※混雑などのため予備のモデルで応答' : '';
        io.stdout(`  ${AI_STAGE_JA[stage]}: OK（${label} / モデル ${r.model}、画像も読めました${fallback}）`);
      } catch (err) {
        failed = true;
        const code = errorCodeOf(err);
        io.stdout(`  ${AI_STAGE_JA[stage]}: 失敗（${label} / ${code}）: ${errorText(err)}`);
        io.stdout("    画像：この段階は失敗したため、画像を受け付けたか確かめられませんでした。");
        io.stdout(`    → ${hintFor(err)}`);
      }
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
  io.stdout(failed ? '直したら .env を保存して、もう一度 npm.cmd run ai:test を実行してください。' : 'すべての段階でAIとつながりました。.env を変えたときは、ツールを起動し直すと反映されます。');
  return failed ? 1 : 0;
}
