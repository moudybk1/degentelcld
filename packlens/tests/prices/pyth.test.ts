import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, PYTH_SOL_USD_FEED_ID, ROOT_DIR, WSOL_MINT } from "../../apps/server/src/config.js";
import type { FetchLike } from "../../apps/server/src/adapters/nansen/client.js";
import { selectPrice } from "../../apps/server/src/normalization/valuation.js";
import { decodePriceUpdateV2, PythPriceFeed, readSolUsdAccount } from "../../apps/server/src/prices/pyth.js";
import { PriceStore } from "../../apps/server/src/prices/store.js";
import { ensureNamespace } from "../../apps/server/src/replay/runner.js";
import { T0, testDb } from "../helpers.js";

type AccountValue = { owner: string; data: [string, string] };
const recorded = JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pyth-sol-usd-account.json"), "utf8")) as { value: AccountValue };
const REAL = recorded.value;
const realBytes = () => Buffer.from(REAL.data[0], "base64");
const withBytes = (b: Buffer): AccountValue => ({ ...REAL, data: [b.toString("base64"), "base64"] });

/** Offsets in a fully verified PriceUpdateV2 account. */
const FEED = 41;
const PRICE = 73;
const CONF = 81;
const PUBLISH = 93;

describe("Pyth PriceUpdateV2 decoding (real mainnet account)", () => {
  it("reads SOL/USD exactly from the recorded account", () => {
    const p = readSolUsdAccount(REAL);
    expect(p).toEqual({ feedId: PYTH_SOL_USD_FEED_ID, price: "120.57041765", conf: "0.01526928", publishTimeMs: Date.parse("2026-09-26T04:42:13Z"), postedSlot: "450570149" });
  });

  it("rejects the wrong owner, another feed, partial verification, a foreign account type, and a wide confidence interval", () => {
    expect(() => readSolUsdAccount({ ...REAL, owner: "11111111111111111111111111111111" })).toThrow(/unexpected owner/);
    expect(() => readSolUsdAccount(null)).toThrow(/not found/);

    const other = realBytes();
    other[FEED] = other[FEED]! ^ 0xff;
    expect(() => readSolUsdAccount(withBytes(other))).toThrow(/different Pyth feed/);

    const partial = realBytes();
    partial[40] = 0;
    expect(() => decodePriceUpdateV2(partial)).toThrow(/partially verified/);

    const foreign = realBytes();
    foreign[0] = foreign[0]! ^ 0xff;
    expect(() => decodePriceUpdateV2(foreign)).toThrow(/Not a Pyth PriceUpdateV2/);

    const wide = realBytes();
    wide.writeBigUInt64LE(200_000_000n, CONF); // ±$2 on ~$120.57: above 1%
    expect(() => readSolUsdAccount(withBytes(wide))).toThrow(/Confidence interval/);

    const negative = realBytes();
    negative.writeBigInt64LE(-1n, PRICE);
    expect(() => readSolUsdAccount(withBytes(negative))).toThrow(/not positive/);

    expect(() => decodePriceUpdateV2(realBytes().subarray(0, 100))).toThrow(/truncated/);
  });
});

describe("pyth-onchain-v1 valuation: a published price, never after the trade", () => {
  const E = Date.parse("2026-09-26T04:43:00Z");
  const snap = (id: string, publish: string, available: string) => ({
    id, quoteMint: WSOL_MINT, availableAtMs: Date.parse(available), candleMs: 0, candles: [{ intervalStartMs: Date.parse(publish), close: "120.5" }],
  });

  it("uses the newest price published at or before the trade and known before it arrived", () => {
    const sel = selectPrice([snap("a", "2026-09-26T04:42:13Z", "2026-09-26T04:42:15Z"), snap("b", "2026-09-26T04:43:00Z", "2026-09-26T04:43:01Z")], E, E + 1500, 120_000);
    expect(sel).toMatchObject({ status: "valued", snapshotId: "b", intervalStartMs: E, candleEndMs: E });
  });

  it("never uses a price published after the trade, or one read after the trade arrived", () => {
    expect(selectPrice([snap("late", "2026-09-26T04:43:01Z", "2026-09-26T04:43:01Z")], E, E + 2000, 120_000).status).toBe("missing_price");
    expect(selectPrice([snap("unseen", "2026-09-26T04:42:50Z", "2026-09-26T04:43:05Z")], E, E + 1000, 120_000).status).toBe("missing_price");
  });

  it("marks a price older than the limit as stale", () => {
    expect(selectPrice([snap("old", "2026-09-26T04:40:59Z", "2026-09-26T04:42:30Z")], E, E + 1000, 120_000)).toMatchObject({ status: "stale_price" });
    expect(selectPrice([snap("edge", "2026-09-26T04:41:00Z", "2026-09-26T04:42:30Z")], E, E + 1000, 120_000).status).toBe("valued");
  });
});

describe("PythPriceFeed", () => {
  const env = { APP_MODE: "live", PRICE_PROVIDER: "pyth", NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "100", SOLANA_RPC_HTTP_URL: "https://rpc.test", SOLANA_RPC_WS_URL: "wss://rpc.test", ADMIN_TOKEN: "a".repeat(40) };

  function setup(responses: (() => { status: number; body: unknown })[]) {
    const db = testDb();
    ensureNamespace(db, "live:t", "live", "t", null, T0);
    const clock = new VirtualClock(Date.parse("2026-09-26T04:42:20Z"));
    const config = loadConfig(env, clock.now());
    const store = new PriceStore(db, "live:t", clock);
    const calls: string[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${url} ${JSON.parse(init.body).method}`);
      const r = responses[Math.min(i++, responses.length - 1)]!();
      return { status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) };
    };
    return { db, clock, config, store, calls, feed: new PythPriceFeed(config, clock, store, fetchImpl) };
  }
  const ok = (value: unknown = REAL) => () => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } } });

  it("stores a snapshot only when the publish time advances, then reports price status", async () => {
    const newer = realBytes();
    newer.writeBigInt64LE(BigInt(Date.parse("2026-09-26T04:43:06Z") / 1000), PUBLISH);
    const { db, clock, config, store, calls, feed } = setup([ok(), ok(), ok(withBytes(newer))]);
    expect(await feed.pollQuote(config.price.quotes[0]!)).toBe(true);
    expect(await feed.pollQuote(config.price.quotes[0]!)).toBe(false); // unchanged account
    clock.advance(50_000);
    expect(await feed.pollQuote(config.price.quotes[0]!)).toBe(true);
    expect(calls[0]).toBe("https://rpc.test getAccountInfo");
    const rows = db.prepare("SELECT timeframe, policy_version, source, candles_json, provider_request_id FROM price_snapshots ORDER BY available_at_ms").all() as {
      timeframe: string; policy_version: string; source: string; candles_json: string; provider_request_id: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ timeframe: "tick", policy_version: "pyth-onchain-v1", source: "pyth:onchain:7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", provider_request_id: "slot:450570149" });
    expect(JSON.parse(rows[0]!.candles_json)).toEqual([{ intervalStartMs: Date.parse("2026-09-26T04:42:13Z"), close: "120.57041765" }]);
    expect(feed.status(config.price.quotes[0]!).state).toBe("valid");
    expect(store.snapshotsFor(WSOL_MINT).map((s) => s.candleMs)).toEqual([0, 0]);
    clock.advance(121_000);
    expect(feed.status(config.price.quotes[0]!).state).toBe("stale");
  });

  it("keeps the previous price and records the error when a read fails", async () => {
    const { config, feed } = setup([ok(), () => ({ status: 429, body: {} }), ok({ ...REAL, owner: "11111111111111111111111111111111" })]);
    await feed.pollQuote(config.price.quotes[0]!);
    expect(await feed.pollQuote(config.price.quotes[0]!)).toBe(false);
    expect(feed.lastError).toBe("RPC HTTP 429");
    expect(await feed.pollQuote(config.price.quotes[0]!)).toBe(false);
    expect(feed.lastError).toMatch(/unexpected owner/);
    expect(feed.status(config.price.quotes[0]!).state).toBe("valid");
  });

  it("resumes from the newest stored price after a restart instead of storing it twice", async () => {
    const first = setup([ok()]);
    await first.feed.pollQuote(first.config.price.quotes[0]!);
    const again = new PythPriceFeed(first.config, first.clock, new PriceStore(first.db, "live:t", first.clock), async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(ok()().body) }));
    expect(await again.pollQuote(first.config.price.quotes[0]!)).toBe(false);
    expect((first.db.prepare("SELECT COUNT(*) AS n FROM price_snapshots").get() as { n: number }).n).toBe(1);
  });
});
