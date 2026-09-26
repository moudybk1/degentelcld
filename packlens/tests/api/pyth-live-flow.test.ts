/**
 * 24/7 live flow with the Pyth price and Nansen off: synthetic pump.fun logs →
 * valuation with Pyth's on-chain SOL/USD price (recorded mainnet account) →
 * pack → read API. The Nansen fake must never be called. No network access.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, PUMP_PROGRAM_ID, ROOT_DIR } from "../../apps/server/src/config.js";
import { migrate, openDatabase } from "../../apps/server/src/db/connection.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { TRADE_EVENT_DISCRIMINATOR } from "../../apps/server/src/collector/decoder.js";
import { base58Decode } from "../../apps/server/src/lib/base58.js";
import type { FetchLike } from "../../apps/server/src/adapters/nansen/client.js";
import { addr, MINT, sig } from "../helpers.js";

const START = Date.UTC(2026, 8, 26, 4, 42, 13);

function tradeLog(user: string, lamports: bigint, tsSec: number): string {
  const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8);
  let o = 0;
  Buffer.from(TRADE_EVENT_DISCRIMINATOR).copy(b, o); o += 8;
  Buffer.from(base58Decode(MINT)!).copy(b, o); o += 32;
  b.writeBigUInt64LE(lamports, o); o += 8;
  b.writeBigUInt64LE(1_000_000_000n, o); o += 8;
  b.writeUInt8(1, o); o += 1;
  Buffer.from(base58Decode(user)!).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(tsSec), o);
  return `Program data: ${b.toString("base64")}`;
}
const txLogs = (line: string) => [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Buy", line, `Program ${PUMP_PROGRAM_ID} success`];

// The recorded account publishes $120.57041765 at START (2026-09-26T04:42:13Z).
const account = (JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pyth-sol-usd-account.json"), "utf8")) as { value: unknown }).value;
const rpc: FetchLike = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: account } }) });
const nansenCalls: string[] = [];
const nansen: FetchLike = async (url) => {
  nansenCalls.push(url);
  throw new Error("Nansen must not be called while it is off");
};

describe("live flow with the Pyth price and Nansen off", () => {
  const clock = new VirtualClock(START + 1500);
  const config = loadConfig(
    {
      APP_MODE: "live", PRICE_PROVIDER: "pyth", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "500",
      SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", SMART_MONEY_ENABLED: "true",
    },
    clock.now(),
  );
  const rt = Runtime.create(config, { clock, fetchImpl: nansen, rpcFetchImpl: rpc, startCollector: false });
  rt.start();
  rt.live!.pricePoller.stop();
  const app = buildServer(rt);
  afterAll(async () => {
    rt.live!.scheduler.stop();
    await app.close();
  });

  it("detects a pack from Pyth-valued buys and spends no Nansen credits", async () => {
    await rt.live!.pricePoller.pollQuote(config.price.quotes[0]!);
    expect(rt.live!.pricePoller.status(config.price.quotes[0]!).state).toBe("valid");
    expect(rt.live!.session.current()).toBeNull();

    const wallets = ["A", "B", "C"].map((w) => addr(`pyth-${w}`));
    const lamports = [200_000_000n, 250_000_000n, 170_000_000n]; // $24.11, $30.14, $20.50 at $120.57
    const t0 = Math.floor(START / 1000) + 2;
    wallets.forEach((w, i) => {
      clock.set(START + (i + 2) * 1000 + 800);
      rt.handleTransaction({ signature: sig(`pyth-tx-${i}`), slot: 1 + i, err: null, logs: txLogs(tradeLog(w, lamports[i]!, t0 + i)), receivedAtMs: clock.now() });
    });
    clock.set(START + 10_000);
    rt.live!.pipeline.tick();

    const packs = rt.db.prepare("SELECT id, eligible_buy_usd, initial_wallet_count FROM packs").all() as { id: string; eligible_buy_usd: string; initial_wallet_count: number }[];
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ initial_wallet_count: 3, eligible_buy_usd: "74.753658943" }); // 24.11408353 + 30.1426044125 + 20.4969710005
    const row = rt.db.prepare("SELECT trade_value_usd, eligibility, payload_json FROM trade_events WHERE wallet = ?").get(wallets[2]) as { trade_value_usd: string; eligibility: string; payload_json: string };
    expect(row).toMatchObject({ trade_value_usd: "20.4969710005", eligibility: "eligible" });
    expect(JSON.parse(row.payload_json)).toMatchObject({ quoteUsdPrice: "120.57041765", quotePriceAtMs: START, priceCandleEndMs: START, priceSource: "pyth:onchain:7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE:pyth-onchain-v1" });

    const status = (await app.inject({ url: "/api/status" })).json().data;
    expect(status.price).toMatchObject({ provider: "pyth", timeframe: "tick", policyVersion: "pyth-onchain-v1", state: "valid" });
    expect(status.analysisPaused).toMatchObject({ paused: true });
    expect(status.analysisPaused.reason).toMatch(/Nansen analysis is off/);

    // With Nansen off, operator enrichment is refused before anything is sent.
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: "t".repeat(40) } });
    const cookie = login.cookies.find((c) => c.name === "packlens_operator")!.value;
    const enrich = await app.inject({ method: "POST", url: `/api/admin/enrich/${packs[0]!.id}`, headers: { cookie: `packlens_operator=${cookie}`, "idempotency-key": "enrich-pyth-1" } });
    expect(enrich.statusCode).toBe(409);
    const overview = (await app.inject({ url: "/api/admin/overview", headers: { cookie: `packlens_operator=${cookie}` } })).json().data;
    expect(overview.config).toMatchObject({ priceProvider: "pyth", nansenMode: "off" });
    expect(overview.usage.credits).toMatchObject({ settled: 0, reserved: 0, priceReserve: 0, dailyCap: null, usedToday: 0 });

    expect(nansenCalls).toEqual([]);
    expect(rt.db.prepare("SELECT COUNT(*) AS n FROM api_usage").get()).toEqual({ n: 0 });
  });
});

describe("live flow with a custom pack rule (5 wallets, $25 per buy)", () => {
  const clock = new VirtualClock(START + 1500);
  const config = loadConfig(
    {
      APP_MODE: "live", PRICE_PROVIDER: "pyth", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "500",
      SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", PACK_MIN_WALLETS: "5", PACK_MIN_TRADE_USD: "25",
    },
    clock.now(),
  );
  // A database that already ran the baseline rule: its namespace and a recently created token.
  const db = openDatabase(":memory:");
  migrate(db, join(ROOT_DIR, "migrations"), clock.now());
  db.prepare("INSERT INTO namespaces (id, mode, created_at_ms, label) VALUES ('live:packlens-live', 'live', ?, 'old')").run(START - 3_600_000);
  db.prepare("INSERT INTO tokens (namespace, chain, mint, name, symbol, first_seen_at_ms, created_event_time_ms) VALUES ('live:packlens-live', 'solana', ?, 'Carried Over', 'CARRY', ?, ?)").run(MINT, START - 600_000, START - 600_000);
  const rt = Runtime.create(config, { clock, db, fetchImpl: nansen, rpcFetchImpl: rpc, startCollector: false });
  rt.start();
  rt.live!.pricePoller.stop();
  const app = buildServer(rt);
  afterAll(async () => {
    rt.live!.scheduler.stop();
    await app.close();
  });

  it("detects into its own namespace, reports the rule, and forms a pack only at the fifth $25 buyer", async () => {
    expect(rt.primaryNamespace).toBe("live:packlens-live:5w-25usd");
    expect(db.prepare("SELECT name, symbol FROM tokens WHERE namespace = ? AND mint = ?").get(rt.primaryNamespace, MINT)).toEqual({ name: "Carried Over", symbol: "CARRY" });
    await rt.live!.pricePoller.pollQuote(config.price.quotes[0]!);

    const wallets = ["A", "B", "C", "D", "E"].map((w) => addr(`rule-${w}`));
    // Buy by wallet i at START + sec, arriving 0.8 s later; 0.25 SOL is $30.14 at $120.57.
    const buy = (i: number, sec: number) => {
      clock.set(START + sec * 1000 + 800);
      rt.handleTransaction({ signature: sig(`rule-tx-${i}`), slot: 10 + i, err: null, logs: txLogs(tradeLog(wallets[i]!, 250_000_000n, Math.floor(START / 1000) + sec)), receivedAtMs: clock.now() });
    };
    for (let i = 0; i < 4; i++) buy(i, 2 + i);
    clock.set(START + 9_000);
    rt.live!.pipeline.tick();
    expect(db.prepare("SELECT COUNT(*) AS n FROM packs").get()).toEqual({ n: 0 }); // four wallets: a baseline pack, not one here
    buy(4, 9); // the fifth, 7 s after the first
    clock.set(START + 14_000);
    rt.live!.pipeline.tick();
    const pack = db.prepare("SELECT id, namespace, initial_wallet_count, config_version FROM packs").get() as { id: string; namespace: string; initial_wallet_count: number; config_version: string };
    expect(pack).toMatchObject({ namespace: "live:packlens-live:5w-25usd", initial_wallet_count: 5, config_version: "pack-custom-5w-25usd-v1" });

    const status = (await app.inject({ url: "/api/status" })).json().data;
    expect(status.namespace).toBe("live:packlens-live:5w-25usd");
    expect(status.detector).toEqual({ version: "pack-custom-5w-25usd-v1", minUniqueWallets: 5, minTradeUsd: "25", triggerWindowSeconds: 20, expansionSeconds: 40, isBaseline: false });
    // The earlier baseline namespace stays readable and still reports the baseline rule.
    expect((await app.inject({ url: "/api/status?namespace=live:packlens-live" })).json().data.detector).toMatchObject({ version: "pack-baseline-v1", isBaseline: true });
    const detail = (await app.inject({ url: `/api/packs/${pack.id}` })).json().data;
    expect(detail.token).toMatchObject({ name: "Carried Over" });
    expect(JSON.stringify(detail)).toContain("5 wallets each bought $25 or more");
    expect(nansenCalls).toEqual([]);
  });
});
