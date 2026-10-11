import type { AiServiceDeps } from './ai/ai-service.js';
import type { RunLoopTiming } from './execution/run-loop.js';
import type { Clock } from './shared/clock.js';
import type { AppLogger } from './logger.js';
import type { ResourceSample } from './resource-monitor.js';
import type { UrlPolicy } from './shared/url-policy.js';

export type RuntimeTiming = RunLoopTiming & {
  /** The live poster's maintain timer (default 15 s). */
  maintainMs?: number;
  /** How long stop() waits for in-flight post-intent results (default 90 s). */
  drainMs?: number;
  /** The resource monitor's interval (default 30 s, spec 16.6). */
  monitorMs?: number;
};

export interface RuntimeOptions {
  projectRoot: string;
  clock?: Clock;
  /** Replaces the file logger (tests). */
  logger?: AppLogger;
  /** Gets a one-line Japanese echo of every info/warn/error record (the console of `npm start`). */
  echo?: (line: string) => void;
  /** Loop intervals in real milliseconds (tests shorten them). */
  timing?: Partial<RuntimeTiming>;
  /** Replaces parts of the AI wiring (tests: a stubbed SDK client, process environment, mock options). */
  ai?: RuntimeAiOptions;
  /** Local API seams (tests and E2E only; the CLI never passes them, P3-R30). */
  api?: RuntimeApiOptions;
  /** Test-only behaviour (DI only: never from config, environment variables or the CLI). */
  testOverrides?: RuntimeTestOverrides;
}

/** Test seams of the AI wiring; never needed in normal use. */
export interface RuntimeAiOptions {
  /** The environment .env is merged under (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  createClient?: AiServiceDeps['createClient'];
  sleep?: AiServiceDeps['sleep'];
  random?: AiServiceDeps['random'];
  mock?: AiServiceDeps['mock'];
}

export interface RuntimeApiOptions {
  /** Default settings.server.port (3001); 0 picks a free port in tests, 3911 in E2E. */
  port?: number;
  /** Default PRODUCTION_URL_POLICY; E2E allows only the mock origin. */
  urlPolicy?: UrlPolicy;
  /** Simulated failures for tests, e.g. an `EACCES` from listen. */
  faults?: { listenErrorCode?: string };
}

export interface RuntimeTestOverrides {
  /** Lets live-mode tests post mock-provider drafts (P3-R41). */
  allowMockAiInLive?: boolean;
  /** Replaces the memory / free-disk sample of the resource monitor. */
  resourceSample?: () => Promise<ResourceSample>;
}
