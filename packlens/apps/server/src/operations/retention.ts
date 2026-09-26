import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { log } from "../lib/log.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Rows per delete. Measured on an hour of live data: ~40 ms per batch; larger batches held the event loop for seconds. */
const BATCH = 250;

type RetentionResult = { outbox: number; events: number; prices: number; idempotency: number };

/**
 * Retention (blueprint §10.4): hourly batched cleanup. Pack evidence,
 * referenced snapshots, pending events, fixture and replay datasets, and the
 * usage ledger are never deleted here. Non-pack live events: 24 hours.
 * Outbox: 24 hours (older Last-Event-ID requests resync).
 *
 * SQLite calls are synchronous, so the scheduled run yields to the event loop
 * between batches; an hour of pump.fun trades is far too much to delete in one go.
 */
export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runYielding(), HOUR);
    this.timer.unref?.();
  }

  stop(): void {
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
        const s = steps.next();
        if (s.done) return s.value;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.running = false;
    }
  }

  /** One batch per step; the return value is the run's totals. */
  private *steps(): Generator<void, RetentionResult, void> {
    const now = this.clock.now();
    let events = 0;
    try {
      const outbox = this.db.prepare("DELETE FROM event_outbox WHERE created_at_ms < ?").run(now - DAY).changes;
      yield;
      // One namespace at a time so the (namespace, event_time_ms) index bounds each batch.
      const liveNamespaces = (this.db.prepare("SELECT id FROM namespaces WHERE id LIKE 'live:%'").all() as { id: string }[]).map((r) => r.id);
      const deleteEvents = this.db.prepare(
        `DELETE FROM trade_events WHERE rowid IN (
           SELECT te.rowid FROM trade_events te
           WHERE te.namespace = ? AND te.event_time_ms < ? AND NOT (te.admission = 'admitted' AND te.detector_applied = 0)
             AND NOT EXISTS (SELECT 1 FROM pack_events pe WHERE pe.namespace = te.namespace AND pe.event_id = te.event_id)
             AND NOT EXISTS (SELECT 1 FROM packs p WHERE p.namespace = te.namespace AND p.trigger_event_id = te.event_id)
           LIMIT ${BATCH})`,
      );
      const deletePrices = this.db.prepare(
        `DELETE FROM price_snapshots WHERE namespace = ? AND available_at_ms < ?
           AND NOT EXISTS (SELECT 1 FROM trade_events te WHERE te.namespace = price_snapshots.namespace AND te.price_snapshot_id = price_snapshots.id)`,
      );
      let prices = 0;
      for (const ns of liveNamespaces) {
        for (;;) {
          const n = deleteEvents.run(ns, now - DAY).changes;
          events += n;
          if (n < BATCH) break;
          yield;
        }
        prices += deletePrices.run(ns, now - 7 * DAY).changes;
        yield;
      }
      const idempotency = this.db.prepare("DELETE FROM idempotency_keys WHERE created_at_ms < ?").run(now - DAY).changes;
      if (outbox + events + prices > 0) log("info", "retention", "Retention cleanup", { outbox, events, prices, idempotency });
      return { outbox, events, prices, idempotency };
    } catch (err) {
      log("error", "retention", "Retention cleanup failed", { error: String(err) });
      return { outbox: 0, events, prices: 0, idempotency: 0 };
    }
  }
}
