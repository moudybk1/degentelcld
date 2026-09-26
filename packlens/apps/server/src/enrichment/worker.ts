/**
 * Enrichment worker: claims queued jobs and runs them through the Nansen
 * client. Public GET routes never reach this code; only the scheduler and
 * authenticated operator mutations enqueue work.
 */
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import {
  CURRENT_BALANCE,
  HOLDERS,
  PNL_SUMMARY,
  RELATED_WALLETS,
  TOKEN_INFORMATION,
  WALLET_DEX_TRADES,
  type EndpointDef,
} from "../adapters/nansen/endpoints.js";
import type { CallResult, NansenClient } from "../adapters/nansen/client.js";
import { log } from "../lib/log.js";
import type { AssessmentService } from "../assessment/assessment.js";
import type { SmartMoneyService } from "../smart-money/service.js";
import { isoNoMillis } from "../prices/poller.js";
import type { JobQueue, JobRow } from "../scheduler/queue.js";
import type { SessionManager } from "../scheduler/session.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export type JobOutcome = { status: "succeeded" | "failed" | "cancelled" | "budget_paused"; reason: string | null; snapshotId: string | null };

function outcomeFrom(res: CallResult<unknown>): JobOutcome {
  if (res.ok) return { status: "succeeded", reason: res.source === "cache" ? "cache_hit" : res.normalized.availability, snapshotId: res.snapshotId };
  switch (res.code) {
    case "budget_paused":
    case "payment_paused":
      return { status: "budget_paused", reason: res.code, snapshotId: res.snapshotId };
    case "no_session":
    case "session_ended":
      return { status: "cancelled", reason: "session_ended", snapshotId: null };
    case "smart_money_disabled":
      return { status: "cancelled", reason: "smart_money_disabled", snapshotId: null };
    case "not_found":
      // The provider has no record for this subject: a valid terminal result shown as unavailable.
      return { status: "succeeded", reason: "unavailable", snapshotId: res.snapshotId };
    default:
      return { status: "failed", reason: res.code, snapshotId: res.snapshotId };
  }
}

export class EnrichmentWorker {
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly queue: JobQueue,
    private readonly client: NansenClient,
    private readonly smartMoney: SmartMoneyService,
    private readonly assessment: AssessmentService,
    private readonly session: SessionManager,
    private readonly concurrency: number,
  ) {}

  start(): void {
    this.stopped = false;
    this.queue.recoverAllRunning();
    this.loop();
  }

  async stop(deadlineMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, deadlineMs))]);
  }

  private loop(): void {
    if (this.stopped) return;
    try {
      this.queue.recoverExpiredLeases();
      if (this.session.current()) {
        while (this.running < this.concurrency) {
          const job = this.queue.claimNext();
          if (!job) break;
          this.running++;
          const p = this.run(job).finally(() => {
            this.running--;
            this.inflight.delete(p);
          });
          this.inflight.add(p);
        }
      }
    } catch (err) {
      log("error", "enrichment-worker", "Worker loop failure", { error: String(err) });
    }
    this.timer = setTimeout(() => this.loop(), 400);
    this.timer.unref?.();
  }

  private async call<Req, T>(def: EndpointDef<Req, T>, req: Req, job: JobRow, purpose: string): Promise<JobOutcome> {
    const res = await this.client.call(def, req, { lane: "BASE_ENRICHMENT", purpose, jobId: job.id, persist: true });
    return outcomeFrom(res as CallResult<unknown>);
  }

  private async execute(job: JobRow): Promise<JobOutcome> {
    const p = JSON.parse(job.payload_json) as { mint?: string; wallet?: string };
    const now = this.clock.now();
    switch (job.type) {
      case "token_info":
        return this.call(TOKEN_INFORMATION, { chain: "solana", token_address: p.mint!, timeframe: "1h" }, job, "token_context");
      case "holders":
        return this.call(
          HOLDERS,
          {
            chain: "solana",
            token_address: p.mint!,
            premium_labels: false,
            aggregate_by_entity: false,
            label_type: "all_holders",
            filters: { value_usd: { min: 0 } },
            pagination: { page: 1, per_page: 20 },
            order_by: [{ field: "token_amount", direction: "DESC" }],
          },
          job,
          "token_holders",
        );
      case "wallet_pnl": {
        // 30-day window ending at 00:00 UTC, so one snapshot serves the wallet all day.
        const to = Math.floor(now / DAY) * DAY;
        return this.call(PNL_SUMMARY, { chain: "solana", wallet_address: p.wallet!, date: { from: isoNoMillis(to - 30 * DAY), to: isoNoMillis(to) } }, job, "wallet_profile");
      }
      case "wallet_dex": {
        // 7-day window ending at the hour boundary (one hour of reuse); one page of 100 rows.
        const to = Math.floor(now / HOUR) * HOUR;
        return this.call(
          WALLET_DEX_TRADES,
          { chain: "solana", address: p.wallet!, date: { from: isoNoMillis(to - 7 * DAY), to: isoNoMillis(to) }, pagination: { page: 1, per_page: 100 } },
          job,
          "wallet_history",
        );
      }
      case "related_wallets":
        return this.call(RELATED_WALLETS, { chain: "solana", wallet_address: p.wallet!, pagination: { page: 1, per_page: 100 } }, job, "wallet_relationships");
      case "balance_followup":
        return this.call(
          CURRENT_BALANCE,
          { chain: "solana", address: p.wallet!, hide_spam_token: false, filters: { token_address: p.mint! }, pagination: { page: 1, per_page: 100 } },
          job,
          "balance_followup",
        );
      case "sm_token_lookup": {
        const r = await this.smartMoney.targetedLookup(p.mint!, job.id);
        if (r.ok) {
          this.netflowIfSmartMoney(job, p.mint!);
          return { status: "succeeded", reason: `pages:${r.pages}`, snapshotId: r.snapshotIds[0] ?? null };
        }
        return outcomeFrom({ ok: false, code: r.code as never, message: "", snapshotId: r.snapshotIds[0] ?? null, attemptIds: [], retryable: false });
      }
      case "sm_netflow": {
        const r = await this.smartMoney.netflowLookup(p.mint!, job.id);
        if (r.ok) return { status: "succeeded", reason: null, snapshotId: r.snapshotId };
        return outcomeFrom({ ok: false, code: r.code as never, message: "", snapshotId: r.snapshotId, attemptIds: [], retryable: false });
      }
      case "sm_global_feed": {
        const { maxTokenAgeDays = null } = JSON.parse(job.payload_json) as { maxTokenAgeDays?: number | null };
        const r = await this.smartMoney.pollGlobalFeed(job.id, 100, maxTokenAgeDays);
        if (r.ok) return { status: "succeeded", reason: `new:${r.newObservations}`, snapshotId: r.snapshotIds[0] ?? null };
        return outcomeFrom({ ok: false, code: r.code as never, message: "", snapshotId: null, attemptIds: [], retryable: false });
      }
      default:
        return { status: "failed", reason: "unknown_job_type", snapshotId: null };
    }
  }

  /**
   * Nansen netflow is almost always empty for brand-new pump.fun tokens (1 of 27
   * in the 2026-09-25 live run), so a pack's netflow lookup follows its token
   * lookup and runs only when Smart Money buyers were observed. Context only:
   * this never changes packs or which packs are analyzed.
   */
  private netflowIfSmartMoney(job: JobRow, mint: string): void {
    const buyers = this.db
      .prepare("SELECT COUNT(DISTINCT trader_address) AS n FROM smart_money_observations WHERE namespace = ? AND token_bought_address = ? AND block_time_ms >= ?")
      .get(job.namespace, mint, this.clock.now() - DAY) as { n: number };
    if (buyers.n === 0) return;
    this.queue.enqueue({
      namespace: job.namespace,
      campaignId: job.campaign_id,
      lane: "SMART_MONEY",
      type: "sm_netflow",
      subject: mint,
      packId: job.pack_id,
      payload: { mint },
      dedupeKey: `${job.namespace}|${job.pack_id ?? "token"}|sm_netflow|${mint}`,
      requestedBy: "smart_money_observed",
    });
  }

  private async run(job: JobRow): Promise<void> {
    let outcome: JobOutcome;
    try {
      outcome = await this.execute(job);
    } catch (err) {
      log("error", "enrichment-worker", "Job failed unexpectedly", { jobId: job.id, type: job.type, error: String(err) });
      outcome = { status: "failed", reason: "internal_error", snapshotId: null };
    }
    this.queue.finish(job.id, outcome.status, outcome.reason, { snapshotId: outcome.snapshotId });
    if (job.pack_id && job.lane === "BASE_ENRICHMENT") {
      try {
        this.assessment.refresh(job.pack_id);
      } catch (err) {
        log("error", "enrichment-worker", "Assessment refresh failed", { packId: job.pack_id, error: String(err) });
      }
    }
  }
}
