import { describe, expect, it } from "vitest";
import { aggregateWindows, type ObservationForCount, type WindowCoverage } from "../../apps/server/src/smart-money/aggregate.js";
import { matchMembers } from "../../apps/server/src/smart-money/matching.js";
import { fingerprintTrade } from "../../apps/server/src/smart-money/service.js";
import { WSOL_MINT } from "../../apps/server/src/config.js";
import { addr, MINT, MINT2, sig } from "../helpers.js";

const asOf = Date.parse("2026-09-25T12:00:00Z");
const at = (s: string) => Date.parse(s);
let n = 0;
function buy(wallet: string, t: number, opts: Partial<ObservationForCount> = {}): ObservationForCount {
  n++;
  return { id: `o${n}`, chain: "solana", transactionHash: sig(`h${n}`), traderAddress: addr(wallet), tokenBoughtAddress: MINT, tokenSoldAddress: WSOL_MINT, blockTimeMs: t, tradeValueUsd: "50", ambiguousSwapIdentity: false, ...opts };
}
function sell(wallet: string, t: number): ObservationForCount {
  return buy(wallet, t, { tokenBoughtAddress: WSOL_MINT, tokenSoldAddress: MINT });
}
const scanned: Record<"5m" | "1h" | "24h", WindowCoverage> = { "5m": "window_scanned", "1h": "window_scanned", "24h": "window_scanned" };
const agg = (observations: ObservationForCount[], coverage = scanned) =>
  aggregateWindows({ mint: MINT, asOfMs: asOf, observations, coverage, scopeHash: "s", snapshotIds: ["snap"], fetchedAtMs: asOf, checked: true, freshness: "fresh" });

describe("V09: three Smart Money windows over (start, end]", () => {
  const obs = [
    buy("A", at("2026-09-25T11:59:00Z")),
    buy("A", at("2026-09-25T11:58:00Z")),
    buy("B", at("2026-09-25T11:55:00Z")),
    buy("C", at("2026-09-25T11:00:00Z")),
    buy("D", at("2026-09-24T12:00:00Z")),
    sell("E", at("2026-09-25T11:59:00Z")),
    buy("F", at("2026-09-25T11:57:00Z")),
    sell("F", at("2026-09-25T11:59:00Z")),
    buy("G", at("2026-09-25T12:00:00Z")),
    buy("H", at("2026-09-25T12:00:01Z")),
  ];
  it("counts 5m=3, 1h=4, 24h=5", () => {
    const [m5, m1, m24] = agg(obs);
    expect([m5!.observedUniqueBuyers, m1!.observedUniqueBuyers, m24!.observedUniqueBuyers]).toEqual([3, 4, 5]);
    expect(m1!.countQualifier).toBe("observed");
    expect(m5!.windowStart).toBe("2026-09-25T11:55:00.000Z");
    expect(m5!.windowEnd).toBe("2026-09-25T12:00:00.000Z");
  });
  it("from an incomplete first page the same counts are lower bounds", () => {
    const [m5, m1, m24] = agg(obs, { "5m": "partial", "1h": "partial", "24h": "partial" });
    expect([m5!.countQualifier, m1!.countQualifier, m24!.countQualifier]).toEqual(["at_least", "at_least", "at_least"]);
    expect(m24!.observedUniqueBuyers).toBe(5);
    expect(m24!.state.coverage).toBe("partial");
  });
  it("null USD for A does not remove A as a buyer; value is partial", () => {
    const withNull = obs.map((o) => (o.traderAddress === addr("A") ? { ...o, tradeValueUsd: null } : o));
    const [, m1] = agg(withNull);
    expect(m1!.observedUniqueBuyers).toBe(4);
    expect(m1!.missingValuationCount).toBe(2);
  });
});

describe("buyer counting rules", () => {
  it("T17: one wallet buying ten times is one buyer", () => {
    const obs = Array.from({ length: 10 }, (_, i) => buy("A", asOf - i * 1000));
    expect(agg(obs)[0]!.observedUniqueBuyers).toBe(1);
  });
  it("T18 / T19: a buyer who later sells remains a buyer; seller-only adds none", () => {
    expect(agg([buy("A", asOf - 60_000), sell("A", asOf - 1000), sell("S", asOf - 1000)])[0]!.observedUniqueBuyers).toBe(1);
  });
  it("T20: a Smart Money buy below $20 still counts for token context", () => {
    const [m5] = agg([buy("A", asOf - 1000, { tradeValueUsd: "6.40" })]);
    expect(m5!.observedUniqueBuyers).toBe(1);
    expect(m5!.knownBuyUsd).toBe("6.4");
  });
  it("T08: identical symbols on different mints stay separate", () => {
    expect(agg([buy("A", asOf - 1000, { tokenBoughtAddress: MINT2 })])[0]!.observedUniqueBuyers).toBe(0);
  });
  it("T25: ambiguous swaps keep the buyer countable but not the USD value", () => {
    const [m5] = agg([buy("A", asOf - 1000, { ambiguousSwapIdentity: true }), buy("B", asOf - 1000)]);
    expect(m5!.observedUniqueBuyers).toBe(2);
    expect(m5!.ambiguousTradeCount).toBe(1);
    expect(m5!.knownBuyUsd).toBe("50");
  });
  it("T27: 5m covered while 24h is incomplete keeps separate coverage", () => {
    const [m5, , m24] = agg([buy("A", asOf - 1000)], { "5m": "window_scanned", "1h": "window_scanned", "24h": "partial" });
    expect(m5!.countQualifier).toBe("observed");
    expect(m24!.countQualifier).toBe("at_least");
  });
  it("T28 / T55: scanned empty, partial empty, and never checked are distinct", () => {
    const [scannedEmpty] = agg([]);
    expect(scannedEmpty).toMatchObject({ observedUniqueBuyers: 0, countQualifier: "observed" });
    expect(scannedEmpty!.state.coverage).toBe("window_scanned");
    const [partialEmpty] = agg([], { "5m": "partial", "1h": "partial", "24h": "partial" });
    expect(partialEmpty).toMatchObject({ observedUniqueBuyers: 0, countQualifier: "at_least" });
    const [unchecked] = aggregateWindows({ mint: MINT, asOfMs: asOf, observations: [], coverage: scanned, scopeHash: "s", snapshotIds: [], fetchedAtMs: null, checked: false, freshness: "unknown" });
    expect(unchecked).toMatchObject({ observedUniqueBuyers: null, countQualifier: "unknown", knownBuyUsd: null });
    expect(unchecked!.state.availability).toBe("not_requested");
  });
});

describe("pack member matching (§9.6)", () => {
  const members = [
    { walletAddress: addr("M1"), signatures: [sig("pack-tx-1")] },
    { walletAddress: addr("M2"), signatures: [sig("pack-tx-2")] },
    { walletAddress: addr("M3"), signatures: [sig("pack-tx-3")] },
  ];
  it("T23: chain, wallet, bought mint, and pack transaction hash confirm one member", () => {
    const obs = [buy("M1", asOf, { transactionHash: sig("pack-tx-1") })];
    const r = matchMembers({ mint: MINT, members, observations: obs, checked: true, checkedAtMs: asOf });
    expect(r.confirmedMemberCount).toBe(1);
    expect(r.matches[0]!.matchState).toBe("pack_buy_confirmed");
    expect(r.matches[1]!.matchState).toBe("checked_no_match");
  });
  it("T22: a wallet seen on another token is only wallet_seen", () => {
    const obs = [buy("M2", asOf, { tokenBoughtAddress: MINT2 })];
    const r = matchMembers({ mint: MINT, members, observations: obs, checked: true, checkedAtMs: asOf });
    expect(r.matches[1]!.matchState).toBe("wallet_seen");
    expect(r.confirmedMemberCount).toBe(0);
  });
  it("wallet match on the same token but a different transaction is not confirmation", () => {
    const obs = [buy("M3", asOf, { transactionHash: sig("unrelated") })];
    const r = matchMembers({ mint: MINT, members, observations: obs, checked: true, checkedAtMs: asOf });
    expect(r.matches[2]!.matchState).toBe("wallet_seen");
  });
  it("T21: a nonmember buying the token raises token counts but not membership", () => {
    const obs = [buy("Outsider", asOf - 1000)];
    expect(agg(obs)[0]!.observedUniqueBuyers).toBe(1);
    expect(matchMembers({ mint: MINT, members, observations: obs, checked: true, checkedAtMs: asOf }).confirmedMemberCount).toBe(0);
  });
  it("T55: never checked means null confirmation, not zero", () => {
    const r = matchMembers({ mint: MINT, members, observations: [], checked: false, checkedAtMs: null });
    expect(r.confirmedMemberCount).toBeNull();
    expect(r.checkedMemberCount).toBe(0);
    expect(r.matches.every((m) => m.matchState === "not_checked")).toBe(true);
  });
});

describe("T24: the same trade from the global feed and a token lookup has one identity", () => {
  it("fingerprints match regardless of scope", () => {
    const t = {
      chain: "solana" as const, transactionHash: sig("x"), blockTimeMs: asOf, traderAddress: addr("A"), traderLabel: "Fund", tokenBoughtAddress: MINT, tokenSoldAddress: WSOL_MINT,
      tokenBoughtSymbol: "M", tokenSoldSymbol: "SOL", tokenBoughtAmount: "10", tokenSoldAmount: "0.1", tradeValueUsd: "20",
    };
    expect(fingerprintTrade(t)).toBe(fingerprintTrade({ ...t, traderLabel: "Smart Trader", tradeValueUsd: "20.0001" }));
    expect(fingerprintTrade(t)).not.toBe(fingerprintTrade({ ...t, tokenBoughtAmount: "11" }));
  });
});
