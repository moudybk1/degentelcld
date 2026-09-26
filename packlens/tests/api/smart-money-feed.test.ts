/**
 * The Smart Money page as an early-token feed: the shared feed asks Nansen only for trades in
 * tokens at most SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS old, and the activity API marks tokens seen
 * in the pump.fun stream with their launch time. Fake Nansen, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, ROOT_DIR, WSOL_MINT } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import type { FetchLike } from "../../apps/server/src/adapters/nansen/client.js";
import { addr, fakeFetch } from "../helpers.js";

const START = Date.UTC(2026, 8, 26, 4, 42, 13);
const PUMP = addr("sm-feed-pump-token");
const OTHER = addr("sm-feed-other-token");
const LAUNCH = START - 4 * 60_000;

const account = (JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pyth-sol-usd-account.json"), "utf8")) as { value: unknown }).value;
const rpc: FetchLike = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: account } }) });

const trade = (hash: string, token: string, symbol: string, atMs: number) => ({
  chain: "solana", block_timestamp: new Date(atMs).toISOString().replace(".000Z", "Z"), transaction_hash: hash, trader_address: addr(`sm-trader-${hash}`), trader_address_label: "Smart Trader",
  token_bought_address: token, token_sold_address: WSOL_MINT, token_bought_amount: 1000, token_sold_amount: 2, token_bought_symbol: symbol, token_sold_symbol: "SOL", trade_value_usd: 480.5,
  token_bought_age_days: 0, token_bought_market_cap: 42000,
});
const fake = fakeFetch((path) =>
  path === "/api/v1/smart-money/dex-trades"
    ? { status: 200, body: { data: [trade("h1", PUMP, "PUMPY", START - 60_000), trade("h2", OTHER, "OTHER", START - 120_000)], pagination: { page: 1, per_page: 100, is_last_page: true } }, headers: { "x-nansen-credits-used": "5" } }
    : { status: 404, body: { code: "not_found" } },
);

describe("Smart Money feed of new tokens", () => {
  const clock = new VirtualClock(START);
  const config = loadConfig(
    {
      APP_MODE: "live", PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "5000", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "5000",
      SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", SMART_MONEY_ENABLED: "true", SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS: "1", SMART_MONEY_POLL_SECONDS: "600",
      ENRICHMENT_AUTO_PACKS_PER_CYCLE: "0",
    },
    clock.now(),
  );
  const rt = Runtime.create(config, { clock, fetchImpl: fake.fn as never, rpcFetchImpl: rpc, startCollector: false });
  rt.start();
  rt.live!.pricePoller.stop();
  rt.live!.scheduler.stop();
  const app = buildServer(rt);
  afterAll(async () => {
    await app.close();
  });

  it("asks Nansen for tokens at most a day old and shows pump.fun launches with the time since launch", async () => {
    expect(config.smartMoney.feedMaxTokenAgeDays).toBe(1);
    // The pump.fun stream saw this token launch three minutes before the Smart Money buy; it never saw OTHER.
    rt.db.prepare("INSERT INTO tokens (namespace, chain, mint, name, symbol, created_event_time_ms, first_seen_at_ms) VALUES (?, 'solana', ?, 'Pumpy', 'PUMPY', ?, ?)").run(rt.primaryNamespace, PUMP, LAUNCH, LAUNCH);

    rt.live!.scheduler.enqueueGlobalFeed();
    await vi.waitFor(() => expect(rt.db.prepare("SELECT status FROM jobs WHERE type = 'sm_global_feed'").get()).toEqual({ status: "succeeded" }), { timeout: 10_000, interval: 50 });
    const call = fake.log.find((l) => l.path === "/api/v1/smart-money/dex-trades")!;
    expect(call.body.filters).toEqual({ token_bought_age_days: { min: 0, max: 1 } });

    const pumpOnly = (await app.inject({ url: "/api/smart-money/activity?pumpfun=1" })).json().data;
    expect(pumpOnly.rows).toHaveLength(1);
    expect(pumpOnly.rows[0]).toMatchObject({ tokenAddress: PUMP, direction: "buy", scope: "New-token feed", pumpfun: true, tokenLaunchedAt: new Date(LAUNCH).toISOString() });
    expect(pumpOnly.scopeDescription).toMatch(/at most 1 day old/);
    expect(pumpOnly.state.freshness).toBe("fresh");

    const all = (await app.inject({ url: "/api/smart-money/activity?pumpfun=0" })).json().data;
    expect(all.rows.map((r: { tokenAddress: string; pumpfun: boolean }) => [r.tokenAddress, r.pumpfun])).toEqual([[PUMP, true], [OTHER, false]]);
    expect((await app.inject({ url: "/api/smart-money/activity?pumpfun=yes" })).statusCode).toBe(400);

    // With a 10-minute poll, the feed stays fresh for two intervals.
    clock.advance(19 * 60_000);
    expect((await app.inject({ url: "/api/smart-money/activity?pumpfun=1&t=1" })).json().data.state.freshness).toBe("fresh");
    clock.advance(2 * 60_000);
    expect((await app.inject({ url: "/api/smart-money/activity?pumpfun=1&t=2" })).json().data.state.freshness).toBe("stale");
  });
});
