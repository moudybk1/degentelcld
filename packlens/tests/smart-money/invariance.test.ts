import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { WSOL_MINT } from "../../apps/server/src/config.js";
import { OutboxBus } from "../../apps/server/src/ingest/outbox.js";
import { SmartMoneyService } from "../../apps/server/src/smart-money/service.js";
import { AssessmentService } from "../../apps/server/src/assessment/assessment.js";
import { orderCandidates } from "../../apps/server/src/enrichment/scheduler.js";
import { semanticDigest } from "../../apps/server/src/replay/runner.js";
import type { SmTrade } from "../../apps/server/src/adapters/nansen/endpoints.js";
import { addr, harness, MINT, sig, T0, tradeEvent } from "../helpers.js";
import type { Db } from "../../apps/server/src/db/connection.js";

const NS = "fixture:inv";

/** V01 + V06 events and a second token pack, identical in every scenario. */
function buildCore() {
  const h = harness(NS);
  const other = addr("mint-other");
  h.feed([
    tradeEvent(NS, "e1", "A", 0, "20"),
    tradeEvent(NS, "e2", "B", 7000, "20"),
    tradeEvent(NS, "e3", "C", 20000, "20"),
    tradeEvent(NS, "e4", "A", 25000, "20"),
    tradeEvent(NS, "e5", "D", 40000, "20"),
    tradeEvent(NS, "o1", "X", 1000, "40", { tokenAddress: other }),
    tradeEvent(NS, "o2", "Y", 2000, "40", { tokenAddress: other }),
    tradeEvent(NS, "o3", "Z", 3000, "40", { tokenAddress: other }),
  ]);
  h.flushTo(60_000);
  return h;
}

function smTrade(wallet: string, hash: string, t: number, bought = MINT): SmTrade {
  return {
    chain: "solana", transactionHash: hash, blockTimeMs: t, traderAddress: addr(wallet), traderLabel: "Smart Trader", tokenBoughtAddress: bought, tokenSoldAddress: WSOL_MINT,
    tokenBoughtSymbol: "M", tokenSoldSymbol: "SOL", tokenBoughtAmount: "10", tokenSoldAmount: "0.1", tradeValueUsd: "25",
  };
}

function snapshot(db: Db, id: string, subject: string) {
  db.prepare(
    `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, fetched_at_ms, availability, coverage, schema_version, source)
     VALUES (?, ?, 'smart-money/dex-trades', 'token', ?, 'p', '{}', ?, 'available', 'window_scanned', 'v1', 'fixture')`,
  ).run(id, NS, subject, T0 + 120_000);
}

function coreView(db: Db) {
  const assessments = db.prepare("SELECT pack_id, analysis_state, review_flags_json FROM pack_assessments ORDER BY pack_id, version").all();
  const candidates = orderCandidates(
    db.prepare("SELECT id, total_wallet_count, eligible_buy_usd, trigger_event_time_ms FROM packs WHERE namespace = ?").all(NS) as never[],
  ).map((c: { id: string }) => c.id);
  const packs = db.prepare("SELECT id, state, core_version, evidence_version, suppress_until_ms, patterns_json FROM packs ORDER BY id").all();
  return { digest: semanticDigest(db, NS), assessments, candidates, packs };
}

describe("V10 / T29 / T30: Smart Money context never changes the core", () => {
  const baseline = coreView(buildCore().db);

  const scenarios: Record<string, (db: Db, sm: SmartMoneyService, clock: VirtualClock) => void> = {
    empty: () => undefined,
    "zero buyers, window scanned": (_db, sm) => sm.recompute(MINT, T0 + 120_000, { "5m": "window_scanned", "1h": "window_scanned", "24h": "window_scanned" }, []),
    "100 buyers including two members": (db, sm) => {
      snapshot(db, "s-large", MINT);
      const trades = Array.from({ length: 100 }, (_, i) => smTrade(`sm${i}`, sig(`sm${i}`), T0 + 30_000 + i));
      trades.push(smTrade("A", sig("e1"), T0), smTrade("D", sig("e5"), T0 + 40_000));
      sm.ingestTrades(trades, "s-large", "scope");
      sm.recompute(MINT, T0 + 120_000, { "5m": "window_scanned", "1h": "window_scanned", "24h": "partial" }, ["s-large"]);
    },
    "positive netflow": (db) => {
      db.prepare(
        `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, fetched_at_ms, availability, coverage, result_json, schema_version, source)
         VALUES ('nf+', ?, 'smart-money/netflow', 'token', ?, 'p', '{}', ?, 'available', 'unknown', '{"values":[{"window":"1h","netFlowUsd":"99999"}]}', 'v1', 'fixture')`,
      ).run(NS, MINT, T0);
    },
    "negative netflow and provider error": (db) => {
      db.prepare(
        `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, fetched_at_ms, availability, coverage, result_json, schema_version, source)
         VALUES ('nf-', ?, 'smart-money/netflow', 'token', ?, 'p', '{}', ?, 'available', 'unknown', '{"values":[{"window":"1h","netFlowUsd":"-99999"}]}', 'v1', 'fixture')`,
      ).run(NS, MINT, T0);
      db.prepare(
        `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, fetched_at_ms, availability, coverage, reason_code, schema_version, source)
         VALUES ('err', ?, 'smart-money/dex-trades', 'token', ?, 'p', '{}', ?, 'error', 'unknown', 'http_error', 'v1', 'fixture')`,
      ).run(NS, MINT, T0);
    },
  };

  for (const [name, apply] of Object.entries(scenarios)) {
    it(`core output, assessment, and candidate priority are identical: ${name}`, () => {
      const h = buildCore();
      const clock = new VirtualClock(T0 + 120_000);
      const sm = new SmartMoneyService(h.db, NS, clock, new OutboxBus(), null);
      apply(h.db, sm, clock);
      // Base assessment reruns after context changes and must not read Smart Money.
      const assessment = new AssessmentService(h.db, clock, new OutboxBus(), null);
      for (const p of h.packs()) assessment.refresh(p.id as string);
      const after = coreView(h.db);
      expect(after.digest).toBe(baseline.digest);
      expect(after.candidates).toEqual(baseline.candidates);
      expect(after.packs).toEqual(baseline.packs);
      expect(after.assessments).toEqual(baseline.assessments);
    });
  }

  it("confirmation changes only with matching transaction evidence", () => {
    const h = buildCore();
    const clock = new VirtualClock(T0 + 120_000);
    const sm = new SmartMoneyService(h.db, NS, clock, new OutboxBus(), null);
    snapshot(h.db, "s1", MINT);
    // A token-count change without matching hashes cannot fabricate confirmation.
    sm.ingestTrades([smTrade("A", sig("not-the-pack-tx"), T0 + 5000), smTrade("Q", sig("q"), T0 + 6000)], "s1", "scope");
    sm.recompute(MINT, T0 + 120_000, { "5m": "window_scanned", "1h": "window_scanned", "24h": "window_scanned" }, ["s1"]);
    const pack = h.packs().find((p) => p.mint === MINT)!;
    const ctx = sm.packContext(pack.id as string, 4, [addr("A"), addr("B"), addr("C"), addr("D")]);
    expect(ctx.confirmedMemberCount).toBe(0);
    expect(ctx.memberMatches.find((m) => m.walletAddress === addr("A"))!.matchState).toBe("wallet_seen");
    // Now the real pack transaction appears.
    sm.ingestTrades([smTrade("A", sig("e1"), T0)], "s1", "scope");
    sm.recompute(MINT, T0 + 120_000, { "5m": "window_scanned", "1h": "window_scanned", "24h": "window_scanned" }, ["s1"]);
    const ctx2 = sm.packContext(pack.id as string, 4, [addr("A"), addr("B"), addr("C"), addr("D")]);
    expect(ctx2.confirmedMemberCount).toBe(1);
    expect(ctx2.contextVersion).toBe(ctx.contextVersion + 1);
  });

  it("T24: ingesting the same trade from two scopes stores one observation with two sources", () => {
    const h = buildCore();
    const sm = new SmartMoneyService(h.db, NS, new VirtualClock(T0), new OutboxBus(), null);
    snapshot(h.db, "g", "global");
    snapshot(h.db, "t", MINT);
    const trade = smTrade("A", sig("dup"), T0 + 1000);
    sm.ingestTrades([trade], "g", "global-scope");
    sm.ingestTrades([trade], "t", "token-scope");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM smart_money_observations").get()).toEqual({ n: 1 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM smart_money_observation_sources").get()).toEqual({ n: 2 });
  });
});
