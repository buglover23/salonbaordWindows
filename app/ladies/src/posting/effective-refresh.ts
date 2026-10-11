import type { ConfigManager } from '../config/loader.js';
import type { EffectiveConfig, EffectiveConfigSource } from '../content/effective-config.js';
import type { InstructionManager } from '../content/instructions/store.js';
import { SerialQueue } from '../storage/serial-queue.js';

export interface RefreshResult {
  effective: EffectiveConfig;
  /** A config edit was rejected (latestRejectedIssues non-empty): nothing new is dispatched. */
  rejected: boolean;
  /** Both the config check and the instruction scan worked (and the instructions are known). */
  ok: boolean;
}

export interface EffectiveConfigServiceDeps {
  config: Pick<ConfigManager, 'reloadIfChanged' | 'latestRejectedIssues'>;
  instructions: Pick<InstructionManager, 'scan' | 'current'>;
  effective: Pick<EffectiveConfigSource, 'current'>;
}

/**
 * P3-R39 / 5.10-a: claim and intent look at the config and the instruction folder right before deciding. Runs one at a
 * time with the RunLoop's config step (`serialize`), so the two never read the folder at the same moment.
 */
export class EffectiveConfigService {
  readonly #queue = new SerialQueue();
  readonly #d: EffectiveConfigServiceDeps;

  constructor(d: EffectiveConfigServiceDeps) {
    this.#d = d;
  }

  serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run(fn);
  }

  refresh(now: Date): Promise<RefreshResult> {
    return this.#queue.run(async () => {
      const { config, instructions, effective } = this.#d;
      let ok = true;
      await config.reloadIfChanged().catch(() => (ok = false));
      await instructions.scan(now).catch(() => (ok = false));
      return { effective: effective.current, rejected: config.latestRejectedIssues.length > 0, ok: ok && instructions.current !== null };
    });
  }
}
