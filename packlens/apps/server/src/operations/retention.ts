import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { log } from "../lib/log.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Retention (blueprint §10.4): hourly batched cleanup. Pack evidence,
 * referenced snapshots, pending events, fixture and replay datasets, and the
 * usage ledger are never deleted here. Non-pack live events: 24 hours.
 * Outbox: 24 hours (older Last-Event-ID requests resync).
 */
export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.runOnce(), HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  runOnce(): { outbox: number; events: number; prices: number; idempotency: number } {
    const now = this.clock.now();
    let events = 0;
    try {
      const outbox = this.db.prepare("DELETE FROM event_outbox WHERE created_at_ms < ?").run(now - DAY).changes;
      for (;;) {
        const n = this.db
          .prepare(
            `DELETE FROM trade_events WHERE rowid IN (
               SELECT te.rowid FROM trade_events te
               WHERE te.namespace LIKE 'live:%' AND te.event_time_ms < ? AND NOT (te.admission = 'admitted' AND te.detector_applied = 0)
                 AND NOT EXISTS (SELECT 1 FROM pack_events pe WHERE pe.namespace = te.namespace AND pe.event_id = te.event_id)
                 AND NOT EXISTS (SELECT 1 FROM packs p WHERE p.namespace = te.namespace AND p.trigger_event_id = te.event_id)
               LIMIT 5000)`,
          )
          .run(now - DAY).changes;
        events += n;
        if (n < 5000) break;
      }
      const prices = this.db
        .prepare(
          `DELETE FROM price_snapshots WHERE namespace LIKE 'live:%' AND available_at_ms < ?
             AND NOT EXISTS (SELECT 1 FROM trade_events te WHERE te.namespace = price_snapshots.namespace AND te.price_snapshot_id = price_snapshots.id)`,
        )
        .run(now - 7 * DAY).changes;
      const idempotency = this.db.prepare("DELETE FROM idempotency_keys WHERE created_at_ms < ?").run(now - DAY).changes;
      if (outbox + events + prices > 0) log("info", "retention", "Retention cleanup", { outbox, events, prices, idempotency });
      return { outbox, events, prices, idempotency };
    } catch (err) {
      log("error", "retention", "Retention cleanup failed", { error: String(err) });
      return { outbox: 0, events, prices: 0, idempotency: 0 };
    }
  }
}
