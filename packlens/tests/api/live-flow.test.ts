/**
 * End-to-end live flow with a fake Nansen provider and synthetic pump.fun logs:
 * transaction → valuation → pack → base enrichment → Smart Money counts and
 * member confirmation → read API. No network access.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, PUMP_PROGRAM_ID, WSOL_MINT } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { TRADE_EVENT_DISCRIMINATOR } from "../../apps/server/src/collector/decoder.js";
import { base58Decode } from "../../apps/server/src/lib/base58.js";
import { addr, fakeFetch, MINT, sig } from "../helpers.js";

const START = Date.UTC(2026, 8, 25, 12, 0, 5); // minute boundary + 5 s
const END_ISO = "2026-09-25T14:00:00Z";

function tradeLog(mint: string, user: string, lamports: bigint, isBuy: boolean, tsSec: number): string {
  const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8);
  let o = 0;
  Buffer.from(TRADE_EVENT_DISCRIMINATOR).copy(b, o); o += 8;
  Buffer.from(base58Decode(mint)!).copy(b, o); o += 32;
  b.writeBigUInt64LE(lamports, o); o += 8;
  b.writeBigUInt64LE(1_000_000_000n, o); o += 8;
  b.writeUInt8(isBuy ? 1 : 0, o); o += 1;
  Buffer.from(base58Decode(user)!).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(tsSec), o);
  return `Program data: ${b.toString("base64")}`;
}

function txLogs(line: string): string[] {
  return [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Buy", line, `Program ${PUMP_PROGRAM_ID} success`];
}

const members = ["A", "B", "C"].map((w) => addr(`live-${w}`));
const packSigs = ["A", "B", "C"].map((w) => sig(`live-tx-${w}`));

const fake = fakeFetch((path, body) => {
  const page = { page: 1, per_page: 100, is_last_page: true };
  switch (path) {
    case "/api/v1/tgm/token-ohlcv": {
      const date = body.date as { from: string; to: string };
      const from = Date.parse(date.from);
      const to = Date.parse(date.to);
      const data = [];
      for (let t = from; t < to; t += 60_000) data.push({ interval_start: new Date(t).toISOString().replace(".000Z", ""), close: 200, market_cap: {} });
      return { status: 200, body: { chain: "solana", token_address: WSOL_MINT, timeframe: "1m", data, truncated: false } };
    }
    case "/api/v1/tgm/token-information":
      return { status: 200, body: { data: { name: "Live Test", symbol: "LIVE", contract_address: MINT, token_details: { total_supply: 1000000000, market_cap_usd: 5000 }, spot_metrics: { total_holders: 10 } } } };
    case "/api/v1/tgm/holders":
      return { status: 200, body: { data: [{ address: members[0], token_amount: 50000000, ownership_percentage: 5, value_usd: 250 }], pagination: page }, headers: { "x-nansen-credits-used": "5" } };
    case "/api/v1/profiler/address/pnl-summary":
      return { status: 200, body: { pagination: page, top5_tokens: [], traded_token_count: 3, traded_times: 9, realized_pnl_usd: 120.5, realized_pnl_percent: 0.1, win_rate: 0.5 } };
    case "/api/v1/profiler/dex-trades":
      return { status: 200, body: { pagination: page, data: [] } };
    case "/api/v1/profiler/address/related-wallets":
      // Member A reports a direct relationship with member B.
      return { status: 200, body: { pagination: page, data: body.wallet_address === members[0] ? [{ address: members[1], relation: "First Funder", transaction_hash: "h", block_timestamp: "2026-09-20T00:00:00", order: 1, chain: "solana" }] : [] } };
    case "/api/v1/profiler/address/current-balance":
      return { status: 200, body: { pagination: page, data: [] } };
    case "/api/v1/smart-money/dex-trades": {
      const rows = [
        // Member A's pack transaction appears in Smart Money data: confirmation.
        { chain: "solana", block_timestamp: new Date(START + 1000).toISOString().replace(".000Z", ""), transaction_hash: packSigs[0], trader_address: members[0], trader_address_label: "Smart Trader", token_bought_address: MINT, token_sold_address: WSOL_MINT, token_bought_symbol: "LIVE", token_sold_symbol: "SOL", token_bought_age_days: 0, token_sold_age_days: 1000, trade_value_usd: 40 },
        // A non-member buyer: raises the token count only.
        { chain: "solana", block_timestamp: new Date(START + 5_000).toISOString().replace(".000Z", ""), transaction_hash: "outsider-tx", trader_address: addr("outsider"), trader_address_label: "Fund", token_bought_address: MINT, token_sold_address: WSOL_MINT, token_bought_symbol: "LIVE", token_sold_symbol: "SOL", token_bought_age_days: 0, token_sold_age_days: 1000, trade_value_usd: 12 },
      ];
      return { status: 200, body: { data: (body.filters as { token_bought_address?: string } | undefined)?.token_bought_address ? rows : [], pagination: page }, headers: { "x-nansen-credits-used": "5" } };
    }
    case "/api/v1/smart-money/netflow":
      return { status: 200, body: { data: [{ token_address: MINT, token_symbol: "LIVE", net_flow_1h_usd: 52, net_flow_24h_usd: 52, net_flow_7d_usd: 52, net_flow_30d_usd: 52, chain: "solana", token_sectors: [], trader_count: 2, token_age_days: 0 }], pagination: page }, headers: { "x-nansen-credits-used": "5" } };
    default:
      return { status: 404, body: { code: "not_found" } };
  }
});

describe("live flow with a fake provider", () => {
  const clock = new VirtualClock(START);
  const config = loadConfig(
    {
      APP_MODE: "live", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "500", NANSEN_SESSION_END_AT: END_ISO,
      SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", SMART_MONEY_ENABLED: "true", NANSEN_MAX_REQUESTS_PER_MINUTE: "1000", ENRICHMENT_AUTO_PACKS_PER_CYCLE: "0",
    },
    START,
  );
  const rt = Runtime.create(config, { clock, fetchImpl: fake.fn as never, startCollector: false });
  rt.start();
  rt.live!.pricePoller.stop();
  rt.live!.scheduler.stop();
  const app = buildServer(rt);
  afterAll(async () => {
    await app.close();
  });

  it("values buys with a closed Nansen candle, detects a pack, enriches it, and matches Smart Money", async () => {
    await rt.live!.pricePoller.pollQuote(config.price.quotes[0]!);
    expect(rt.live!.pricePoller.status(config.price.quotes[0]!).state).toBe("valid");

    const t0 = Math.floor(START / 1000) + 2; // chain seconds after the snapshot
    const amounts = [150_000_000n, 200_000_000n, 99_000_000n]; // $30, $40, $19.80
    ["A", "B", "C"].forEach((w, i) => {
      clock.set(START + (i + 2) * 1000 + 800);
      rt.handleTransaction({ signature: packSigs[i]!, slot: 1 + i, err: null, logs: txLogs(tradeLog(MINT, members[i]!, amounts[i]!, true, t0 + i)), receivedAtMs: clock.now() });
    });
    // C paid $19.80: not eligible, so no pack yet.
    clock.set(START + 10_000);
    rt.live!.pipeline.tick();
    expect(rt.db.prepare("SELECT COUNT(*) AS n FROM packs").get()).toEqual({ n: 0 });
    const cRow = rt.db.prepare("SELECT eligibility_reason, trade_value_usd FROM trade_events WHERE wallet = ?").get(members[2]) as { eligibility_reason: string; trade_value_usd: string };
    expect(cRow).toEqual({ eligibility_reason: "below_threshold", trade_value_usd: "19.8" });

    // C buys again for $30 within the window: pack forms (two $x buys never combine).
    clock.set(START + 11_000);
    rt.handleTransaction({ signature: sig("live-tx-C2"), slot: 9, err: null, logs: txLogs(tradeLog(MINT, members[2]!, 150_000_000n, true, t0 + 8)), receivedAtMs: clock.now() });
    // A failed transaction is ignored before decoding by the collector; a sell is ineligible.
    rt.handleTransaction({ signature: sig("sell"), slot: 10, err: null, logs: txLogs(tradeLog(MINT, addr("seller"), 900_000_000n, false, t0 + 8)), receivedAtMs: clock.now() });
    clock.set(START + 14_000);
    rt.live!.pipeline.tick();
    const packs = rt.db.prepare("SELECT id, eligible_buy_usd, initial_wallet_count FROM packs").all() as { id: string; eligible_buy_usd: string; initial_wallet_count: number }[];
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ eligible_buy_usd: "100", initial_wallet_count: 3 });
    const packId = packs[0]!.id;

    // Operator enrichment through the protected API.
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: "t".repeat(40) } });
    const cookie = login.cookies.find((c) => c.name === "packlens_operator")!.value;
    const enrich = await app.inject({ method: "POST", url: `/api/admin/enrich/${packId}`, headers: { cookie: `packlens_operator=${cookie}`, "idempotency-key": "enrich-00001" } });
    expect(enrich.statusCode).toBe(202);

    await vi.waitFor(
      () => {
        const pending = rt.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') AND type <> 'balance_followup'").get() as { n: number };
        expect(pending.n).toBe(0);
      },
      { timeout: 10_000, interval: 100 },
    );

    const detail = (await app.inject({ url: `/api/packs/${packId}` })).json().data;
    expect(detail.context.tokenInfo.state.availability).toBe("available");
    expect(detail.context.holders.data.holders[0].isPackMember).toBe(true);
    expect(detail.assessment.reviewFlags).toContain("CHECK_RELATIONSHIP");
    const [m5, m1] = detail.smartMoney.windows;
    expect(m1.observedUniqueBuyers).toBe(2); // member A + outsider
    expect(m1.countQualifier).toBe("observed");
    expect(m5.state.coverage).toBe("window_scanned");
    expect(detail.smartMoney.packConfirmation.confirmedMemberCount).toBe(1);
    expect(detail.smartMoney.packConfirmation.totalMemberCount).toBe(3);
    expect(detail.smartMoney.netflow.data.values[0].netFlowUsd).toBe("52");
    expect(detail.summary).toContain("1 of 3 pack members confirmed");

    // Every provider attempt is in the ledger with settled credits; the key never leaves the backend.
    const usage = (await app.inject({ url: "/api/admin/usage", headers: { cookie: `packlens_operator=${cookie}` } })).json().data;
    expect(usage.attempts.total).toBe(fake.calls);
    expect(usage.credits.settled).toBeGreaterThan(0);
    expect(usage.credits.unresolved).toBe(0);
    for (const l of fake.log) expect(JSON.stringify(l.body)).not.toContain('"apikey"');

    // Balance follow-up waits for trigger + 5 minutes.
    const followups = rt.db.prepare("SELECT status FROM jobs WHERE type = 'balance_followup'").all() as { status: string }[];
    expect(followups.every((f) => f.status === "queued")).toBe(true);
    clock.set(START + 6 * 60_000);
    await vi.waitFor(() => {
      const f = rt.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'balance_followup' AND status = 'succeeded'").get() as { n: number };
      expect(f.n).toBe(2);
    }, { timeout: 10_000, interval: 100 });
    const detail2 = (await app.inject({ url: `/api/packs/${packId}` })).json().data;
    expect(detail2.assessment.analysisState).toBe("complete");
  });
});
