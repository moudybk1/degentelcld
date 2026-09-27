import { describe, expect, it } from "vitest";
import { earlierPacks } from "../../apps/server/src/api/afterPack.js";
import { addr, harness, T0, tradeEvent } from "../helpers.js";

/**
 * "At 15 min" is a completed observation: it exists only once 15 minutes have
 * passed after the earlier pack, it stops at the last trade at or before 15:00,
 * and gaps, graduation, or the end of the data make it partial.
 */
describe("earlier packs: 15-minute outcomes", () => {
  const NS = "live:earlier";
  const M1 = addr("mint-1");
  const M2 = addr("mint-2");
  const MIN = 60_000;

  function setup() {
    const h = harness(NS);
    // Earlier pack on M1 (A, B, C; trigger at 10 s), then a buy at +2 min at twice the price.
    h.feed([
      tradeEvent(NS, "a1", "A", 0, "20", { tokenAddress: M1 }),
      tradeEvent(NS, "b1", "B", 5000, "20", { tokenAddress: M1 }),
      tradeEvent(NS, "c1", "C", 10_000, "20", { tokenAddress: M1 }),
    ]);
    h.flushTo(60_000);
    h.feed([tradeEvent(NS, "x1", "X", 2 * MIN, "20", { tokenAddress: M1, tokenAmountRaw: "500000" })]);
    h.flushTo(3 * MIN);
    // The pack being viewed, on M2 at +6 min, shares A and B.
    h.feed([
      tradeEvent(NS, "a2", "A", 6 * MIN, "20", { tokenAddress: M2 }),
      tradeEvent(NS, "b2", "B", 6 * MIN + 5000, "20", { tokenAddress: M2 }),
      tradeEvent(NS, "d2", "D", 6 * MIN + 10_000, "20", { tokenAddress: M2 }),
    ]);
    h.flushTo(7 * MIN);
    const packs = h.packs() as { id: string; namespace: string; mint: string; first_event_time_ms: number; trigger_event_time_ms: number }[];
    const viewed = packs.find((p) => p.mint === M2)!;
    const at = (ms: number) => earlierPacks(h.db, viewed, [addr("A"), addr("B"), addr("D")], T0 + ms)[0]!;
    // Keep the stream current: trades on another token after 15 minutes.
    const later = () => {
      h.feed([tradeEvent(NS, "z", "Z", 16 * MIN, "20", { tokenAddress: addr("mint-3") })]);
      h.flushTo(17 * MIN);
    };
    return { h, at, later };
  }

  it("is observing before 15 minutes, with 'so far' values and no 15-minute values", () => {
    const { at } = setup();
    const e = at(7 * MIN);
    expect(e.outcomeState).toBe("observing");
    expect(e.changePct15m).toBeNull();
    expect(e.peakChangePct15m).toBeNull();
    expect(e.changeSoFarPct).toBe(100);
    expect(e.observedMs).toBe(7 * MIN - 10_000);
  });

  it("completes after 15 minutes at the last trade before the cutoff, and does not follow later prices", () => {
    const { h, at, later } = setup();
    later();
    // A trade on M1 after the cutoff must not change the completed value.
    h.feed([tradeEvent(NS, "y1", "Y", 16 * MIN, "20", { tokenAddress: M1, tokenAmountRaw: "250000" })]);
    h.flushTo(17 * MIN);
    const e = at(17 * MIN);
    expect(e.outcomeState).toBe("complete");
    expect(e.changePct15m).toBe(100);
    expect(e.peakChangePct15m).toBe(100);
    expect(e.priceAtMs).toBe(T0 + 2 * MIN);
    expect(e.observedMs).toBe(15 * MIN);
    expect(e.changeSoFarPct).toBeNull();
  });

  it("is partial when a collector gap or the token leaving the bonding curve cut the 15 minutes short", () => {
    const gap = setup();
    gap.later();
    gap.h.db.prepare("INSERT INTO collector_gaps (id, namespace, started_at_ms, ended_at_ms, reason, recovery_state) VALUES ('g', ?, ?, ?, 'test', 'closed_unrecovered')").run(NS, T0 + 5 * MIN, T0 + 6 * MIN);
    expect(gap.at(17 * MIN)).toMatchObject({ outcomeState: "partial", outcomeNote: "gap", changePct15m: 100 });

    const grad = setup();
    grad.later();
    grad.h.db.prepare("INSERT INTO tokens (namespace, chain, mint, first_seen_at_ms, completed_at_ms) VALUES (?, 'solana', ?, ?, ?)").run(NS, M1, T0, T0 + 3 * MIN);
    expect(grad.at(17 * MIN)).toMatchObject({ outcomeState: "partial", outcomeNote: "graduated" });
  });

  it("is partial, not observing, when recorded data ends inside the 15 minutes", () => {
    const { at } = setup();
    // No trade for an hour: the data is no longer being collected.
    expect(at(70 * MIN)).toMatchObject({ outcomeState: "partial", outcomeNote: "data_ended", observedMs: 6 * MIN });
  });
});
