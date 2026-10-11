import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { acquireAppLock, type AcquireAppLockOptions } from './app-lock.js';
import type { DataPaths } from './paths.js';

// Maintenance commands that write what the running tool also writes (template / trend caches, AI usage, jobs, history)
// take app.lock for their whole run (spec 11.4-1: one writer). While the tool runs they refuse, telling the owner to stop
// it first; they never write behind its back.

export type CommandLockOptions = Pick<AcquireAppLockOptions, 'isPidAlive' | 'getProcessStartTime' | 'getBootTime' | 'sleep'>;

/** Runs `fn` holding app.lock; LOCK_CONFLICT (the tool is running) says in Japanese to stop it first. Always releases. */
export async function withCommandLock<T>(paths: DataPaths, command: string, fn: () => Promise<T>, o: CommandLockOptions = {}): Promise<T> {
  let lock;
  try {
    lock = await acquireAppLock({ lockFile: paths.lockFile, instanceId: newId('cmd'), clock: systemClock, ...o });
  } catch (err) {
    if (err instanceof AppFailure && err.error.code === 'LOCK_CONFLICT') {
      throw new AppFailure(
        appError('LOCK_CONFLICT', 'cli', systemClock, {
          message: `ツールが動作中（npm.cmd start）か、別のコマンドを実行中のため、${command} は実行できません。動作中のツールを Ctrl+C で止めてから、もう一度実行してください。（${err.error.message}）`,
          retryable: false,
          details: { ...err.error.details_redacted, command },
        }),
      );
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => undefined);
  }
}
