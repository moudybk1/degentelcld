import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { NansenClient, type SessionGuard } from "../../apps/server/src/adapters/nansen/client.js";
import { HOLDERS, OHLCV, PNL_SUMMARY, RELATED_WALLETS, SMART_MONEY_DEX, SMART_MONEY_NETFLOW, TOKEN_INFORMATION, WALLET_DEX_TRADES, CURRENT_BALANCE } from "../../apps/server/src/adapters/nansen/endpoints.js";
import { BudgetLedger } from "../../apps/server/src/scheduler/budget.js";
import { DispatchGate } from "../../apps/server/src/scheduler/gate.js";
import { ensureNamespace } from "../../apps/server/src/replay/runner.js";
import { WSOL_MINT } from "../../apps/server/src/config.js";
import { addr, fakeFetch, MINT, T0, testDb, type FakeReply } from "../helpers.js";

const NS = "live:test";
const openSession: SessionGuard = { blockReason: () => null, sessionEndMs: () => T0 + 3_600_000 };

/** Real-time clock anchored at T0, for tests that wait on Retry-After. */
function anchoredClock() {
  const start = Date.now();
  return { now: () => T0 + (Date.now() - start) };
}

function setup(handler: (path: string, body: Record<string, unknown>, call: number) => FakeReply, budget = 1000, session: SessionGuard = openSession, clock: { now(): number } = new VirtualClock(T0)) {
  const db = testDb();
  ensureNamespace(db, NS, "live", "test", null, T0);
  const ledger = new BudgetLedger(db, "camp", clock, () => 2);
  ledger.ensureCampaign(budget, null);
  const gate = new DispatchGate(2, 1000, clock);
  const fake = fakeFetch(handler);
  const client = new NansenClient({
    db, clock, namespace: NS, ledger, gate, apiKey: "test-key", baseUrl: "https://api.nansen.ai", timeoutMs: 15000,
    fetchImpl: fake.fn as never, session, sleep: async () => undefined, random: () => 0,
  });
  return { db, clock, ledger, client, fake };
}

const tokenInfoBody = { data: { name: "Moth", symbol: "MOTH", contract_address: MINT, token_details: { market_cap_usd: 19120.44, total_supply: 1000000000 }, spot_metrics: { total_holders: 211, liquidity_usd: 12840.2 } } };
const infoReq = { chain: "solana" as const, token_address: MINT, timeframe: "1h" as const };
const meta = { lane: "BASE_ENRICHMENT" as const, purpose: "test", jobId: null, persist: true };

describe("request shapes (T51): endpoint-specific address field names", () => {
  it("never sends address and wallet_address together and uses the documented paths", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: { pagination: { page: 1, per_page: 100, is_last_page: true }, data: [], top5_tokens: [], traded_token_count: 0, traded_times: 0, realized_pnl_usd: 0, realized_pnl_percent: 0, win_rate: 0 } }));
    const w = addr("W");
    await client.call(PNL_SUMMARY, { chain: "solana", wallet_address: w, date: { from: "2026-08-21T12:00:00Z", to: "2026-09-20T12:00:00Z" } }, meta);
    await client.call(WALLET_DEX_TRADES, { chain: "solana", address: w, date: { from: "2026-09-13T12:00:00Z", to: "2026-09-20T12:00:00Z" }, pagination: { page: 1, per_page: 100 } }, meta);
    await client.call(RELATED_WALLETS, { chain: "solana", wallet_address: w, pagination: { page: 1, per_page: 100 } }, meta);
    await client.call(CURRENT_BALANCE, { chain: "solana", address: w, hide_spam_token: false, filters: { token_address: MINT }, pagination: { page: 1, per_page: 100 } }, meta);
    expect(fake.log.map((l) => l.path)).toEqual([
      "/api/v1/profiler/address/pnl-summary",
      "/api/v1/profiler/dex-trades",
      "/api/v1/profiler/address/related-wallets",
      "/api/v1/profiler/address/current-balance",
    ]);
    for (const l of fake.log) expect("address" in l.body && "wallet_address" in l.body).toBe(false);
    expect(fake.log[0]!.body.wallet_address).toBe(w);
    expect(fake.log[1]!.body.address).toBe(w);
  });

  it("holders request keeps premium labels off", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: { data: [], pagination: { page: 1, per_page: 20, is_last_page: true } }, headers: { "x-nansen-credits-used": "5" } }));
    await client.call(HOLDERS, { chain: "solana", token_address: MINT, premium_labels: false, aggregate_by_entity: false, label_type: "all_holders", filters: { value_usd: { min: 0 } }, pagination: { page: 1, per_page: 20 }, order_by: [{ field: "token_amount", direction: "DESC" }] }, meta);
    expect(fake.log[0]!.body.premium_labels).toBe(false);
    expect(fake.log[0]!.body.filters).toEqual({ value_usd: { min: 0 } });
  });
});

describe("ledger, cache, and single-flight", () => {
  it("records the attempt, settles actual credits from headers, and persists a snapshot", async () => {
    const { client, db, ledger } = setup(() => ({ status: 200, body: tokenInfoBody, headers: { "x-nansen-credits-used": "1", "x-nansen-credits-remaining": "1999" } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT * FROM api_usage").get() as Record<string, unknown>;
    expect(row).toMatchObject({ http_status: 200, http_outcome: "success", normalization_status: "ok", actual_credits: 1, reservation_status: "settled", provider_request_id: "req-1" });
    expect(ledger.totals().settled).toBe(1);
    expect(client.lastReportedRemaining).toBe(1999);
    const snap = db.prepare("SELECT availability, source, result_json FROM enrichment_snapshots").get() as { availability: string; source: string; result_json: string };
    expect(snap.availability).toBe("available");
    expect(JSON.parse(snap.result_json).marketCapUsd).toBe("19120.44");
  });

  it("T56: a cache hit is not a provider call; different params are different keys", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: tokenInfoBody }));
    await client.call(TOKEN_INFORMATION, infoReq, meta);
    const again = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(again.ok && again.source).toBe("cache");
    expect(fake.calls).toBe(1);
    expect(client.cacheHits).toBe(1);
    await client.call(TOKEN_INFORMATION, { ...infoReq, token_address: addr("other") }, meta).catch(() => undefined);
    expect(fake.calls).toBe(2);
  });

  it("T31: identical concurrent requests share one upstream call", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: tokenInfoBody, delayMs: 30 }));
    const results = await Promise.all([1, 2, 3].map(() => client.call(TOKEN_INFORMATION, infoReq, meta)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.calls).toBe(1);
  });
});

describe("error policy (§8.4)", () => {
  it("T34: 429 respects Retry-After and every attempt enters the ledger", async () => {
    const { client, db } = setup(
      (_p, _b, call) => (call === 1 ? { status: 429, body: { code: "rate_limit_exceeded" }, headers: { "retry-after": "1", "x-nansen-credits-used": "0" } } : { status: 200, body: tokenInfoBody }),
      1000,
      openSession,
      anchoredClock(),
    );
    const started = Date.now();
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok).toBe(true);
    const rows = db.prepare("SELECT http_status, retry_of_attempt_id, reservation_status FROM api_usage ORDER BY started_at_ms, rowid").all() as { http_status: number; retry_of_attempt_id: string | null; reservation_status: string }[];
    expect(rows.map((x) => x.http_status)).toEqual([429, 200]);
    expect(rows[1]!.retry_of_attempt_id).not.toBeNull();
    expect(rows[0]!.reservation_status).toBe("settled");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950); // waited for Retry-After
  });

  it("5xx retries at most twice (three attempts total)", async () => {
    const { client, fake } = setup(() => ({ status: 503, body: {} }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok).toBe(false);
    expect(fake.calls).toBe(3);
  });

  it("T33: a timeout after send keeps an unresolved attempt and reservation", async () => {
    const { client, db, ledger } = setup(() => ({ status: 0, body: null, throws: "timeout" }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, { ...meta });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("timeout");
    const rows = db.prepare("SELECT http_outcome, reservation_status FROM api_usage").all();
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => (x as { reservation_status: string }).reservation_status === "unresolved")).toBe(true);
    expect(ledger.totals().unresolved).toBe(3);
  });

  it("a body that times out after the provider answered is settled at the reported cost and not retried", async () => {
    const { client, db, ledger, fake } = setup(() => ({ status: 200, body: tokenInfoBody, throws: "body_timeout", headers: { "x-nansen-credits-used": "1" } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, { ...meta });
    expect(r.ok === false && r.code).toBe("timeout");
    expect(r.ok === false && r.retryable).toBe(false);
    expect(fake.calls).toBe(1);
    const rows = db.prepare("SELECT http_status, http_outcome, reservation_status, actual_credits, error_code FROM api_usage").all();
    expect(rows).toEqual([{ http_status: 200, http_outcome: "timeout", reservation_status: "settled", actual_credits: 1, error_code: "body_not_received" }]);
    expect(ledger.totals().settled).toBe(1);
    expect(ledger.totals().unresolved).toBe(0);
  });

  it("400/422 are not retried and are recorded as adapter failures", async () => {
    const { client, fake } = setup(() => ({ status: 422, body: { code: "invalid_field_value" }, headers: { "x-nansen-credits-used": "0" } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("bad_request");
    expect(fake.calls).toBe(1);
  });

  it("T57: 401 pauses paid dispatch; later calls are blocked without sending", async () => {
    const { client, fake } = setup(() => ({ status: 401, body: { code: "unauthenticated" }, headers: {} }));
    const r1 = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r1.ok === false && r1.code).toBe("auth_paused");
    const r2 = await client.call(TOKEN_INFORMATION, { ...infoReq, token_address: addr("z") }, meta);
    expect(r2.ok === false && r2.code).toBe("auth_paused");
    expect(fake.calls).toBe(1);
  });

  it("402 pauses dispatch as insufficient credits", async () => {
    const { client } = setup(() => ({ status: 402, body: {} }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("payment_paused");
    expect(client.pauseState.reason).toBe("payment");
  });

  it("schema changes fail normalization on HTTP 200 and still settle the charge", async () => {
    const { client, db, ledger } = setup(() => ({ status: 200, body: { data: { name: 5 } } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("schema_error");
    expect(db.prepare("SELECT http_outcome, normalization_status FROM api_usage").get()).toEqual({ http_outcome: "success", normalization_status: "schema_error" });
    expect(ledger.totals().settled).toBe(1);
    const snap = db.prepare("SELECT availability FROM enrichment_snapshots").get() as { availability: string };
    expect(snap.availability).toBe("error");
  });

  it("a subject mismatch is a schema error, never silently accepted", async () => {
    const { client } = setup(() => ({ status: 200, body: { ...tokenInfoBody, data: { ...tokenInfoBody.data, contract_address: addr("wrong") } } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("schema_error");
  });

  it("budget exhaustion blocks before sending", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: tokenInfoBody }), 2);
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("budget_paused");
    expect(fake.calls).toBe(0);
  });

  it("no session: nothing is sent", async () => {
    const { client, fake } = setup(() => ({ status: 200, body: tokenInfoBody }), 1000, { blockReason: () => "no_session", sessionEndMs: () => null });
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("no_session");
    expect(fake.calls).toBe(0);
  });
});

describe("provider mappings", () => {
  it("OHLCV keeps only closed, positive candles in [from, to) and preserves precision", async () => {
    const { client } = setup(() => ({
      status: 200,
      body: `{"chain":"solana","token_address":"${WSOL_MINT}","timeframe":"1m","data":[{"interval_start":"2026-09-20T11:58:00Z","close":212.123456789012345678,"market_cap":{}},{"interval_start":"2026-09-20T11:59:00Z","close":null,"market_cap":{}},{"interval_start":"2026-09-20T12:00:00Z","close":213,"market_cap":{}}],"truncated":false}`,
    }));
    const r = await client.call(OHLCV, { chain: "solana", token_address: WSOL_MINT, timeframe: "1m", date: { from: "2026-09-20T11:50:00Z", to: "2026-09-20T12:00:00Z" } }, { lane: "PRICE", purpose: "quote_price", jobId: null, persist: false, bypassCache: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.data.candles).toEqual([{ intervalStartMs: Date.parse("2026-09-20T11:58:00Z"), close: "212.123456789012345678" }]);
      expect(r.normalized.data.skippedCandles).toBe(2);
    }
  });

  it("5m OHLCV drops the open candle that the inclusive `to` returns", async () => {
    const { client } = setup(() => ({
      status: 200,
      body: { chain: "solana", token_address: WSOL_MINT, timeframe: "5m", data: [{ interval_start: "2026-09-20T11:50:00Z", close: 118.1, market_cap: {} }, { interval_start: "2026-09-20T11:55:00Z", close: 118.2, market_cap: {} }, { interval_start: "2026-09-20T12:00:00Z", close: 118.3, market_cap: {} }] },
    }));
    const r = await client.call(OHLCV, { chain: "solana", token_address: WSOL_MINT, timeframe: "5m", date: { from: "2026-09-20T11:30:00Z", to: "2026-09-20T12:00:00Z" } }, { lane: "PRICE", purpose: "q", jobId: null, persist: false, bypassCache: true });
    expect(r.ok && r.normalized.data.candles.map((c) => c.close)).toEqual(["118.1", "118.2"]);
  });

  it("OHLCV truncation is rejected", async () => {
    const { client } = setup(() => ({ status: 200, body: { chain: "solana", token_address: WSOL_MINT, timeframe: "1m", data: [], truncated: true } }));
    const r = await client.call(OHLCV, { chain: "solana", token_address: WSOL_MINT, timeframe: "1m", date: { from: "2026-09-20T11:50:00Z", to: "2026-09-20T12:00:00Z" } }, { lane: "PRICE", purpose: "q", jobId: null, persist: false, bypassCache: true });
    expect(r.ok === false && r.code).toBe("schema_error");
  });

  it("Smart Money DEX rows must match the requested bought token and Solana", async () => {
    const row = { chain: "solana", block_timestamp: "2026-09-20T11:59:00", transaction_hash: "h", trader_address: addr("T"), trader_address_label: "Fund", token_bought_address: MINT, token_sold_address: WSOL_MINT, token_bought_symbol: "M", token_sold_symbol: "SOL", token_bought_age_days: 0, token_sold_age_days: 900, trade_value_usd: 25.5 };
    const { client } = setup(() => ({ status: 200, body: { data: [row, { ...row, trade_value_usd: null, transaction_hash: "h2" }], pagination: { page: 1, per_page: 100, is_last_page: true } }, headers: { "x-nansen-credits-used": "5" } }));
    const r = await client.call(SMART_MONEY_DEX, { chains: ["solana"], filters: { token_bought_address: MINT }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] }, { lane: "SMART_MONEY", purpose: "t", jobId: null, persist: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.data.trades[0]!.blockTimeMs).toBe(Date.parse("2026-09-20T11:59:00Z"));
      expect(r.normalized.data.trades[1]!.tradeValueUsd).toBeNull();
      expect(r.normalized.isLastPage).toBe(true);
    }
    const { client: c2 } = setup(() => ({ status: 200, body: { data: [{ ...row, token_bought_address: addr("other") }], pagination: {} } }));
    const bad = await c2.call(SMART_MONEY_DEX, { chains: ["solana"], filters: { token_bought_address: MINT }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] }, { lane: "SMART_MONEY", purpose: "t", jobId: null, persist: true });
    expect(bad.ok === false && bad.code).toBe("schema_error");
  });

  it("netflow keeps four separate provider values and never fabricates asOf", async () => {
    const { client } = setup(() => ({ status: 200, body: { data: [{ token_address: MINT, token_symbol: "M", net_flow_1h_usd: -120.5, net_flow_24h_usd: 50, net_flow_7d_usd: 50, net_flow_30d_usd: 50, chain: "solana", token_sectors: [], trader_count: 4, token_age_days: 0 }], pagination: { page: 1, per_page: 100, is_last_page: true } } }));
    const r = await client.call(SMART_MONEY_NETFLOW, { chains: ["solana"], filters: { token_address: MINT }, pagination: { page: 1, per_page: 100 } }, { lane: "SMART_MONEY", purpose: "n", jobId: null, persist: true });
    expect(r.ok && r.normalized.data.values).toEqual([
      { window: "1h", netFlowUsd: "-120.5" },
      { window: "24h", netFlowUsd: "50" },
      { window: "7d", netFlowUsd: "50" },
      { window: "30d", netFlowUsd: "50" },
    ]);
    expect(r.ok && r.normalized.data.asOf).toBeNull();
  });
});

describe("provider query timeouts", () => {
  it("HTTP 500 query_timeout is not retried with an identical request", async () => {
    const { client, fake } = setup(() => ({ status: 500, body: { code: "query_timeout", message: "Query timed out" }, headers: { "x-nansen-credits-cost": "1" } }));
    const r = await client.call(TOKEN_INFORMATION, infoReq, meta);
    expect(r.ok === false && r.code).toBe("http_error");
    expect(fake.calls).toBe(1);
  });
});
