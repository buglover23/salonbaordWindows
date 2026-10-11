import type { EnvSource } from '../config/env-file.js';
import type { ConfigIssue } from '../config/loader.js';
import { GEMINI_MAX_OUTPUT_TOKENS, type ModelPricing, type Settings } from '../config/schemas.js';
import { AI_STAGE_JA } from '../shared/labels.js';
import { AI_STAGES, type AiStage, type Mode } from '../shared/types.js';
import { AI_SERVICE_INFO, normalizeWord, parseServiceName, type AiService, type AiServiceInfo, type JsonMode } from './ai-services.js';

// Which AI service, model and key each stage uses (ruling P2-R17): AI_<STAGE>_* in .env (or the environment) over
// settings.json ai.*. Read once when the providers are built, so an edited .env applies after a restart. Keys are only
// handed to the SDK clients: never logged, never in issues, status shows at most the last 4 characters.

export const AI_ENV_FIELDS = ['PROVIDER', 'MODEL', 'API_KEY', 'BASE_URL', 'FREE_TIER', 'JSON_MODE', 'PRICE_IN', 'PRICE_OUT', 'FALLBACK_MODELS', 'API_VERSION', 'MAX_TOKENS'] as const;
export type AiEnvField = (typeof AI_ENV_FIELDS)[number];

const STAGE_ENV: Record<AiStage, string> = { analysis: 'ANALYSIS', generation: 'GENERATION', check: 'CHECK' };
export const aiEnvKey = (stage: AiStage, field: AiEnvField): string => `AI_${STAGE_ENV[stage]}_${field}`;
const KNOWN_KEYS: readonly string[] = AI_STAGES.flatMap((stage) => AI_ENV_FIELDS.map((field) => aiEnvKey(stage, field)));

/** The variable a value was read from and its .env line (null: the process environment). */
export interface ValueOrigin {
  key: string;
  line: number | null;
}

/** USD per million tokens. */
export interface StagePrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface StageAiConfig {
  stage: AiStage;
  /** 'env': at least one AI_<STAGE>_* value (or, for CHECK, an inherited GENERATION value) applies; 'settings': settings.json only. */
  source: 'env' | 'settings';
  /** null: not chosen (or not readable); 'mock': settings.json ai.provider "mock". */
  service: AiService | 'mock' | null;
  model: string | null;
  /** Secret: only for the SDK client. */
  apiKey: string | null;
  /** The variable the key is (or would be) read from, e.g. AI_ANALYSIS_API_KEY or GEMINI_API_KEY. */
  keyName: string | null;
  /** null: the service's standard endpoint. */
  baseURL: string | null;
  /** Gemini only. */
  freeTier: boolean | null;
  /** Gemini only: AI_<STAGE>_FALLBACK_MODELS; null = settings.json ai.gemini.fallback_models (ruling P2-R18). */
  fallbackModels: string[] | null;
  /** Gemini only: the API version in the request URL (AI_<STAGE>_API_VERSION, else settings.json ai.gemini.api_version); null = the SDK's default. */
  apiVersion: string | null;
  /** AI_<STAGE>_MAX_TOKENS: a floor for the output-token limit of this stage (Gemini: replaces ai.gemini.max_output_tokens); null = unset. */
  maxTokens: number | null;
  jsonMode: JsonMode;
  price: StagePrice | null;
  /** CHECK only: some values were taken from GENERATION. */
  inherited: boolean;
  origins: Partial<Record<AiEnvField, ValueOrigin>>;
}

export interface AiConfigResult {
  stages: Record<AiStage, StageAiConfig>;
  /** CONFIG_INVALID: no real provider is built until these are fixed. */
  issues: ConfigIssue[];
  warnings: ConfigIssue[];
}

/** Limits for a Gemini free-tier model chosen in .env that settings.json has none for: the shipped placeholders, unverified. */
export const PLACEHOLDER_FREE_LIMIT: Readonly<{ rpm: number; rpd: number; verified_at: null }> = Object.freeze({ rpm: 5, rpd: 100, verified_at: null });

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an http(s) URL on this PC (a local LLM server), which needs no key. */
export function isLocalUrl(url: string | null): boolean {
  if (url === null) return false;
  const parsed = URL.parse(url);
  return parsed !== null && LOCAL_HOSTS.has(parsed.hostname);
}

/** At most the last 4 characters, and none of a short key. */
export function maskKey(key: string | null): string | null {
  if (key === null) return null;
  return key.length >= 12 ? `****${key.slice(-4)}` : '****';
}

// ---------------------------------------------------------------- findings

type Location = Pick<ConfigIssue, 'file' | 'path'>;
const where = (o: ValueOrigin): Location => (o.line === null ? { file: '環境変数', path: o.key } : { file: '.env', path: `${o.line}行目（${o.key}）` });
const named = (key: string): Location => ({ file: '.env', path: key });

class Findings {
  readonly issues: ConfigIssue[] = [];
  readonly warnings: ConfigIssue[] = [];
  readonly #seen = new Set<string>();

  issue(at: Location, message: string): void {
    this.#add(this.issues, 'i', at, message);
  }

  warn(at: Location, message: string): void {
    this.#add(this.warnings, 'w', at, message);
  }

  // Inherited values would otherwise report the same line twice (GENERATION and CHECK).
  #add(list: ConfigIssue[], kind: string, at: Location, message: string): void {
    const key = JSON.stringify([kind, at.file, at.path, message]);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    list.push({ ...at, message });
  }
}

// ---------------------------------------------------------------- value parsing

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'on', '1', 'はい', '有効', '無料', '無料枠']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'off', '0', 'いいえ', '無効', '有料']);
const JSON_MODE_WORDS: Readonly<Record<string, JsonMode>> = {
  json_schema: 'json_schema',
  schema: 'json_schema',
  json_object: 'json_object',
  object: 'json_object',
  json: 'json_object',
  none: 'none',
  text: 'none',
  off: 'none',
};

function parseBool(raw: string): boolean | null {
  const w = normalizeWord(raw);
  return TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : null;
}

function parseJsonMode(raw: string): JsonMode | null {
  const w = normalizeWord(raw);
  return Object.hasOwn(JSON_MODE_WORDS, w) ? (JSON_MODE_WORDS[w] as JsonMode) : null;
}

function parsePrice(raw: string): number | null {
  const s = raw.normalize('NFKC').trim().replace(/^\$/, '').replace(/ドル$/, '').trim();
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

// Printable ASCII only: a space or a full-width character in a model id or key is a typing or pasting mistake.
const NOT_PRINTABLE_ASCII = /[^!-~]/;

type UrlCheck = { ok: true; url: string } | { ok: false; message: string };

function checkBaseUrl(raw: string): UrlCheck {
  const url = URL.parse(raw);
  if (url === null || !/^https?:\/\//i.test(raw) || /[\s\p{Cc}]/u.test(raw)) {
    return { ok: false, message: '接続先のURLを読み取れません。https:// で始まるURLを書いてください（例: https://openrouter.ai/api/v1。パソコン内のAIなら http://localhost:11434/v1 など）。' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: '接続先のURLにユーザー名やパスワードを含めないでください（キーは API_KEY の行に書きます）。' };
  }
  if (raw.includes('?') || raw.includes('#')) {
    return { ok: false, message: '接続先のURLには「?」や「#」から後ろを書けません（キーは API_KEY の行に書きます）。' };
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return { ok: false, message: 'http:// が使えるのは、このパソコンの中で動くAI（localhost・127.0.0.1）だけです。それ以外は https:// で書いてください（キーが暗号化されずに送られるのを防ぐため）。' };
  }
  return { ok: true, url: raw };
}

// ---------------------------------------------------------------- .env lines and unknown keys

const STAGE_WORDS: Readonly<Record<string, string>> = { IMAGE: 'ANALYSIS', VISION: 'ANALYSIS', TEXT: 'GENERATION', WRITING: 'GENERATION', CONSISTENCY: 'CHECK' };
const FIELD_WORDS: Readonly<Record<string, string>> = {
  KEY: 'API_KEY',
  APIKEY: 'API_KEY',
  URL: 'BASE_URL',
  ENDPOINT: 'BASE_URL',
  BASEURL: 'BASE_URL',
  SERVICE: 'PROVIDER',
  FREE: 'FREE_TIER',
  FREETIER: 'FREE_TIER',
  JSON: 'JSON_MODE',
  JSONMODE: 'JSON_MODE',
  VERSION: 'API_VERSION',
  APIVERSION: 'API_VERSION',
  TOKENS: 'MAX_TOKENS',
  MAXTOKENS: 'MAX_TOKENS',
};

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** The known key an unknown AI_* key most likely meant, or null. */
function suggestKey(key: string): string | null {
  const up = key.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '_');
  if (KNOWN_KEYS.includes(up)) return up;
  const m = /^AI_([A-Z]+)_(.+)$/.exec(up);
  if (m !== null) {
    const stage = STAGE_WORDS[m[1] as string] ?? m[1];
    const field = FIELD_WORDS[(m[2] as string).replace(/_/g, '')] ?? FIELD_WORDS[m[2] as string] ?? m[2];
    const candidate = `AI_${stage}_${field}`;
    if (KNOWN_KEYS.includes(candidate)) return candidate;
  }
  let best: string | null = null;
  let bestDistance = 3;
  for (const known of KNOWN_KEYS) {
    const d = editDistance(up, known);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
    }
  }
  return best;
}

const isAiKey = (key: string): boolean => /^ai_/i.test(key.normalize('NFKC'));

function fileFindings(env: EnvSource, f: Findings): void {
  for (const p of env.file?.problems ?? []) {
    const ai = p.key !== null && isAiKey(p.key);
    const at: Location = { file: '.env', path: p.reason === 'unterminated_quote' && p.key !== null ? `${p.line}行目（${p.key}）` : `${p.line}行目` };
    if (p.reason === 'unterminated_quote') {
      const message = '引用符（" や \'）が閉じていません。値の最後にも同じ引用符を書いてください。';
      if (ai) f.issue(at, message);
      else f.warn(at, `${message}この行は読み飛ばします。`);
    } else if (ai) {
      f.issue(at, '「名前=値」の形になっていません（= は半角で書きます）。例: AI_ANALYSIS_PROVIDER=gemini');
    } else {
      f.warn(at, '「名前=値」の形になっていないため読み飛ばします。');
    }
  }
  for (const key of env.keys()) {
    if (!isAiKey(key) || KNOWN_KEYS.includes(key)) continue;
    const suggestion = suggestKey(key);
    // Other software may set its own AI_* variables: from the environment, only near-misses of ours are reported.
    if (env.fileValue(key) === undefined && suggestion === null) continue;
    f.warn(
      where({ key, line: env.get(key)?.line ?? null }),
      `「${key}」はこのツールが知らない項目のため使いません。${suggestion === null ? '使える項目は .env.example にあります。' : `「${suggestion}」の書き間違いではありませんか。`}`,
    );
  }
  const lines = new Map<string, number[]>();
  for (const e of env.file?.entries ?? []) {
    if (isAiKey(e.key)) lines.set(e.key, [...(lines.get(e.key) ?? []), e.line]);
  }
  for (const [key, ls] of lines) {
    if (ls.length < 2) continue;
    const last = ls[ls.length - 1] as number;
    f.warn({ file: '.env', path: `${last}行目（${key}）` }, `${key} が ${ls.join('・')}行目に書かれています。最後の ${last}行目の値を使います。`);
  }
  for (const key of KNOWN_KEYS) {
    const inFile = env.fileValue(key);
    if (inFile !== undefined && env.get(key)?.line === null) {
      f.warn(where({ key, line: inFile.line }), `${key} は Windows の環境変数にも設定されているため、.env ではなく環境変数の値を使います。`);
    }
  }
}

// ---------------------------------------------------------------- stages

interface Field {
  value: string;
  origin: ValueOrigin;
}
type Fields = Partial<Record<AiEnvField, Field>>;
type Requirement = 'provider' | 'model' | 'key' | 'base_url';

function readFields(stage: AiStage, env: EnvSource): Fields {
  const out: Fields = {};
  for (const field of AI_ENV_FIELDS) {
    const key = aiEnvKey(stage, field);
    const v = env.get(key);
    if (v !== undefined && v.value.trim() !== '') out[field] = { value: v.value.trim(), origin: { key, line: v.line } };
  }
  return out;
}

function settingsService(p: Settings['ai']['provider']): AiService | 'mock' | null {
  return p === 'anthropic' ? 'claude' : p;
}

/** The settings.json section with the service's models and prices, or null. */
const sectionOf = (ai: Settings['ai'], info: AiServiceInfo) => (info.settingsSection === null ? null : ai[info.settingsSection]);

function emptyStage(stage: AiStage, source: 'env' | 'settings', service: StageAiConfig['service']): StageAiConfig {
  return { stage, source, service, model: null, apiKey: null, keyName: null, baseURL: null, freeTier: null, fallbackModels: null, apiVersion: null, maxTokens: null, jsonMode: 'json_schema', price: null, inherited: false, origins: {} };
}

function settingsStage(stage: AiStage, ai: Settings['ai'], env: EnvSource): StageAiConfig {
  const service = settingsService(ai.provider);
  if (service === null || service === 'mock') return emptyStage(stage, 'settings', service);
  const info = AI_SERVICE_INFO[service];
  const section = sectionOf(ai, info);
  const keyName = info.legacyKeyEnv(ai);
  const key = keyName === null ? undefined : env.get(keyName)?.value.trim();
  return {
    ...emptyStage(stage, 'settings', service),
    model: section?.models[stage] ?? null,
    apiKey: key === undefined || key === '' ? null : key,
    keyName,
    freeTier: service === 'gemini' ? ai.gemini.free_tier : null,
    apiVersion: service === 'gemini' ? ai.gemini.api_version : null,
  };
}

interface StageContext {
  ai: Settings['ai'];
  env: EnvSource;
  services: Readonly<Record<AiService, AiServiceInfo>>;
  f: Findings;
}

/** `skip`: requirements whose failure GENERATION already reported for the values CHECK inherits. */
function resolveStage(stage: AiStage, fields: Fields, c: StageContext, skip: ReadonlySet<Requirement>): { cfg: StageAiConfig; failed: Set<Requirement> } {
  const { ai, env, f } = c;
  const failed = new Set<Requirement>();
  const fail = (req: Requirement, at: Location, message: string): void => {
    failed.add(req);
    if (!skip.has(req)) f.issue(at, message);
  };
  const present = AI_ENV_FIELDS.filter((k) => fields[k] !== undefined);
  const first = present[0] === undefined ? undefined : fields[present[0]];
  if (first === undefined) return { cfg: settingsStage(stage, ai, env), failed };
  const origins = Object.fromEntries(present.map((k) => [k, fields[k]?.origin])) as StageAiConfig['origins'];
  const anchor = fields.PROVIDER?.origin ?? first.origin;
  const stageJa = AI_STAGE_JA[stage];

  let service: StageAiConfig['service'];
  if (fields.PROVIDER !== undefined) {
    service = parseServiceName(fields.PROVIDER.value);
    if (service === null) {
      fail(
        'provider',
        where(fields.PROVIDER.origin),
        `「${fields.PROVIDER.value}」は使えるサービス名ではありません。gemini・claude・openai・openai_compatible のどれかを書いてください（Claude は anthropic とも書けます）。`,
      );
    }
  } else {
    service = settingsService(ai.provider);
    if (service === null || service === 'mock') {
      fail(
        'provider',
        where(first.origin),
        `${stageJa}の .env の項目を使うには、${aiEnvKey(stage, 'PROVIDER')}= にサービス名（gemini・claude・openai・openai_compatible）を書いてください（settings.json の ai.provider が ${service === null ? '未設定' : 'mock'} のため）。`,
      );
    }
  }
  if (service === null || service === 'mock') return { cfg: { ...emptyStage(stage, 'env', null), origins }, failed };
  const info = c.services[service];
  const section = sectionOf(ai, info);

  let model: string | null = null;
  if (fields.MODEL !== undefined) {
    const m = fields.MODEL.value.normalize('NFKC').trim();
    if (NOT_PRINTABLE_ASCII.test(m)) {
      fail('model', where(fields.MODEL.origin), 'モデル名に空白や全角文字が含まれています。サービスの説明にあるとおり、半角の英数字で書いてください。');
    } else {
      model = m;
    }
  } else {
    model = section === null ? null : section.models[stage];
    if (model === null) {
      const fallback = info.settingsSection === null ? '' : `（settings.json の ai.${info.settingsSection}.models.${stage} も未設定です）`;
      fail('model', where(anchor), `${stageJa}のモデル名がありません。${aiEnvKey(stage, 'MODEL')}= の後ろにモデル名（例: ${info.modelExample}）を書いてください${fallback}。`);
    }
  }

  let baseURL: string | null = null;
  if (fields.BASE_URL !== undefined) {
    const r = checkBaseUrl(fields.BASE_URL.value);
    if (r.ok) baseURL = r.url;
    else fail('base_url', where(fields.BASE_URL.origin), r.message);
  } else if (service === 'openai_compatible') {
    fail(
      'base_url',
      named(aiEnvKey(stage, 'BASE_URL')),
      `${stageJa}は openai_compatible（OpenAI互換）のため、接続先のURLが必要です。${aiEnvKey(stage, 'BASE_URL')}= の後ろに、使うサービスの説明にある OpenAI 互換のURL（例: https://openrouter.ai/api/v1、パソコン内の Ollama なら http://localhost:11434/v1）を書いてください。`,
    );
  }

  let apiKey: string | null = null;
  const legacy = info.legacyKeyEnv(ai);
  let keyName = aiEnvKey(stage, 'API_KEY');
  let keyField: Field | undefined = fields.API_KEY;
  if (keyField !== undefined) {
    keyName = keyField.origin.key;
  } else if (legacy !== null) {
    const v = env.get(legacy);
    if (v !== undefined && v.value.trim() !== '') {
      keyName = legacy;
      keyField = { value: v.value.trim(), origin: { key: legacy, line: v.line } };
    }
  }
  if (keyField !== undefined) {
    if (NOT_PRINTABLE_ASCII.test(keyField.value)) {
      fail('key', where(keyField.origin), 'APIキーに空白や全角文字が含まれています（キーは表示しません）。サービスの画面からコピーし直して貼り付けてください。');
    } else {
      apiKey = keyField.value;
    }
  } else if (!(service === 'openai_compatible' && (isLocalUrl(baseURL) || failed.has('base_url')))) {
    const also = legacy === null ? '' : `${legacy}= に書いたキーも使えます。`;
    fail(
      'key',
      named(aiEnvKey(stage, 'API_KEY')),
      `${stageJa}（${info.label}）のAPIキーがありません。${info.keyHelp}、.env に「${aiEnvKey(stage, 'API_KEY')}=」に続けて書いてください（${also}キーは画面やログには表示しません）。`,
    );
  }

  let freeTier: boolean | null = null;
  if (service === 'gemini') {
    freeTier = ai.gemini.free_tier;
    if (fields.FREE_TIER !== undefined) {
      const b = parseBool(fields.FREE_TIER.value);
      if (b === null) f.issue(where(fields.FREE_TIER.origin), 'FREE_TIER には true（無料枠）か false（有料）を書いてください。');
      else freeTier = b;
    }
  } else if (fields.FREE_TIER !== undefined) {
    f.warn(where(fields.FREE_TIER.origin), `FREE_TIER は Gemini のときだけ使います（${info.label}では使いません）。`);
  }

  let fallbackModels: string[] | null = null;
  if (fields.FALLBACK_MODELS !== undefined) {
    const list = fields.FALLBACK_MODELS.value.normalize('NFKC').split(/[,、]/).map((m) => m.trim()).filter((m) => m !== '');
    if (service !== 'gemini') {
      f.warn(where(fields.FALLBACK_MODELS.origin), `FALLBACK_MODELS は Gemini のときだけ使います（${info.label}では使いません）。`);
    } else if (list.some((m) => NOT_PRINTABLE_ASCII.test(m))) {
      f.issue(where(fields.FALLBACK_MODELS.origin), '予備のモデル名に空白や全角文字が含まれています。半角の英数字で書き、複数ならカンマ（,）で区切ってください（例: gemini-3.6-flash,gemini-3.5-flash）。');
    } else {
      fallbackModels = list;
    }
  }

  let apiVersion: string | null = null;
  if (service === 'gemini') {
    apiVersion = ai.gemini.api_version;
    if (fields.API_VERSION !== undefined) {
      const v = fields.API_VERSION.value.normalize('NFKC').trim();
      if (/^[A-Za-z0-9._-]+$/.test(v)) apiVersion = v;
      else f.issue(where(fields.API_VERSION.origin), 'API_VERSION には API のバージョン名を半角の英数字で書いてください（例: v1beta）。');
    }
  } else if (fields.API_VERSION !== undefined) {
    f.warn(where(fields.API_VERSION.origin), `API_VERSION は Gemini のときだけ使います（${info.label}では使いません）。`);
  }

  let maxTokens: number | null = null;
  if (fields.MAX_TOKENS !== undefined) {
    const raw = fields.MAX_TOKENS.value.normalize('NFKC').trim();
    if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0) maxTokens = Number(raw);
    else f.issue(where(fields.MAX_TOKENS.origin), 'MAX_TOKENS には1以上の整数を書いてください（例: 16000）。');
  }

  let jsonMode: JsonMode = 'json_schema';
  if (fields.JSON_MODE !== undefined) {
    if (service === 'openai' || service === 'openai_compatible') {
      const m = parseJsonMode(fields.JSON_MODE.value);
      if (m === null) f.issue(where(fields.JSON_MODE.origin), 'JSON_MODE には json_schema・json_object・none のどれかを書いてください。');
      else jsonMode = m;
    } else {
      f.warn(where(fields.JSON_MODE.origin), `JSON_MODE は openai・openai_compatible のときだけ使います（${info.label}では使いません）。`);
    }
  }

  let price: StagePrice | null = null;
  const priceFields = [fields.PRICE_IN, fields.PRICE_OUT];
  const priceGiven = priceFields.some((p) => p !== undefined);
  if (priceGiven) {
    const given = (fields.PRICE_IN ?? fields.PRICE_OUT) as Field;
    if (service === 'gemini' && freeTier === true) {
      f.warn(where(given.origin), 'Gemini の無料枠では料金を数えないため、PRICE_IN・PRICE_OUT は使いません。');
    } else {
      const values = priceFields.map((p) => {
        if (p === undefined) return undefined;
        const n = parsePrice(p.value);
        if (n === null) f.issue(where(p.origin), '料金は100万トークンあたりのドルを数字で書いてください（例: 2.5）。');
        return n;
      });
      const [input, output] = values;
      if (typeof input === 'number' && typeof output === 'number') {
        price = { input_per_mtok: input, output_per_mtok: output };
      } else if (!values.includes(null)) {
        const prefix = given.origin.key.replace(/_PRICE_(IN|OUT)$/, '');
        f.issue(where(given.origin), `料金は ${prefix}_PRICE_IN（入力）と ${prefix}_PRICE_OUT（出力）の両方を書いてください（100万トークンあたりのドル）。`);
      }
    }
  }

  // Every paid service fails closed on an unknown price (the budget could not stop it); a PC-local server costs nothing.
  const paid = service === 'claude' || service === 'openai' || (service === 'gemini' && freeTier === false) || (service === 'openai_compatible' && baseURL !== null && !isLocalUrl(baseURL));
  if (paid && model !== null && price === null && !priceGiven && (section === null || !Object.hasOwn(section.pricing, model))) {
    const prefix = (fields.MODEL?.origin.key ?? aiEnvKey(stage, 'MODEL')).replace(/_MODEL$/, '');
    const how = section === null ? '書いてください。無料で使える接続先なら、どちらも 0 と書いてください。' : `書くか、settings.json の ai.${info.settingsSection}.pricing に書いてください。`;
    f.issue(
      where(fields.MODEL?.origin ?? anchor),
      `モデル「${model}」の料金が分からないため、利用額を見積もれません（予算で止められないので、このままでは使いません）。${prefix}_PRICE_IN=（入力100万トークンあたりのドル）と ${prefix}_PRICE_OUT=（出力）を${how}`,
    );
  }

  if (stage === 'analysis' && !info.images) {
    f.issue(where(anchor), `${info.label} は画像を読めないため、画像解析には使えません。${aiEnvKey('analysis', 'PROVIDER')} を画像を読めるサービスにしてください。`);
  }

  return { cfg: { stage, source: 'env', service, model, apiKey, keyName, baseURL, freeTier, fallbackModels, apiVersion, maxTokens, jsonMode, price, inherited: false, origins }, failed };
}

function freeTierConsistency(stages: Record<AiStage, StageAiConfig>, f: Findings): void {
  const gemini = AI_STAGES.filter((s) => stages[s].service === 'gemini' && stages[s].freeTier !== null);
  if (new Set(gemini.map((s) => stages[s].freeTier)).size <= 1) return;
  const origin = gemini.map((s) => stages[s].origins.FREE_TIER).find((o) => o !== undefined);
  const list = gemini.map((s) => `${AI_STAGE_JA[s]}: ${stages[s].freeTier ? '無料枠' : '有料'}`).join('、');
  f.issue(
    origin === undefined ? named('AI_ANALYSIS_FREE_TIER') : where(origin),
    `Gemini の無料枠（FREE_TIER）は、Gemini を使うすべての段階で同じにしてください（${list}）。書いていない段階は settings.json の ai.gemini.free_tier に従います。`,
  );
}

/**
 * Resolves the three stages. Per stage, every AI_<STAGE>_* value overrides settings.json; an unset PROVIDER means
 * settings.json ai.provider, an unset MODEL (Gemini, Claude, OpenAI) the settings model of that stage, an unset key the old
 * variable (GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY). CHECK takes every value it leaves unset from
 * GENERATION's .env values, unless it names a different service. `services` is replaceable for tests.
 */
export function resolveAiConfig(ai: Settings['ai'], env: EnvSource, services: Readonly<Record<AiService, AiServiceInfo>> = AI_SERVICE_INFO): AiConfigResult {
  const f = new Findings();
  fileFindings(env, f);
  const c: StageContext = { ai, env, services, f };
  const raw = { analysis: readFields('analysis', env), generation: readFields('generation', env), check: readFields('check', env) };
  const none = new Set<Requirement>();
  const analysis = resolveStage('analysis', raw.analysis, c, none);
  const generation = resolveStage('generation', raw.generation, c, none);
  const ownService = raw.check.PROVIDER === undefined ? undefined : parseServiceName(raw.check.PROVIDER.value);
  const inherit = generation.cfg.source === 'env' && (ownService === undefined || (ownService !== null && ownService === generation.cfg.service));
  const check = resolveStage('check', inherit ? { ...raw.generation, ...raw.check } : raw.check, c, inherit ? generation.failed : none);
  const inherited = inherit && AI_ENV_FIELDS.some((k) => raw.check[k] === undefined && raw.generation[k] !== undefined);
  const stages = { analysis: analysis.cfg, generation: generation.cfg, check: { ...check.cfg, inherited } };
  freeTierConsistency(stages, f);
  return { stages, issues: f.issues, warnings: f.warnings };
}

/**
 * True when the stages run one provider each (registry.ts): some stage takes a value from .env (or the environment), or
 * uses OpenAI (settings.json ai.provider "openai" has no single-provider path).
 */
export const usesEnvStages = (r: AiConfigResult): boolean => AI_STAGES.some((s) => r.stages[s].source === 'env' || r.stages[s].service === 'openai');

// ---------------------------------------------------------------- settings overlays

/** A .env price as a price-list entry (cache reads at the input price, so the estimate errs high). */
export const envPricing = (p: StagePrice): ModelPricing => ({ input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok, cache_read_per_mtok: p.input_per_mtok, verified_at: '.env' });

/**
 * The settings a Gemini or Claude provider serving this .env stage reads on every call: its provider, the stage's model
 * (and Gemini fallback models) and key variable, the free tier, a .env price (cache reads at the input price, so the
 * estimate errs high) and, for a free-tier model settings.json has no limits for, PLACEHOLDER_FREE_LIMIT. Anything else
 * is unchanged.
 */
export function stageSettings(settings: Settings, cfg: StageAiConfig): Settings {
  const ai = overlayAi(settings.ai, cfg);
  return ai === settings.ai ? settings : { ...settings, ai };
}

function overlayAi(ai: Settings['ai'], cfg: StageAiConfig): Settings['ai'] {
  if (cfg.source !== 'env' || cfg.model === null) return ai;
  const model = cfg.model;
  if (cfg.service === 'gemini') {
    const g = ai.gemini;
    const free = cfg.freeTier ?? g.free_tier;
    const fallbacks = cfg.fallbackModels ?? g.fallback_models[cfg.stage];
    const unlimited = free ? [model, ...fallbacks].filter((m) => !Object.hasOwn(g.limits, m)) : [];
    const gemini = {
      ...g,
      api_key_env: cfg.keyName ?? g.api_key_env,
      models: { ...g.models, [cfg.stage]: model },
      fallback_models: { ...g.fallback_models, [cfg.stage]: fallbacks },
      max_output_tokens: cfg.maxTokens === null ? g.max_output_tokens : { ...g.max_output_tokens, [cfg.stage]: Math.min(cfg.maxTokens, GEMINI_MAX_OUTPUT_TOKENS) },
      free_tier: free,
      limits: { ...g.limits, ...Object.fromEntries(unlimited.map((m) => [m, { ...PLACEHOLDER_FREE_LIMIT }])) },
      pricing: cfg.price === null ? g.pricing : { ...g.pricing, [model]: envPricing(cfg.price) },
    };
    return { ...ai, provider: 'gemini', gemini };
  }
  if (cfg.service === 'claude') {
    const a = ai.anthropic;
    const anthropic = {
      ...a,
      api_key_env: cfg.keyName ?? a.api_key_env,
      models: { ...a.models, [cfg.stage]: model },
      pricing: cfg.price === null ? a.pricing : { ...a.pricing, [model]: envPricing(cfg.price) },
    };
    return { ...ai, provider: 'anthropic', anthropic };
  }
  return ai;
}

/**
 * settings.ai as the Gemini status lines (geminiQuotaStatusLines) should read it: provider gemini, the models of the
 * stages that use Gemini (null for the others), their tier, limits and prices. null when no stage uses Gemini.
 */
export function effectiveGeminiAi(ai: Settings['ai'], r: AiConfigResult): Settings['ai'] | null {
  const stages = AI_STAGES.filter((s) => r.stages[s].service === 'gemini');
  if (stages.length === 0) return null;
  const models: Record<AiStage, string | null> = { analysis: null, generation: null, check: null };
  const fallbacks: Record<AiStage, string[]> = { analysis: [], generation: [], check: [] };
  let out = ai;
  for (const s of stages) {
    models[s] = r.stages[s].model;
    out = overlayAi(out, r.stages[s]);
    fallbacks[s] = out.gemini.fallback_models[s];
  }
  const free = r.stages[stages[0] as AiStage].freeTier ?? out.gemini.free_tier;
  return { ...out, provider: 'gemini', gemini: { ...out.gemini, free_tier: free, models, fallback_models: fallbacks } };
}

// ---------------------------------------------------------------- status

export type EnvFileState = 'found' | 'missing' | 'unreadable';

/** What status shows of a stage: no key, at most its last 4 characters. */
export interface AiStageStatus {
  stage: AiStage;
  source: 'env' | 'settings';
  inherited: boolean;
  service: AiService | 'mock' | null;
  model: string | null;
  key_masked: string | null;
  key_name: string | null;
  /** false: an OpenAI-compatible server on this PC, which needs no key. */
  key_required: boolean;
  /** No service, though .env names one: the key holding the value that is not a service name (CHECK's may be GENERATION's). */
  provider_invalid: string | null;
  free_tier: boolean | null;
  base_url: string | null;
  json_mode: JsonMode;
  api_version: string | null;
}

export interface AiConfigStatus {
  env_file: EnvFileState;
  stages: AiStageStatus[];
  issues: ConfigIssue[];
  warnings: ConfigIssue[];
}

export function aiConfigStatus(r: AiConfigResult, envFile: EnvFileState): AiConfigStatus {
  return {
    env_file: envFile,
    stages: AI_STAGES.map((stage) => {
      const s = r.stages[stage];
      return {
        stage,
        source: s.source,
        inherited: s.inherited,
        service: s.service,
        model: s.model,
        key_masked: maskKey(s.apiKey),
        key_name: s.keyName,
        key_required: !(s.service === 'openai_compatible' && isLocalUrl(s.baseURL)),
        provider_invalid: s.service === null ? (s.origins.PROVIDER?.key ?? null) : null,
        free_tier: s.freeTier,
        base_url: s.baseURL,
        json_mode: s.jsonMode,
        api_version: s.apiVersion,
      };
    }),
    issues: r.issues.map((i) => ({ ...i })),
    warnings: r.warnings.map((i) => ({ ...i })),
  };
}

function stageText(s: AiStageStatus): string {
  if (s.service === null && s.provider_invalid !== null) return `サービス 誤りあり（下の .env の誤りを参照。.env の ${s.provider_invalid}）`;
  if (s.service === null) return `サービス 未設定（.env の ${aiEnvKey(s.stage, 'PROVIDER')} か settings.json の ai.provider に書いてください）`;
  if (s.service === 'mock') return 'サービス mock（仮のAI。本物のAIは呼びません）';
  const info = AI_SERVICE_INFO[s.service];
  const key =
    s.key_masked !== null
      ? `${s.key_masked}（${s.key_name ?? aiEnvKey(s.stage, 'API_KEY')}）`
      : s.key_required
        ? `未設定（${s.key_name ?? aiEnvKey(s.stage, 'API_KEY')}）`
        : 'なし（パソコン内のAIのため不要）';
  const free = s.service === 'gemini' ? (s.free_tier === true ? 'はい' : 'いいえ（有料）') : '対象外';
  const endpoint = s.base_url ?? (info.standardEndpoint === null ? '未設定' : `標準（${info.standardEndpoint}）`);
  const parts = [`サービス ${info.label}`, `モデル ${s.model ?? '未設定'}`, `キー ${key}`, `無料枠 ${free}`, `接続先 ${endpoint}`];
  if (s.service === 'openai_compatible') parts.push(`JSON形式 ${s.json_mode}`);
  if (s.api_version !== null) parts.push(`APIバージョン ${s.api_version}`);
  return parts.join(' / ');
}

const issueLine = (i: ConfigIssue): string => `    - ${i.path === '' ? i.file : `${i.file} ${i.path}`}: ${i.message}`;

/** The status section: per stage service / model / masked key / free tier / endpoint, then .env problems. */
export function aiConfigStatusLines(s: AiConfigStatus, o: { mode: Mode; dryRunUsesRealAi: boolean; consistencyCheck: Settings['ai']['consistency_check'] }): string[] {
  const lines = ['AIの設定（.env の AI_ で始まる行と settings.json。.env を変えたときは、ツールを起動し直すと反映されます）:'];
  if (s.env_file === 'unreadable') {
    lines.push('  ※ .env ファイルを読み取れませんでした（ほかのソフトで開いたままなどの可能性があります）。settings.json と環境変数の設定だけで表示しています。');
  }
  for (const st of s.stages) {
    const name = AI_STAGE_JA[st.stage];
    if (st.stage === 'check' && o.consistencyCheck === 'off') {
      lines.push(`  ${name}: 使いません（settings.json の ai.consistency_check が off）`);
      continue;
    }
    const from = st.source === 'settings' ? 'settings.json' : st.inherited ? '.env、文章生成から引き継ぎ' : '.env';
    lines.push(`  ${name}（${from}）: ${stageText(st)}`);
  }
  if (o.mode === 'dry_run' && !o.dryRunUsesRealAi) {
    lines.push('  ※ dry-run では本物のAIを呼ばず、仮の文章を使います（この設定は本番と npm.cmd run ai:test で使います）。');
  }
  if (s.issues.length > 0) lines.push('  .env の誤り（直すまで本物のAIを使えません。直したらツールを起動し直してください）:', ...s.issues.map(issueLine));
  if (s.warnings.length > 0) lines.push('  .env の注意:', ...s.warnings.map(issueLine));
  return lines;
}
