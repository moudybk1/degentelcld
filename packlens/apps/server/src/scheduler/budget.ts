import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";

export type Lane = "PRICE" | "BASE_ENRICHMENT" | "SMART_MONEY";

export type BudgetTotals = {
  budget: number;
  settled: number;
  reserved: number;
  unresolved: number;
  /** budget - settled - unresolved - reserved (accounting remaining). */
  remaining: number;
  priceReserve: number;
  /** Credits allowed per UTC day, or null when only the campaign budget applies. */
  dailyCap: number | null;
  /** Credits settled, reserved, or unresolved since 00:00 UTC today. */
  usedToday: number;
};

export type ReserveRequest = {
  attemptId: string;
  lane: Lane;
  amount: number;
  endpoint: string;
  parameterHash: string;
  purpose: string;
  subjectId: string | null;
  jobId: string | null;
  retryOfAttemptId: string | null;
};

export type ReserveResult = { ok: true } | { ok: false; reason: "insufficient_credits" | "daily_cap" | "no_campaign"; available: number };

const DAY_MS = 24 * 60 * 60_000;

/**
 * Campaign credit ledger (blueprint §12.2, §12.3). Before each send:
 * available = budget - settled - unresolved - active reservations. Non-price
 * lanes additionally keep priceReserve untouched. The ledger survives restart
 * and never caps the total number of calls; only credits and sessions do.
 */
export class BudgetLedger {
  constructor(
    private readonly db: Db,
    readonly campaignId: string,
    private readonly clock: Clock,
    private readonly priceReserve: () => number,
    private readonly dailyCap: number | null = null,
  ) {}

  ensureCampaign(configuredBudget: number, endsAtMs: number | null): void {
    const existing = this.db.prepare("SELECT configured_budget FROM api_campaigns WHERE id = ?").get(this.campaignId) as { configured_budget: number } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO api_campaigns (id, configured_budget, started_at_ms, ends_at_ms) VALUES (?, ?, ?, ?)")
        .run(this.campaignId, configuredBudget, this.clock.now(), endsAtMs);
    } else if (existing.configured_budget !== configuredBudget) {
      // Operator changed the configured budget; the ledger itself is never reset.
      this.db.prepare("UPDATE api_campaigns SET configured_budget = ?, ends_at_ms = ? WHERE id = ?").run(configuredBudget, endsAtMs, this.campaignId);
    }
  }

  totals(): BudgetTotals {
    const c = this.db.prepare("SELECT configured_budget FROM api_campaigns WHERE id = ?").get(this.campaignId) as { configured_budget: number } | undefined;
    const budget = c?.configured_budget ?? 0;
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_amount END), 0) AS settled,
           COALESCE(SUM(CASE WHEN status = 'reserved' THEN amount END), 0) AS reserved,
           COALESCE(SUM(CASE WHEN status = 'unresolved' THEN amount END), 0) AS unresolved
         FROM budget_reservations WHERE campaign_id = ?`,
      )
      .get(this.campaignId) as { settled: number; reserved: number; unresolved: number };
    return {
      budget,
      settled: r.settled,
      reserved: r.reserved,
      unresolved: r.unresolved,
      remaining: budget - r.settled - r.reserved - r.unresolved,
      priceReserve: this.priceReserve(),
      dailyCap: this.dailyCap,
      usedToday: this.usedToday(),
    };
  }

  /** Spending since 00:00 UTC: settled at actual cost, open and unresolved reservations at their reserved amount. */
  usedToday(): number {
    const dayStart = Math.floor(this.clock.now() / DAY_MS) * DAY_MS;
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_amount WHEN status IN ('reserved', 'unresolved') THEN amount ELSE 0 END), 0) AS used
         FROM budget_reservations WHERE campaign_id = ? AND created_at_ms >= ?`,
      )
      .get(this.campaignId, dayStart) as { used: number };
    return r.used;
  }

  /** Atomically reserve credits and open the ledger row for this attempt. */
  reserve(req: ReserveRequest): ReserveResult {
    const tx = this.db.transaction((): ReserveResult => {
      const campaign = this.db.prepare("SELECT id FROM api_campaigns WHERE id = ?").get(this.campaignId);
      if (!campaign) return { ok: false, reason: "no_campaign", available: 0 };
      const t = this.totals();
      const available = req.lane === "PRICE" ? t.remaining : t.remaining - t.priceReserve;
      if (req.amount > available) return { ok: false, reason: "insufficient_credits", available: Math.max(0, available) };
      if (t.dailyCap !== null && t.usedToday + req.amount > t.dailyCap) return { ok: false, reason: "daily_cap", available: Math.max(0, t.dailyCap - t.usedToday) };
      const now = this.clock.now();
      this.db
        .prepare(
          `INSERT INTO api_usage (attempt_id, campaign_id, job_id, lane, endpoint, parameter_hash, purpose, subject_id, retry_of_attempt_id, started_at_ms,
             http_outcome, normalization_status, expected_credits, reservation_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, 'reserved')`,
        )
        .run(req.attemptId, this.campaignId, req.jobId, req.lane, req.endpoint, req.parameterHash, req.purpose, req.subjectId, req.retryOfAttemptId, now, req.amount);
      this.db
        .prepare("INSERT INTO budget_reservations (attempt_id, campaign_id, lane, amount, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'reserved', ?, ?)")
        .run(req.attemptId, this.campaignId, req.lane, req.amount, now, now);
      return { ok: true };
    });
    return tx.immediate();
  }

  /** Settlement replaces the reservation with the actual cost; it is not a second debit. */
  settle(attemptId: string, actualCredits: number): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE budget_reservations SET status = 'settled', settled_amount = ?, updated_at_ms = ? WHERE attempt_id = ? AND status IN ('reserved', 'unresolved')")
        .run(actualCredits, now, attemptId);
      this.db.prepare("UPDATE api_usage SET reservation_status = 'settled' WHERE attempt_id = ?").run(attemptId);
    })();
  }

  /** Unknown outcome (for example, timeout after send): keep a conservative reservation. */
  markUnresolved(attemptId: string, conservativeAmount?: number): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      if (conservativeAmount !== undefined) {
        this.db
          .prepare("UPDATE budget_reservations SET status = 'unresolved', amount = MAX(amount, ?), updated_at_ms = ? WHERE attempt_id = ? AND status = 'reserved'")
          .run(conservativeAmount, now, attemptId);
      } else {
        this.db.prepare("UPDATE budget_reservations SET status = 'unresolved', updated_at_ms = ? WHERE attempt_id = ? AND status = 'reserved'").run(now, attemptId);
      }
      this.db.prepare("UPDATE api_usage SET reservation_status = 'unresolved' WHERE attempt_id = ?").run(attemptId);
    })();
  }

  /** Release a reservation for a request that was provably never sent. */
  release(attemptId: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE budget_reservations SET status = 'released', settled_amount = 0, updated_at_ms = ? WHERE attempt_id = ? AND status = 'reserved'").run(now, attemptId);
      this.db.prepare("UPDATE api_usage SET reservation_status = 'released' WHERE attempt_id = ?").run(attemptId);
    })();
  }
}
