import { describe, expect, it } from "vitest";
import type { PackMember } from "@packlens/contracts";
import { buySizeCV, computePatterns, largestBuyerShare } from "../../apps/server/src/patterns/indicators.js";
import { deriveAnalysisState, observedTopShare } from "../../apps/server/src/assessment/assessment.js";
import { orderCandidates } from "../../apps/server/src/enrichment/scheduler.js";
import { RetentionJob, retentionFloorKey } from "../../apps/server/src/operations/retention.js";
import { ensureNamespace } from "../../apps/server/src/replay/runner.js";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { Decimal } from "../../apps/server/src/lib/decimal.js";
import { addr, harness, T0, testDb, tradeEvent } from "../helpers.js";

const DAY = 86_400_000;

const m = (w: string, usd: string, first: number, kind: "initial" | "expanded" = "initial"): PackMember => ({
  packId: "p", walletAddress: addr(w), memberKind: kind, firstEntryTimeMs: T0 + first, initialFirstEntryTimeMs: kind === "initial" ? T0 + first : null, joinedAtEventTimeMs: T0, eligibleBuyUsd: usd, eventIds: [],
});

describe("patterns-v1", () => {
  it("CV uses the population standard deviation; null when n < 2 or mean is zero", () => {
    expect(buySizeCV([new Decimal(20), new Decimal(20)])).toBe("0");
    expect(buySizeCV([new Decimal(10), new Decimal(30)])).toBe("0.5");
    expect(buySizeCV([new Decimal(20)])).toBeNull();
    expect(buySizeCV([new Decimal(0), new Decimal(0)])).toBeNull();
  });
  it("largest buyer share is value over total pack value", () => {
    expect(largestBuyerShare([new Decimal(20), new Decimal(60)])).toBe("0.75");
    expect(largestBuyerShare([])).toBeNull();
  });
  it("entry spans, member count, coverage start, and no combined score", () => {
    const p = computePatterns({ mint: "M", triggerEventTimeMs: T0 + 20_000, members: [m("A", "20", 0), m("B", "40", 7000), m("C", "20", 20000), m("D", "20", 35000, "expanded")], earlierPacks: [], namespaceFirstObservedMs: T0 - 3_600_000 });
    expect(p).toMatchObject({ initialEntrySpanMs: 20000, allMemberEntrySpanMs: 35000, memberCount: 4, cooccurrencePairCount: 0, patternScore: null, formulaVersion: "patterns-v1" });
    expect(p.cooccurrenceCoverageStart).toBe(new Date(T0 - 3_600_000).toISOString());
  });
  it("co-occurrence counts distinct pairs in earlier other-token packs within 24 hours only", () => {
    const members = [m("A", "20", 0), m("B", "20", 1), m("C", "20", 2)];
    const p = computePatterns({
      mint: "M", triggerEventTimeMs: T0, members, namespaceFirstObservedMs: null,
      earlierPacks: [
        { packId: "1", mint: "N", triggerEventTimeMs: T0 - 1000, wallets: [addr("A"), addr("B"), addr("C")] }, // 3 pairs
        { packId: "2", mint: "O", triggerEventTimeMs: T0 - 2000, wallets: [addr("A"), addr("B")] }, // same pair, no new count
        { packId: "3", mint: "M", triggerEventTimeMs: T0 - 1000, wallets: [addr("A"), addr("B")] }, // same token: ignored
        { packId: "4", mint: "P", triggerEventTimeMs: T0 + 1000, wallets: [addr("A"), addr("C")] }, // future: ignored
        { packId: "5", mint: "Q", triggerEventTimeMs: T0 - 25 * 3_600_000, wallets: [addr("A"), addr("B")] }, // too old
      ],
    });
    expect(p.cooccurrencePairCount).toBe(3);
  });
});

describe("base assessment", () => {
  const j = (status: string) => ({ type: "x", status, status_reason: null, result_json: null });
  it("derives analysis states from base jobs only", () => {
    expect(deriveAnalysisState([])).toBe("not_requested");
    expect(deriveAnalysisState([j("queued")])).toBe("queued");
    expect(deriveAnalysisState([j("succeeded"), j("queued")])).toBe("running");
    expect(deriveAnalysisState([j("succeeded"), j("succeeded")])).toBe("complete");
    expect(deriveAnalysisState([j("succeeded"), j("failed")])).toBe("partial");
    expect(deriveAnalysisState([j("failed")])).toBe("error");
    expect(deriveAnalysisState([j("succeeded"), j("budget_paused")])).toBe("budget_paused");
    expect(deriveAnalysisState([j("cancelled")])).toBe("not_requested");
  });
  it("concentration needs ordering and a verified supply denominator", () => {
    expect(observedTopShare(["600", "200"], "1000", true)).toBe("0.8");
    expect(observedTopShare(["600"], null, true)).toBeNull();
    expect(observedTopShare(["600"], "1000", false)).toBeNull();
    expect(observedTopShare(["2000"], "1000", true)).toBeNull(); // incompatible units
  });
});

describe("candidate priority", () => {
  it("orders by wallets, then exact USD, then newest, then id; never by Smart Money", () => {
    const rows = [
      { id: "b", total_wallet_count: 4, eligible_buy_usd: "100.000000000000000001", trigger_event_time_ms: 1 },
      { id: "a", total_wallet_count: 4, eligible_buy_usd: "100", trigger_event_time_ms: 5 },
      { id: "c", total_wallet_count: 5, eligible_buy_usd: "20", trigger_event_time_ms: 1 },
      { id: "d", total_wallet_count: 4, eligible_buy_usd: "100", trigger_event_time_ms: 5 },
    ];
    expect(orderCandidates(rows).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("retention", () => {
  it("never deletes pack evidence or non-live data", () => {
    const h = harness("live:ret");
    h.feed([tradeEvent("live:ret", "e1", "A", 0, "20"), tradeEvent("live:ret", "e2", "B", 7000, "20"), tradeEvent("live:ret", "e3", "C", 20000, "20"), tradeEvent("live:ret", "s", "S", 21000, "20", { side: "sell" })]);
    h.flushTo(60_000);
    const job = new RetentionJob(h.db, new VirtualClock(T0 + 3 * 24 * 3_600_000));
    const r = job.runOnce();
    expect(r.events).toBe(1); // only the non-pack sell
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM trade_events").get()).toEqual({ n: 3 });
    expect(h.packs()).toHaveLength(1);
  });

  it("resumes each scan from a stored floor and deletes every row that shares the floor's event time", () => {
    const h = harness("live:floor");
    // A pack at T0, then 600 non-pack sells at one event time (more than two batches share it).
    h.feed([tradeEvent("live:floor", "e1", "A", 0, "20"), tradeEvent("live:floor", "e2", "B", 7000, "20"), tradeEvent("live:floor", "e3", "C", 20000, "20")]);
    h.feed(Array.from({ length: 600 }, (_, i) => tradeEvent("live:floor", `s${i}`, `S${i}`, 30_000, "20", { side: "sell" })));
    h.flushTo(90_000);
    const run = (atMs: number) => new RetentionJob(h.db, new VirtualClock(T0 + atMs)).runOnce();
    const floor = () => Number(h.db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(retentionFloorKey("live:floor")));

    expect(run(3_600_000).events).toBe(0); // nothing is 24 h old yet
    expect(run(DAY + 3_600_000).events).toBe(600);
    expect(h.db.prepare("SELECT COUNT(*) FROM trade_events").pluck().get()).toBe(3); // pack evidence stays
    expect(floor()).toBe(T0 + 30_000); // the newest deleted time (later than the cutoff minus the one-hour overlap)

    // Later trades age out on a later run; the kept evidence before the floor is not scanned again.
    h.feed([tradeEvent("live:floor", "late-sell", "L", 3 * 3_600_000, "20", { side: "sell" })]);
    h.flushTo(3 * 3_600_000 + 60_000);
    expect(run(DAY + 4 * 3_600_000).events).toBe(1);
    expect(floor()).toBe(T0 + 3 * 3_600_000);
  });

  it("deletes outbox rows older than 24 hours in batches through the created_at index", () => {
    const db = testDb();
    ensureNamespace(db, "live:ob", "live", "test", null, T0);
    const insert = db.prepare("INSERT INTO event_outbox (namespace, event_type, aggregate_id, aggregate_version, created_at_ms, payload_json) VALUES ('live:ob', 'pack.updated', 'p', 1, ?, '{}')");
    db.transaction(() => {
      for (let i = 0; i < 2500; i++) insert.run(T0 + i);
      insert.run(T0 + DAY);
    })();
    expect(new RetentionJob(db, new VirtualClock(T0 + DAY + 2500)).runOnce().outbox).toBe(2500);
    expect(db.prepare("SELECT created_at_ms FROM event_outbox").pluck().all()).toEqual([T0 + DAY]);
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT sequence FROM event_outbox WHERE created_at_ms < ? ORDER BY created_at_ms LIMIT 1000").all(0) as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("event_outbox_created");
  });
});

describe("automatic work keeps price polling funded for the session", async () => {
  const { EnrichmentScheduler, PACK_ENRICHMENT_CREDITS } = await import("../../apps/server/src/enrichment/scheduler.js");
  const { BudgetLedger } = await import("../../apps/server/src/scheduler/budget.js");
  const { SessionManager } = await import("../../apps/server/src/scheduler/session.js");
  const { JobQueue } = await import("../../apps/server/src/scheduler/queue.js");
  const { AssessmentService } = await import("../../apps/server/src/assessment/assessment.js");
  const { OutboxBus } = await import("../../apps/server/src/ingest/outbox.js");
  const { testConfig, testDb } = await import("../helpers.js");
  it("headroom = remaining - price reserve - polls left until session end", () => {
    const db = testDb();
    const clock = new VirtualClock(T0);
    const config = { ...testConfig(), nansen: { ...testConfig().nansen, sessionEndAtMs: T0 + 3_600_000 } };
    const ledger = new BudgetLedger(db, "c", clock, () => 2);
    ledger.ensureCampaign(200, null);
    const session = new SessionManager(db, clock, config, "c");
    session.start({ startedBy: "test" });
    const s = new EnrichmentScheduler(db, clock, config, "live:c", new JobQueue(db, clock), session, new AssessmentService(db, clock, new OutboxBus(), null), ledger);
    // 1 hour at 30 s polling = 120 polls; 200 - 2 - 120 = 78 credits of headroom.
    expect(s.automaticHeadroom()).toBe(78);
    expect(PACK_ENRICHMENT_CREDITS).toBe(23);
  });

  it("with a daily cap and Pyth prices, automatic spending is paced across the UTC day", () => {
    const db = testDb();
    const day = Math.floor(T0 / 86_400_000) * 86_400_000;
    const clock = new VirtualClock(day + 6 * 3_600_000); // 06:00 UTC: a quarter of the day
    const base = testConfig({ PRICE_PROVIDER: "pyth" });
    const config = { ...base, nansen: { ...base.nansen, continuous: true, dailyCreditCap: 1000 } };
    const ledger = new BudgetLedger(db, "c", clock, () => 0, 1000);
    ledger.ensureCampaign(100_000, null);
    const session = new SessionManager(db, clock, config, "c");
    const s = new EnrichmentScheduler(db, clock, config, "live:c", new JobQueue(db, clock), session, new AssessmentService(db, clock, new OutboxBus(), null), ledger);
    // 90% of 1,000 for automatic work, paced: (6 h + 1 h burst) / 24 h → 262 credits by 06:00.
    expect(s.automaticHeadroom()).toBe(262);
    const reserve = (id: string, amount: number) =>
      ledger.reserve({ attemptId: id, lane: "BASE_ENRICHMENT", amount, endpoint: "e", parameterHash: "h", purpose: "p", subjectId: null, jobId: null, retryOfAttemptId: null });
    expect(reserve("a", 250).ok).toBe(true);
    expect(s.automaticHeadroom()).toBe(12);
    // Operators are limited only by the cap itself.
    expect(reserve("manual", 500).ok).toBe(true);
    clock.advance(18 * 3_600_000 - 1); // 23:59:59.999: the full automatic share is available
    expect(s.automaticHeadroom()).toBe(900 - 750);
  });
});
