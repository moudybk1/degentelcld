/**
 * Enrichment scheduling (blueprint §12.2, §17.11). Candidates are selected by
 * (totalWalletCount DESC, eligibleBuyUsd DESC, triggerEventTime DESC, id ASC)
 * and never by Smart Money. At most 50 packs wait for base enrichment; the
 * number of packs analyzed automatically per cycle is an operator-visible
 * scope setting, and unscheduled packs stay `not_requested` with coverage shown.
 */
import type { Clock } from "../clock.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { parseDecimal } from "../lib/decimal.js";
import { log } from "../lib/log.js";
import type { AssessmentService } from "../assessment/assessment.js";
import type { BudgetLedger } from "../scheduler/budget.js";
import type { JobQueue } from "../scheduler/queue.js";
import type { SessionManager } from "../scheduler/session.js";

const BALANCE_FOLLOWUP_DELAY_MS = 5 * 60_000;
/** Expected credits for one pack's P0 job set (public pricing): 1+5+3+3+2+2 base, +5+5 Smart Money. */
export const PACK_ENRICHMENT_CREDITS = 26;
const GLOBAL_FEED_CREDITS = 5;
const PIN_SM_REFRESH_MS = 120_000;
const PIN_NETFLOW_REFRESH_MS = 5 * 60_000;

type Candidate = { id: string; total_wallet_count: number; eligible_buy_usd: string; trigger_event_time_ms: number };

/** Locked candidate ordering; exported for tests. */
export function orderCandidates<T extends Candidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.total_wallet_count !== b.total_wallet_count) return b.total_wallet_count - a.total_wallet_count;
    const c = parseDecimal(b.eligible_buy_usd).comparedTo(parseDecimal(a.eligible_buy_usd));
    if (c !== 0) return c;
    if (a.trigger_event_time_ms !== b.trigger_event_time_ms) return b.trigger_event_time_ms - a.trigger_event_time_ms;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export class EnrichmentScheduler {
  private timers: NodeJS.Timeout[] = [];
  private cycleStartMs = 0;
  private scheduledThisCycle = 0;
  private lastPinSm = new Map<string, number>();
  private lastPinNetflow = new Map<string, number>();
  private sessionWasActive = false;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    readonly namespace: string,
    private readonly queue: JobQueue,
    private readonly session: SessionManager,
    private readonly assessment: AssessmentService,
    private readonly ledger: BudgetLedger | null = null,
  ) {}

  /**
   * Operator-chosen reserve for automatic work: keep enough credits to fund
   * quote-price polling until the session ends, so automatic enrichment and
   * the Smart Money feed can never starve USD eligibility. Operator-triggered
   * enrichment is not limited by this reserve (only by the ledger).
   */
  automaticHeadroom(): number | null {
    if (!this.ledger) return null;
    const s = this.session.current();
    if (!s) return 0;
    const t = this.ledger.totals();
    const pollsLeft = Math.ceil(Math.max(0, s.ends_at_ms - this.clock.now()) / (this.config.price.refreshSeconds * 1000));
    const sessionPriceNeed = pollsLeft * this.config.price.quotes.length;
    return t.remaining - t.priceReserve - sessionPriceNeed;
  }

  private canAutoSpend(cost: number): boolean {
    const h = this.automaticHeadroom();
    return h === null || h >= cost;
  }

  start(): void {
    this.cycleStartMs = this.clock.now();
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(() => {
        try {
          fn();
        } catch (err) {
          log("error", "enrichment-scheduler", "Scheduler tick failed", { error: String(err) });
        }
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.config.enrichment.cycleSeconds * 1000, () => this.runCycle(true));
    every(this.config.smartMoney.pollSeconds * 1000, () => this.enqueueGlobalFeed());
    every(10_000, () => this.housekeeping());
    // First cycle and first feed poll shortly after startup.
    const first = setTimeout(() => {
      this.runCycle(false);
      this.enqueueGlobalFeed();
    }, 3000);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Called after packs commit. Uses remaining per-cycle quota; never waits on enrichment. */
  onPacksCreated(): void {
    this.runCycle(false);
  }

  private runCycle(newCycle: boolean): void {
    if (newCycle || this.clock.now() - this.cycleStartMs >= this.config.enrichment.cycleSeconds * 1000) {
      this.cycleStartMs = this.clock.now();
      this.scheduledThisCycle = 0;
    }
    if (!this.session.current()) return;
    const quota = this.config.enrichment.autoPacksPerCycle - this.scheduledThisCycle;
    if (quota <= 0) return;
    const waiting = (
      this.db
        .prepare("SELECT COUNT(DISTINCT pack_id) AS n FROM jobs WHERE namespace = ? AND lane = 'BASE_ENRICHMENT' AND status IN ('queued', 'running') AND pack_id IS NOT NULL")
        .get(this.namespace) as { n: number }
    ).n;
    const room = Math.min(quota, this.config.enrichment.maxQueuedPacks - waiting);
    if (room <= 0) return;
    if (!this.canAutoSpend(PACK_ENRICHMENT_CREDITS)) return; // keep price polling funded for the session
    const rows = this.db
      .prepare(
        `SELECT p.id, p.total_wallet_count, p.eligible_buy_usd, p.trigger_event_time_ms FROM pack_enrichment e JOIN packs p ON p.id = e.pack_id
         WHERE e.namespace = ? AND e.status = 'not_requested' AND p.invalidated = 0`,
      )
      .all(this.namespace) as Candidate[];
    for (const c of orderCandidates(rows).slice(0, room)) {
      if (!this.canAutoSpend(PACK_ENRICHMENT_CREDITS)) break;
      this.schedulePack(c.id, "auto");
      this.scheduledThisCycle++;
    }
  }

  /** Enqueue the P0 job set for one pack (also used by the operator enrich action). */
  schedulePack(packId: string, requestedBy: string): { jobIds: string[] } {
    const pack = this.db
      .prepare("SELECT p.id, p.namespace, p.mint, p.triggered_at_ms, e.profile_wallets_json, e.relationship_wallets_json FROM packs p JOIN pack_enrichment e ON e.pack_id = p.id WHERE p.id = ?")
      .get(packId) as { id: string; namespace: string; mint: string; triggered_at_ms: number; profile_wallets_json: string; relationship_wallets_json: string } | undefined;
    if (!pack) throw new Error("Pack not found");
    const profile = JSON.parse(pack.profile_wallets_json) as string[];
    const relationship = JSON.parse(pack.relationship_wallets_json) as string[];
    const now = this.clock.now();
    const campaignId = this.session.campaignId;
    const jobIds: string[] = [];
    const add = (lane: "BASE_ENRICHMENT" | "SMART_MONEY", type: Parameters<JobQueue["enqueue"]>[0]["type"], subject: string, payload: Record<string, unknown>, nextAttemptAtMs?: number) => {
      const r = this.queue.enqueue({
        namespace: pack.namespace,
        campaignId,
        lane,
        type,
        subject,
        packId,
        payload,
        dedupeKey: `${pack.namespace}|${packId}|${type}|${subject}`,
        nextAttemptAtMs,
        requestedBy,
      });
      jobIds.push(r.jobId);
    };
    this.db.transaction(() => {
      add("BASE_ENRICHMENT", "token_info", pack.mint, { mint: pack.mint });
      add("BASE_ENRICHMENT", "holders", pack.mint, { mint: pack.mint });
      for (const w of profile) {
        add("BASE_ENRICHMENT", "wallet_pnl", w, { wallet: w });
        add("BASE_ENRICHMENT", "wallet_dex", w, { wallet: w });
      }
      for (const w of relationship) add("BASE_ENRICHMENT", "related_wallets", w, { wallet: w });
      const followupAt = Math.max(now, pack.triggered_at_ms + BALANCE_FOLLOWUP_DELAY_MS);
      for (const w of relationship) add("BASE_ENRICHMENT", "balance_followup", w, { wallet: w, mint: pack.mint, scheduledAtMs: followupAt }, followupAt);
      if (this.config.smartMoney.enabled) {
        add("SMART_MONEY", "sm_token_lookup", pack.mint, { mint: pack.mint });
        add("SMART_MONEY", "sm_netflow", pack.mint, { mint: pack.mint });
      }
      this.db
        .prepare("UPDATE pack_enrichment SET status = 'scheduled', requested_by = ?, scheduled_at_ms = ? WHERE pack_id = ?")
        .run(requestedBy, now, packId);
    })();
    this.assessment.refresh(packId);
    return { jobIds };
  }

  enqueueGlobalFeed(): void {
    if (!this.config.smartMoney.enabled) return;
    if (this.session.blockReason("SMART_MONEY") !== null) return;
    if (!this.canAutoSpend(GLOBAL_FEED_CREDITS)) return;
    // Coalesced: an existing queued or running feed job absorbs this tick.
    this.queue.enqueue({
      namespace: this.namespace,
      campaignId: this.session.campaignId,
      lane: "SMART_MONEY",
      type: "sm_global_feed",
      subject: "global",
      packId: null,
      payload: {},
      dedupeKey: `${this.namespace}|sm_global_feed`,
      requestedBy: "scheduler",
    });
  }

  /** Operator demo pins are the only automatic token-refresh trigger after the initial lookup. */
  private refreshPins(): void {
    if (!this.config.smartMoney.enabled || this.session.blockReason("SMART_MONEY") !== null) return;
    const pins = this.db.prepare("SELECT mint FROM demo_pins WHERE namespace = ? AND enabled = 1").all(this.namespace) as { mint: string }[];
    const now = this.clock.now();
    for (const { mint } of pins) {
      if (now - (this.lastPinSm.get(mint) ?? 0) >= PIN_SM_REFRESH_MS) {
        this.lastPinSm.set(mint, now);
        this.queue.enqueue({
          namespace: this.namespace, campaignId: this.session.campaignId, lane: "SMART_MONEY", type: "sm_token_lookup", subject: mint, packId: null,
          payload: { mint }, dedupeKey: `${this.namespace}|pin|sm_token_lookup|${mint}`, requestedBy: "demo_pin",
        });
      }
      if (now - (this.lastPinNetflow.get(mint) ?? 0) >= PIN_NETFLOW_REFRESH_MS) {
        this.lastPinNetflow.set(mint, now);
        this.queue.enqueue({
          namespace: this.namespace, campaignId: this.session.campaignId, lane: "SMART_MONEY", type: "sm_netflow", subject: mint, packId: null,
          payload: { mint }, dedupeKey: `${this.namespace}|pin|sm_netflow|${mint}`, requestedBy: "demo_pin",
        });
      }
    }
  }

  private housekeeping(): void {
    const active = this.session.current() !== null;
    if (this.sessionWasActive && !active) {
      const n = this.queue.cancelQueued("session_ended", this.namespace);
      log("info", "enrichment-scheduler", "Session ended; queued jobs cancelled", { cancelled: n });
      const packs = this.db.prepare("SELECT DISTINCT pack_id FROM jobs WHERE namespace = ? AND status_reason = 'session_ended' AND pack_id IS NOT NULL").all(this.namespace) as { pack_id: string }[];
      for (const p of packs) this.assessment.refresh(p.pack_id);
    }
    this.sessionWasActive = active;
    if (active) this.refreshPins();
  }
}
