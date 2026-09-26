import type { TradeEvent } from "@packlens/contracts";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { compareOrder } from "../detector/core.js";
import { canonicalJson } from "../lib/json.js";
import { sha256Hex } from "../lib/ids.js";
import type { DetectorEngine } from "./engine.js";

export type IngestOutcome = "admitted" | "late" | "backfill" | "duplicate" | "conflict";

export type IngestCounters = {
  received: number;
  admitted: number;
  late: number;
  backfill: number;
  duplicates: number;
  conflicts: number;
  eligible: number;
  unvalued: number;
  ticks: number;
  tickFailures: number;
};

/** Hash of on-chain content only; arrival time and valuation do not change identity. */
export function eventContentHash(e: TradeEvent): string {
  return sha256Hex(
    canonicalJson({
      chain: e.chain,
      signature: e.signature,
      eventOrdinal: e.eventOrdinal,
      slot: e.slot,
      blockTimeMs: e.blockTimeMs,
      walletAddress: e.walletAddress,
      tokenAddress: e.tokenAddress,
      side: e.side,
      tokenAmountRaw: e.tokenAmountRaw,
      quoteAmountRaw: e.quoteAmountRaw,
      quoteAssetAddress: e.quoteAssetAddress,
      decoderVersion: e.decoderVersion,
    }),
  );
}

/**
 * Ordering buffer and watermark for one namespace (blueprint §5.4).
 * W = max(previousW, floor(now) - tolerance). An event normalized with
 * E <= W is late and excluded from live detection. Each tick drains admitted
 * events with E <= newW in (E, slot, signature, ordinal) order, then timers.
 */
export class IngestPipeline {
  private watermarkMs: number | null;
  private pending: TradeEvent[] = [];
  private firstObservedMs: number | null;
  readonly counters: IngestCounters = { received: 0, admitted: 0, late: 0, backfill: 0, duplicates: 0, conflicts: 0, eligible: 0, unvalued: 0, ticks: 0, tickFailures: 0 };
  private readonly insertStmt;
  private readonly existingStmt;

  constructor(
    private readonly db: Db,
    readonly namespace: string,
    private readonly clock: Clock,
    private readonly engine: DetectorEngine,
    private readonly toleranceMs: number,
  ) {
    const ns = db.prepare("SELECT watermark_ms, first_observed_event_ms FROM namespaces WHERE id = ?").get(namespace) as
      | { watermark_ms: number | null; first_observed_event_ms: number | null }
      | undefined;
    if (!ns) throw new Error(`Unknown namespace ${namespace}`);
    this.watermarkMs = ns.watermark_ms;
    this.firstObservedMs = ns.first_observed_event_ms;
    this.insertStmt = db.prepare(
      `INSERT INTO trade_events (namespace, event_id, chain, mint, wallet, signature, event_ordinal, slot, event_time_ms, received_at_ms, normalized_at_ms,
         side, source_mode, valuation_status, trade_value_usd, price_snapshot_id, admission, admission_watermark_ms, detector_applied, eligibility, eligibility_reason,
         payload_json, payload_hash)
       VALUES (?, ?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, event_id) DO NOTHING`,
    );
    this.existingStmt = db.prepare("SELECT payload_hash FROM trade_events WHERE namespace = ? AND event_id = ?");
    this.restorePending();
  }

  /** Restore admitted-but-unapplied events with their original admission (§17.13). */
  private restorePending(): void {
    const rows = this.db
      .prepare("SELECT payload_json FROM trade_events WHERE namespace = ? AND admission = 'admitted' AND detector_applied = 0")
      .all(this.namespace) as { payload_json: string }[];
    this.pending = rows.map((r) => JSON.parse(r.payload_json) as TradeEvent);
  }

  get watermark(): number | null {
    return this.watermarkMs;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  ingest(event: TradeEvent): IngestOutcome {
    if (event.namespace !== this.namespace) throw new Error("Event namespace does not match pipeline");
    this.counters.received++;
    const hash = eventContentHash(event);
    let admission: "admitted" | "late" | "backfill";
    if (event.sourceMode === "backfill") admission = "backfill";
    else if (this.watermarkMs !== null && event.blockTimeMs <= this.watermarkMs) admission = "late";
    else admission = "admitted";

    const eligibility = admission === "admitted" ? "pending" : admission === "late" ? "late" : "ineligible";
    const stored: TradeEvent = { ...event, coreEligibility: eligibility === "ineligible" ? "ineligible" : eligibility };
    const info = this.insertStmt.run(
      this.namespace, event.eventId, event.tokenAddress, event.walletAddress, event.signature, event.eventOrdinal, event.slot, event.blockTimeMs,
      event.receivedAtMs, event.normalizedAtMs, event.side, event.sourceMode, event.valuationStatus, event.tradeValueUsd, event.priceSnapshotId,
      admission, this.watermarkMs, admission === "admitted" ? 0 : 1, eligibility, admission === "admitted" ? null : admission,
      JSON.stringify(stored), hash,
    );
    if (info.changes === 0) {
      const existing = this.existingStmt.get(this.namespace, event.eventId) as { payload_hash: string } | undefined;
      if (existing && existing.payload_hash !== hash) {
        this.db
          .prepare("INSERT INTO audit_conflicts (namespace, event_id, existing_hash, incoming_hash, detected_at_ms) VALUES (?, ?, ?, ?, ?)")
          .run(this.namespace, event.eventId, existing.payload_hash, hash, this.clock.now());
        this.counters.conflicts++;
        return "conflict";
      }
      this.counters.duplicates++;
      return "duplicate";
    }
    if (event.valuationStatus !== "valued") this.counters.unvalued++;
    if (this.firstObservedMs === null || event.blockTimeMs < this.firstObservedMs) {
      this.firstObservedMs = event.blockTimeMs;
      this.db.prepare("UPDATE namespaces SET first_observed_event_ms = ? WHERE id = ?").run(event.blockTimeMs, this.namespace);
    }
    if (admission === "late") {
      this.counters.late++;
      return "late";
    }
    if (admission === "backfill") {
      this.counters.backfill++;
      return "backfill";
    }
    this.counters.admitted++;
    this.pending.push(stored);
    return "admitted";
  }

  /**
   * Earliest clock time at which tick() drains an event or closes an expansion
   * window, or null when nothing waits. Earlier ticks only advance the watermark.
   */
  nextWorkAtMs(): number | null {
    let w = this.engine.nextTimerWatermarkMs();
    for (const e of this.pending) if (w === null || e.blockTimeMs < w) w = e.blockTimeMs;
    if (w === null) return null;
    return this.watermarkMs !== null && this.watermarkMs >= w ? this.clock.now() : w + this.toleranceMs;
  }

  /** Advance the watermark from the clock and process due events and timers. */
  tick(): { drained: number; createdPackIds: string[] } {
    const floorNow = Math.floor(this.clock.now());
    return this.advanceTo(floorNow - this.toleranceMs);
  }

  /** Advance to an explicit watermark (replay, tests). Never moves backwards. */
  advanceTo(targetMs: number): { drained: number; createdPackIds: string[] } {
    const newW = this.watermarkMs === null ? targetMs : Math.max(this.watermarkMs, targetMs);
    const due = this.pending.filter((e) => e.blockTimeMs <= newW);
    due.sort((a, b) =>
      compareOrder(
        { timeMs: a.blockTimeMs, slot: a.slot, signature: a.signature, ordinal: a.eventOrdinal },
        { timeMs: b.blockTimeMs, slot: b.slot, signature: b.signature, ordinal: b.eventOrdinal },
      ),
    );
    this.counters.ticks++;
    let result;
    try {
      result = this.engine.applyTick(due, newW);
    } catch (err) {
      this.counters.tickFailures++;
      this.engine.resetCache();
      throw err;
    }
    const drained = new Set(due.map((e) => e.eventId));
    this.pending = this.pending.filter((e) => !drained.has(e.eventId));
    this.watermarkMs = newW;
    this.counters.eligible += result.eligible;
    return { drained: due.length, createdPackIds: result.createdPackIds };
  }
}
