import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OverviewData, PackListItem } from "@packlens/contracts";
import { loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";

/**
 * The radar overview summarizes exactly the packs the radar list returns for
 * the same filters. Expected values are recomputed here from the list.
 */
describe("radar overview (fixture)", () => {
  const config = loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" });
  const rt = Runtime.create(config);
  rt.start();
  const app = buildServer(rt);
  let all: PackListItem[] = [];
  const overview = async (query = "") => {
    const r = await app.inject({ url: `/api/overview${query}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ schemaVersion: "radar-overview.v1", mode: "fixture" });
    return r.json().data as OverviewData;
  };
  const list = async (query = "") => (await app.inject({ url: `/api/packs?limit=100${query}` })).json().data.items as PackListItem[];
  beforeAll(async () => {
    all = await list();
  });
  afterAll(() => app.close());

  it("totals match the radar list for the same filters", async () => {
    const o = await overview();
    expect(o.totals.packs).toBe(all.length);
    expect(o.totals.tokens).toBe(new Set(all.map((i) => i.core.tokenAddress)).size);
    const perMint = new Map<string, number>();
    for (const i of all) perMint.set(i.core.tokenAddress, (perMint.get(i.core.tokenAddress) ?? 0) + 1);
    expect(o.totals.repeatTokens).toBe([...perMint.values()].filter((n) => n > 1).length);
    expect(Number(o.totals.eligibleBuyUsd)).toBeCloseTo(all.reduce((a, i) => a + Number(i.core.eligibleBuyUsd), 0), 6);
    expect(o.totals.maxWallets).toBe(Math.max(...all.map((i) => i.core.totalWalletCount)));
    expect(o.totals.repeatPairPacks).toBe(all.filter((i) => i.patterns.cooccurrencePairCount > 0).length);
  });

  it("buckets and size bands each account for every pack exactly once", async () => {
    const o = await overview();
    expect(o.range).not.toBeNull();
    expect(o.buckets.reduce((a, b) => a + b.packs, 0)).toBe(o.totals.packs);
    expect(o.sizeBands.reduce((a, b) => a + b.packs, 0)).toBe(o.totals.packs);
    for (let i = 1; i < o.buckets.length; i++) expect(o.buckets[i]!.startMs - o.buckets[i - 1]!.startMs).toBe(o.bucketMs);
    expect(o.buckets[0]!.startMs % o.bucketMs).toBe(0);
    expect(o.buckets.length).toBeLessThanOrEqual(73);
    for (const i of all) {
      const b = o.buckets.find((x) => i.core.triggerEventTimeMs >= x.startMs && i.core.triggerEventTimeMs < x.startMs + o.bucketMs);
      expect(b?.packs).toBeGreaterThan(0);
    }
  });

  it("never summarizes time before the namespace started observing events", async () => {
    const o = await overview(`?from=${encodeURIComponent("2020-01-01T00:00:00Z")}`);
    expect(o.coverageStartMs).not.toBeNull();
    expect(o.range!.fromMs).toBe(o.coverageStartMs);
    // Fixture data is historical: the range ends at the last observed event, not at wall-clock now.
    expect(o.range!.toMs).toBeLessThan(Date.now() - 60_000);
  });

  it("applies the same filters as the list", async () => {
    const o = await overview("?minWallets=4");
    const four = await list("&minWallets=4");
    expect(four.length).toBeGreaterThan(0);
    expect(four.length).toBeLessThan(all.length);
    expect(o.totals.packs).toBe(four.length);
    expect(o.top.byWallets.map((p) => p.id).sort()).toEqual(four.slice(0, 5).map((i) => i.core.id).sort());

    const t = [...all].sort((a, b) => a.core.triggerEventTimeMs - b.core.triggerEventTimeMs);
    const from = new Date(t[1]!.core.triggerEventTimeMs).toISOString();
    const to = new Date(t[t.length - 2]!.core.triggerEventTimeMs).toISOString();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    expect((await overview(`?${q}`)).totals.packs).toBe((await list(`&${q}`)).length);

    expect((await app.inject({ url: "/api/overview?minWallets=2" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/overview?namespace=live:nope" })).statusCode).toBe(404);
  });

  it("ranks packs and repeated tokens from stored columns", async () => {
    const o = await overview();
    const w = o.top.byWallets.map((p) => p.totalWalletCount);
    expect(w).toEqual([...w].sort((a, b) => b - a));
    const usd = o.top.byUsd.map((p) => Number(p.eligibleBuyUsd));
    expect(usd).toEqual([...usd].sort((a, b) => b - a));
    expect(o.top.byUsd[0]!.id).toBe([...all].sort((a, b) => Number(b.core.eligibleBuyUsd) - Number(a.core.eligibleBuyUsd))[0]!.core.id);
    for (const t of o.top.repeatTokens) {
      const packs = all.filter((i) => i.core.tokenAddress === t.token.mint);
      expect(t.packs).toBe(packs.length);
      expect(t.packs).toBeGreaterThan(1);
      expect(t.latestPackId).toBe([...packs].sort((a, b) => b.core.triggerEventTimeMs - a.core.triggerEventTimeMs)[0]!.core.id);
    }
    expect(o.top.repeatTokens.length).toBeGreaterThan(0);
  });
});
