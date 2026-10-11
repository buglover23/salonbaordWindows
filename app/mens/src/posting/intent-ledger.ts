import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppLogger } from '../logger.js';
import { jstDateKey } from '../shared/time.js';
import { POST_TYPES } from '../shared/types.js';
import { isoUtc } from '../shared/zod-helpers.js';
import { errnoCode, storageFailure } from '../storage/atomic-json.js';

export type LedgerFs = Pick<typeof fsp, 'open' | 'mkdir' | 'readFile' | 'readdir' | 'unlink'>;

const LedgerLineSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['intent', 'void']),
  at: isoUtc,
  job_id: z.string().min(1),
  attempt_id: z.string().min(1),
  instance_id: z.string().min(1),
  post_type: z.enum(POST_TYPES),
});
export type LedgerLine = z.infer<typeof LedgerLineSchema>;
export type LedgerEntry = Omit<LedgerLine, 'v' | 'kind'>;

const FILE = /^submit-intents-(\d{4}-\d{2})\.jsonl$/;
const KEEP_DAYS = 400;
const monthOf = (d: Date): string => jstDateKey(d).slice(0, 7);

function parseLine(raw: string): LedgerLine | null {
  try {
    const r = LedgerLineSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * P3-R38: an append-only record of every submit intent, in <modeRoot>/ledger (outside data/, so a restore of data/ from a
 * backup never rewinds it). One JSON line per intent or void, fsynced before the attempt's intent is saved, one file per
 * JST month, kept 400 days. Not a store and not a journal: only the startup check reads it.
 */
export class IntentLedger {
  readonly #dir: string;
  readonly #logger: AppLogger;
  readonly #fs: LedgerFs;

  constructor(dir: string, o: { logger: AppLogger; fs?: LedgerFs }) {
    this.#dir = dir;
    this.#logger = o.logger;
    this.#fs = o.fs ?? fsp;
  }

  /** Throws FILE_IO_ERROR / DISK_FULL when the line is not durably written (then no permission may be issued). */
  appendIntent(e: LedgerEntry): Promise<void> {
    return this.#append({ v: 1, kind: 'intent', ...e });
  }

  /** The intent above was not saved in the attempt after all (step 4.3 failed): it explains the line. */
  appendVoid(e: LedgerEntry): Promise<void> {
    return this.#append({ v: 1, kind: 'void', ...e });
  }

  /** The lines at or after `from`, oldest file first. Unreadable lines (a write cut short) are skipped with a warning. */
  async readSince(from: Date): Promise<LedgerLine[]> {
    const out: LedgerLine[] = [];
    for (const name of await this.#files()) {
      if ((FILE.exec(name)?.[1] ?? '') < monthOf(from)) continue;
      const path = join(this.#dir, name);
      let text: string;
      try {
        text = await this.#fs.readFile(path, 'utf8');
      } catch (err) {
        throw storageFailure(err, '送信記録（ledger）の読込', path);
      }
      text.split('\n').forEach((raw, i) => {
        if (raw.trim() === '') return;
        const parsed = parseLine(raw);
        if (parsed === null) {
          this.#logger.warn('LEDGER_LINE_IGNORED', `送信記録（ledger）の読めない行を読み飛ばしました（書込の途中で止まった行の可能性があります）: ${name} ${i + 1}行目`, { file: name, line: i + 1 });
          return;
        }
        if (Date.parse(parsed.at) >= from.getTime()) out.push(parsed);
      });
    }
    return out;
  }

  /** Removes the month files whose every line is older than 400 days. */
  async prune(now: Date): Promise<void> {
    const cutoff = monthOf(new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000));
    for (const name of await this.#files()) {
      if ((FILE.exec(name)?.[1] ?? cutoff) >= cutoff) continue;
      const path = join(this.#dir, name);
      try {
        await this.#fs.unlink(path);
      } catch (err) {
        this.#logger.warn('LEDGER_PRUNE_FAILED', `古い送信記録（ledger）を削除できませんでした（次回また試します）: ${name}`, { file: name, errno: errnoCode(err) ?? null });
      }
    }
  }

  async #append(line: LedgerLine): Promise<void> {
    const path = join(this.#dir, `submit-intents-${monthOf(new Date(line.at))}.jsonl`);
    try {
      await this.#fs.mkdir(this.#dir, { recursive: true });
      const handle = await this.#fs.open(path, 'a');
      try {
        await handle.write(`${JSON.stringify(LedgerLineSchema.parse(line))}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw storageFailure(err, '送信記録（ledger）の書込', path);
    }
  }

  async #files(): Promise<string[]> {
    try {
      return (await this.#fs.readdir(this.#dir)).filter((n) => FILE.test(n)).sort();
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return [];
      throw storageFailure(err, '送信記録（ledger）のフォルダの読込', this.#dir);
    }
  }
}
