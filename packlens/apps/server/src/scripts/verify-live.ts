/**
 * npm run verify:live: explicit, keyed, budgeted, session-bounded smoke test
 * (blueprint §17.1, MVP §3.2 and gate G1). Every call goes through the same
 * guarded client and ledger as the app. Sanitized response shapes are written
 * to docs/compatibility/ for adapter contract evidence.
 *
 * Steps:
 *  1. Solana RPC: subscribe to pump.fun logs for 15 s; decode buys, sells, failures.
 *  2. Nansen OHLCV 1m for WSOL (quote price).
 *  3. Smart Money DEX global page; pick a real Solana token and trader from it.
 *  4. Token information, holders, wallet PnL, wallet DEX history, related wallets,
 *     current balance, Smart Money netflow, and a targeted Smart Money DEX lookup.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { SystemClock } from "../clock.js";
import { ConfigError, loadConfig, loadDotEnv, PUMP_PROGRAM_ID, redactUrl, WSOL_MINT } from "../config.js";
import { migrate, openDatabase } from "../db/connection.js";
import { decodeLogs } from "../collector/decoder.js";
import { NansenClient, type CallResult, type SessionGuard } from "../adapters/nansen/client.js";
import {
  CURRENT_BALANCE,
  HOLDERS,
  OHLCV,
  PNL_SUMMARY,
  RELATED_WALLETS,
  SMART_MONEY_DEX,
  SMART_MONEY_NETFLOW,
  TOKEN_INFORMATION,
  WALLET_DEX_TRADES,
  type EndpointDef,
} from "../adapters/nansen/endpoints.js";
import { BudgetLedger } from "../scheduler/budget.js";
import { DispatchGate } from "../scheduler/gate.js";
import { ensureNamespace } from "../replay/runner.js";
import { isoNoMillis } from "../prices/poller.js";
import { setLogSink } from "../lib/log.js";

loadDotEnv();
setLogSink(() => undefined, "error");

type StepResult = { step: string; ok: boolean; detail: string };
const results: StepResult[] = [];
const say = (s: string) => process.stdout.write(`${s}\n`);

async function rpcCheck(wsUrl: string): Promise<StepResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 15_000 });
    let notifications = 0;
    let failed = 0;
    let buys = 0;
    let sells = 0;
    let decodeErrors = 0;
    const latencies: number[] = [];
    const finish = (ok: boolean, detail: string) => {
      ws.removeAllListeners();
      ws.terminate();
      resolve({ step: "solana-rpc-logsSubscribe", ok, detail });
    };
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }] })));
    ws.on("message", (raw) => {
      const now = Date.now();
      const msg = JSON.parse(raw.toString()) as { method?: string; params?: { result?: { value?: { err: unknown; logs: string[] } } } };
      if (msg.method !== "logsNotification") return;
      const v = msg.params?.result?.value;
      if (!v) return;
      notifications++;
      if (v.err) {
        failed++;
        return;
      }
      const d = decodeLogs(v.logs);
      decodeErrors += d.errors;
      for (const t of d.trades) {
        if (t.isBuy) buys++;
        else sells++;
        latencies.push(now - t.timestampSec * 1000);
      }
    });
    ws.on("error", (e) => finish(false, `WebSocket error: ${e.message}`));
    setTimeout(() => {
      latencies.sort((a, b) => a - b);
      const p = (q: number) => latencies[Math.floor(q * (latencies.length - 1))] ?? null;
      const late = latencies.filter((x) => x > 2000).length;
      finish(
        buys + sells > 0 && decodeErrors === 0,
        `${notifications} notifications in 15 s, ${failed} failed transactions ignored, decoded ${buys} buys and ${sells} sells, ${decodeErrors} decode errors; ` +
          `chain-to-arrival latency p50 ${p(0.5)} ms, p90 ${p(0.9)} ms; ${latencies.length ? ((100 * late) / latencies.length).toFixed(1) : "0"}% would be late at 2 s tolerance`,
      );
    }, 15_000);
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig({ ...process.env, APP_MODE: "live" });
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const clock = new SystemClock();
  say(`PackLens live verification · RPC ${redactUrl(config.rpc.wsUrl)} · budget ${config.nansen.budgetCredits} credits · session ends ${new Date(config.nansen.sessionEndAtMs!).toISOString()}`);

  say("1/3  Solana RPC and pump.fun decoder (15 s)…");
  const rpc = await rpcCheck(config.rpc.wsUrl!);
  results.push(rpc);
  say(`     ${rpc.ok ? "PASS" : "FAIL"} ${rpc.detail}`);

  const db = openDatabase(config.databasePath);
  migrate(db, join(config.rootDir, "migrations"), clock.now());
  const ns = `live:${config.nansen.campaignId}`;
  ensureNamespace(db, ns, "live", `Live campaign ${config.nansen.campaignId}`, null, clock.now());
  const ledger = new BudgetLedger(db, config.nansen.campaignId, clock, () => config.price.reservePolls * config.price.quotes.length);
  ledger.ensureCampaign(config.nansen.budgetCredits!, config.nansen.sessionEndAtMs);
  const end = config.nansen.sessionEndAtMs!;
  const session: SessionGuard = {
    blockReason: () => (clock.now() >= end ? "session_ended" : null),
    sessionEndMs: () => end,
  };
  const client = new NansenClient({
    db, clock, namespace: ns, ledger, gate: new DispatchGate(config.nansen.maxConcurrency, config.nansen.maxRequestsPerMinute, clock),
    apiKey: config.nansen.apiKey!, baseUrl: config.nansen.baseUrl, timeoutMs: config.nansen.timeoutMs, session,
  });
  const compatDir = join(config.rootDir, "docs", "compatibility");
  mkdirSync(compatDir, { recursive: true });
  const shapes: Record<string, unknown> = {};

  const call = async <Req, T>(label: string, def: EndpointDef<Req, T>, req: Req, lane: "PRICE" | "BASE_ENRICHMENT" | "SMART_MONEY", describe: (d: T) => string): Promise<CallResult<T>> => {
    const r = await client.call(def, req, { lane, purpose: `verify_live:${label}`, jobId: null, persist: lane !== "PRICE", bypassCache: true });
    if (r.ok) {
      results.push({ step: def.name, ok: true, detail: `${r.normalized.availability}; ${describe(r.normalized.data)}` });
      shapes[def.name] = { request: req, availability: r.normalized.availability, page: r.normalized.page, isLastPage: r.normalized.isLastPage, providerRequestId: r.providerRequestId };
      say(`     PASS ${def.name}: ${r.normalized.availability}; ${describe(r.normalized.data)}`);
    } else {
      results.push({ step: def.name, ok: false, detail: `${r.code}: ${r.message}` });
      shapes[def.name] = { request: req, failure: r.code };
      say(`     FAIL ${def.name}: ${r.code}: ${r.message}`);
    }
    return r;
  };

  const policy = config.price.policy;
  say(`2/3  Nansen quote price (OHLCV ${policy.timeframe}, closed candles, policy ${policy.version}${policy.isBaseline ? "" : ", documented fallback"})…`);
  const to = Math.floor(clock.now() / policy.candleMs) * policy.candleMs;
  const price = await call("quote-price", OHLCV, { chain: "solana", token_address: WSOL_MINT, timeframe: policy.timeframe, date: { from: isoNoMillis(to - policy.rangeMs), to: isoNoMillis(to) } }, "PRICE", (d) => {
    const last = d.candles[d.candles.length - 1];
    return last ? `${d.candles.length} closed candles; latest ${new Date(last.intervalStartMs).toISOString()} close $${last.close} (age at fetch ${Math.round((Date.now() - last.intervalStartMs) / 1000)} s)` : "no candles";
  });
  if (price.ok && price.normalized.data.candles.length > 0) {
    const newest = price.normalized.data.candles[price.normalized.data.candles.length - 1]!.intervalStartMs;
    say(`     Price freshness: the newest closed candle starts ${Math.round((Date.now() - newest) / 1000)} s before now (valid for events while that is ≤ ${policy.maxCandleAgeMs / 1000} s).`);
  }

  say("3/3  Nansen Smart Money, token, and wallet endpoints…");
  const feed = await call("sm-global", SMART_MONEY_DEX, { chains: ["solana"], pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] }, "SMART_MONEY", (d) => `${d.trades.length} trades; newest ${d.newestMs ? new Date(d.newestMs).toISOString() : "—"}`);
  let token = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"; // fallback subject (WIF) if the feed is empty
  let wallet: string | null = null;
  if (feed.ok) {
    const quoteLike = new Set([WSOL_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
    const pick = feed.normalized.data.trades.find((t) => !quoteLike.has(t.tokenBoughtAddress));
    if (pick) {
      token = pick.tokenBoughtAddress;
      wallet = pick.traderAddress;
    } else if (feed.normalized.data.trades[0]) wallet = feed.normalized.data.trades[0].traderAddress;
  }
  say(`     Subjects from the live feed: token ${token}, wallet ${wallet ?? "none"}`);
  await call("token-info", TOKEN_INFORMATION, { chain: "solana", token_address: token, timeframe: "1h" }, "BASE_ENRICHMENT", (d) => (d ? `${d.symbol ?? "?"} market cap ${d.marketCapUsd ?? "null"}` : "no data"));
  await call("holders", HOLDERS, { chain: "solana", token_address: token, premium_labels: false, aggregate_by_entity: false, label_type: "all_holders", filters: { value_usd: { min: 0 } }, pagination: { page: 1, per_page: 20 }, order_by: [{ field: "token_amount", direction: "DESC" }] }, "BASE_ENRICHMENT", (d) => `${d.holders.length} holders; last page ${d.isLastPage}`);
  await call("netflow", SMART_MONEY_NETFLOW, { chains: ["solana"], filters: { token_address: token }, pagination: { page: 1, per_page: 100 } }, "SMART_MONEY", (d) => (d.rowFound ? `1h ${d.values[0]!.netFlowUsd}, 24h ${d.values[1]!.netFlowUsd}` : "no row for token"));
  await call("sm-token", SMART_MONEY_DEX, { chains: ["solana"], filters: { token_bought_address: token }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] }, "SMART_MONEY", (d) => `${d.trades.length} buys of this token; unique buyers ${new Set(d.trades.map((t) => t.traderAddress)).size}`);
  if (wallet) {
    const hour = Math.floor(clock.now() / 3_600_000) * 3_600_000;
    const five = Math.floor(clock.now() / 300_000) * 300_000;
    await call("pnl", PNL_SUMMARY, { chain: "solana", wallet_address: wallet, date: { from: isoNoMillis(hour - 30 * 86_400_000), to: isoNoMillis(hour) } }, "BASE_ENRICHMENT", (d) => `realized ${d.realizedPnlUsd}, win rate ${d.winRate}, sales ${d.tradedTimes}`);
    await call("wallet-dex", WALLET_DEX_TRADES, { chain: "solana", address: wallet, date: { from: isoNoMillis(five - 7 * 86_400_000), to: isoNoMillis(five) }, pagination: { page: 1, per_page: 100 } }, "BASE_ENRICHMENT", (d) => `${d.trades.length} trades; last page ${d.isLastPage}`);
    await call("related", RELATED_WALLETS, { chain: "solana", wallet_address: wallet, pagination: { page: 1, per_page: 100 } }, "BASE_ENRICHMENT", (d) => `${d.related.length} related wallets`);
    await call("balance", CURRENT_BALANCE, { chain: "solana", address: wallet, hide_spam_token: false, filters: { token_address: token }, pagination: { page: 1, per_page: 100 } }, "BASE_ENRICHMENT", (d) => `${d.balances.length} balances; token observed ${d.packToken?.observedOnFetchedPages}`);
  }

  const totals = ledger.totals();
  const usage = db.prepare("SELECT COUNT(*) AS n, SUM(normalization_status = 'ok') AS ok FROM api_usage WHERE purpose LIKE 'verify_live:%'").get() as { n: number; ok: number };
  writeFileSync(
    join(compatDir, "verify-live-latest.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), rpc: redactUrl(config.rpc.wsUrl), results, shapes, ledger: totals, lastReportedRemaining: client.lastReportedRemaining }, null, 2) + "\n",
  );
  say("");
  say(`Summary: ${results.filter((r) => r.ok).length}/${results.length} steps passed · ${usage.n} provider attempts (${usage.ok} schema-valid) · credits settled ${totals.settled}, unresolved ${totals.unresolved} · account remaining ${client.lastReportedRemaining ?? "not reported"}`);
  say(`Evidence: docs/compatibility/verify-live-latest.json`);
  db.close();
  process.exit(results.every((r) => r.ok) ? 0 : 2);
}

void main();
