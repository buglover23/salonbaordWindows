/** Polling interval under the MutationObserver: background tabs throttle timers, so the observer may be all that runs. */
export const POLL_MS = 250;

/**
 * Resolves with the predicate's first truthy value, or null at the deadline. DOM changes trigger a check at once and a
 * polling timer checks anyway (observer callbacks can be suppressed). The deadline is checked against both
 * performance.now() and Date.now(), after the predicate, so a throttled timer only delays a check and never skips it.
 */
export function waitFor<T>(
  predicate: () => T | null | undefined | false,
  opts: { timeoutMs: number; onTick?: () => void; root?: Node },
): Promise<T | null> {
  return new Promise((resolve) => {
    const startPerf = performance.now();
    const startWall = Date.now();
    let done = false;
    let observer: MutationObserver | null = null;
    const finish = (value: T | null): void => {
      done = true;
      observer?.disconnect();
      clearInterval(timer);
      resolve(value);
    };
    const check = (): void => {
      if (done) return;
      const value = predicate();
      if (value !== null && value !== undefined && value !== false) finish(value);
      else if (performance.now() - startPerf >= opts.timeoutMs || Date.now() - startWall >= opts.timeoutMs) finish(null);
    };
    const timer = setInterval(() => {
      opts.onTick?.();
      check();
    }, POLL_MS);
    observer = new MutationObserver(check);
    observer.observe(opts.root ?? document, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  });
}
