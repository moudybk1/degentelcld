import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { BASELINE_DETECTOR_CONFIG } from "../../apps/server/src/config.js";
import { DetectorEngine } from "../../apps/server/src/ingest/engine.js";
import { IngestPipeline } from "../../apps/server/src/ingest/pipeline.js";
import { OutboxBus, readOutboxAfter } from "../../apps/server/src/ingest/outbox.js";
import { ensureNamespace, semanticDigest } from "../../apps/server/src/replay/runner.js";
import { harness, members, T0, testDb, tradeEvent } from "../helpers.js";

const NS = "fixture:test";

describe("ordering buffer and watermark (§5.4)", () => {
  it("T13: out-of-order arrivals inside tolerance produce the same deterministic result", () => {
    const a = harness("fixture:a");
    const b = harness("fixture:b");
    const evs = (ns: string) => [tradeEvent(ns, "e1", "A", 0, "20"), tradeEvent(ns, "e2", "B", 7000, "20"), tradeEvent(ns, "e3", "C", 20000, "20")];
    a.feed(evs("fixture:a"));
    b.feed([...evs("fixture:b")].reverse());
    a.flushTo(60_000);
    b.flushTo(60_000);
    expect(a.packs()).toHaveLength(1);
    expect(semanticDigest(a.db, "fixture:a")).toBe(semanticDigest(b.db, "fixture:b"));
  });

  it("T14: an event normalized with E <= W is late and never creates a live alert", () => {
    const h = harness(NS);
    h.flushTo(10_000); // W = T0 + 10s
    expect(h.pipeline.ingest(tradeEvent(NS, "late", "A", 5000, "50"))).toBe("late");
    h.feed([tradeEvent(NS, "e2", "B", 11_000, "50"), tradeEvent(NS, "e3", "C", 12_000, "50")]);
    h.flushTo(60_000);
    expect(h.packs()).toHaveLength(0);
    const row = h.db.prepare("SELECT eligibility, detector_applied FROM trade_events WHERE admission = 'late'").get() as { eligibility: string; detector_applied: number };
    expect(row).toEqual({ eligibility: "late", detector_applied: 1 });
  });

  it("backfill cannot create packs", () => {
    const h = harness(NS);
    h.feed(["A", "B", "C"].map((w, i) => tradeEvent(NS, `bf${i}`, w, i * 1000, "50", { sourceMode: "backfill" })));
    h.flushTo(60_000);
    expect(h.packs()).toHaveLength(0);
  });

  it("T47: a buffered event exactly at expansionEnd is processed before the freeze timer", () => {
    const h = harness(NS);
    h.feed([
      tradeEvent(NS, "e1", "A", 0, "20"),
      tradeEvent(NS, "e2", "B", 7000, "20"),
      tradeEvent(NS, "e3", "C", 20000, "20"),
      tradeEvent(NS, "e4", "A", 25000, "20"),
      tradeEvent(NS, "e5", "D", 40000, "20"),
    ]);
    h.flushTo(40_000); // W == expansionEnd: event drained, no freeze
    let p = h.packs()[0]!;
    expect(p.state).toBe("collecting");
    expect(p.total_wallet_count).toBe(4);
    h.flushTo(40_001); // W > expansionEnd: freeze
    p = h.packs()[0]!;
    expect(p.state).toBe("frozen");
    expect(p.core_version).toBe(4); // create 1, two expansions, freeze
    expect(p.evidence_version).toBe(3);
  });

  it("T12 / V05: a duplicate delivery after trigger changes neither value nor cooldown", () => {
    const h = harness(NS);
    const e3 = tradeEvent(NS, "e3", "C", 20000, "20");
    h.feed([tradeEvent(NS, "e1", "A", 0, "20"), tradeEvent(NS, "e2", "B", 7000, "20"), e3]);
    h.flushTo(21_000);
    expect(h.pipeline.ingest({ ...e3, receivedAtMs: e3.receivedAtMs + 5000 })).toBe("duplicate");
    h.flushTo(60_000);
    const p = h.packs()[0]!;
    expect(p.eligible_buy_usd).toBe("60");
    expect(p.suppress_until_ms).toBe(T0 + 140_000);
  });

  it("same ID with different content is an audit conflict, never an overwrite", () => {
    const h = harness(NS);
    const e = tradeEvent(NS, "x", "A", 0, "20");
    h.pipeline.ingest(e);
    expect(h.pipeline.ingest({ ...e, quoteAmountRaw: "999" })).toBe("conflict");
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM audit_conflicts").get() as { n: number };
    expect(n.n).toBe(1);
    const stored = h.db.prepare("SELECT payload_json FROM trade_events").get() as { payload_json: string };
    expect(JSON.parse(stored.payload_json).quoteAmountRaw).toBe("100000000");
  });
});

describe("persistence and recovery", () => {
  it("T35 / T49: restart restores pending events with their original admission and the cooldown", () => {
    const db = testDb();
    const h = harness(NS, db);
    h.feed([tradeEvent(NS, "e1", "A", 0, "20"), tradeEvent(NS, "e2", "B", 7000, "20"), tradeEvent(NS, "e3", "C", 20000, "20")]);
    h.flushTo(21_000);
    // Admit more events, then "crash" before they are processed.
    h.feed([tradeEvent(NS, "f", "F", 150_000, "20"), tradeEvent(NS, "g", "G", 155_000, "20"), tradeEvent(NS, "h", "H", 160_000, "20")]);
    expect(h.pipeline.pendingCount).toBe(3);

    // New process: fresh engine/pipeline on the same database, much later wall clock.
    const clock = new VirtualClock(T0 + 3_600_000);
    const engine = new DetectorEngine(db, NS, BASELINE_DETECTOR_CONFIG, clock, new OutboxBus());
    const pipeline = new IngestPipeline(db, NS, clock, engine, 2000);
    expect(pipeline.pendingCount).toBe(3); // not re-judged as late
    pipeline.tick();
    const packs = db.prepare("SELECT * FROM packs WHERE namespace = ? ORDER BY trigger_event_time_ms").all(NS) as Record<string, unknown>[];
    expect(packs).toHaveLength(2); // cooldown restored: H at exactly 140+... triggers only because F/G/H window qualifies after 140
    expect(packs[0]!.state).toBe("frozen");
    expect(packs[1]!.first_event_time_ms).toBe(T0 + 150_000);
  });

  it("restart during cooldown suppresses a qualifying window before expiry", () => {
    const db = testDb();
    const h = harness(NS, db);
    h.feed([tradeEvent(NS, "e1", "A", 0, "20"), tradeEvent(NS, "e2", "B", 7000, "20"), tradeEvent(NS, "e3", "C", 20000, "20")]);
    h.flushTo(50_000);
    const clock = new VirtualClock(T0 + 60_000);
    const engine = new DetectorEngine(db, NS, BASELINE_DETECTOR_CONFIG, clock, new OutboxBus());
    const pipeline = new IngestPipeline(db, NS, clock, engine, 2000);
    for (const [id, w, t] of [["x", "X", 100_000], ["y", "Y", 105_000], ["z", "Z", 110_000]] as const) pipeline.ingest(tradeEvent(NS, id, w, t, "20"));
    pipeline.advanceTo(T0 + 200_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM packs").get()).toEqual({ n: 1 });
  });

  it("T37: a failed commit publishes nothing and keeps prior state", () => {
    const db = testDb();
    const h = harness(NS, db);
    let notified = 0;
    h.outbox.onCommitted(() => notified++);
    h.feed([tradeEvent(NS, "e1", "A", 0, "20"), tradeEvent(NS, "e2", "B", 7000, "20"), tradeEvent(NS, "e3", "C", 20000, "20")]);
    db.exec("CREATE TRIGGER fail_pack BEFORE INSERT ON packs BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    expect(() => h.flushTo(21_000)).toThrow(/simulated failure/);
    expect(notified).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_events WHERE detector_applied = 1").get()).toEqual({ n: 0 });
    // After the failure clears, the same events process exactly once.
    db.exec("DROP TRIGGER fail_pack");
    h.flushTo(21_000);
    expect(h.packs()).toHaveLength(1);
    expect(members(db, h.packs()[0]!.id as string)).toHaveLength(3);
  });

  it("T50: outbox rows are written with the change and replay by sequence", () => {
    const h = harness(NS);
    h.feed([tradeEvent(NS, "e1", "A", 0, "20"), tradeEvent(NS, "e2", "B", 7000, "20"), tradeEvent(NS, "e3", "C", 20000, "20")]);
    h.flushTo(60_000);
    const rows = readOutboxAfter(h.db, NS, 0);
    expect(rows.map((r) => r.event_type)).toEqual(["pack.created", "pack.updated"]);
    expect(rows[1]!.aggregate_version).toBe(2); // freeze increments coreVersion only
    expect(readOutboxAfter(h.db, NS, rows[0]!.sequence).map((r) => r.event_type)).toEqual(["pack.updated"]);
  });
});

describe("namespace isolation", () => {
  it("T39: identical input in two namespaces never cross-dedupes or mutates the other", () => {
    const db = testDb();
    const live = harness("live:test", db);
    const replay = harness("replay:test", db);
    const mk = (ns: string) => [tradeEvent(ns, "e1", "A", 0, "20"), tradeEvent(ns, "e2", "B", 7000, "20"), tradeEvent(ns, "e3", "C", 20000, "20")];
    live.feed(mk("live:test"));
    live.flushTo(60_000);
    replay.feed(mk("replay:test"));
    replay.flushTo(60_000);
    expect(live.packs()).toHaveLength(1);
    expect(replay.packs()).toHaveLength(1);
    expect(live.packs()[0]!.id).not.toBe(replay.packs()[0]!.id);
    expect(semanticDigest(db, "live:test")).toBe(semanticDigest(db, "replay:test"));
  });

  it("T52: cross-namespace evidence references are rejected by the schema", () => {
    const db = testDb();
    ensureNamespace(db, "live:x", "live", "x", null, T0);
    const live = harness("live:y", db);
    live.feed([
      tradeEvent("live:y", "e1", "A", 0, "20"),
      tradeEvent("live:y", "e2", "B", 7000, "20"),
      tradeEvent("live:y", "e3", "C", 20000, "20"),
      tradeEvent("live:y", "s1", "S", 21000, "20", { side: "sell" }),
    ]);
    live.flushTo(60_000);
    const pack = live.packs()[0]!;
    const ev = db.prepare("SELECT event_id FROM trade_events WHERE namespace = 'live:y' AND side = 'sell'").get() as { event_id: string };
    expect(() =>
      db.prepare("INSERT INTO pack_events (pack_id, namespace, event_id, evidence_role, accepted_at_event_time_ms, evidence_version) VALUES (?, 'live:x', ?, 'initial', 0, 1)").run(pack.id, ev.event_id),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO namespaces (id, mode, created_at_ms) VALUES ('replay:bad', 'live', 0)").run()).toThrow(/CHECK/);
  });
});
