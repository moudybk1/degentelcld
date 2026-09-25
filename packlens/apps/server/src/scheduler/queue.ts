import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { newId } from "../lib/ids.js";
import type { Lane } from "./budget.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "budget_paused";

export type JobType =
  | "token_info"
  | "holders"
  | "wallet_pnl"
  | "wallet_dex"
  | "related_wallets"
  | "balance_followup"
  | "sm_token_lookup"
  | "sm_netflow"
  | "sm_global_feed";

export type JobRow = {
  id: string;
  namespace: string;
  campaign_id: string | null;
  lane: Lane;
  type: JobType;
  subject: string;
  pack_id: string | null;
  payload_json: string;
  status: JobStatus;
  status_reason: string | null;
  active_dedupe_key: string | null;
  attempts: number;
  lease_until_ms: number | null;
  next_attempt_at_ms: number;
  enqueued_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  requested_by: string;
  result_json: string | null;
};

export type EnqueueInput = {
  namespace: string;
  campaignId: string | null;
  lane: Lane;
  type: JobType;
  subject: string;
  packId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  nextAttemptAtMs?: number;
  requestedBy: string;
};

const LEASE_MS = 90_000;
const MAX_LEASE_RECOVERIES = 3;

/**
 * Database-backed job queue (blueprint §10.3, §12.2). Active dedupe keys are
 * unique while a job is queued or running and are released on terminal state.
 * Claims are atomic status changes with leases; expired leases return to the
 * queue a bounded number of times.
 */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  enqueue(input: EnqueueInput): { jobId: string; deduped: boolean } {
    const existing = this.db.prepare("SELECT id FROM jobs WHERE active_dedupe_key = ?").get(input.dedupeKey) as { id: string } | undefined;
    if (existing) return { jobId: existing.id, deduped: true };
    const id = newId("job");
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, namespace, campaign_id, lane, type, subject, pack_id, payload_json, status, active_dedupe_key, attempts, next_attempt_at_ms, enqueued_at_ms, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
      )
      .run(id, input.namespace, input.campaignId, input.lane, input.type, input.subject, input.packId, JSON.stringify(input.payload), input.dedupeKey,
        input.nextAttemptAtMs ?? now, now, input.requestedBy);
    return { jobId: id, deduped: false };
  }

  /** Atomically claim the next due job: BASE_ENRICHMENT before SMART_MONEY, then FIFO. */
  claimNext(): JobRow | null {
    const now = this.clock.now();
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until_ms = ?, started_at_ms = ?
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'queued' AND next_attempt_at_ms <= ?
           ORDER BY CASE lane WHEN 'PRICE' THEN 0 WHEN 'BASE_ENRICHMENT' THEN 1 ELSE 2 END, next_attempt_at_ms, enqueued_at_ms, id LIMIT 1
         ) AND status = 'queued'
         RETURNING *`,
      )
      .get(now + LEASE_MS, now, now) as JobRow | undefined;
    return row ?? null;
  }

  finish(jobId: string, status: Exclude<JobStatus, "queued" | "running">, reason: string | null, result: unknown = null): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, status_reason = ?, finished_at_ms = ?, lease_until_ms = NULL, active_dedupe_key = NULL, result_json = ? WHERE id = ?")
      .run(status, reason, this.clock.now(), result === null ? null : JSON.stringify(result), jobId);
  }

  /** Return a running job to the queue (for example, the session ended mid-flight is NOT this case). */
  retryLater(jobId: string, delayMs: number, reason: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'queued', status_reason = ?, lease_until_ms = NULL, next_attempt_at_ms = ? WHERE id = ?")
      .run(reason, this.clock.now() + delayMs, jobId);
  }

  /** Recover jobs whose lease expired (crash or restart); idempotent handlers make this safe. */
  recoverExpiredLeases(): number {
    const now = this.clock.now();
    const failed = this.db
      .prepare("UPDATE jobs SET status = 'failed', status_reason = 'lease_expired', active_dedupe_key = NULL, finished_at_ms = ? WHERE status = 'running' AND lease_until_ms < ? AND attempts >= ?")
      .run(now, now, MAX_LEASE_RECOVERIES);
    const requeued = this.db
      .prepare("UPDATE jobs SET status = 'queued', status_reason = 'lease_recovered', lease_until_ms = NULL WHERE status = 'running' AND lease_until_ms < ?")
      .run(now);
    return failed.changes + requeued.changes;
  }

  /** On startup nothing is in flight: running jobs from a previous process are recoverable now. */
  recoverAllRunning(): number {
    const now = this.clock.now();
    return this.db.prepare("UPDATE jobs SET lease_until_ms = ? WHERE status = 'running'").run(now - 1).changes + this.recoverExpiredLeases();
  }

  /** Session end: queued work is cancelled rather than silently starting a new session. */
  cancelQueued(reason: string, namespace: string): number {
    return this.db
      .prepare("UPDATE jobs SET status = 'cancelled', status_reason = ?, active_dedupe_key = NULL, finished_at_ms = ? WHERE status = 'queued' AND namespace = ?")
      .run(reason, this.clock.now(), namespace).changes;
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  jobsForPack(packId: string): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE pack_id = ? ORDER BY enqueued_at_ms").all(packId) as JobRow[];
  }
}
