import type { Settings } from '../config/schemas.js';

// The AI services a stage can use (.env AI_<STAGE>_PROVIDER), with what the operator text and the config checks need
// to know about them. No SDK is imported here, so status and config checks stay light.

export const AI_SERVICES = ['gemini', 'claude', 'openai', 'openai_compatible'] as const;
export type AiService = (typeof AI_SERVICES)[number];

/** How the answer is constrained: a JSON Schema, JSON without a schema, or plain text from which the JSON is taken. */
export const JSON_MODES = ['json_schema', 'json_object', 'none'] as const;
export type JsonMode = (typeof JSON_MODES)[number];

export interface AiServiceInfo {
  /** Operator-facing name. */
  label: string;
  /** Where a key comes from, as the start of a Japanese sentence ("…でAPIキーを作り"). */
  keyHelp: string;
  /** The host shown in status when no BASE_URL is set; null = the service has no standard endpoint. */
  standardEndpoint: string | null;
  /** The settings.json section with models and prices, or null. */
  settingsSection: 'gemini' | 'anthropic' | 'openai' | null;
  /** The variable read when AI_<STAGE>_API_KEY is not set (the names used before .env stages existed); null = none. */
  legacyKeyEnv: (ai: Settings['ai']) => string | null;
  /** Whether it can read images (required for the analysis stage). */
  images: boolean;
  /** A model id for messages. */
  modelExample: string;
}

export const AI_SERVICE_INFO: Readonly<Record<AiService, AiServiceInfo>> = {
  gemini: {
    label: 'Google Gemini',
    keyHelp: 'Google AI Studio（https://aistudio.google.com/）でGoogleアカウントにログインしてAPIキーを作り',
    standardEndpoint: 'generativelanguage.googleapis.com',
    settingsSection: 'gemini',
    legacyKeyEnv: (ai) => ai.gemini.api_key_env,
    images: true,
    modelExample: 'gemini-3.8-flash',
  },
  claude: {
    label: 'Claude（Anthropic）',
    keyHelp: 'Claude Console（https://console.anthropic.com/）でAPIキーを作り',
    standardEndpoint: 'api.anthropic.com',
    settingsSection: 'anthropic',
    legacyKeyEnv: (ai) => ai.anthropic.api_key_env,
    images: true,
    modelExample: 'claude-opus-5-5',
  },
  openai: {
    label: 'OpenAI',
    keyHelp: 'OpenAI の管理画面（https://platform.openai.com/api-keys）でAPIキーを作り',
    standardEndpoint: 'api.openai.com',
    settingsSection: 'openai',
    legacyKeyEnv: () => 'OPENAI_API_KEY',
    images: true,
    modelExample: 'gpt-6.1-sol',
  },
  openai_compatible: {
    label: 'OpenAI互換',
    keyHelp: '使うサービスの管理画面でAPIキーを作り',
    standardEndpoint: null,
    settingsSection: null,
    legacyKeyEnv: () => null,
    // Depends on the model; `npm run ai:test` sends a small image for the analysis stage to find out.
    images: true,
    modelExample: 'サービスの説明にあるモデル名',
  },
};

const ALIASES: Readonly<Record<string, AiService>> = {
  gemini: 'gemini',
  google: 'gemini',
  google_gemini: 'gemini',
  ジェミニ: 'gemini',
  ジェミナイ: 'gemini',
  claude: 'claude',
  anthropic: 'claude',
  クロード: 'claude',
  openai: 'openai',
  open_ai: 'openai',
  chatgpt: 'openai',
  オープンai: 'openai',
  openai_compatible: 'openai_compatible',
  openai_compat: 'openai_compatible',
  compatible: 'openai_compatible',
  openai互換: 'openai_compatible',
  open_ai互換: 'openai_compatible',
};

/** Full-width to half-width (NFKC), trimmed, lower case, spaces and hyphens as "_". */
export function normalizeWord(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** The service a PROVIDER value names (aliases such as anthropic → claude), or null. */
export function parseServiceName(raw: string): AiService | null {
  const word = normalizeWord(raw);
  return Object.hasOwn(ALIASES, word) ? (ALIASES[word] as AiService) : null;
}
