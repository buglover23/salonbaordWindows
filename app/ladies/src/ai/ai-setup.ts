import { join } from 'node:path';
import { envSource, readEnvFile, type EnvFile, type EnvSource } from '../config/env-file.js';
import type { Settings } from '../config/schemas.js';
import { AI_STAGES } from '../shared/types.js';
import { isLocalUrl, resolveAiConfig, type AiConfigResult, type EnvFileState, type StageAiConfig } from './ai-config.js';

export interface AiSetup {
  config: AiConfigResult;
  envFile: EnvFileState;
  /** The .env file over the environment, as read (config is resolved from it and settings.json ai.*). */
  env: EnvSource;
}

/**
 * Reads <envDir>/.env (envDirOf: the project root, or settings.shared_root) and resolves the AI stages (ruling P2-R17).
 * The file is not copied into process.env: keys go
 * only to the SDK clients. Read once per process, so an edited .env applies after a restart. An unreadable file is
 * reported (status), and the environment and settings.json still apply.
 */
export async function loadAiSetup(envDir: string, ai: Settings['ai'], env: Readonly<Record<string, string | undefined>> = process.env): Promise<AiSetup> {
  let file: EnvFile | null = null;
  let envFile: EnvFileState;
  try {
    file = await readEnvFile(join(envDir, '.env'));
    envFile = file.exists ? 'found' : 'missing';
  } catch {
    envFile = 'unreadable';
  }
  const source = envSource(file, env);
  return { config: resolveAiConfig(ai, source), envFile, env: source };
}

/** The first stage in use with a real service but no key (a local OpenAI-compatible server needs none); null when none. */
export function stageWithoutKey(r: AiConfigResult, ai: Settings['ai']): StageAiConfig | null {
  for (const stage of AI_STAGES) {
    const s = r.stages[stage];
    if (stage === 'check' && ai.consistency_check === 'off') continue;
    if (s.service !== null && s.service !== 'mock' && s.apiKey === null && !(s.service === 'openai_compatible' && isLocalUrl(s.baseURL))) return s;
  }
  return null;
}

/** The startup .env values resolved against the current settings.json ai.* (settings.json reloads while the tool runs; .env is read once). */
export const currentAiSetup = (setup: AiSetup, ai: Settings['ai']): AiSetup => ({ ...setup, config: resolveAiConfig(ai, setup.env) });
