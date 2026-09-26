import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AfterPackData, PackDetail, PackListItem, ReadoutItem } from "@packlens/contracts";
import { loadConfig, ROOT_DIR } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { buildReadout, type ReadoutInput } from "../../apps/server/src/api/readout.js";
import { loadDataset } from "../../apps/server/src/replay/dataset.js";

/**
 * After-the-pack facts are computed from stored trades only. Expected values
 * are recomputed here from the dataset file, independently of the SQL.
 */
const { dataset } = loadDataset(ROOT_DIR, "synthetic-demo-v1");
const price = (e: { quoteAmountRaw: string; tokenAmountRaw: string }) => Number(e.quoteAmountRaw) / Number(e.tokenAmountRaw);
const ADVICE = /\b(buy now|sell now|should (buy|sell)|recommend|target|will (rise|fall|pump|dump)|guaranteed|safe to)\b/i;

describe("after the pack (fixture)", () => {
  const config = loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" });
  const rt = Runtime.create(config);
  rt.start();
  const app = buildServer(rt);
  let items: PackListItem[] = [];
  const detail = async (symbol: string, index = 0) => {
    const it = items.filter((i) => i.token.symbol === symbol)[index]!;
    return (await app.inject({ url: `/api/packs/${it.core.id}` })).json().data as PackDetail;
  };
  beforeAll(async () => {
    items = (await app.inject({ url: "/api/packs?limit=50" })).json().data.items;
  });
  afterAll(() => app.close());

  it("measures the latest and peak price against the pack's average entry in SOL", async () => {
    const d = await detail("LMOTH");
    const buys = d.evidence.filter((e) => e.side === "buy");
    const entry = buys.reduce((a, e) => a + Number(e.quoteAmountRaw), 0) / buys.reduce((a, e) => a + Number(e.tokenAmountRaw), 0);
    const trades = dataset.events.filter((e) => e.mint === d.core.tokenAddress).sort((a, b) => a.blockTimeMs - b.blockTimeMs);
    const after = trades.filter((e) => e.blockTimeMs > d.core.triggerEventTimeMs);
    const last = trades[trades.length - 1]!;
    const peak = Math.max(...after.map(price));

    expect(d.after.entryPriceSol).not.toBeNull();
    expect(d.after.lastChangePct).toBeCloseTo((price(last) / entry - 1) * 100, 2);
    expect(d.after.peak!.changePct).toBeCloseTo((peak / entry - 1) * 100, 2);
    expect(d.after.lastTradeAt).toBe(new Date(last.blockTimeMs).toISOString());
    expect(d.after.activity.buys + d.after.activity.sells).toBe(after.length);
    expect(d.after.activity.buys).toBe(after.filter((e) => e.side === "buy").length);
  });

  it("counts pack wallets that sold after their own first buy", async () => {
    const d = await detail("LMOTH");
    const sold = (w: string) => d.after.members.rows.find((r) => r.walletAddress === w)!;
    expect(d.after.members.count).toBe(6);
    expect(d.after.members.sold).toBe(4);
    const memberWallets = new Set(d.members.map((m) => m.walletAddress));
    const sellers = new Set(dataset.events.filter((e) => e.mint === d.core.tokenAddress && e.side === "sell" && memberWallets.has(e.wallet)).map((e) => e.wallet));
    expect(sellers.size).toBe(4);
    for (const w of sellers) expect(sold(w).soldShare).toBeGreaterThan(0.99);
    const holders = d.members.filter((m) => !sellers.has(m.walletAddress));
    for (const m of holders) {
      expect(sold(m.walletAddress).soldShare).toBe(0);
      expect(sold(m.walletAddress).firstSellAt).toBeNull();
    }
    // The first sale is W1's partial sell 25 s after its buy.
    expect(Math.min(...d.after.members.rows.filter((r) => r.secondsToFirstSell !== null).map((r) => r.secondsToFirstSell!))).toBe(25);
  });

  it("draws a bounded series with pack-buy and pack-sell markers", async () => {
    const d = await detail("LMOTH");
    expect(d.after.series.length).toBeGreaterThan(10);
    expect(d.after.series.length).toBeLessThanOrEqual(3 * 241);
    expect(d.after.markers.filter((m) => m.kind === "pack_buy")).toHaveLength(d.evidence.filter((e) => e.side === "buy").length);
    expect(d.after.markers.filter((m) => m.kind === "member_sell").length).toBeGreaterThanOrEqual(4);
    const ts = d.after.series.map((p) => p.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // Downsampling keeps each bucket's high and low, so the line reaches the true peak and low.
    const afterPts = d.after.series.filter((p) => p.t > d.core.triggerEventTimeMs).map((p) => p.changePct);
    expect(Math.max(...afterPts)).toBeCloseTo(d.after.peak!.changePct, 6);
    expect(Math.min(...afterPts)).toBeCloseTo(d.after.trough!.changePct, 6);
  });

  it("reports graduation and stops at the bonding curve", async () => {
    const d = await detail("HARBR");
    expect(d.after.graduatedAt).toBe("2026-09-24T12:12:00.000Z");
    expect(d.after.notes.join(" ")).toMatch(/completed its pump.fun bonding curve/);
    expect(d.readout.some((r) => r.group === "check" && /left the pump.fun bonding curve/.test(r.text))).toBe(true);
    expect(d.after.marketCapUsd).not.toBeNull();
  });

  it("lists earlier packs that share at least two wallets, with their 15-minute move", async () => {
    const salt = items.filter((i) => i.token.symbol === "SALTM").sort((a, b) => a.core.triggerEventTimeMs - b.core.triggerEventTimeMs)[0]!;
    const d = (await app.inject({ url: `/api/packs/${salt.core.id}` })).json().data as PackDetail;
    expect(d.earlierPacks).toHaveLength(1);
    const e = d.earlierPacks[0]!;
    expect(e.tokenSymbol).toBe("LMOTH");
    expect(e.sharedWallets).toBe(2);
    expect(e.triggerEventTimeMs).toBeLessThan(d.core.triggerEventTimeMs);
    expect(e.peakChangePct15m).not.toBeNull();
    const lm = await detail("LMOTH");
    expect(lm.earlierPacks).toHaveLength(0); // a pack never sees later packs
  });

  it("keeps fixture notes free of live retention warnings", async () => {
    const d = await detail("LMOTH");
    expect(d.after.notes.join(" ")).not.toMatch(/24 hours/);
  });

  it("writes a readout of facts, checks, and unknowns without advice or forecasts", async () => {
    for (const it of items) {
      const d = (await app.inject({ url: `/api/packs/${it.core.id}` })).json().data as PackDetail;
      const text = d.readout.map((r) => r.text).join(" ");
      expect(text).not.toMatch(ADVICE);
      expect(d.readout.filter((r) => r.group === "unknown").at(-1)!.text).toMatch(/not a forecast/);
      expect(d.readout.some((r) => r.group === "happened")).toBe(true);
    }
    const finch = await detail("FINCH");
    expect(finch.readout.map((r) => r.text)).toContain(finch.readout.find((r) => /^1 of 4 pack wallets has sold/.test(r.text))?.text);
  });

  it("serves radar summaries in one batched call and validates IDs", async () => {
    const ids = items.map((i) => i.core.id);
    const r = await app.inject({ url: `/api/packs/after?ids=${ids.join(",")}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.schemaVersion).toBe("pack-after-summary.v1");
    for (const it of items) expect(body.data.items[it.core.id]).toEqual(it.after);
    expect((await app.inject({ url: "/api/packs/after" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/packs/after?ids=not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/packs/after?ids=${Array(51).fill(ids[0]).join(",")}` })).statusCode).toBe(400);
    const unknown = await app.inject({ url: `/api/packs/after?ids=${"f".repeat(64)}` });
    expect(unknown.json().data.items).toEqual({});
  });

  it("the after summary on the list matches the detail", async () => {
    const d = await detail("LMOTH");
    const it = items.find((i) => i.token.symbol === "LMOTH")!;
    expect(it.after!.lastChangePct).toBeCloseTo(d.after.lastChangePct!, 6);
    expect(it.after!.peakChangePct).toBeCloseTo(d.after.peak!.changePct, 6);
    expect(it.after!.membersSold).toBe(d.after.members.sold);
    expect(it.after!.tradesAfter).toBe(d.after.activity.buys + d.after.activity.sells);
  });
});

describe("readout rules", () => {
  const base = (): ReadoutInput => {
    const after: AfterPackData = {
      asOf: "2026-09-24T12:30:00.000Z",
      entryPriceSol: "0.00000003",
      lastPriceSol: "0.00000009",
      lastPriceUsd: "0.000018",
      lastTradeAt: "2026-09-24T12:10:00.000Z",
      lastChangePct: 200,
      peak: { changePct: 200, at: "2026-09-24T12:10:00.000Z" },
      trough: { changePct: 5, at: "2026-09-24T12:02:00.000Z" },
      marketCapUsd: "18000",
      activity: { buys: 10, sells: 2, uniqueBuyers: 8, uniqueSellers: 2, buySol: "3", sellSol: "1", netSol: "2" },
      members: { count: 3, sold: 1, exited: 1, soldShare: 0.3, firstSellAt: "2026-09-24T12:01:00.000Z", rows: [] },
      series: [],
      markers: [],
      tokenCreatedAt: null,
      graduatedAt: null,
      observedSince: null,
      notes: [],
    };
    return {
      core: {
        id: "a".repeat(64), namespace: "fixture:t", chain: "solana", tokenAddress: "T", state: "frozen", configVersion: "pack-baseline-v1",
        firstEventTimeMs: Date.parse("2026-09-24T12:00:00Z"), triggerEventTimeMs: Date.parse("2026-09-24T12:00:05Z"), triggeredAtMs: 0,
        lastAcceptedEventTimeMs: 0, initialWalletCount: 3, totalWalletCount: 3, eligibleBuyUsd: "100", expansionEndMs: 0, suppressUntilMs: 0, coreVersion: 1, evidenceVersion: 1,
      },
      token: { chain: "solana", mint: "T", name: "Test", symbol: "TST", identitySource: "pumpfun_create_event", imageUrl: null },
      patterns: { formulaVersion: "patterns-v1", initialEntrySpanMs: 5000, allMemberEntrySpanMs: 5000, memberCount: 3, buySizeCV: "0.5", largestBuyerShare: "0.4", cooccurrencePairCount: 0, cooccurrenceCoverageStart: null, patternScore: null },
      after,
      earlier: [],
      oneHour: undefined,
      confirmation: {
        packId: "a".repeat(64), evidenceVersion: null, contextVersion: 0, confirmedMemberCount: null, checkedMemberCount: 0, totalMemberCount: 3, matchedObservationIds: [], memberMatches: [], updatedAt: null,
        state: { availability: "unavailable", coverage: "unknown", freshness: "unknown", fetchedAt: null, periodStart: null, periodEnd: null, reasonCode: "not_checked", snapshotIds: [] },
      },
      assessment: { version: 1, analysisState: "complete", reviewFlags: [], scheduledMemberCount: 3, totalMemberCount: 3, snapshotIds: [] },
      coverage: { source: "pumpfun", commitment: "confirmed", quoteMints: [], gapIds: [], lateEventCount: 0, unvaluedEventCount: 0, auditedInvalidated: false },
    } as ReadoutInput;
  };
  const texts = (items: ReadoutItem[], group: ReadoutItem["group"]) => items.filter((i) => i.group === group).map((i) => i.text);

  it("does not repeat the peak when the latest trade is the peak", () => {
    const h = texts(buildReadout(base()), "happened").join(" ");
    expect(h).toMatch(/\+200% against the pack's average entry price \(in SOL\)\. That is also the highest since the pack formed\./);
    expect(h).not.toMatch(/It peaked at/);
  });

  it("flags a large move and uses singular grammar for one seller", () => {
    const r = buildReadout(base());
    expect(texts(r, "happened").join(" ")).toMatch(/1 of 3 pack wallets has sold, 30% of the tokens they bought/);
    expect(texts(r, "check").join(" ")).toMatch(/already \+200% above the pack's entry/);
  });

  it("describes a pack with no trades after it without inventing a price", () => {
    const i = base();
    i.after = { ...i.after, lastChangePct: null, peak: null, trough: null, activity: { buys: 0, sells: 0, uniqueBuyers: 0, uniqueSellers: 0, buySol: "0", sellSol: "0", netSol: "0" }, members: { ...i.after.members, sold: 0, soldShare: 0, firstSellAt: null } };
    const h = texts(buildReadout(i), "happened").join(" ");
    expect(h).toMatch(/No trades have been observed since the pack formed/);
    expect(h).toMatch(/None of the 3 pack wallets have sold/);
    expect(h).not.toMatch(/%.*against/);
  });
});
