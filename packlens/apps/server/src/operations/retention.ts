import { performance } from "node:perf_hooks";
import type { Clock } from "../clock.js";
import { getMeta, setMeta, type Db } from "../db/connection.js";
import { log } from "../lib/log.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Rows per delete. Measured on an hour of live data: ~40 ms per batch; larger batches held the event loop for seconds. */
const BATCH = 250;
/** Outbox rows are small and found through their created_at_ms index. */
const OUTBOX_BATCH = 1000;
/** Longest pause between batches. */
const MAX_PAUSE_MS = 2000;
/**
 * Each run resumes its trade scan this far before the previous run's cutoff, so
 * a row admitted late or applied late near the boundary is still looked at once more.
 */
const FLOOR_OVERLAP_MS = HOUR;

type RetentionResult = { outbox: number; events: number; prices: number; idempotency: number };

/** Meta key holding the event time from which a namespace's next trade scan starts. */
export const retentionFloorKey = (namespace: string) => `retention_floor:${namespace}`;

/**
 * Retention (blueprint §10.4): hourly batched cleanup. Pack evidence,
 * referenced snapshots, pending events, fixture and replay datasets, and the
 * usage ledger are never deleted here. Non-pack live events: 24 hours.
 * Outbox: 24 hours (older Last-Event-ID requests resync).
 *
 * Kept rows (pack evidence) stay in the trade time index forever, so a scan from
 * the oldest row would walk all of them again for every batch (measured on the
 * live VPS 2026-09-27: ~16,000 kept rows per hour of trades, 27 s per hour of
 * data with a cold cache). Each namespace's scan therefore resumes from a floor
 * stored in `meta`; everything before it has been looked at already.
 *
 * SQLite calls are synchronous, so the scheduled run yields to the event loop
 * between batches, for as long as the batch held it, so ingestion and page
 * reads get at least half of the loop while an hour of trades is deleted.
 */
export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runYielding(), HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Run every batch back to back. */
  runOnce(): RetentionResult {
    const steps = this.steps();
    for (;;) {
      const s = steps.next();
      if (s.done) return s.value;
    }
  }

  /** Run batch by batch, letting queued requests and stream messages through in between. */
  async runYielding(): Promise<RetentionResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const steps = this.steps();
      for (;;) {
        const started = performance.now();
        const s = steps.next();
        if (s.done) return s.value;
        const held = performance.now() - started;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(MAX_PAUSE_MS, held)));
        // Shutting down: the database may close while this run waits.
        if (this.stopped) return null;
      }
    } finally {
      this.running = false;
    }
  }

  /** One batch per step; the return value is the run's totals. */
  private *steps(): Generator<void, RetentionResult, void> {
    const now = this.clock.now();
    let outbox = 0;
    let events = 0;
    try {
      const deleteOutbox = this.db.prepare(
        `DELETE FROM event_outbox WHERE sequence IN (SELECT sequence FROM event_outbox WHERE created_at_ms < ? ORDER BY created_at_ms LIMIT ${OUTBOX_BATCH})`,
      );
      for (;;) {
        const n = deleteOutbox.run(now - DAY).changes;
        outbox += n;
        if (n < OUTBOX_BATCH) break;
        yield;
      }
      yield;
      // One namespace at a time so the (namespace, event_time_ms) index bounds each batch.
      const liveNamespaces = (this.db.prepare("SELECT id FROM namespaces WHERE id LIKE 'live:%'").all() as { id: string }[]).map((r) => r.id);
      const deleteEvents = this.db.prepare(
        `DELETE FROM trade_events WHERE rowid IN (
           SELECT te.rowid FROM trade_events te
           WHERE te.namespace = ? AND te.event_time_ms >= ? AND te.event_time_ms < ? AND NOT (te.admission = 'admitted' AND te.detector_applied = 0)
             AND NOT EXISTS (SELECT 1 FROM pack_events pe WHERE pe.namespace = te.namespace AND pe.event_id = te.event_id)
             AND NOT EXISTS (SELECT 1 FROM packs p WHERE p.namespace = te.namespace AND p.trigger_event_id = te.event_id)
           ORDER BY te.event_time_ms
           LIMIT ${BATCH})
         RETURNING event_time_ms`,
      );
      const deletePrices = this.db.prepare(
        `DELETE FROM price_snapshots WHERE namespace = ? AND available_at_ms < ?
           AND NOT EXISTS (SELECT 1 FROM trade_events te WHERE te.namespace = price_snapshots.namespace AND te.price_snapshot_id = price_snapshots.id)`,
      );
      let prices = 0;
      const cutoff = now - DAY;
      for (const ns of liveNamespaces) {
        let floor = Number(getMeta(this.db, retentionFloorKey(ns)) ?? 0);
        for (;;) {
          const deleted = deleteEvents.all(ns, floor, cutoff) as { event_time_ms: number }[];
          events += deleted.length;
          if (deleted.length < BATCH) break;
          // Rows before the newest deleted time are kept rows; rows at that time may remain, so the next batch starts there.
          floor = deleted.reduce((m, r) => Math.max(m, r.event_time_ms), floor);
          yield;
        }
        setMeta(this.db, retentionFloorKey(ns), String(Math.max(floor, cutoff - FLOOR_OVERLAP_MS)));
        prices += deletePrices.run(ns, now - 7 * DAY).changes;
        yield;
      }
      const idempotency = this.db.prepare("DELETE FROM idempotency_keys WHERE created_at_ms < ?").run(now - DAY).changes;
      if (outbox + events + prices > 0) log("info", "retention", "Retention cleanup", { outbox, events, prices, idempotency });
      return { outbox, events, prices, idempotency };
    } catch (err) {
      log("error", "retention", "Retention cleanup failed", { error: String(err) });
      return { outbox, events, prices: 0, idempotency: 0 };
    }
  }
}
