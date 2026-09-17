const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialises every outbound ANAF call so that no two calls START closer together than
 * `minIntervalMs`.
 *
 * ANAF documents a limit of one request per second and blocks clients that exceed it.
 * The specification (section 10) requires that limit to be GLOBAL to the service rather
 * than per user or per request, which is why this is a single shared instance rather
 * than something created per request scope.
 *
 * Known limit, stated in the README: this is in-process. Running more than one instance
 * of the service requires a distributed limiter (a Redis token bucket), because the
 * budget belongs to the whole deployment, not to one process.
 */
export class AnafRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const gate = this.tail.then(async () => {
      const waitFor = this.lastStartedAt + this.minIntervalMs - Date.now();
      if (waitFor > 0) await sleep(waitFor);
      this.lastStartedAt = Date.now();
    });
    // The chain must survive a rejected task, otherwise one failure stops the limiter
    // for the lifetime of the process.
    this.tail = gate.then(
      () => undefined,
      () => undefined,
    );
    return gate.then(() => fn());
  }
}
