/**
 * A job queue whose worker loop runs in the async context it was started in,
 * like a pool or queue library created before a transaction opens. Jobs run
 * there, not in the caller's context.
 */
export function startWorker() {
  const jobs: Array<() => Promise<void>> = [];
  let wake: () => void = () => {};
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const job = jobs.shift();
      if (job) await job();
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  return {
    /** Runs `job` on the worker and resolves when it finishes. */
    run: (job: () => Promise<unknown>) =>
      new Promise<void>((done, fail) => {
        jobs.push(() => job().then(() => done(), fail));
        wake();
      }),
    stop: () => {
      stopped = true;
      wake();
      return loop;
    },
  };
}

/** Rejects with `deadlock` when `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock')), ms)),
  ]);
}
