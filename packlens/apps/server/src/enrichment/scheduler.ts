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

/**
 * Upper bound of credits for one pack's job set: token information 1, holders 5, PnL and trades for
 * the first three initial members 3+3, relationships for the first two 2, and up to two extra
 * profiles (PnL + relationships) 4, plus a Smart Money token lookup 5. Netflow (5) follows only when
 * Smart Money buyers are observed. Cached wallet data costs nothing.
 */
export const PACK_ENRICHMENT_CREDITS = 23;
/** Automatic work may use this share of the daily cap, paced across the UTC day; the rest is kept for operators. */
const AUTO_DAILY_SHARE = 0.9;
const DAY_MS = 24 * 60 * 60_000;
/** Only recent packs are automatic candidates; older unanalyzed packs stay available to operators. */
const CANDIDATE_WINDOW_MS = 30 * 60_000;
/** Repeat wallets profiled automatically per cycle (PnL + relationships, 2 credits each unless cached). */
const REPEAT_WALLETS_PER_CYCLE = 3;
const REPEAT_WALLET_MIN_PACKS = 3;
const REPEAT_WALLET_CREDITS = 2;
const REPEAT_WALLET_INTERVAL_MS = 5 * 60_000;
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
    return this.headrooms()?.paced ?? null;
  }

  /** True when only the daily pace holds automatic work back; the budget itself still covers `cost`. */
  isPacing(cost: number): boolean {
    const h = this.headrooms();
    return h !== null && h.paced < cost && h.budget >= cost;
  }

  /** Automatic headroom before (`budget`) and after (`paced`) daily pacing; null without a ledger. */
  private headrooms(): { budget: number; paced: number } | null {
    if (!this.ledger) return null;
    const s = this.session.current();
    if (!s) return { budget: 0, paced: 0 };
    const t = this.ledger.totals();
    // Pyth prices are read from the chain and cost no credits.
    const pollsLeft = this.config.price.provider === "nansen" ? Math.ceil(Math.max(0, s.ends_at_ms - this.clock.now()) / (this.config.price.refreshSeconds * 1000)) : 0;
    const sessionPriceNeed = pollsLeft * this.config.price.quotes.length;
    const budget = t.remaining - t.priceReserve - sessionPriceNeed;
    if (t.dailyCap === null) return { budget, paced: budget };
    // Pace automatic spending across the UTC day (plus one hour of burst) so the cap is not
    // used up in the first hours; operators keep the rest of the day's allowance.
    const elapsed = (this.clock.now() % DAY_MS) / DAY_MS;
    const paced = Math.floor(t.dailyCap * AUTO_DAILY_SHARE * Math.min(1, elapsed + 1 / 24));
    return { budget, paced: Math.min(budget, paced - t.usedToday) };
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
    // Its own rhythm, so a short pack cycle does not spend the pace in 2-credit steps.
    every(REPEAT_WALLET_INTERVAL_MS, () => this.profileRepeatWallets());
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
    // Waiting packs reserve their credits only as their jobs run, so count them at full cost:
    // a cycle schedules no more packs than the headroom (and the daily pace) covers.
    const headroom = this.automaticHeadroom();
    const affordable = headroom === null ? Infinity : Math.floor(headroom / PACK_ENRICHMENT_CREDITS) - waiting;
    const room = Math.min(quota, this.config.enrichment.maxQueuedPacks - waiting, affordable);
    if (room <= 0) return; // keep price polling funded for the session
    // Recent packs only, pre-sorted in SQL: at 24/7 volume the unanalyzed backlog grows by
    // tens of thousands of packs a day. The locked ordering is applied exactly to the top rows.
    const rows = this.db
      .prepare(
        `SELECT p.id, p.total_wallet_count, p.eligible_buy_usd, p.trigger_event_time_ms FROM packs p JOIN pack_enrichment e ON e.pack_id = p.id
         WHERE p.namespace = ? AND p.trigger_event_time_ms >= ? AND e.status = 'not_requested' AND p.invalidated = 0
         ORDER BY p.total_wallet_count DESC, CAST(p.eligible_buy_usd AS REAL) DESC LIMIT ?`,
      )
      .all(this.namespace, this.clock.now() - CANDIDATE_WINDOW_MS, room + 20) as Candidate[];
    for (const c of orderCandidates(rows).slice(0, room)) {
      this.schedulePack(c.id, "auto");
      this.scheduledThisCycle++;
    }
  }

  /**
   * Profile the wallets that keep appearing in packs (at least three, active in the last
   * day) that have no Nansen profile from the last 24 hours. Context only.
   */
  profileRepeatWallets(): number {
    if (!this.session.current()) return 0;
    const now = this.clock.now();
    const rows = this.db
      .prepare(
        `SELECT s.wallet FROM wallet_pack_stats s
         WHERE s.namespace = ? AND s.packs >= ? AND s.last_seen_ms >= ?
           AND NOT EXISTS (SELECT 1 FROM enrichment_snapshots x WHERE x.namespace = s.namespace AND x.endpoint = 'profiler/address/pnl-summary'
                           AND x.subject_id = s.wallet AND x.fetched_at_ms >= ?)
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.namespace = s.namespace AND j.type = 'wallet_pnl' AND j.subject = s.wallet AND j.status IN ('queued', 'running'))
         ORDER BY s.packs DESC, s.last_seen_ms DESC LIMIT ?`,
      )
      .all(this.namespace, REPEAT_WALLET_MIN_PACKS, now - DAY_MS, now - DAY_MS, REPEAT_WALLETS_PER_CYCLE) as { wallet: string }[];
    let n = 0;
    for (const { wallet } of rows) {
      if (!this.canAutoSpend(REPEAT_WALLET_CREDITS)) break;
      for (const type of ["wallet_pnl", "related_wallets"] as const) {
        this.queue.enqueue({
          namespace: this.namespace, campaignId: this.session.campaignId, lane: "BASE_ENRICHMENT", type, subject: wallet, packId: null,
          payload: { wallet }, dedupeKey: `${this.namespace}|repeat|${type}|${wallet}`, requestedBy: "repeat_wallets",
        });
      }
      n++;
    }
    return n;
  }

  /**
   * Extra profiles beyond the spec's first three initial members (which stay unchanged and alone
   * feed the base assessment): the largest buyer, and the member seen in the most earlier packs.
   */
  extraProfileWallets(packId: string, selected: string[]): { wallet: string; reason: "largest_buyer" | "repeat_wallet"; earlierPacks: number }[] {
    const members = this.db
      .prepare(
        `SELECT m.wallet, m.eligible_buy_usd, COALESCE(s.packs, 1) - 1 AS earlier FROM pack_members m
         LEFT JOIN wallet_pack_stats s ON s.namespace = m.namespace AND s.wallet = m.wallet WHERE m.pack_id = ?`,
      )
      .all(packId) as { wallet: string; eligible_buy_usd: string; earlier: number }[];
    const skip = new Set(selected);
    const out: { wallet: string; reason: "largest_buyer" | "repeat_wallet"; earlierPacks: number }[] = [];
    const largest = members
      .filter((m) => !skip.has(m.wallet))
      .sort((a, b) => parseDecimal(b.eligible_buy_usd).comparedTo(parseDecimal(a.eligible_buy_usd)) || (a.wallet < b.wallet ? -1 : 1))[0];
    if (largest) {
      out.push({ wallet: largest.wallet, reason: "largest_buyer", earlierPacks: largest.earlier });
      skip.add(largest.wallet);
    }
    const repeat = members.filter((m) => !skip.has(m.wallet) && m.earlier > 0).sort((a, b) => b.earlier - a.earlier || (a.wallet < b.wallet ? -1 : 1))[0];
    if (repeat) out.push({ wallet: repeat.wallet, reason: "repeat_wallet", earlierPacks: repeat.earlier });
    return out;
  }

  /** Enqueue the P0 job set for one pack (also used by the operator enrich action). */
  schedulePack(packId: string, requestedBy: string): { jobIds: string[] } {
    const pack = this.db
      .prepare("SELECT p.id, p.namespace, p.mint, e.profile_wallets_json, e.relationship_wallets_json FROM packs p JOIN pack_enrichment e ON e.pack_id = p.id WHERE p.id = ?")
      .get(packId) as { id: string; namespace: string; mint: string; profile_wallets_json: string; relationship_wallets_json: string } | undefined;
    if (!pack) throw new Error("Pack not found");
    const profile = JSON.parse(pack.profile_wallets_json) as string[];
    const relationship = JSON.parse(pack.relationship_wallets_json) as string[];
    const extras = this.extraProfileWallets(packId, profile);
    const now = this.clock.now();
    const campaignId = this.session.campaignId;
    const jobIds: string[] = [];
    const add = (lane: "BASE_ENRICHMENT" | "SMART_MONEY", type: Parameters<JobQueue["enqueue"]>[0]["type"], subject: string, payload: Record<string, unknown>) => {
      const r = this.queue.enqueue({
        namespace: pack.namespace,
        campaignId,
        lane,
        type,
        subject,
        packId,
        payload,
        dedupeKey: `${pack.namespace}|${packId}|${type}|${subject}`,
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
      // Extra profiles; wallets profiled in the last day are served from stored snapshots at no cost.
      for (const x of extras) {
        add("BASE_ENRICHMENT", "wallet_pnl", x.wallet, { wallet: x.wallet });
        add("BASE_ENRICHMENT", "related_wallets", x.wallet, { wallet: x.wallet });
      }
      // Holding versus selling comes from on-chain trades (After the pack), so the paid 5-minute
      // balance check is not scheduled. Netflow follows the token lookup when Smart Money bought.
      if (this.config.smartMoney.enabled) add("SMART_MONEY", "sm_token_lookup", pack.mint, { mint: pack.mint });
      this.db
        .prepare("UPDATE pack_enrichment SET status = 'scheduled', requested_by = ?, scheduled_at_ms = ?, extra_profile_wallets_json = ? WHERE pack_id = ?")
        .run(requestedBy, now, JSON.stringify(extras), packId);
    })();
    this.assessment.refresh(packId);
    return { jobIds };
  }

  enqueueGlobalFeed(): void {
    if (!this.config.smartMoney.feedEnabled) return;
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
      payload: { maxTokenAgeDays: this.config.smartMoney.feedMaxTokenAgeDays },
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
