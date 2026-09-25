import { describe, expect, it } from "vitest";
import { OutboxBus } from "../../apps/server/src/ingest/outbox.js";
import { runDataset, semanticDigest } from "../../apps/server/src/replay/runner.js";
import { loadDataset, type Dataset } from "../../apps/server/src/replay/dataset.js";
import { loadConfig, ROOT_DIR, WSOL_MINT } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { addr, MINT, MINT2, sig, T0, testConfig, testDb } from "../helpers.js";

const config = testConfig();

function dataset(events: Dataset["events"], priceSnapshots: Dataset["priceSnapshots"] = [], mode: Dataset["mode"] = "recorded"): Dataset {
  return {
    datasetId: "test-dataset",
    label: "test",
    mode,
    origin: mode === "recorded" ? "recorded-live" : "synthetic",
    chain: "solana",
    source: "pumpfun",
    decoderVersion: "test",
    configVersion: config.detector.version,
    createdAt: "2026-09-20T00:00:00Z",
    description: "synthetic test",
    events,
    priceSnapshots,
    tokens: [],
  };
}

function ev(id: string, wallet: string, tSec: number, usd: string | null, mint = MINT, extra: Partial<Dataset["events"][number]> = {}): Dataset["events"][number] {
  return {
    signature: sig(id), ordinal: 0, slot: 1000 + tSec, blockTimeMs: T0 + tSec * 1000, receivedAtMs: T0 + tSec * 1000 + 800, wallet: addr(wallet), mint, side: "buy",
    tokenAmountRaw: "1", quoteAmountRaw: "100000000", quoteMint: WSOL_MINT, quoteDecimals: 9,
    pinned: { valuationStatus: usd === null ? "missing_price" : "valued", tradeValueUsd: usd, quoteUsdPrice: usd === null ? null : "200", quotePriceAtMs: usd === null ? null : T0 - 60_000, priceSnapshotId: null, priceCandleEndMs: null, priceSource: "recorded" },
    ...extra,
  };
}

const run = (db: ReturnType<typeof testDb>, ds: Dataset, namespace: string, mode: "recorded-arrival" | "historical-event-time" = "recorded-arrival") =>
  runDataset({ db, outbox: new OutboxBus(), config, dataset: ds, datasetHash: "h", namespace, namespaceMode: "replay", replayMode: mode, label: "t" });

describe("replay determinism", () => {
  const base = [ev("e1", "A", 0, "20"), ev("e2", "B", 7, "20"), ev("e3", "C", 20, "20"), ev("e4", "A", 25, "20"), ev("e5", "D", 40, "20")];

  it("identical input, clock, prices, and mode reproduce the same digest in separate namespaces", () => {
    const db = testDb();
    const a = run(db, dataset(base), "replay:a");
    const b = run(db, dataset(base), "replay:b");
    expect(a.packIds).toHaveLength(1);
    expect(a.digest).toBe(b.digest);
    expect(a.packIds[0]).not.toBe(b.packIds[0]);
  });

  it("T60: different inputs produce different digests", () => {
    const db = testDb();
    const a = run(db, dataset(base), "replay:a");
    const b = run(db, dataset(base.map((e, i) => (i === 4 ? ev("e5", "D", 40, "21") : e))), "replay:b");
    expect(a.digest).not.toBe(b.digest);
  });

  it("T16: recorded replay uses the pinned value, not a different later price", () => {
    const db = testDb();
    const laterPrice = [{ id: "p", quoteMint: WSOL_MINT, availableAtMs: T0 - 10_000, candles: [{ intervalStartMs: T0 - 60_000, close: "999" }] }];
    const r = run(db, dataset(base, laterPrice), "replay:pinned");
    const values = db.prepare("SELECT trade_value_usd FROM trade_events WHERE namespace = 'replay:pinned' ORDER BY event_time_ms").all() as { trade_value_usd: string }[];
    expect(values.every((v) => v.trade_value_usd === "20")).toBe(true);
    expect(r.packIds).toHaveLength(1);
  });

  it("recorded admission watermarks reproduce late events exactly", () => {
    const db = testDb();
    const events = [
      ev("e1", "A", 0, "20", MINT, { admissionWatermarkMs: T0 - 5000 }),
      ev("e2", "B", 7, "20", MINT, { admissionWatermarkMs: T0 + 5000 }),
      ev("late", "C", 8, "20", MINT, { admissionWatermarkMs: T0 + 9000, receivedAtMs: T0 + 11_500 }),
      ev("e3", "D", 20, "20", MINT, { admissionWatermarkMs: T0 + 18_000 }),
    ];
    const r = run(db, dataset(events), "replay:late");
    expect(r.late).toBe(1);
    expect(r.packIds).toHaveLength(1);
    const members = db.prepare("SELECT wallet FROM pack_members").all() as { wallet: string }[];
    expect(members.map((m) => m.wallet)).not.toContain(addr("C"));
  });

  it("historical-event-time evaluates by event time", () => {
    const db = testDb();
    const shuffled = [...base].reverse().map((e, i) => ({ ...e, receivedAtMs: T0 + 100_000 + i }));
    const r = run(db, dataset(shuffled), "replay:hist", "historical-event-time");
    const ref = run(db, dataset(base), "replay:ref", "historical-event-time");
    expect(r.digest).toBe(ref.digest);
  });

  it("T40: co-occurrence in replay never sees future packs", () => {
    const db = testDb();
    const events = [
      // Pack on MINT2 at 0-20 s with A, B, C.
      ev("x1", "A", 0, "20", MINT2), ev("x2", "B", 5, "20", MINT2), ev("x3", "C", 10, "20", MINT2),
      // Pack on MINT at 300 s with A, B, D: co-occurs with the earlier MINT2 pack (pair A-B).
      ev("y1", "A", 300, "20"), ev("y2", "B", 305, "20"), ev("y3", "D", 310, "20"),
    ];
    run(db, dataset(events), "replay:co");
    const packs = db.prepare("SELECT mint, patterns_json FROM packs WHERE namespace = 'replay:co' ORDER BY trigger_event_time_ms").all() as { mint: string; patterns_json: string }[];
    expect(JSON.parse(packs[0]!.patterns_json).cooccurrencePairCount).toBe(0); // earlier pack cannot see the later one
    expect(JSON.parse(packs[1]!.patterns_json).cooccurrencePairCount).toBe(1);
  });

  it("a run never mutates an existing namespace", () => {
    const db = testDb();
    run(db, dataset(base), "replay:once");
    expect(() => run(db, dataset(base), "replay:once")).toThrow(/already holds events/);
  });
});

describe("registered synthetic fixture", () => {
  it("loads with a verified hash and seeds deterministically", () => {
    const { dataset: ds, manifest } = loadDataset(ROOT_DIR, "synthetic-demo-v1");
    expect(manifest.eventCount).toBe(ds.events.length);
    const db = testDb();
    const a = runDataset({ db, outbox: new OutboxBus(), config, dataset: ds, datasetHash: manifest.sha256, namespace: "replay:fx1", namespaceMode: "replay", replayMode: "recorded-arrival", label: "fx" });
    const b = runDataset({ db, outbox: new OutboxBus(), config, dataset: ds, datasetHash: manifest.sha256, namespace: "replay:fx2", namespaceMode: "replay", replayMode: "recorded-arrival", label: "fx" });
    expect(a.digest).toBe(b.digest);
    expect(a.packIds).toHaveLength(5);
    expect(a.late).toBe(1);
    expect(semanticDigest(db, "replay:fx1")).toBe(a.digest);
  });

  it("rebuilds a fixture namespace seeded from an older dataset, and leaves other namespaces alone", () => {
    const db = testDb();
    const rt = Runtime.create(loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" }), { db, startCollector: false });
    const ns = rt.ensureFixture();
    const { dataset: ds, manifest } = loadDataset(ROOT_DIR, "synthetic-demo-v1");
    runDataset({ db, outbox: new OutboxBus(), config, dataset: ds, datasetHash: manifest.sha256, namespace: "replay:keep", namespaceMode: "replay", replayMode: "recorded-arrival", label: "keep" });
    const count = (n: string) => (db.prepare("SELECT COUNT(*) AS n FROM trade_events WHERE namespace = ?").get(n) as { n: number }).n;
    const packs = (n: string) => (db.prepare("SELECT COUNT(*) AS n FROM packs WHERE namespace = ?").get(n) as { n: number }).n;
    const before = count(ns);
    // Unchanged dataset: nothing is rebuilt.
    const firstPack = (db.prepare("SELECT id FROM packs WHERE namespace = ? ORDER BY id LIMIT 1").get(ns) as { id: string }).id;
    rt.ensureFixture();
    expect((db.prepare("SELECT id FROM packs WHERE namespace = ? ORDER BY id LIMIT 1").get(ns) as { id: string }).id).toBe(firstPack);
    // Simulate a namespace seeded from an older dataset version.
    db.prepare("UPDATE namespaces SET dataset_hash = 'old' WHERE id = ?").run(ns);
    db.prepare("DELETE FROM trade_events WHERE namespace = ? AND event_id NOT IN (SELECT event_id FROM pack_events WHERE namespace = ?) AND event_id NOT IN (SELECT trigger_event_id FROM packs WHERE namespace = ?)").run(ns, ns, ns);
    rt.ensureFixture();
    expect(count(ns)).toBe(before);
    expect(packs(ns)).toBe(5);
    expect((db.prepare("SELECT dataset_hash FROM namespaces WHERE id = ?").get(ns) as { dataset_hash: string }).dataset_hash).toBe(manifest.sha256);
    expect(count("replay:keep")).toBe(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects unregistered datasets and paths", () => {
    expect(() => loadDataset(ROOT_DIR, "does-not-exist")).toThrow(/not registered/);
  });
});

describe("dataset price policy", () => {
  it("fixture results do not change when the operator runs the 5m fallback live", () => {
    const { dataset: ds, manifest } = loadDataset(ROOT_DIR, "synthetic-demo-v1");
    const five = testConfig({ PRICE_TIMEFRAME: "5m" });
    const db = testDb();
    const a = runDataset({ db, outbox: new OutboxBus(), config, dataset: ds, datasetHash: manifest.sha256, namespace: "replay:p1", namespaceMode: "replay", replayMode: "recorded-arrival", label: "p" });
    const b = runDataset({ db, outbox: new OutboxBus(), config: five, dataset: ds, datasetHash: manifest.sha256, namespace: "replay:p5", namespaceMode: "replay", replayMode: "recorded-arrival", label: "p" });
    expect(b.digest).toBe(a.digest);
    expect(b.packIds).toHaveLength(5); // the outage still leaves Paper Kite unvalued
  });
});
