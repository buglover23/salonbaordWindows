// Node-side timing constants of the live poster (plan §5.4). The extension keeps its own relative timeouts.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The coordinator's own maintain timer (never the RunLoop). */
export const MAINTAIN_INTERVAL_MS = 15 * SECOND;
/** "Connected" in status: an authenticated extension request arrived within this time. */
export const CONNECTED_WITHIN_MS = 90 * SECOND;
/** Missing heartbeats before intent: abandon after this many × queue.heartbeat_seconds. */
export const PRE_INTENT_TIMEOUT_FACTOR = 3;
/** Missing heartbeats/results after intent: unknown after this many × queue.heartbeat_seconds. */
export const POST_INTENT_TIMEOUT_FACTOR = 6;
/** A permission with no clicking/submitted/result within ttl + this → unknown. */
export const UNUSED_PERMISSION_GRACE_MS = 2 * MINUTE;
/** Permission TTL: min(this, window_end − now − PERMISSION_WINDOW_MARGIN_MS). */
export const PERMISSION_TTL_MAX_MS = 60 * SECOND;
export const PERMISSION_WINDOW_MARGIN_MS = 5 * SECOND;
/** Intent refused (WINDOW_CLOSED) when less than this is left of the posting window. */
export const INTENT_MIN_WINDOW_MS = 15 * SECOND;
/** A post claim is refused when less than this (the expected fill time) is left of the window. */
export const CLAIM_MIN_WINDOW_MS = 180 * SECOND;
/** A repeated claim of a still-unstarted command within this time returns the same command. */
export const CLAIM_IDEMPOTENCY_MS = 60 * SECOND;
/** Pre-intent abandons per job per JST day before the job fails (manual retry). */
export const ABANDON_CAP_PER_DAY = 3;
/** Automatic reconcile: intent +2 min, then +5 min, then +15 min after the previous try; then the operator. */
export const RECONCILE_DELAYS_MS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE] as const;
export const RECONCILE_MAX_AUTO = RECONCILE_DELAYS_MS.length;
/** A pending preflight without a result expires after this. */
export const PREFLIGHT_EXPIRY_MS = 5 * MINUTE;
