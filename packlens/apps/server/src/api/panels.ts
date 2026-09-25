import type { Panel, PanelState } from "@packlens/contracts";
import type { Db } from "../db/connection.js";

type SnapRow = {
  id: string;
  fetched_at_ms: number;
  period_start_ms: number | null;
  period_end_ms: number | null;
  availability: PanelState["availability"];
  coverage: PanelState["coverage"];
  reason_code: string | null;
  result_json: string | null;
};

export type PanelQuery = {
  namespace: string;
  endpoint: string;
  subjectId: string;
  ttlMs: number;
  jobType?: string;
  /** Restrict to snapshots whose params match (json path → value). */
  paramFilter?: { path: string; value: string };
};

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Derive a panel from stored snapshots and job status (FR-12). Availability,
 * coverage, and freshness are independent. A failed refresh keeps the previous
 * snapshot readable with reason "update_delayed"; unknown is never zero.
 */
export function buildPanel<T>(db: Db, nowMs: number, q: PanelQuery): Panel<T> {
  const filterSql = q.paramFilter ? ` AND json_extract(params_json, '${q.paramFilter.path.replace(/'/g, "")}') = ?` : "";
  const args: unknown[] = [q.namespace, q.endpoint, q.subjectId];
  if (q.paramFilter) args.push(q.paramFilter.value);
  const latest = db
    .prepare(`SELECT * FROM enrichment_snapshots WHERE namespace = ? AND endpoint = ? AND subject_id = ?${filterSql} ORDER BY fetched_at_ms DESC, id DESC LIMIT 1`)
    .get(...args) as SnapRow | undefined;
  const good = db
    .prepare(
      `SELECT * FROM enrichment_snapshots WHERE namespace = ? AND endpoint = ? AND subject_id = ?${filterSql} AND availability IN ('available', 'empty') ORDER BY fetched_at_ms DESC, id DESC LIMIT 1`,
    )
    .get(...args) as SnapRow | undefined;
  const job = q.jobType
    ? (db
        .prepare("SELECT status FROM jobs WHERE namespace = ? AND type = ? AND subject = ? ORDER BY enqueued_at_ms DESC LIMIT 1")
        .get(q.namespace, q.jobType, q.subjectId) as { status: string } | undefined)
    : undefined;
  const pendingJob = job && (job.status === "queued" || job.status === "running");

  const base: PanelState = {
    availability: "not_requested",
    coverage: "unknown",
    freshness: "unknown",
    fetchedAt: null,
    periodStart: null,
    periodEnd: null,
    reasonCode: null,
    snapshotIds: [],
  };

  if (!latest) {
    if (pendingJob) return { data: null, state: { ...base, availability: "queued" } };
    if (job?.status === "budget_paused") return { data: null, state: { ...base, availability: "budget_paused", reasonCode: "budget_paused" } };
    if (job?.status === "cancelled") return { data: null, state: { ...base, reasonCode: "session_ended" } };
    return { data: null, state: base };
  }

  if (good) {
    const stale = nowMs - good.fetched_at_ms > q.ttlMs;
    const delayed = latest.id !== good.id; // a newer attempt failed
    return {
      data: good.result_json === null ? null : (JSON.parse(good.result_json) as T),
      state: {
        availability: good.availability,
        coverage: good.coverage,
        freshness: stale || delayed ? "stale" : "fresh",
        fetchedAt: iso(good.fetched_at_ms),
        periodStart: iso(good.period_start_ms),
        periodEnd: iso(good.period_end_ms),
        reasonCode: delayed ? "update_delayed" : pendingJob ? "refresh_queued" : null,
        snapshotIds: [good.id],
      },
    };
  }

  // Only failures so far.
  return {
    data: null,
    state: {
      ...base,
      availability: pendingJob ? "queued" : latest.availability,
      fetchedAt: iso(latest.fetched_at_ms),
      reasonCode: latest.reason_code,
      snapshotIds: [latest.id],
    },
  };
}
