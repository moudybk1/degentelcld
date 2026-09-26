import type { Clock } from "../clock.js";

export type CatchUpOptions = {
  /** Tick interval of the live loop. */
  tickMs: number;
  /** Extra delay beyond one interval that counts as a stall of the event loop. */
  stallMs: number;
  /** The stream counts as current again once its newest event time is at most this old. */
  currentMs: number;
  /** Longest hold; after it the watermark advances even if the stream never caught up. */
  maxHoldMs: number;
};

/**
 * Holds the live watermark after the event loop was blocked (a long SQLite
 * statement, retention, disk stalls from the host). While the loop is blocked,
 * stream messages wait unread in the socket; the first tick afterwards would
 * move the watermark to now − tolerance before they are read, marking trades
 * that arrived on time as late and excluding them from detection.
 *
 * After a stall the watermark stays where it is until the stream is current
 * again (its newest event time is within `currentMs` of now, which is the
 * backlog being drained) or `maxHoldMs` has passed. Admission and ordering
 * rules are unchanged; packs from the held period are only detected later.
 * Replay and tests advance the pipeline directly and never use this guard.
 */
export class CatchUpGuard {
  private lastTickAtMs: number | null = null;
  private holdSinceMs: number | null = null;
  private stallMsInHold = 0;
  stalls = 0;
  holds = 0;
  heldMs = 0;

  constructor(
    private readonly clock: Clock,
    private readonly opts: CatchUpOptions,
    private readonly onRelease: (info: { heldMs: number; stallMs: number; caughtUp: boolean }) => void = () => {},
  ) {}

  get holding(): boolean {
    return this.holdSinceMs !== null;
  }

  /** Call once per tick with the newest event time seen on the stream; true when the watermark may advance now. */
  mayAdvance(newestEventTimeMs: number | null): boolean {
    const now = this.clock.now();
    const late = this.lastTickAtMs === null ? 0 : now - this.lastTickAtMs - this.opts.tickMs;
    this.lastTickAtMs = now;
    if (late > this.opts.stallMs) {
      this.stalls++;
      this.stallMsInHold += late;
      if (this.holdSinceMs === null) {
        this.holdSinceMs = now;
        this.holds++;
      }
      // Nothing that queued up during the stall has been read yet, so the stream cannot look current: wait at least one tick.
      return false;
    }
    if (this.holdSinceMs === null) return true;
    const caughtUp = newestEventTimeMs !== null && now - newestEventTimeMs <= this.opts.currentMs;
    const held = now - this.holdSinceMs;
    if (!caughtUp && held < this.opts.maxHoldMs) return false;
    this.heldMs += held;
    this.onRelease({ heldMs: held, stallMs: this.stallMsInHold, caughtUp });
    this.holdSinceMs = null;
    this.stallMsInHold = 0;
    return true;
  }
}
