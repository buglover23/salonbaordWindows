import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type BuildOptions, type Metafile } from 'esbuild';
import sharp from 'sharp';
import { loadConfig } from '../src/config/loader.js';
import { extensionName } from '../src/shared/labels.js';
import { forPlatform } from '../src/shared/platform-text.js';
import type { AudienceCategory } from '../src/shared/types.js';
import { PRODUCTION_URL_POLICY } from '../src/shared/url-policy.js';
import { idFromKey } from './extension-key.js';

// Builds the Chrome extension (Plan 3 Task 4a): production → apps/extension/dist/, e2e → apps/extension/dist-e2e/.
// The manifest is generated (never hand-edited) and the output must pass the safety checks below, or nothing is kept.

export type Target = 'production' | 'e2e';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'apps/extension/src';
/** The fixed E2E values (P3-R18, P3-R30): the mock SALON BOARD origin and the test API port. */
const E2E = { apiBase: 'http://127.0.0.1:3911', origins: ['http://sb-mock.localhost:3912'] };
const API_CLIENT = `${SRC}/sw/api-client.ts`;

export interface BuildOutput {
  target: Target;
  outDir: string;
  apiBase: string;
  origins: string[];
  key: string;
  /** settings.server.allowed_extension_ids[0] (production only). */
  expectedId: string | null;
  manifest: Record<string, unknown>;
  /** Text outputs by file name. */
  files: Record<string, string>;
  /** Bundle file name → its esbuild metafile inputs (paths relative to the repository root). */
  inputs: Record<string, string[]>;
  /** Import paths esbuild left external. */
  externals: string[];
}

/** `audiences`: the copy's settings.audiences; the name tells the メンズ and レディース extensions apart. */
export function makeManifest(key: string, origins: readonly string[], audiences: readonly AudienceCategory[] | null = null): Record<string, unknown> {
  const matches = origins.map((o) => `${o}/*`);
  const name = extensionName(audiences);
  return {
    manifest_version: 3,
    name,
    version: '0.3.0',
    key,
    minimum_chrome_version: '140',
    permissions: ['storage', 'alarms'],
    host_permissions: ['http://127.0.0.1/*', ...matches],
    background: { service_worker: 'service-worker.js', type: 'module' },
    // With no allowed origin yet this is a pairing-only build.
    ...(matches.length > 0 ? { content_scripts: [{ matches, js: ['content.js'], run_at: 'document_idle', all_frames: false }] } : {}),
    action: { default_popup: 'popup.html', default_title: name },
  };
}

export async function buildExtension(opts: { target: Target; outDir?: string; configDir?: string }): Promise<BuildOutput> {
  const e2e = opts.target === 'e2e';
  const outDir = opts.outDir ?? join(ROOT, 'apps', 'extension', e2e ? 'dist-e2e' : 'dist');
  let apiBase = E2E.apiBase;
  let origins = E2E.origins;
  let expectedId: string | null = null;
  let audiences: readonly AudienceCategory[] | null = null;
  if (!e2e) {
    const loaded = await loadConfig(opts.configDir ?? join(ROOT, 'config'));
    if (!loaded.ok) throw new Error(['設定ファイルに問題があるため拡張機能を作れません:', ...loaded.issues.map((i) => `- ${i.message}`)].join('\n'));
    apiBase = `http://127.0.0.1:${loaded.snapshot.settings.server.port}`;
    origins = loaded.snapshot.salonboardFields.allowed_origins;
    expectedId = loaded.snapshot.settings.server.allowed_extension_ids[0] ?? null;
    audiences = loaded.snapshot.settings.audiences;
  }
  const key = (await readFile(join(ROOT, 'apps', 'extension', 'keys', keyFile(opts.target, audiences)), 'utf8')).trim();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const common: BuildOptions = {
    absWorkingDir: ROOT,
    outdir: outDir,
    bundle: true,
    platform: 'browser',
    target: 'chrome140',
    // Constant folding drops the E2E hooks from production; comments go; identifiers stay readable.
    minifySyntax: true,
    minifyWhitespace: true,
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { __API_BASE__: JSON.stringify(apiBase), __E2E__: String(e2e), __SALONBOARD_ORIGINS__: JSON.stringify(origins) },
  };
  const esm = await build({ ...common, format: 'esm', entryPoints: { 'service-worker': `${SRC}/sw/index.ts`, popup: `${SRC}/popup/popup.ts` } });
  const iife = await build({ ...common, format: 'iife', entryPoints: { content: `${SRC}/content/index.ts` } });
  for (const f of ['popup.html', 'popup.css']) await copyFile(join(ROOT, SRC, 'popup', f), join(outDir, f));
  await writeFile(join(outDir, 'probe.jpg'), await probeImage());
  const manifest = makeManifest(key, origins, audiences);
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const files: Record<string, string> = {};
  for (const f of ['service-worker.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'manifest.json']) files[f] = await readFile(join(outDir, f), 'utf8');
  const out: BuildOutput = { target: opts.target, outDir, apiBase, origins, key, expectedId, manifest, files, ...bundleInputs([esm.metafile, iife.metafile], outDir) };
  const issues = await checkBuild(out, (p) => readFile(join(ROOT, p), 'utf8'));
  if (issues.length > 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(['拡張機能の安全チェックに失敗したため、作った拡張機能を消しました:', ...issues.map((i) => `- ${i}`)].join('\n'));
  }
  return out;
}

/** The レディース copy has its own key (its own extension ID, so both extensions can be installed); the rest keep their target's. */
export const keyFile = (target: Target, audiences: readonly AudienceCategory[] | null): string =>
  target === 'production' && audiences?.length === 1 && audiences[0] === 'ladies' ? 'ladies.pub.b64' : `${target}.pub.b64`;

function bundleInputs(metafiles: (Metafile | undefined)[], outDir: string): Pick<BuildOutput, 'inputs' | 'externals'> {
  const inputs: Record<string, string[]> = {};
  const externals: string[] = [];
  for (const meta of metafiles) {
    for (const [file, o] of Object.entries(meta?.outputs ?? {})) {
      inputs[relative(outDir, join(ROOT, file)).replace(/\\/g, '/')] = Object.keys(o.inputs);
      externals.push(...o.imports.filter((i) => i.external).map((i) => i.path));
    }
  }
  return { inputs, externals };
}

/** 640×480 grey checkerboard, no text: the synthetic image the upload probe sets (Task 5a); never a real photo. */
function probeImage(): Promise<Buffer> {
  const [w, h] = [640, 480];
  const px = Buffer.alloc(w * h);
  for (let i = 0; i < px.length; i++) px[i] = ((i % w >> 5) + (Math.floor(i / w) >> 5)) % 2 === 0 ? 112 : 144;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 80 }).toBuffer();
}

const FORBIDDEN_PERMISSIONS = ['<all_urls>', 'scripting', 'tabs', 'cookies', 'webRequest', 'debugger'];
const FORBIDDEN_KEYS = ['externally_connectable', 'web_accessible_resources'];
/** URL strings inside Zod that are not endpoints (JSON Schema $schema ids, an IPv6 parse check); nothing can fetch them. */
const LIBRARY_URL_STRINGS = new Set(['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-04/schema#', 'http://[${value}]']);

/**
 * Post-build checks (Task 4a; 1.1-R09, 8.1-a, A31). Returns Japanese issues; any issue fails the build.
 * `readSource` reads a bundle input (repository-relative path) for the fetch attribution.
 */
export async function checkBuild(o: BuildOutput, readSource: (path: string) => Promise<string>): Promise<string[]> {
  const issues: string[] = [];
  const m = o.manifest as {
    permissions?: string[];
    optional_permissions?: string[];
    host_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts?: { matches?: string[] }[];
  };
  const permissions = [...(m.permissions ?? []), ...(m.optional_permissions ?? []), ...(m.host_permissions ?? []), ...(m.optional_host_permissions ?? [])];
  const matches = (m.content_scripts ?? []).flatMap((c) => c.matches ?? []);
  for (const p of FORBIDDEN_PERMISSIONS) {
    if (permissions.some((x) => x === p || x.startsWith(p)) || JSON.stringify(o.manifest).includes('<all_urls>')) issues.push(`manifest に使えない権限 ${p} があります`);
  }
  for (const k of FORBIDDEN_KEYS) if (k in o.manifest) issues.push(`manifest に ${k} は書けません`);
  for (const p of [...permissions, ...matches]) if (/^[^:]+:\/\/[^/]*\*/.test(p)) issues.push(`manifest のホスト指定にワイルドカードは使えません: ${p}`);
  if (matches.some((x) => x.includes('127.0.0.1'))) issues.push('content script を 127.0.0.1 で動かすことはできません');

  const sw = o.files['service-worker.js'] ?? '';
  const content = o.files['content.js'] ?? '';
  if (sw.includes('import(')) issues.push('service-worker.js に import( があります');
  for (const [name, text] of Object.entries(o.files)) {
    if (name.endsWith('.js') && /chrome\s*(\.\s*|\[\s*["'`])(webRequest|cookies|debugger)\b/.test(text)) issues.push(`${name} に使えない chrome API（webRequest / cookies / debugger）があります`);
    const scanned = name === 'manifest.json' ? text.replace(o.key, '') : text;
    const token = scanned.match(/[A-Za-z0-9_-]{32,}/g)?.find(looksLikeToken);
    if (token !== undefined) issues.push(`${name} に鍵のような文字列があります（${token.slice(0, 6)}…）`);
    if (o.target === 'production' && text.includes('__e2e')) issues.push(`${name} に E2E 用の仕組み（__e2e）が残っています`);
  }
  for (const g of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource']) if (content.includes(g)) issues.push(`content.js に通信（${g}）があります`);
  for (const input of o.inputs['service-worker.js'] ?? []) {
    if (input !== API_CLIENT && (await readSource(input).catch(() => '')).includes('fetch(')) issues.push(`service-worker.js の ${input} に fetch( があります（通信は api-client.ts だけ）`);
  }
  for (const url of sw.match(/https?:\/\/[^\s'"`)\\]+/g) ?? []) {
    if (url !== o.apiBase && !o.origins.includes(url) && !LIBRARY_URL_STRINGS.has(url)) issues.push(`service-worker.js に決められていない接続先 ${url} があります`);
  }
  for (const p of [...Object.values(o.inputs).flat(), ...o.externals]) if (p.startsWith('node:')) issues.push(`拡張機能に Node の機能（${p}）が入っています`);
  if (o.target === 'production') {
    const id = idFromKey(o.key);
    if (id !== o.expectedId) {
      issues.push(
        `拡張機能のIDが設定と一致しません。「${String(o.manifest.name)}」のIDは ${id} です。config\\settings.json の server.allowed_extension_ids を ["${id}"] にしてから、もう一度 npm.cmd run build:extension を実行してください（いまの値: ${o.expectedId ?? 'なし'}）`,
      );
    }
    for (const origin of o.origins) {
      const reason = PRODUCTION_URL_POLICY.checkOrigin(origin);
      if (reason !== null) issues.push(`接続先 ${origin} は使えません: ${reason}`);
    }
  }
  return issues;
}

/** A base64url-like run that mixes digits, lower and upper case and is not a sorted alphabet run. */
function looksLikeToken(s: string): boolean {
  const sorted = [...s].every((c, i) => i === 0 || c.charCodeAt(0) >= s.charCodeAt(i - 1));
  return /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && !sorted;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--target');
  const target = i === -1 ? 'production' : process.argv[i + 1];
  if (target !== 'production' && target !== 'e2e') {
    console.error(forPlatform('使い方: npm.cmd run build:extension （テスト用は npm.cmd run build:extension -- --target e2e）'));
    process.exit(2);
  }
  buildExtension({ target }).then(
    (o) => {
      console.log(`拡張機能を作りました: ${relative(process.cwd(), o.outDir) || o.outDir}`);
      if (o.origins.length === 0) console.log(forPlatform('SALON BOARD の接続先がまだ記録されていないため、ツールとの接続だけに使える版を作りました。npm.cmd run checks:record -- origin で接続先を記録した後に、もう一度 npm.cmd run build:extension を実行してください。'));
    },
    (e: unknown) => {
      console.error(e instanceof Error ? forPlatform(e.message) : e);
      process.exit(1);
    },
  );
}
