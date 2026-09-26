/**
 * Nansen client pipeline (blueprint §8.2):
 * validate request → canonical parameter hash → cache/single-flight →
 * session and pause checks → rate gate → reserve credits → send → capture
 * headers → validate response → normalize → persist snapshot → settle → ledger.
 *
 * The key is sent only in the `apikey` header from the backend. Every attempt,
 * retry, and page is a separate ledger row. Cache hits are not provider calls.
 */
import type { Clock } from "../../clock.js";
import type { Db } from "../../db/connection.js";
import { newId, sha256Hex } from "../../lib/ids.js";
import { canonicalJson, parseLossless } from "../../lib/json.js";
import { log } from "../../lib/log.js";
import type { BudgetLedger, Lane } from "../../scheduler/budget.js";
import type { DispatchGate } from "../../scheduler/gate.js";
import { SchemaMismatchError, type EndpointDef, type Normalized } from "./endpoints.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type PauseReason = "auth" | "payment" | null;

export interface SessionGuard {
  /** Returns null when dispatch is allowed, otherwise a reason code. */
  blockReason(lane: Lane): "session_ended" | "no_session" | "smart_money_disabled" | null;
  sessionEndMs(lane: Lane): number | null;
}

export type CallMeta = {
  lane: Lane;
  purpose: string;
  jobId: string | null;
  /** Persist an enrichment snapshot (price snapshots are persisted by the price poller). */
  persist: boolean;
  scopeHash?: string | null;
  /** Skip the cache even when a fresh snapshot exists (poller refresh). */
  bypassCache?: boolean;
};

export type CallFailureCode =
  | "budget_paused"
  | "session_ended"
  | "no_session"
  | "smart_money_disabled"
  | "auth_paused"
  | "payment_paused"
  | "schema_error"
  | "bad_request"
  | "not_found"
  | "http_error"
  | "timeout"
  | "network_error"
  | "rate_limited";

export type CallSuccess<T> = {
  ok: true;
  source: "cache" | "provider";
  snapshotId: string | null;
  normalized: Normalized<T>;
  fetchedAtMs: number;
  requestStartedAtMs: number;
  providerRequestId: string | null;
  attemptIds: string[];
};

export type CallFailure = {
  ok: false;
  code: CallFailureCode;
  message: string;
  snapshotId: string | null;
  attemptIds: string[];
  retryable: boolean;
};

export type CallResult<T> = CallSuccess<T> | CallFailure;

type Headers = { cost: number | null; used: number | null; remaining: number | null; requestId: string | null; retryAfterS: number | null };

/**
 * Extra time to read a body once the provider has answered: by then the call is
 * charged, so waiting longer is cheaper than paying again for a retry.
 */
const BODY_TIMEOUT_MS = 30_000;

function timeoutError(message: string): Error {
  const e = new Error(message);
  e.name = "TimeoutError";
  return e;
}

function nonNegInt(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function readHeaders(h: { get(name: string): string | null }): Headers {
  return {
    cost: nonNegInt(h.get("x-nansen-credits-cost")),
    used: nonNegInt(h.get("x-nansen-credits-used")),
    remaining: (() => {
      const v = h.get("x-nansen-credits-remaining");
      if (v === null) return null;
      const n = Number(v.trim());
      return Number.isFinite(n) ? Math.floor(n) : null;
    })(),
    requestId: h.get("x-request-id"),
    retryAfterS: nonNegInt(h.get("retry-after")),
  };
}

export type NansenClientDeps = {
  db: Db;
  clock: Clock;
  namespace: string;
  ledger: BudgetLedger;
  gate: DispatchGate;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  session: SessionGuard;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
};

export class NansenClient {
  private readonly inflight = new Map<string, Promise<CallResult<unknown>>>();
  private pause: { reason: PauseReason; message: string | null } = { reason: null, message: null };
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  cacheHits = 0;
  lastReportedRemaining: number | null = null;

  constructor(private readonly deps: NansenClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    const persisted = deps.db.prepare("SELECT value FROM meta WHERE key = 'nansen_cache_hits'").get() as { value: string } | undefined;
    this.cacheHits = persisted ? Number(persisted.value) : 0;
  }

  get pauseState(): { reason: PauseReason; message: string | null } {
    return this.pause;
  }

  /** Operator acknowledged a fixed configuration or funded account. */
  clearPause(): void {
    this.pause = { reason: null, message: null };
  }

  parameterHash(def: EndpointDef<unknown, unknown>, req: unknown): string {
    return sha256Hex(`${def.name}|${canonicalJson(req)}`);
  }

  async call<Req, T>(def: EndpointDef<Req, T>, req: Req, meta: CallMeta): Promise<CallResult<T>> {
    const paramHash = this.parameterHash(def as EndpointDef<unknown, unknown>, req);
    if (!meta.bypassCache && def.ttlMs !== null) {
      const cached = this.readCache<T>(def, paramHash);
      if (cached) return cached;
    }
    const key = `${def.name}|${paramHash}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<CallResult<T>>;
    const p = this.execute(def, req, meta, paramHash).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p as Promise<CallResult<unknown>>);
    return p;
  }

  private readCache<T>(def: EndpointDef<unknown, T> | EndpointDef<never, T>, paramHash: string): CallSuccess<T> | null {
    const now = this.deps.clock.now();
    const row = this.deps.db
      .prepare(
        `SELECT id, fetched_at_ms, result_json, availability, page, is_last_page, period_start_ms, period_end_ms FROM enrichment_snapshots
         WHERE namespace = ? AND endpoint = ? AND parameter_hash = ? AND availability IN ('available', 'empty') AND fetched_at_ms >= ?
         ORDER BY fetched_at_ms DESC LIMIT 1`,
      )
      .get(this.deps.namespace, def.name, paramHash, now - (def.ttlMs ?? 0)) as
      | { id: string; fetched_at_ms: number; result_json: string | null; availability: "available" | "empty"; page: number | null; is_last_page: number | null; period_start_ms: number | null; period_end_ms: number | null }
      | undefined;
    if (!row) return null;
    this.cacheHits++;
    this.deps.db.prepare("INSERT INTO meta (key, value) VALUES ('nansen_cache_hits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.cacheHits));
    return {
      ok: true,
      source: "cache",
      snapshotId: row.id,
      normalized: {
        availability: row.availability,
        data: (row.result_json === null ? null : JSON.parse(row.result_json)) as T,
        page: row.page,
        isLastPage: row.is_last_page === null ? null : row.is_last_page === 1,
        periodStartMs: row.period_start_ms,
        periodEndMs: row.period_end_ms,
      },
      fetchedAtMs: row.fetched_at_ms,
      requestStartedAtMs: row.fetched_at_ms,
      providerRequestId: null,
      attemptIds: [],
    };
  }

  private blocked(lane: Lane): CallFailure | null {
    if (this.pause.reason === "auth") return { ok: false, code: "auth_paused", message: "Nansen access failed (401/403); paid dispatch is paused until the configuration is fixed.", snapshotId: null, attemptIds: [], retryable: false };
    if (this.pause.reason === "payment") return { ok: false, code: "payment_paused", message: "Nansen reported insufficient credits (402); paid dispatch is paused.", snapshotId: null, attemptIds: [], retryable: false };
    const reason = this.deps.session.blockReason(lane);
    if (reason) return { ok: false, code: reason, message: reason === "smart_money_disabled" ? "Smart Money is disabled." : "No active Nansen session.", snapshotId: null, attemptIds: [], retryable: false };
    return null;
  }

  private async execute<Req, T>(def: EndpointDef<Req, T>, req: Req, meta: CallMeta, paramHash: string): Promise<CallResult<T>> {
    const maxAttempts = this.deps.maxAttempts ?? 3;
    const attemptIds: string[] = [];
    let lastFailure: CallFailure | null = null;
    let retryOf: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const blocked = this.blocked(meta.lane);
      if (blocked) {
        lastFailure = { ...blocked, attemptIds };
        break;
      }
      const release = await this.deps.gate.acquire(meta.lane);
      const attemptId = newId("att");
      let sent = false;
      try {
        const blockedAfterWait = this.blocked(meta.lane);
        if (blockedAfterWait) {
          lastFailure = { ...blockedAfterWait, attemptIds };
          break;
        }
        const reservation = this.deps.ledger.reserve({
          attemptId,
          lane: meta.lane,
          amount: def.expectedCredits,
          endpoint: def.name,
          parameterHash: paramHash,
          purpose: meta.purpose,
          subjectId: def.subjectId(req),
          jobId: meta.jobId,
          retryOfAttemptId: retryOf,
        });
        if (!reservation.ok) {
          lastFailure = {
            ok: false,
            code: "budget_paused",
            message:
              reservation.reason === "daily_cap"
                ? `Analysis paused: the daily Nansen credit cap is reached (${reservation.available} left today, ${def.expectedCredits} needed); it resets at 00:00 UTC.`
                : `Analysis paused: ${reservation.available} credits available for this lane, ${def.expectedCredits} needed.`,
            snapshotId: null,
            attemptIds,
            retryable: false,
          };
          break;
        }
        attemptIds.push(attemptId);
        const outcome = await this.sendOnce(def, req, meta, paramHash, attemptId, () => {
          sent = true;
        });
        if (outcome.ok) return { ...outcome, attemptIds };
        lastFailure = { ...outcome, attemptIds };
        if (!outcome.retryable) break;
        retryOf = attemptId;
      } catch (err) {
        // Defensive: an unexpected local failure. If the request may have been sent, keep it unresolved.
        if (attemptIds.includes(attemptId)) {
          if (sent) this.deps.ledger.markUnresolved(attemptId, def.expectedCredits);
          else this.deps.ledger.release(attemptId);
        }
        log("error", "nansen-client", "Unexpected client failure", { endpoint: def.name, error: String(err) });
        lastFailure = { ok: false, code: "network_error", message: "Unexpected local failure", snapshotId: null, attemptIds, retryable: false };
        break;
      } finally {
        release();
      }
      // Backoff with full jitter: 0..min(30s, 1s × 2^retryIndex); Retry-After is a minimum.
      const retryIndex = attempt;
      const base = Math.min(30_000, 1000 * 2 ** retryIndex);
      let wait = Math.floor(this.random() * base);
      const ra = (lastFailure as CallFailure & { retryAfterMs?: number }).retryAfterMs;
      if (ra !== undefined) wait = Math.max(wait, ra);
      const end = this.deps.session.sessionEndMs(meta.lane);
      if (end !== null && this.deps.clock.now() + wait >= end) break; // never retry beyond session expiry
      await this.sleep(wait);
    }
    const failure = lastFailure ?? { ok: false as const, code: "network_error" as const, message: "No attempt was made", snapshotId: null, attemptIds, retryable: false };
    if (meta.persist && failure.code !== "session_ended" && failure.code !== "no_session" && failure.code !== "smart_money_disabled") {
      failure.snapshotId = this.persistFailure(def, req, meta, paramHash, failure, attemptIds[attemptIds.length - 1] ?? null);
    }
    return failure;
  }

  private async sendOnce<Req, T>(
    def: EndpointDef<Req, T>,
    req: Req,
    meta: CallMeta,
    paramHash: string,
    attemptId: string,
    markSent: () => void,
  ): Promise<(CallSuccess<T> | (CallFailure & { retryAfterMs?: number })) & {}> {
    const db = this.deps.db;
    const startedAt = this.deps.clock.now();
    let status: number | null = null;
    let headers: Headers = { cost: null, used: null, remaining: null, requestId: null, retryAfterS: null };
    let bodyText: string;
    const finish = (fields: { http_outcome: string; normalization_status: string; error_code: string | null; snapshot_id?: string | null }) => {
      const finishedAt = this.deps.clock.now();
      db.prepare(
        `UPDATE api_usage SET finished_at_ms = ?, duration_ms = ?, http_status = ?, http_outcome = ?, normalization_status = ?, provider_request_id = ?,
           quoted_credits = ?, actual_credits = ?, remaining_credits = ?, snapshot_id = ?, error_code = ? WHERE attempt_id = ?`,
      ).run(finishedAt, finishedAt - startedAt, status, fields.http_outcome, fields.normalization_status, headers.requestId, headers.cost, headers.used, headers.remaining,
        fields.snapshot_id ?? null, fields.error_code, attemptId);
    };
    const settle = () => {
      if (headers.used !== null) {
        this.deps.ledger.settle(attemptId, headers.used);
        if (headers.used > def.expectedCredits) {
          log("warn", "nansen-client", "Actual cost exceeded the estimate", { endpoint: def.name, expected: def.expectedCredits, used: headers.used });
        }
      } else {
        this.deps.ledger.markUnresolved(attemptId, Math.max(def.expectedCredits, headers.cost ?? 0));
      }
      if (headers.remaining !== null) this.lastReportedRemaining = headers.remaining;
    };

    const ctrl = new AbortController();
    let deadline = setTimeout(() => ctrl.abort(timeoutError("Request timed out")), this.deps.timeoutMs);
    try {
      markSent();
      const res = await this.fetchImpl(`${this.deps.baseUrl}${def.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", apikey: this.deps.apiKey },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      status = res.status;
      headers = readHeaders(res.headers);
      clearTimeout(deadline);
      deadline = setTimeout(() => ctrl.abort(timeoutError("Response body timed out")), BODY_TIMEOUT_MS);
      bodyText = await res.text();
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (status !== null) {
        // The provider answered (status and credit headers arrived) and has charged for the call;
        // only the body was lost. Record the reported cost and do not retry, which would pay again.
        settle();
        finish({ http_outcome: isTimeout ? "timeout" : "network_error", normalization_status: "not_applicable", error_code: "body_not_received" });
        return { ok: false, code: isTimeout ? "timeout" : "network_error", message: "The provider answered, but the response body did not arrive", snapshotId: null, attemptIds: [], retryable: false };
      }
      // The request may have reached the provider: keep the attempt and reservation unresolved.
      this.deps.ledger.markUnresolved(attemptId, def.expectedCredits);
      finish({ http_outcome: isTimeout ? "timeout" : "network_error", normalization_status: "not_applicable", error_code: isTimeout ? "timeout" : "network_error" });
      return { ok: false, code: isTimeout ? "timeout" : "network_error", message: isTimeout ? "Request timed out" : "Network error", snapshotId: null, attemptIds: [], retryable: true };
    } finally {
      clearTimeout(deadline);
    }

    if (status < 200 || status >= 300) {
      settle();
      let code: CallFailureCode = "http_error";
      let retryable = false;
      let providerCode: string | null = null;
      try {
        const parsed = JSON.parse(bodyText) as { code?: unknown };
        if (typeof parsed.code === "string") providerCode = parsed.code;
      } catch {
        /* error body is not JSON */
      }
      if (status === 401 || status === 403) {
        code = "auth_paused";
        this.pause = { reason: "auth", message: `HTTP ${status}${providerCode ? ` (${providerCode})` : ""}` };
      } else if (status === 402 || providerCode === "insufficient_credits") {
        code = "payment_paused";
        this.pause = { reason: "payment", message: `HTTP ${status}` };
      } else if (status === 400 || status === 422) {
        code = "bad_request";
      } else if (status === 404) {
        code = "not_found";
      } else if (status === 429) {
        code = "rate_limited";
        retryable = true;
        const ra = (headers.retryAfterS ?? 5) * 1000;
        this.deps.gate.pauseUntil(this.deps.clock.now() + ra);
      } else if (status >= 500) {
        // A provider query timeout means "adjust the query": an identical retry would fail the same way.
        retryable = providerCode !== "query_timeout";
      }
      finish({ http_outcome: "http_error", normalization_status: "not_applicable", error_code: providerCode ?? `http_${status}` });
      log(code === "auth_paused" || code === "payment_paused" ? "error" : "warn", "nansen-client", "Provider returned an error", { endpoint: def.name, status, providerCode, requestId: headers.requestId });
      if (code === "auth_paused" || code === "payment_paused" || code === "bad_request") this.recordOperationalError(code, `${def.name} HTTP ${status}${providerCode ? ` ${providerCode}` : ""}`);
      const out: CallFailure & { retryAfterMs?: number } = {
        ok: false,
        code,
        message: `Nansen returned HTTP ${status}`,
        snapshotId: null,
        attemptIds: [],
        retryable,
      };
      if (status === 429) out.retryAfterMs = (headers.retryAfterS ?? 5) * 1000;
      return out;
    }

    // HTTP success. Normalization is recorded separately; settlement always runs.
    let normalized: Normalized<T>;
    try {
      normalized = def.normalize(parseLossless(bodyText), req);
    } catch (err) {
      settle();
      const message = err instanceof SchemaMismatchError ? err.message : "Response body is not valid JSON";
      finish({ http_outcome: "success", normalization_status: "schema_error", error_code: "schema_error" });
      this.recordOperationalError("schema_error", `${def.name}: ${message}`);
      log("warn", "nansen-client", "Schema mismatch", { endpoint: def.name, message, requestId: headers.requestId });
      return { ok: false, code: "schema_error", message, snapshotId: null, attemptIds: [], retryable: false };
    }
    const fetchedAt = this.deps.clock.now();
    let snapshotId: string | null = null;
    try {
      if (meta.persist) snapshotId = this.persistSuccess(def, req, meta, paramHash, normalized, fetchedAt, attemptId);
    } catch (err) {
      log("error", "nansen-client", "Snapshot persistence failed; attempt and cost are retained", { endpoint: def.name, error: String(err) });
      this.recordOperationalError("snapshot_persist_failed", `${def.name}: ${String(err)}`);
    } finally {
      settle();
    }
    finish({ http_outcome: "success", normalization_status: "ok", error_code: null, snapshot_id: snapshotId });
    return {
      ok: true,
      source: "provider",
      snapshotId,
      normalized,
      fetchedAtMs: fetchedAt,
      requestStartedAtMs: startedAt,
      providerRequestId: headers.requestId,
      attemptIds: [],
    };
  }

  private persistSuccess<Req, T>(def: EndpointDef<Req, T>, req: Req, meta: CallMeta, paramHash: string, n: Normalized<T>, fetchedAt: number, attemptId: string): string {
    const id = newId("snap");
    this.deps.db
      .prepare(
        `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, scope_hash, fetched_at_ms,
           period_start_ms, period_end_ms, availability, coverage, reason_code, page, is_last_page, result_json, attempt_id, schema_version, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'nansen')`,
      )
      .run(id, this.deps.namespace, def.name, def.subjectType, def.subjectId(req), paramHash, canonicalJson(req), meta.scopeHash ?? null, fetchedAt,
        n.periodStartMs, n.periodEndMs, n.availability, n.isLastPage === true ? "window_scanned" : n.isLastPage === false ? "partial" : "unknown",
        n.page, n.isLastPage === null ? null : n.isLastPage ? 1 : 0, JSON.stringify(n.data), attemptId, `${def.name}.v1`);
    return id;
  }

  private persistFailure<Req, T>(def: EndpointDef<Req, T>, req: Req, meta: CallMeta, paramHash: string, f: CallFailure, attemptId: string | null): string {
    const id = newId("snap");
    const availability = f.code === "budget_paused" || f.code === "payment_paused" ? "budget_paused" : f.code === "not_found" ? "unavailable" : "error";
    this.deps.db
      .prepare(
        `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, scope_hash, fetched_at_ms,
           availability, coverage, reason_code, result_json, attempt_id, schema_version, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, NULL, ?, ?, 'nansen')`,
      )
      .run(id, this.deps.namespace, def.name, def.subjectType, def.subjectId(req), paramHash, canonicalJson(req), meta.scopeHash ?? null, this.deps.clock.now(),
        availability, f.code, attemptId, `${def.name}.v1`);
    return id;
  }

  private recordOperationalError(code: string, message: string): void {
    this.deps.db.prepare("INSERT INTO operational_errors (at_ms, component, code, message) VALUES (?, 'nansen-client', ?, ?)").run(this.deps.clock.now(), code, message.slice(0, 300));
    this.deps.db.prepare("DELETE FROM operational_errors WHERE id <= (SELECT MAX(id) - 500 FROM operational_errors)").run();
  }
}
