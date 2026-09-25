import { describe, expect, it } from "vitest";
import { selectPrice, tradeValueUsd, type PriceSnapshotView } from "../../apps/server/src/normalization/valuation.js";
import { normalizeTrade } from "../../apps/server/src/normalization/normalize.js";
import { NATIVE_SOL_QUOTE, WSOL_MINT } from "../../apps/server/src/config.js";
import type { DecodedTrade } from "../../apps/server/src/collector/decoder.js";
import { addr, MINT, sig } from "../helpers.js";

const iso = (s: string) => Date.parse(s);
const MAX = 120_000;

function snap(id: string, availableAt: string, start: string, close: string): PriceSnapshotView {
  return { id, quoteMint: WSOL_MINT, availableAtMs: iso(availableAt), candles: [{ intervalStartMs: iso(start), close }] };
}

describe("V08: closed candles without look-ahead", () => {
  const E = iso("2026-09-25T12:02:10Z");
  const R = iso("2026-09-25T12:02:11Z");
  const p1 = snap("p1", "2026-09-25T12:02:05Z", "2026-09-25T12:01:00Z", "200");
  const p2 = snap("p2", "2026-09-25T12:02:05Z", "2026-09-25T12:02:00Z", "250");
  const p3 = snap("p3", "2026-09-25T12:02:12Z", "2026-09-25T12:01:00Z", "210");

  it("selects p1 and values 0.1 SOL at exactly $20 (eligible)", () => {
    const sel = selectPrice([p1, p2, p3], E, R, MAX);
    expect(sel).toMatchObject({ status: "valued", snapshotId: "p1", close: "200" });
    expect(tradeValueUsd("100000000", 9, "200")).toBe("20");
  });

  it("T42 / T43: without p1, the open candle and the post-arrival snapshot are rejected", () => {
    expect(selectPrice([p2, p3], E, R, MAX).status).toBe("missing_price");
  });

  it("T44: a closed, available but too-old candle is stale, even if fetched recently", () => {
    const old = snap("old", "2026-09-25T12:02:09Z", "2026-09-25T11:59:00Z", "199");
    expect(selectPrice([old], E, R, MAX).status).toBe("stale_price");
  });

  it("a snapshot older than 120 s at arrival is stale", () => {
    const aged = snap("aged", "2026-09-25T12:00:05Z", "2026-09-25T12:01:00Z", "199");
    // candle start 12:01 with snapshot available at 12:00:05 is inconsistent but tests fetch age alone
    expect(selectPrice([aged], E, R, MAX).status).toBe("stale_price");
  });

  it("T45: a price that arrives later never revalues the original event", () => {
    const late = snap("late", "2026-09-25T12:02:30Z", "2026-09-25T12:01:00Z", "200");
    expect(selectPrice([late], E, R, MAX).status).toBe("missing_price");
  });

  it("tie-break: descending (intervalStart, availableAt, snapshotId)", () => {
    const a = snap("a", "2026-09-25T12:02:01Z", "2026-09-25T12:01:00Z", "200");
    const b = snap("b", "2026-09-25T12:02:04Z", "2026-09-25T12:01:00Z", "201");
    const c = snap("c", "2026-09-25T12:02:04Z", "2026-09-25T12:01:00Z", "202");
    expect(selectPrice([a, b, c], E, R, MAX)).toMatchObject({ snapshotId: "c", close: "202" });
    const older = snap("z", "2026-09-25T12:02:09Z", "2026-09-25T12:00:00Z", "150");
    expect(selectPrice([older, a], E, R, MAX)).toMatchObject({ snapshotId: "a" });
  });

  it("null or non-positive closes never feed detection", () => {
    const bad = { id: "bad", quoteMint: WSOL_MINT, availableAtMs: iso("2026-09-25T12:02:05Z"), candles: [{ intervalStartMs: iso("2026-09-25T12:01:00Z"), close: "0" }] };
    expect(selectPrice([bad], E, R, MAX).status).toBe("missing_price");
  });

  it("precision: amount × price is exact before the threshold", () => {
    expect(tradeValueUsd("99999999", 9, "200")).toBe("19.9999998");
    expect(tradeValueUsd("18446744073709551615", 9, "123.456789")).toBe("2277375790844.960561017664235");
  });
});

function decoded(overrides: Partial<DecodedTrade> = {}): DecodedTrade {
  return {
    ordinal: 0,
    mint: MINT,
    solAmountRaw: "100000000",
    tokenAmountRaw: "3500000000000",
    isBuy: true,
    user: addr("buyer"),
    timestampSec: iso("2026-09-25T12:02:10Z") / 1000,
    feeRaw: "950000",
    creatorFeeRaw: "300000",
    ixName: "buy",
    quoteMint: "11111111111111111111111111111111",
    quoteAmountRaw: "100000000",
    ...overrides,
  };
}

const ctx = (snapshots: PriceSnapshotView[]) => ({
  namespace: "live:test",
  sourceMode: "live" as const,
  signature: sig("tx"),
  slot: 1,
  receivedAtMs: iso("2026-09-25T12:02:11Z"),
  normalizedAtMs: iso("2026-09-25T12:02:11.2Z"),
  quotes: [NATIVE_SOL_QUOTE],
  snapshotsFor: () => snapshots,
  maxPriceAgeMs: MAX,
  priceSource: "test",
});

describe("normalization", () => {
  const p1 = snap("p1", "2026-09-25T12:02:05Z", "2026-09-25T12:01:00Z", "200");

  it("maps native SOL (default pubkey) to the WSOL price and pins provenance", () => {
    const ev = normalizeTrade(decoded(), ctx([p1]));
    expect(ev.quoteAssetAddress).toBe(WSOL_MINT);
    expect(ev).toMatchObject({ valuationStatus: "valued", tradeValueUsd: "20", priceSnapshotId: "p1", quotePriceAtMs: iso("2026-09-25T12:01:00Z"), priceCandleEndMs: iso("2026-09-25T12:02:00Z") });
    expect(ev.eventId).toBe(`solana:${sig("tx")}:0`);
    expect(ev.blockTimeMs).toBe(iso("2026-09-25T12:02:10Z")); // chain time, never arrival time
  });

  it("T15: a missing price yields null value, never a financial zero", () => {
    const ev = normalizeTrade(decoded(), ctx([]));
    expect(ev.valuationStatus).toBe("missing_price");
    expect(ev.tradeValueUsd).toBeNull();
  });

  it("T58: the traded amount excludes separately reported fees", () => {
    const ev = normalizeTrade(decoded({ solAmountRaw: "99000000", quoteAmountRaw: "99000000", feeRaw: "5000000" }), ctx([p1]));
    expect(ev.tradeValueUsd).toBe("19.8");
  });

  it("T59: an unsupported quote is recorded as unsupported_quote and never assumed $1 or SOL", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const ev = normalizeTrade(decoded({ quoteMint: usdc, quoteAmountRaw: "25000000" }), ctx([p1]));
    expect(ev.valuationStatus).toBe("unsupported_quote");
    expect(ev.tradeValueUsd).toBeNull();
    expect(ev.quoteAssetAddress).toBe(usdc);
  });

  it("legacy logs without quote fields are SOL-quoted via sol_amount", () => {
    const ev = normalizeTrade(decoded({ quoteMint: null, quoteAmountRaw: null }), ctx([p1]));
    expect(ev.quoteAssetAddress).toBe(WSOL_MINT);
    expect(ev.tradeValueUsd).toBe("20");
  });
});

describe("documented 5m fallback policy (nansen-5m-closed-v1)", () => {
  const E = iso("2026-09-25T12:12:10Z");
  const R = iso("2026-09-25T12:12:11Z");
  const limits = { maxCandleAgeMs: 900_000, maxFetchAgeMs: 120_000 };
  const five = (id: string, avail: string, start: string, close: string): PriceSnapshotView => ({ id, quoteMint: WSOL_MINT, availableAtMs: iso(avail), candleMs: 300_000, candles: [{ intervalStartMs: iso(start), close }] });

  it("values with the latest closed 5m candle up to 15 minutes old", () => {
    const s = five("f1", "2026-09-25T12:11:00Z", "2026-09-25T12:00:00Z", "118.5");
    expect(selectPrice([s], E, R, limits)).toMatchObject({ status: "valued", candleEndMs: iso("2026-09-25T12:05:00Z"), close: "118.5" });
  });
  it("never uses the open 5m candle, even when returned", () => {
    const open = five("f2", "2026-09-25T12:11:00Z", "2026-09-25T12:10:00Z", "119");
    expect(selectPrice([open], E, R, limits).status).toBe("missing_price");
  });
  it("a closed 5m candle older than 15 minutes is stale", () => {
    const old = five("f3", "2026-09-25T12:11:00Z", "2026-09-25T11:55:00Z", "117");
    expect(selectPrice([old], E, R, limits).status).toBe("stale_price");
  });
  it("the 1m baseline limits still reject a 5-minute-old candle", () => {
    const s = five("f4", "2026-09-25T12:11:00Z", "2026-09-25T12:05:00Z", "118");
    expect(selectPrice([s], E, R, 120_000).status).toBe("stale_price");
  });
});
