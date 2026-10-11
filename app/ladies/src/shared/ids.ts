import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from './clock.js';
import { jstCompact } from './time.js';

/** j-YYYYMMDD-HHmmss-xxxxxx: JST timestamp plus 6 lowercase hex random chars. */
export function newJobId(clock: Clock): string {
  return `j-${jstCompact(clock.now())}-${randomBytes(3).toString('hex')}`;
}

/** `<prefix>-<uuid>`. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
