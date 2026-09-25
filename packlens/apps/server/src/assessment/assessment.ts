/**
 * Deterministic base assessment (blueprint §7.2). Returns investigation
 * reasons, never predictions. Inputs are base provider evidence only
 * (related wallets, holders, token supply). Smart Money, netflow, LLM output,
 * and later prices are never read here.
 */
import type { AnalysisState, ReviewFlag } from "@packlens/contracts";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { canonical, Decimal, parseDecimal } from "../lib/decimal.js";
import { writeOutbox, type OutboxBus } from "../ingest/outbox.js";

type BaseJob = { type: string; status: string; status_reason: string | null; result_json: string | null };

export function deriveAnalysisState(jobs: BaseJob[]): AnalysisState {
  if (jobs.length === 0) return "not_requested";
  const s = jobs.map((j) => j.status);
  const pending = s.filter((x) => x === "queued" || x === "running").length;
  if (pending > 0) {
    if (s.includes("running") || s.includes("succeeded")) return "running";
    return "queued";
  }
  if (s.every((x) => x === "succeeded")) return "complete";
  if (s.includes("budget_paused")) return "budget_paused";
  if (s.includes("succeeded")) return "partial";
  // Session ended before any work ran: nothing was analyzed, which is not an error.
  if (s.every((x) => x === "cancelled")) return "not_requested";
  return "error";
}

export type ConcentrationFacts = { observedTopShare: string | null; holderCount: number; totalSupply: string | null };

/** Top-N observed share of verified total supply; null when ordering or denominator is unavailable. */
export function observedTopShare(holderAmounts: (string | null)[], totalSupply: string | null, orderedByAmount: boolean): string | null {
  if (!orderedByAmount || totalSupply === null) return null;
  let supply: Decimal;
  try {
    supply = parseDecimal(totalSupply);
  } catch {
    return null;
  }
  if (!supply.greaterThan(0)) return null;
  let sum = new Decimal(0);
  for (const a of holderAmounts.slice(0, 20)) {
    if (a === null) return null;
    sum = sum.plus(parseDecimal(a));
  }
  const share = sum.div(supply);
  if (share.greaterThan(1)) return null; // incompatible units: do not claim a distribution
  return canonical(new Decimal(share.toFixed(18)));
}

export class AssessmentService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly outbox: OutboxBus,
    private readonly concentrationThreshold: string | null,
  ) {}

  refresh(packId: string): void {
    const pack = this.db.prepare("SELECT id, namespace, mint, total_wallet_count FROM packs WHERE id = ?").get(packId) as
      | { id: string; namespace: string; mint: string; total_wallet_count: number }
      | undefined;
    if (!pack) return;
    const enr = this.db.prepare("SELECT profile_wallets_json, relationship_wallets_json, status FROM pack_enrichment WHERE pack_id = ?").get(packId) as
      | { profile_wallets_json: string; relationship_wallets_json: string; status: string }
      | undefined;
    const jobs = this.db
      .prepare("SELECT type, status, status_reason, result_json FROM jobs WHERE pack_id = ? AND lane = 'BASE_ENRICHMENT'")
      .all(packId) as BaseJob[];
    const analysisState = deriveAnalysisState(jobs);
    const snapshotIds = [...new Set(jobs.flatMap((j) => (j.result_json ? ((JSON.parse(j.result_json) as { snapshotId?: string | null }).snapshotId ?? null) : null)).filter((x): x is string => typeof x === "string"))].sort();

    const flags: ReviewFlag[] = [];
    const reasons: Record<string, unknown>[] = [];
    const members = new Set((this.db.prepare("SELECT wallet FROM pack_members WHERE pack_id = ?").all(packId) as { wallet: string }[]).map((m) => m.wallet));

    // CHECK_RELATIONSHIP: a provider-returned direct relationship between pack members.
    const relWallets = enr ? (JSON.parse(enr.relationship_wallets_json) as string[]) : [];
    for (const w of relWallets) {
      const snap = this.db
        .prepare("SELECT id, result_json FROM enrichment_snapshots WHERE namespace = ? AND endpoint = 'profiler/address/related-wallets' AND subject_id = ? AND availability = 'available' ORDER BY fetched_at_ms DESC LIMIT 1")
        .get(pack.namespace, w) as { id: string; result_json: string } | undefined;
      if (!snap) continue;
      const related = (JSON.parse(snap.result_json) as { related: { address: string; relation: string }[] }).related;
      for (const r of related) {
        if (r.address !== w && members.has(r.address)) {
          if (!flags.includes("CHECK_RELATIONSHIP")) flags.push("CHECK_RELATIONSHIP");
          reasons.push({ flag: "CHECK_RELATIONSHIP", wallet: w, relatedAddress: r.address, relation: r.relation, snapshotId: snap.id });
        }
      }
    }

    // CHECK_CONCENTRATION: only with an explicitly configured threshold and a valid denominator.
    if (this.concentrationThreshold !== null) {
      const holders = this.db
        .prepare("SELECT id, result_json FROM enrichment_snapshots WHERE namespace = ? AND endpoint = 'tgm/holders' AND subject_id = ? AND availability = 'available' ORDER BY fetched_at_ms DESC LIMIT 1")
        .get(pack.namespace, pack.mint) as { id: string; result_json: string } | undefined;
      const info = this.db
        .prepare("SELECT id, result_json FROM enrichment_snapshots WHERE namespace = ? AND endpoint = 'tgm/token-information' AND subject_id = ? AND availability = 'available' ORDER BY fetched_at_ms DESC LIMIT 1")
        .get(pack.namespace, pack.mint) as { id: string; result_json: string } | undefined;
      if (holders && info) {
        const h = JSON.parse(holders.result_json) as { holders: { tokenAmount: string | null }[] };
        const t = JSON.parse(info.result_json) as { totalSupply: string | null } | null;
        const share = observedTopShare(h.holders.map((x) => x.tokenAmount), t?.totalSupply ?? null, true);
        if (share !== null && parseDecimal(share).greaterThanOrEqualTo(parseDecimal(this.concentrationThreshold))) {
          flags.push("CHECK_CONCENTRATION");
          reasons.push({ flag: "CHECK_CONCENTRATION", observedTopShare: share, threshold: this.concentrationThreshold, snapshotIds: [holders.id, info.id] });
        }
      }
    }

    const scheduledMemberCount = enr && enr.status === "scheduled" ? (JSON.parse(enr.profile_wallets_json) as string[]).length : 0;
    const latest = this.db
      .prepare("SELECT version, analysis_state, review_flags_json, snapshot_ids_json, scheduled_member_count FROM pack_assessments WHERE pack_id = ? ORDER BY version DESC LIMIT 1")
      .get(packId) as { version: number; analysis_state: string; review_flags_json: string; snapshot_ids_json: string; scheduled_member_count: number } | undefined;
    const unchanged =
      latest &&
      latest.analysis_state === analysisState &&
      latest.review_flags_json === JSON.stringify(flags) &&
      latest.snapshot_ids_json === JSON.stringify(snapshotIds) &&
      latest.scheduled_member_count === scheduledMemberCount;
    if (unchanged) return;
    const version = (latest?.version ?? 0) + 1;
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pack_assessments (pack_id, namespace, version, analysis_state, review_flags_json, scheduled_member_count, total_member_count, snapshot_ids_json, reasons_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(packId, pack.namespace, version, analysisState, JSON.stringify(flags), scheduledMemberCount, pack.total_wallet_count, JSON.stringify(snapshotIds), JSON.stringify(reasons), now);
      writeOutbox(this.db, pack.namespace, "analysis.updated", packId, version, { packId, version, analysisState }, now);
    })();
    this.outbox.notifyCommitted(pack.namespace);
  }
}
