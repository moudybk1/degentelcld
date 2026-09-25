import type { Clock } from "../clock.js";
import type { Lane } from "./budget.js";

const LANE_PRIORITY: Record<Lane, number> = { PRICE: 0, BASE_ENRICHMENT: 1, SMART_MONEY: 2 };

type Waiter = { lane: Lane; seq: number; resolve: (release: () => void) => void };

/**
 * Concurrency and per-minute rate gate for provider requests (blueprint §12.2).
 * A due price request gets the next available slot; in-flight requests are
 * never cancelled. This limits rate, never the total number of calls.
 */
export class DispatchGate {
  private active = 0;
  private sent: number[] = [];
  private waiters: Waiter[] = [];
  private seq = 0;
  private pausedUntilMs = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPerMinute: number,
    private readonly clock: Clock,
  ) {}

  /** Respect Retry-After and rate-limit rejections across all lanes. */
  pauseUntil(ms: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs, ms);
    this.schedule();
  }

  acquire(lane: Lane): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiters.push({ lane, seq: this.seq++, resolve });
      this.waiters.sort((a, b) => LANE_PRIORITY[a.lane] - LANE_PRIORITY[b.lane] || a.seq - b.seq);
      this.pump();
    });
  }

  get queued(): number {
    return this.waiters.length;
  }

  private pump(): void {
    const now = this.clock.now();
    this.sent = this.sent.filter((t) => now - t < 60_000);
    while (this.waiters.length > 0 && this.active < this.maxConcurrency && this.sent.length < this.maxPerMinute && now >= this.pausedUntilMs) {
      const w = this.waiters.shift()!;
      this.active++;
      this.sent.push(now);
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.waiters.length === 0 || this.timer) return;
    const now = this.clock.now();
    let wait = 250;
    if (now < this.pausedUntilMs) wait = this.pausedUntilMs - now;
    else if (this.sent.length >= this.maxPerMinute && this.sent[0] !== undefined) wait = this.sent[0] + 60_000 - now;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(10, wait));
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
