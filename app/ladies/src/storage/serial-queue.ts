/**
 * Runs tasks one at a time in submission order (spec 11.4-1: every write goes through one queue).
 * A failing task rejects only its own promise. A task must not await another run() on the same queue (it would wait forever).
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #onError: ((err: unknown) => void) | undefined;

  /** `onError` sees every failed task (the runtime watches for a full disk, 15.1-q); it must not throw. */
  constructor(onError?: (err: unknown) => void) {
    this.#onError = onError;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => fn());
    if (this.#onError !== undefined) result.catch(this.#onError);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
