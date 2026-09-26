/**
 * Credit-aware Nansen usage with the Pyth price in continuous mode: extra profiles
 * for the largest buyer and repeat wallets, wallet data reused across packs,
 * netflow only after Smart Money buyers, repeat-wallet profiling, and the
 * Repeat wallets read model. Synthetic logs and a fake provider; no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, PUMP_PROGRAM_ID, ROOT_DIR } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { PACK_ENRICHMENT_CREDITS } from "../../apps/server/src/enrichment/scheduler.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { TRADE_EVENT_DISCRIMINATOR } from "../../apps/server/src/collector/decoder.js";
import { base58Decode } from "../../apps/server/src/lib/base58.js";
import type { FetchLike } from "../../apps/server/src/adapters/nansen/client.js";
import { addr, fakeFetch, sig } from "../helpers.js";

const START = Date.UTC(2026, 8, 26, 4, 42, 13); // the recorded Pyth account's publish time
const account = (JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pyth-sol-usd-account.json"), "utf8")) as { value: { data: [string, string] } }).value;
/** The recorded Pyth account, re-published at `publishMs` (same price), as the RPC would return it. */
const rpcAt = (publishMs: () => number): FetchLike => async () => {
  const bytes = Buffer.from(account.data[0], "base64");
  bytes.writeBigInt64LE(BigInt(Math.floor(publishMs() / 1000)), 93);
  const value = { ...account, data: [bytes.toString("base64"), "base64"] };
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }) };
};

function tradeLog(mint: string, user: string, lamports: bigint, tsSec: number): string {
  const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8);
  let o = 0;
  Buffer.from(TRADE_EVENT_DISCRIMINATOR).copy(b, o); o += 8;
  Buffer.from(base58Decode(mint)!).copy(b, o); o += 32;
  b.writeBigUInt64LE(lamports, o); o += 8;
  b.writeBigUInt64LE(1_000_000_000n, o); o += 8;
  b.writeUInt8(1, o); o += 1;
  Buffer.from(base58Decode(user)!).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(tsSec), o);
  return `Program data: ${b.toString("base64")}`;
}
const txLogs = (line: string) => [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Buy", line, `Program ${PUMP_PROGRAM_ID} success`];

const W = ["A", "B", "C", "D", "E"].map((w) => addr(`usage-${w}`));
const MINTS = ["X", "Y", "Z"].map((m) => addr(`usage-mint-${m}`));

const page = { page: 1, per_page: 100, is_last_page: true };
const fake = fakeFetch((path) => {
  switch (path) {
    case "/api/v1/tgm/token-information":
      return { status: 200, body: { data: { name: "T", symbol: "T", token_details: { total_supply: 1_000_000_000 } } } };
    case "/api/v1/tgm/holders":
      return { status: 200, body: { data: [], pagination: page }, headers: { "x-nansen-credits-used": "5" } };
    case "/api/v1/profiler/address/pnl-summary":
      return { status: 200, body: { pagination: page, top5_tokens: [], traded_token_count: 12, traded_times: 40, realized_pnl_usd: 250.5, realized_pnl_percent: 0.25, win_rate: 0.6 } };
    case "/api/v1/profiler/dex-trades":
    case "/api/v1/profiler/address/related-wallets":
      return { status: 200, body: { pagination: page, data: [] } };
    case "/api/v1/smart-money/dex-trades":
      return { status: 200, body: { data: [], pagination: page }, headers: { "x-nansen-credits-used": "5" } };
    default:
      return { status: 404, body: { code: "not_found" } };
  }
});
const pnlCalls = (wallet: string) => fake.log.filter((l) => l.path === "/api/v1/profiler/address/pnl-summary" && l.body.wallet_address === wallet).length;

describe("credit-aware Nansen usage (Pyth price, continuous Nansen)", () => {
  const clock = new VirtualClock(START + 1500);
  const config = loadConfig(
    {
      APP_MODE: "live", PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "5000", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k",
      NANSEN_BUDGET_CREDITS: "5000", SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", SMART_MONEY_ENABLED: "true",
      NANSEN_MAX_REQUESTS_PER_MINUTE: "1000", ENRICHMENT_AUTO_PACKS_PER_CYCLE: "0",
    },
    clock.now(),
  );
  const rt = Runtime.create(config, { clock, fetchImpl: fake.fn as never, rpcFetchImpl: rpcAt(() => clock.now() - 1000), startCollector: false });
  rt.start();
  rt.live!.pricePoller.stop();
  rt.live!.scheduler.stop();
  const app = buildServer(rt);
  afterAll(async () => {
    await app.close();
  });

  /** One pack per mint: buyers in order, with lamports per buyer; returns the pack id. */
  let slot = 1;
  const formPack = async (mint: string, buyers: [string, bigint][], atMs: number): Promise<string> => {
    // A fresh Pyth price published just before the buys, as in live operation.
    clock.set(atMs - 500);
    await rt.live!.pricePoller.pollQuote(config.price.quotes[0]!);
    const t0 = Math.floor(atMs / 1000);
    buyers.forEach(([w, lamports], i) => {
      clock.set(atMs + i * 1000 + 800);
      rt.handleTransaction({ signature: sig(`usage-${mint}-${i}`), slot: slot++, err: null, logs: txLogs(tradeLog(mint, w, lamports, t0 + i)), receivedAtMs: clock.now() });
    });
    clock.set(atMs + 10_000);
    rt.live!.pipeline.tick();
    return (rt.db.prepare("SELECT id FROM packs WHERE mint = ?").get(mint) as { id: string }).id;
  };
  const enrichAndWait = async (packId: string) => {
    rt.live!.scheduler.schedulePack(packId, "operator");
    await vi.waitFor(() => expect(rt.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get()).toEqual({ n: 0 }), { timeout: 10_000, interval: 50 });
  };

  it("profiles the largest buyer beyond the first three, and skips netflow without Smart Money buyers", async () => {
    await rt.live!.pricePoller.pollQuote(config.price.quotes[0]!);
    expect(rt.live!.session.current()!.started_by).toBe("continuous");
    // A, B, C start the pack ($24 each); D joins later with the largest buy ($60).
    const p1 = await formPack(MINTS[0]!, [[W[0]!, 200_000_000n], [W[1]!, 200_000_000n], [W[2]!, 200_000_000n], [W[3]!, 500_000_000n]], START + 2000);
    await enrichAndWait(p1);
    const detail = (await app.inject({ url: `/api/packs/${p1}` })).json().data;
    expect(detail.context.selectedProfileWallets).toEqual([W[0], W[1], W[2]]);
    expect(detail.context.extraProfileWallets).toEqual([{ wallet: W[3], reason: "largest_buyer", earlierPacks: 0 }]);
    expect(detail.context.wallets.map((w: { walletAddress: string }) => w.walletAddress)).toContain(W[3]);
    expect(rt.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('balance_followup', 'sm_netflow')").get()).toEqual({ n: 0 });
    expect(detail.smartMoney.netflow.state.availability).toBe("not_requested");
  });

  it("reuses a wallet profile from the last day instead of paying again", async () => {
    // A starts a second pack on another token; A's PnL comes from the stored snapshot.
    const before = pnlCalls(W[0]!);
    const p2 = await formPack(MINTS[1]!, [[W[0]!, 200_000_000n], [W[4]!, 200_000_000n], [W[1]!, 200_000_000n]], START + 60_000);
    await enrichAndWait(p2);
    expect(pnlCalls(W[0]!)).toBe(before);
    expect(pnlCalls(W[4]!)).toBe(1);
    const detail = (await app.inject({ url: `/api/packs/${p2}` })).json().data;
    const a = detail.context.wallets.find((w: { walletAddress: string }) => w.walletAddress === W[0]);
    expect(a.pnl.data.realizedPnlUsd).toBe("250.5");
  });

  it("counts packs per wallet and profiles repeat wallets that have no recent profile", async () => {
    await formPack(MINTS[2]!, [[W[0]!, 200_000_000n], [W[1]!, 200_000_000n], [W[3]!, 200_000_000n]], START + 120_000);
    const stats = rt.db.prepare("SELECT wallet, packs FROM wallet_pack_stats WHERE namespace = ? ORDER BY packs DESC, wallet").all(rt.primaryNamespace) as { wallet: string; packs: number }[];
    expect(stats.find((s) => s.wallet === W[0])!.packs).toBe(3);
    expect(stats.find((s) => s.wallet === W[1])!.packs).toBe(3);
    // A and B already have profiles from today, so nothing is queued for them.
    expect(rt.live!.scheduler.profileRepeatWallets()).toBe(0);
    // A day later the profiles are old enough to refresh (they must still be active).
    clock.advance(20 * 3_600_000);
    await formPack(addr("usage-mint-W"), [[W[0]!, 200_000_000n], [W[1]!, 200_000_000n], [W[2]!, 200_000_000n]], clock.now() + 1000);
    clock.advance(4 * 3_600_000 + 60_000);
    // A and B are in 4 packs now; C and D in 2, below the 3-pack minimum.
    expect(rt.live!.scheduler.profileRepeatWallets()).toBe(2);
    const queued = rt.db.prepare("SELECT type, subject FROM jobs WHERE requested_by = 'repeat_wallets' ORDER BY type, subject").all() as { type: string; subject: string }[];
    expect(queued.filter((j) => j.type === "wallet_pnl").map((j) => j.subject).sort()).toEqual([W[0], W[1]].sort());
    expect(queued.filter((j) => j.type === "related_wallets")).toHaveLength(2);
    await vi.waitFor(() => expect(rt.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get()).toEqual({ n: 0 }), { timeout: 10_000, interval: 50 });
  });

  it("serves Repeat wallets from stored data, most packs first", async () => {
    const r = await app.inject({ url: "/api/wallets/repeat?active=all&minPacks=3" });
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    // Ties on pack count: the wallet seen in a pack most recently first (B bought after A).
    expect(data.items.map((i: { wallet: string; packs: number }) => [i.wallet, i.packs])).toEqual([[W[1], 4], [W[0], 4]]);
    expect(data.items[0].pnl.data.winRate).toBe("0.6");
    expect(data.totalRepeatWallets).toBe(2);
    expect((await app.inject({ url: "/api/wallets/repeat?active=all&minPacks=2" })).json().data.items).toHaveLength(4);
    expect((await app.inject({ url: "/api/wallets/repeat?active=forever" })).statusCode).toBe(400);
  });

  it("only recent packs are automatic candidates, so the backlog never grows the cycle", () => {
    const old = rt.db.prepare("SELECT COUNT(*) AS n FROM pack_enrichment WHERE status = 'not_requested'").get() as { n: number };
    expect(old.n).toBeGreaterThan(0);
    const cfg = rt.config as { enrichment: { autoPacksPerCycle: number } };
    cfg.enrichment.autoPacksPerCycle = 5;
    clock.advance(31 * 60_000);
    rt.live!.scheduler.onPacksCreated();
    expect(rt.db.prepare("SELECT COUNT(*) AS n FROM pack_enrichment WHERE requested_by = 'auto'").get()).toEqual({ n: 0 });
  });

  it("a cycle schedules only the packs the pace covers, counting packs still waiting to run", async () => {
    const cfg = rt.config as { enrichment: { autoPacksPerCycle: number } };
    cfg.enrichment.autoPacksPerCycle = 0;
    for (const m of ["P1", "P2", "P3"]) await formPack(addr(`usage-mint-${m}`), [[W[0]!, 200_000_000n], [W[1]!, 200_000_000n], [W[2]!, 200_000_000n]], clock.now() + 60_000);
    clock.advance(301_000); // a new cycle
    const h = rt.live!.scheduler.automaticHeadroom()!;
    expect(h).toBeGreaterThan(30);
    expect(rt.live!.ledger.reserve({ attemptId: "burst-1", lane: "BASE_ENRICHMENT", amount: h - 30, endpoint: "test", parameterHash: "h", purpose: "test", subjectId: null, jobId: null, retryOfAttemptId: null }).ok).toBe(true);
    const autoPacks = () => (rt.db.prepare("SELECT COUNT(*) AS n FROM pack_enrichment WHERE requested_by = 'auto'").get() as { n: number }).n;

    cfg.enrichment.autoPacksPerCycle = 3;
    rt.live!.scheduler.onPacksCreated();
    expect(autoPacks()).toBe(1); // 30 credits of headroom cover one 23-credit pack, not three
    rt.live!.scheduler.onPacksCreated(); // same cycle, quota left, headroom unchanged
    expect(autoPacks()).toBe(1); // the scheduled pack has not spent yet, so it still holds its share
  });

  it("waiting for the daily pace is not reported as a pause; a short budget is", async () => {
    const reserved = rt.live!.ledger.reserve({
      attemptId: "pace-1", lane: "BASE_ENRICHMENT", amount: 2000, endpoint: "test", parameterHash: "h", purpose: "test", subjectId: null, jobId: null, retryOfAttemptId: null,
    });
    expect(reserved).toEqual({ ok: true });
    const t = rt.live!.ledger.totals();
    expect(t.dailyCap! - t.usedToday).toBeGreaterThanOrEqual(PACK_ENRICHMENT_CREDITS);
    expect(rt.live!.scheduler.automaticHeadroom()).toBeLessThan(PACK_ENRICHMENT_CREDITS); // ahead of the pace at ~05:15 UTC
    expect((await app.inject({ url: "/api/status" })).json().data.analysisPaused).toEqual({ paused: false, reason: null });

    rt.db.prepare("UPDATE api_campaigns SET configured_budget = ? WHERE id = ?").run(t.budget - t.remaining + 10, rt.live!.ledger.campaignId);
    const paused = (await app.inject({ url: "/api/status" })).json().data.analysisPaused;
    expect(paused.paused).toBe(true);
    expect(paused.reason).toMatch(/not enough credits left in the budget/);
  });
});
