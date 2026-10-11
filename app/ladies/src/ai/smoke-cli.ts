import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { TemplateSource } from '../content/template-source.js';
import { TrendFeed } from '../content/trend-feed.js';
import { createFileLogger, type AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { AppFailure } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { makeNewJob, type Job } from '../shared/job-schema.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../shared/labels.js';
import { AUDIENCE_CATEGORIES, POST_TYPES, type AudienceCategory, type PostType } from '../shared/types.js';
import { layoutProfile } from '../posting/profile/route-resolve.js';
import { SIDECAR_FILE } from '../storage/sidecar.js';
import { withCommandLock, type CommandLockOptions } from '../storage/command-lock.js';
import { DedupeStore } from '../storage/dedupe-store.js';
import { HistoryStore } from '../storage/history-store.js';
import { inspectImage } from '../storage/image-inspect.js';
import { JobStore } from '../storage/job-store.js';
import { envDirOf, resolveDataPaths } from '../storage/paths.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { formatConfigIssue } from '../status.js';
import { fieldJa } from '../validation/types.js';
import { loadValidationInputs, validateDraft } from '../validation/validator.js';
import { analyzeJob } from './analyzer.js';
import { buildGenerationContext, combineRecentPatterns, instructionView, JobDraftPatterns, styleMenusMissing, STYLE_MENUS_MISSING_STATUS } from './context.js';
import { renderHashtags } from './draft-schemas.js';
import { aiEnvKey } from './ai-config.js';
import { loadAiSetup, stageWithoutKey } from './ai-setup.js';
import { createAiProvider, type AiFactoryDeps } from './factory.js';
import { generateDraft } from './generator.js';
import { UsageMeter, type UsageSummary } from './usage-meter.js';

// `npm.cmd run ai:smoke -- <画像のパス>` (manual, real API, costs a few cents): one photo is analysed, one draft generated
// and validated with the real provider, and the draft and the AI usage are printed in Japanese. It never posts, never
// creates a job and never touches the queues: the photo is copied into a temporary folder that is removed afterwards.
// It refuses without an API key (before any network use) and holds app.lock (refused while the tool runs).

export interface SmokeCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface SmokeCliOptions {
  lock?: CommandLockOptions;
  /** The environment .env is merged under (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the real SDK client (tests: no network). */
  createClient?: AiFactoryDeps['createClient'];
  /** Replaces the real Gemini SDK client (tests: no network). */
  createGeminiClient?: AiFactoryDeps['createGeminiClient'];
  logger?: AppLogger;
}

const USAGE = '使い方: npm.cmd run ai:smoke -- "画像のパス" --type blog --audience ladies（--type は style か blog、--audience は mens か ladies。省くとブログ・レディース）';

type Args = { image: string; type: PostType; audience: AudienceCategory };

function parseArgs(args: readonly string[]): Args | { error: string } {
  let image: string | null = null;
  let type: PostType = 'blog';
  let audience: AudienceCategory = 'ladies';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--type') {
      const v = args[++i];
      if (!POST_TYPES.includes(v as PostType)) return { error: `--type には style か blog を指定してください: ${v ?? '(なし)'}` };
      type = v as PostType;
    } else if (arg === '--audience') {
      const v = args[++i];
      if (!AUDIENCE_CATEGORIES.includes(v as AudienceCategory)) return { error: `--audience には mens か ladies を指定してください: ${v ?? '(なし)'}` };
      audience = v as AudienceCategory;
    } else if (arg.startsWith('--')) {
      return { error: `ai:smoke に指定できない引数です: ${arg}` };
    } else if (image === null) {
      image = arg;
    } else {
      return { error: `画像のパスは1つだけ指定してください: ${arg}` };
    }
  }
  return image === null ? { error: '確認に使う画像のパスを指定してください。' } : { image, type, audience };
}

const usd = (n: number): string => (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));

function usageLines(before: UsageSummary, after: UsageSummary): string[] {
  const t = after.today;
  const b = before.today;
  return [
    `AIの使用量（この確認の分）: ${t.requests - b.requests}回、入力 ${t.input_tokens - b.input_tokens}・出力 ${t.output_tokens - b.output_tokens}・キャッシュ読込 ${t.cache_read_input_tokens - b.cache_read_input_tokens} トークン、見積 ${usd(t.est_usd - b.est_usd)}ドル`,
    `本日（${after.date}）の合計: ${t.requests}回、見積 ${usd(t.est_usd)}ドル / 予算 ${usd(after.limits.daily_usd)}ドル`,
  ];
}

export async function aiSmokeCommand(projectRoot: string, args: readonly string[], io: SmokeCliIo, clock: Clock, o: SmokeCliOptions = {}): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    io.stderr(parsed.error);
    io.stderr(USAGE);
    return 1;
  }
  const loaded = await loadConfig(join(projectRoot, 'config'));
  if (!loaded.ok) {
    io.stderr('設定ファイルに誤りがあるため、AIの動作確認ができません。次の箇所を直して保存してください:');
    for (const issue of loaded.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const snapshot = loaded.snapshot;
  const { settings } = snapshot;
  // Checked before the lock and before anything else: without a key nothing is sent anywhere.
  // The real AI: .env AI_<STAGE>_* per stage, else settings.json's provider (Gemini unless "anthropic" or "openai"; never the mock).
  const p = settings.ai.provider;
  const realAi = { ...settings.ai, provider: p === 'anthropic' || p === 'openai' ? p : ('gemini' as const) };
  const setup = await loadAiSetup(envDirOf(projectRoot, settings), realAi, o.env);
  if (setup.config.issues.length > 0) {
    io.stderr('AIの設定（.env）に誤りがあるため、AIの動作確認はしません。次の箇所を直して保存してください:');
    for (const issue of setup.config.issues) io.stderr(formatConfigIssue(issue));
    return 1;
  }
  const noKey = stageWithoutKey(setup.config, realAi);
  if (noKey !== null) {
    const keyEnv = noKey.keyName ?? aiEnvKey(noKey.stage, 'API_KEY');
    io.stderr(`AIのAPIキーが見つからないため、AIの動作確認はしません。このツールのフォルダの .env に「${keyEnv}=」に続けてキーを書いてから、もう一度実行してください（キーは画面やログには表示しません）。`);
    return 1;
  }
  if (parsed.type === 'style' && styleMenusMissing(snapshot)) {
    io.stderr(`スタイル投稿の確認はできません: ${STYLE_MENUS_MISSING_STATUS}`);
    return 1;
  }
  const image = resolve(process.cwd(), parsed.image);
  const inspected = await inspectImage(image, { maxBytes: settings.resources.max_input_file_mb * 1024 * 1024, maxPixels: settings.resources.max_input_pixels });
  if (!inspected.ok) {
    io.stderr(`画像を読み取れません（${inspected.reason}）: ${image}`);
    return 1;
  }
  const paths = resolveDataPaths(projectRoot, settings);
  return withCommandLock(
    paths,
    'ai:smoke',
    async () => {
      const logger = o.logger ?? createFileLogger({ logsDir: paths.logsDir, level: settings.logs.level, instanceId: newId('cmd'), mode: settings.mode, clock });
      const queue = new SerialQueue();
      const meter = await UsageMeter.load({ dir: paths.aiUsageDir, queue, getSettings: () => settings, clock });
      const templates = new TemplateSource({ mapping: () => snapshot.templateMapping, categories: () => snapshot.categories, cacheDir: paths.templateCacheDir, baseDir: projectRoot, logger, clock });
      await templates.refresh();
      const library = templates.library;
      if (library === null) {
        io.stderr(`テンプレートを読み込めないため、AIの動作確認はしません（${templates.problem?.message ?? '理由不明'}）。npm.cmd run templates:import で確認してください。`);
        return 1;
      }
      const trends = new TrendFeed({ config: () => snapshot, cacheDir: paths.trendCacheDir, baseDir: projectRoot, workbookDir: paths.trendWorkbookDir, logger, clock });
      await trends.refresh(clock.now());
      const provider = createAiProvider({ ...settings, ai: realAi }, 'live', {
        meter,
        aiConfig: setup.config,
        clock,
        logger,
        ...(o.createClient === undefined ? {} : { createClient: o.createClient }),
        ...(o.createGeminiClient === undefined ? {} : { createGeminiClient: o.createGeminiClient }),
      });
      // The photo is copied into a temporary bundle; the tool's data folders are only read (history, jobs for duplicates).
      const temp = await mkdtemp(join(tmpdir(), 'salon-ai-smoke-'));
      const tempPaths = resolveDataPaths(temp, { ...settings, mode: 'live', data_root: '.' });
      const before = await meter.summary(clock.now());
      try {
        const made = makeNewJob({
          salon_id: snapshot.salon.salon_id,
          post_type: parsed.type,
          audience_category: parsed.audience,
          image: { relative_path: 'x', sha256: '0'.repeat(64), mime: inspected.mime, bytes: inspected.bytes, width: inspected.width, height: inspected.height, original_name: 'smoke' },
          config_hash: snapshot.hash,
          clock,
        });
        const ext = inspected.format === 'jpeg' ? 'jpg' : inspected.format;
        const job: Job = { ...made, status: 'ANALYZING', stage: 'analyze', image: { ...made.image, relative_path: `images/processing/${made.id}/source.${ext}` } };
        await mkdir(join(temp, 'images', 'processing', job.id), { recursive: true });
        await copyFile(image, join(temp, ...job.image.relative_path.split('/')));
        // The photo's sidecar (same name, .json) as the intake would bundle it, so its category_hint and menus apply.
        await copyFile(join(dirname(image), `${basename(image, extname(image))}.json`), join(temp, 'images', 'processing', job.id, SIDECAR_FILE)).catch(() => undefined);

        io.stdout('AIの動作確認（ai:smoke）');
        io.stdout(`  画像: ${image}（${inspected.width}×${inspected.height}）`);
        io.stdout(`  種類: ${POST_TYPE_JA[parsed.type]}・${AUDIENCE_JA[parsed.audience]}`);
        io.stdout('  ※ 本物のAIを使うため、数セント程度の費用がかかります。投稿はしません。');

        io.stdout('[1/3] 画像の解析…');
        const analysis = await analyzeJob({ provider, paths: tempPaths, snapshot, clock, logger }, job);
        io.stdout(`  長さ: ${analysis.hair_length.value} / 色: ${analysis.observed_color.value} / カテゴリー: ${analysis.suggested_category_ids.join(', ')}`);

        io.stdout('[2/3] 文章の作成…');
        const history = await HistoryStore.load(paths, queue, clock, { mode: settings.mode });
        const jobs = await JobStore.open(paths, queue, clock);
        const dedupe = await DedupeStore.load(paths, queue, clock);
        const generating: Job = { ...job, status: 'GENERATING', stage: 'generate', analysis };
        const context = await buildGenerationContext(
          {
            snapshot,
            paths: tempPaths,
            templates: library,
            trends,
            instructions: instructionView(snapshot),
            recent: combineRecentPatterns(history, new JobDraftPatterns(jobs)),
            clock,
            logger,
            // As in the pipeline: the route's page profile sets limits and hashtag placement (P2-D10).
            profile: layoutProfile({ base: snapshot, routes: snapshot.salonboardFields.posting_routes }, parsed.type, parsed.audience),
          },
          generating,
          analysis,
          clock.now(),
        );
        const generated = await generateDraft({ provider, paths: tempPaths, clock, logger, maxInputPixels: settings.resources.max_input_pixels }, generating, context);
        const draft = generated.draft;

        io.stdout('[3/3] 文章の検査…');
        const inputs = await loadValidationInputs({ history, jobs, dedupe }, generating, snapshot);
        const outcome = await validateDraft(
          {
            job: { ...generating, status: 'VALIDATING', stage: 'validate', draft },
            generation: context,
            snapshot,
            recent: inputs.recent,
            duplicates: inputs.duplicates,
            generatorViolations: generated.violations,
            check: { provider, paths: tempPaths, clock, logger, maxInputPixels: settings.resources.max_input_pixels },
          },
          draft,
        );
        io.stdout(outcome.ok ? '  検査: 合格' : `  検査: 不合格（${outcome.violations.length}件。実際の運用では作り直します）`);
        for (const v of outcome.violations.slice(0, 10)) io.stdout(`    - ${fieldJa(v.field)}: ${v.reason_ja}`);

        io.stdout('下書き:');
        io.stdout(`  タイトル: ${draft.title}`);
        if (draft.post_type === 'style') {
          io.stdout(`  メニュー: ${draft.menu_text}`);
          io.stdout(`  スタイリストコメント: ${draft.stylist_comment}`);
        } else {
          io.stdout('  本文:');
          for (const line of draft.body.split('\n')) io.stdout(`    ${line}`);
        }
        io.stdout(`  ハッシュタグ: ${renderHashtags(draft.hashtags)}`);
        for (const line of usageLines(before, await meter.summary(clock.now()))) io.stdout(line);
        io.stdout('投稿はしていません。job も作っていません。');
        return 0;
      } catch (err) {
        if (!(err instanceof AppFailure)) throw err;
        io.stderr(`AIの動作確認が途中で止まりました（${err.error.code}）: ${err.error.message}`);
        for (const line of usageLines(before, await meter.summary(clock.now()))) io.stderr(line);
        return 1;
      } finally {
        await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    },
    o.lock,
  );
}
