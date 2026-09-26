import type { Clock } from "../clock.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { newId } from "../lib/ids.js";
import type { SessionGuard } from "../adapters/nansen/client.js";
import type { Lane } from "./budget.js";

export type SessionRow = {
  id: string;
  campaign_id: string;
  started_at_ms: number;
  ends_at_ms: number;
  smart_money_ends_at_ms: number;
  ended_at_ms: number | null;
  ended_reason: string | null;
  started_by: string;
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * Time-bounded Nansen sessions (blueprint §14.2, §17.2). NANSEN_SESSION_END_AT
 * bounds every poller; the Smart Money session cannot end later. Session end
 * stops dispatch without resetting the campaign ledger.
 *
 * Continuous mode (Pyth price, no NANSEN_SESSION_END_AT, NANSEN_DAILY_CREDIT_CAP
 * above 0): each session covers the rest of the current UTC day and the next
 * one starts on first use, so paid work stays bounded by the daily cap and the
 * campaign budget. Without a session end or a cap, Nansen is off entirely.
 */
export class SessionManager implements SessionGuard {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    readonly campaignId: string,
  ) {}

  current(): SessionRow | null {
    const now = this.clock.now();
    const row = this.db
      .prepare("SELECT * FROM nansen_sessions WHERE campaign_id = ? AND ended_at_ms IS NULL ORDER BY started_at_ms DESC LIMIT 1")
      .get(this.campaignId) as SessionRow | undefined;
    if (row && now < row.ends_at_ms) return row;
    if (row) this.db.prepare("UPDATE nansen_sessions SET ended_at_ms = ?, ended_reason = 'expired' WHERE id = ?").run(row.ends_at_ms, row.id);
    return this.config.nansen.continuous ? this.start({ startedBy: "continuous" }) : null;
  }

  maxEndMs(): number | null {
    if (this.config.nansen.continuous) return Math.floor(this.clock.now() / DAY_MS) * DAY_MS + DAY_MS;
    return this.config.nansen.sessionEndAtMs;
  }

  /** Start (or replace) the active session, bounded by the configured end. */
  start(opts: { endsAtMs?: number; smartMoneyEndsAtMs?: number; startedBy: string }): SessionRow {
    const now = this.clock.now();
    const maxEnd = this.maxEndMs();
    if (maxEnd === null) throw new Error("Nansen is off: set NANSEN_DAILY_CREDIT_CAP (continuous) or NANSEN_SESSION_END_AT to allow sessions");
    if (maxEnd <= now) throw new Error("NANSEN_SESSION_END_AT is not in the future; no session can start");
    const endsAt = Math.min(opts.endsAtMs ?? maxEnd, maxEnd);
    const smMax = Math.min(this.config.smartMoney.sessionEndAtMs ?? endsAt, endsAt);
    const smEnds = Math.min(opts.smartMoneyEndsAtMs ?? smMax, smMax);
    if (endsAt <= now) throw new Error("Session end must be in the future");
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE nansen_sessions SET ended_at_ms = ?, ended_reason = 'replaced' WHERE campaign_id = ? AND ended_at_ms IS NULL").run(now, this.campaignId);
      const id = newId("ses");
      this.db
        .prepare("INSERT INTO nansen_sessions (id, campaign_id, started_at_ms, ends_at_ms, smart_money_ends_at_ms, started_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, this.campaignId, now, endsAt, smEnds, opts.startedBy);
      return id;
    });
    const id = tx();
    return this.db.prepare("SELECT * FROM nansen_sessions WHERE id = ?").get(id) as SessionRow;
  }

  end(reason: string): void {
    this.db.prepare("UPDATE nansen_sessions SET ended_at_ms = ?, ended_reason = ? WHERE campaign_id = ? AND ended_at_ms IS NULL").run(this.clock.now(), reason, this.campaignId);
  }

  blockReason(lane: Lane): "session_ended" | "no_session" | "smart_money_disabled" | null {
    const s = this.current();
    if (!s) return "no_session";
    if (lane === "SMART_MONEY") {
      if (!this.config.smartMoney.enabled) return "smart_money_disabled";
      if (this.clock.now() >= s.smart_money_ends_at_ms) return "session_ended";
    }
    return null;
  }

  sessionEndMs(lane: Lane): number | null {
    const s = this.current();
    if (!s) return null;
    return lane === "SMART_MONEY" ? s.smart_money_ends_at_ms : s.ends_at_ms;
  }
}
