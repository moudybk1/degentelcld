import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { CatchUpGuard } from "../../apps/server/src/ingest/catchUp.js";

const T0 = Date.parse("2026-09-26T12:00:00Z");
const OPTS = { tickMs: 250, stallMs: 400, currentMs: 2000, maxHoldMs: 20_000 };

function setup() {
  const clock = new VirtualClock(T0);
  const released: { heldMs: number; stallMs: number; caughtUp: boolean }[] = [];
  const guard = new CatchUpGuard(clock, OPTS, (i) => released.push(i));
  return { clock, guard, released };
}

describe("catch-up guard for the live watermark", () => {
  it("advances on every regular tick, including slightly late ones", () => {
    const { clock, guard } = setup();
    for (let i = 0; i < 20; i++) {
      expect(guard.mayAdvance(clock.now() - 1300)).toBe(true);
      clock.advance(i % 5 === 0 ? 600 : 250); // 350 ms late is not a stall
    }
    expect(guard.stalls).toBe(0);
  });

  it("holds on the tick after a stall even when the newest seen event looks recent", () => {
    const { clock, guard } = setup();
    expect(guard.mayAdvance(clock.now() - 1000)).toBe(true);
    clock.advance(1250); // the loop was blocked for about a second
    expect(guard.mayAdvance(clock.now() - 1500)).toBe(false);
    expect(guard.holding).toBe(true);
  });

  it("keeps holding while the backlog is read and releases once the stream is current", () => {
    const { clock, guard, released } = setup();
    guard.mayAdvance(T0 - 1300);
    clock.advance(8250); // an 8 s stall; the newest event read is from before it
    expect(guard.mayAdvance(T0 - 1300)).toBe(false);
    clock.advance(250);
    expect(guard.mayAdvance(clock.now() - 5000)).toBe(false); // backlog half read: events still 5 s old
    clock.advance(250);
    expect(guard.mayAdvance(clock.now() - 1400)).toBe(true); // fresh events again
    expect(guard.holding).toBe(false);
    expect(released).toEqual([{ heldMs: 500, stallMs: 8000, caughtUp: true }]);
  });

  it("releases after the longest hold even if the stream never becomes current", () => {
    const { clock, guard, released } = setup();
    guard.mayAdvance(null);
    clock.advance(3250);
    expect(guard.mayAdvance(null)).toBe(false);
    let advanced = false;
    for (let i = 0; i < 100 && !advanced; i++) {
      clock.advance(250);
      advanced = guard.mayAdvance(null);
    }
    expect(advanced).toBe(true);
    expect(released[0]).toMatchObject({ caughtUp: false });
    expect(released[0]!.heldMs).toBeGreaterThanOrEqual(20_000);
  });
});
