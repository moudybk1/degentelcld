/**
 * Protection for public hosting. The API, the collector, and the detector
 * share one event loop and SQLite calls are synchronous, so a burst of heavy
 * page reads could hold the loop long enough for incoming trades to fall
 * behind the 2 s watermark (measured: 12 concurrent large pack pages held it
 * for 5.2 s). Three pieces keep reads from starving ingestion:
 *
 * - ReadGate runs heavy reads one at a time and returns to the event loop
 *   between them, so ticks and stream messages run in between; it sheds load
 *   (503) instead of queueing without bound.
 * - TtlCache keeps recent read results for a few seconds, so a popular page is
 *   computed once, not once per viewer.
 * - RateLimiter bounds requests per client and, weighted by milliseconds, the
 *   uncached read work one client can cause.
 */

export class BusyError extends Error {
  constructor() {
    super("The server is busy; try again in a moment.");
  }
}

export class ReadGate {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly maxWaiting: number) {}

  get queued(): number {
    return this.waiting;
  }

  /** Run `fn` after every earlier job, starting on a fresh event-loop turn. */
  run<T>(fn: () => T): Promise<T> {
    if (this.waiting >= this.maxWaiting) return Promise.reject(new BusyError());
    this.waiting++;
    const job = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) => {
          // A timer (not a microtask) lets pending I/O and due ticks run first.
          setTimeout(() => {
            this.waiting--;
            try {
              resolve(fn());
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }, 0);
        }),
    );
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

type Entry<T> = { value: T; expiresAt: number };

/** Small TTL cache with insertion-order eviction. */
export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Fixed-window counter per key; windows reset every `windowMs`. Hits may carry a weight (for example milliseconds of work). */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 100_000,
  ) {}

  /** Count one hit of `weight`; returns null when allowed, or the seconds until the window resets. */
  hit(key: string, weight = 1): number | null {
    const now = this.now();
    let h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.windowMs) {
      if (!h && this.hits.size >= this.maxKeys) this.prune(now);
      h = { windowStart: now, count: 0 };
      this.hits.set(key, h);
    }
    h.count += weight;
    if (h.count <= this.limit) return null;
    return this.secondsLeft(h, now);
  }

  /** Without counting: null when `key` is below its limit, else the seconds until the window resets. */
  blockedFor(key: string): number | null {
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.windowMs || h.count < this.limit) return null;
    return this.secondsLeft(h, now);
  }

  private secondsLeft(h: { windowStart: number }, now: number): number {
    return Math.max(1, Math.ceil((h.windowStart + this.windowMs - now) / 1000));
  }

  private prune(now: number): void {
    for (const [k, h] of this.hits) if (now - h.windowStart >= this.windowMs) this.hits.delete(k);
    // Still full (many active clients): drop the oldest windows rather than grow without bound.
    while (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }
}
