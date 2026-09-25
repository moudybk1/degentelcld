import { EventEmitter } from "node:events";
import type { SseEventType } from "@packlens/contracts";
import type { Db } from "../db/connection.js";

/**
 * Transactional outbox (blueprint §10.3). Rows are written inside the same DB
 * transaction as the change they describe; subscribers are notified only after
 * the commit succeeds, and read committed rows by sequence.
 */
export class OutboxBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  notifyCommitted(namespace: string): void {
    this.emitter.emit("committed", namespace);
  }
  onCommitted(listener: (namespace: string) => void): () => void {
    this.emitter.on("committed", listener);
    return () => this.emitter.off("committed", listener);
  }
}

export function writeOutbox(
  db: Db,
  namespace: string,
  type: SseEventType,
  aggregateId: string,
  aggregateVersion: number,
  payload: Record<string, unknown>,
  nowMs: number,
): void {
  db.prepare(
    "INSERT INTO event_outbox (namespace, event_type, aggregate_id, aggregate_version, created_at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(namespace, type, aggregateId, aggregateVersion, nowMs, JSON.stringify(payload));
}

export type OutboxRow = {
  sequence: number;
  namespace: string;
  event_type: SseEventType;
  aggregate_id: string;
  aggregate_version: number;
  created_at_ms: number;
  payload_json: string;
};

export function readOutboxAfter(db: Db, namespace: string, afterSequence: number, limit = 500): OutboxRow[] {
  return db
    .prepare("SELECT * FROM event_outbox WHERE namespace = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
    .all(namespace, afterSequence, limit) as OutboxRow[];
}

export function oldestOutboxSequence(db: Db, namespace: string): number | null {
  const row = db.prepare("SELECT MIN(sequence) AS s FROM event_outbox WHERE namespace = ?").get(namespace) as { s: number | null };
  return row.s;
}

export function latestOutboxSequence(db: Db): number {
  const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM event_outbox").get() as { s: number };
  return row.s;
}
