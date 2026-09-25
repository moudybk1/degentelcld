/**
 * Smart Money context engine (blueprint §9). Writes only observations,
 * observation sources, token window metrics, pack confirmation contexts, and
 * match evidence. It never writes packs, members, evidence, checkpoints, or
 * assessments, and nothing here feeds back into detection or priority.
 */
import type { PackSmartMoneyContext, PanelState, SmartMoneyWindow, SmartMoneyWindowMetric } from "@packlens/contracts";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { newId, sha256Hex } from "../lib/ids.js";
import { canonicalJson } from "../lib/json.js";
import { writeOutbox, type OutboxBus } from "../ingest/outbox.js";
import type { NansenClient } from "../adapters/nansen/client.js";
import { SMART_MONEY_DEX, SMART_MONEY_NETFLOW, type SmDexReq, type SmTrade } from "../adapters/nansen/endpoints.js";
import { aggregateWindows, WINDOW_MS, WINDOWS, type ObservationForCount, type WindowCoverage } from "./aggregate.js";
import { matchMembers } from "./matching.js";

export const SM_ADAPTER_VERSION = "sm-dex-v1";
export const TOKEN_METRIC_SCOPE = sha256Hex(canonicalJson({ endpoint: "smart-money/dex-trades", chain: "solana", labels: "endpoint-default-smart-money-group", adapter: SM_ADAPTER_VERSION }));
export const SM_DEX_FRESH_MS = 240_000;
export const NETFLOW_FRESH_MS = 300_000;

export function scopeHashFor(filters: SmDexReq["filters"] | undefined, perPage: number): string {
  return sha256Hex(canonicalJson({ endpoint: "smart-money/dex-trades", chain: "solana", filters: filters ?? null, perPage, labels: "endpoint-default-smart-money-group", adapter: SM_ADAPTER_VERSION }));
}

/** Fingerprint from chain, hash, wallet, token pair, amounts, and time; never invents a log ordinal. */
export function fingerprintTrade(t: SmTrade): string {
  return sha256Hex(
    canonicalJson([t.chain, t.transactionHash, t.traderAddress, t.tokenBoughtAddress, t.tokenSoldAddress, t.tokenBoughtAmount, t.tokenSoldAmount, t.blockTimeMs]),
  );
}

type ObsRow = {
  id: string;
  chain: string;
  transaction_hash: string;
  trader_address: string;
  trader_label: string | null;
  token_bought_address: string;
  token_sold_address: string;
  token_bought_symbol: string | null;
  token_sold_symbol: string | null;
  token_bought_amount: string | null;
  token_sold_amount: string | null;
  block_time_ms: number;
  trade_value_usd: string | null;
  ambiguous_swap_identity: number;
};

function toCount(r: ObsRow): ObservationForCount {
  return {
    id: r.id,
    chain: r.chain,
    transactionHash: r.transaction_hash,
    traderAddress: r.trader_address,
    tokenBoughtAddress: r.token_bought_address,
    tokenSoldAddress: r.token_sold_address,
    blockTimeMs: r.block_time_ms,
    tradeValueUsd: r.trade_value_usd,
    ambiguousSwapIdentity: r.ambiguous_swap_identity === 1,
  };
}

export type ScanResult = {
  ok: boolean;
  code: string | null;
  asOfMs: number | null;
  pages: number;
  coverage: Record<SmartMoneyWindow, WindowCoverage>;
  snapshotIds: string[];
  newObservations: number;
};

export class SmartMoneyService {
  constructor(
    private readonly db: Db,
    readonly namespace: string,
    private readonly clock: Clock,
    private readonly outbox: OutboxBus,
    private readonly client: NansenClient | null,
  ) {}

  /** Store a page of trades: one evidence identity per trade, several sources allowed. */
  ingestTrades(trades: SmTrade[], snapshotId: string, scopeHash: string): { inserted: number; ids: string[] } {
    const now = this.clock.now();
    const counts = new Map<string, number>();
    for (const t of trades) {
      const f = fingerprintTrade(t);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const insert = this.db.prepare(
      `INSERT INTO smart_money_observations (id, namespace, fingerprint, chain, transaction_hash, trader_address, trader_label, token_bought_address, token_sold_address,
         token_bought_symbol, token_sold_symbol, token_bought_amount, token_sold_amount, block_time_ms, trade_value_usd, ambiguous_swap_identity, first_seen_at_ms)
       VALUES (?, ?, ?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const markAmbiguous = this.db.prepare("UPDATE smart_money_observations SET ambiguous_swap_identity = 1 WHERE id = ?");
    const findId = this.db.prepare("SELECT id FROM smart_money_observations WHERE namespace = ? AND fingerprint = ?");
    const source = this.db.prepare(
      "INSERT INTO smart_money_observation_sources (namespace, observation_id, snapshot_id, scope_hash) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    );
    let inserted = 0;
    const ids: string[] = [];
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const t of trades) {
        const f = fingerprintTrade(t);
        if (seen.has(f)) continue;
        seen.add(f);
        // Identical rows inside one response cannot be told apart: keep one identity, flag it.
        const ambiguous = (counts.get(f) ?? 0) > 1;
        const existing = findId.get(this.namespace, f) as { id: string } | undefined;
        let id: string;
        if (existing) {
          id = existing.id;
          if (ambiguous) markAmbiguous.run(id);
        } else {
          id = newId("smobs");
          insert.run(id, this.namespace, f, t.transactionHash, t.traderAddress, t.traderLabel, t.tokenBoughtAddress, t.tokenSoldAddress,
            t.tokenBoughtSymbol, t.tokenSoldSymbol, t.tokenBoughtAmount, t.tokenSoldAmount, t.blockTimeMs, t.tradeValueUsd, ambiguous ? 1 : 0, now);
          inserted++;
        }
        ids.push(id);
        source.run(this.namespace, id, snapshotId, scopeHash);
      }
    })();
    return { inserted, ids };
  }

  /**
   * Targeted lookup for a bought mint, newest first. Stops at the 24-hour
   * lower bound, the last page, no progress, session end, or insufficient
   * credits. Coverage: page 1 is one consistent response, so any window whose
   * lower bound page 1 crosses (or a last page 1) is window_scanned; windows
   * that need later pages of a rolling feed remain partial.
   */
  async targetedLookup(mint: string, jobId: string | null, perPage = 100): Promise<ScanResult> {
    const coverage: Record<SmartMoneyWindow, WindowCoverage> = { "5m": "unknown", "1h": "unknown", "24h": "unknown" };
    if (!this.client) return { ok: false, code: "no_client", asOfMs: null, pages: 0, coverage, snapshotIds: [], newObservations: 0 };
    const filters = { token_bought_address: mint };
    const scopeHash = scopeHashFor(filters, perPage);
    const snapshotIds: string[] = [];
    let asOf: number | null = null;
    let pageNo = 1;
    let newObs = 0;
    const seenFingerprints = new Set<string>();
    for (;;) {
      const req: SmDexReq = { chains: ["solana"], filters, pagination: { page: pageNo, per_page: perPage }, order_by: [{ field: "block_timestamp", direction: "DESC" }] };
      const res = await this.client.call(SMART_MONEY_DEX, req, { lane: "SMART_MONEY", purpose: "smart_money_token_lookup", jobId, persist: true, scopeHash });
      if (!res.ok) {
        if (pageNo === 1) return { ok: false, code: res.code, asOfMs: null, pages: 0, coverage, snapshotIds: res.snapshotId ? [res.snapshotId] : [], newObservations: 0 };
        break; // earlier pages remain valid; later windows stay partial
      }
      if (res.snapshotId) snapshotIds.push(res.snapshotId);
      if (pageNo === 1) asOf = res.fetchedAtMs;
      const trades = res.normalized.data.trades;
      const before = seenFingerprints.size;
      for (const t of trades) seenFingerprints.add(fingerprintTrade(t));
      if (res.snapshotId) newObs += this.ingestTrades(trades, res.snapshotId, scopeHash).inserted;
      const oldest = res.normalized.data.oldestMs;
      const last = res.normalized.isLastPage === true || trades.length < perPage;
      if (pageNo === 1) {
        for (const w of WINDOWS) {
          const lower = asOf! - WINDOW_MS[w];
          if (last || (oldest !== null && oldest <= lower)) coverage[w] = "window_scanned";
          else coverage[w] = "partial";
        }
      }
      const progressed = seenFingerprints.size > before;
      if (last || !progressed || (oldest !== null && oldest <= asOf! - WINDOW_MS["24h"])) break;
      pageNo++;
    }
    for (const w of WINDOWS) if (coverage[w] === "unknown") coverage[w] = "partial";
    this.recordScan(mint, asOf!, coverage, snapshotIds, pageNo);
    return { ok: true, code: null, asOfMs: asOf, pages: pageNo, coverage, snapshotIds, newObservations: newObs };
  }

  private recordScan(mint: string, asOfMs: number, coverage: Record<SmartMoneyWindow, WindowCoverage>, snapshotIds: string[], pages: number): void {
    this.db
      .prepare(
        `INSERT INTO poller_checkpoints (id, session_id, scope, last_page, request_count, last_run_at_ms, updated_at_ms, oldest_block_time_ms, newest_block_time_ms)
         VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET last_page = excluded.last_page, request_count = poller_checkpoints.request_count + excluded.request_count,
           last_run_at_ms = excluded.last_run_at_ms, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(`${this.namespace}|token|${mint}`, `token:${mint}`, pages, pages, asOfMs, this.clock.now());
    this.recompute(mint, asOfMs, coverage, snapshotIds);
  }

  /** Global feed: one page per poll, conservatively partial for every window. */
  async pollGlobalFeed(jobId: string | null, perPage = 100): Promise<ScanResult> {
    const coverage: Record<SmartMoneyWindow, WindowCoverage> = { "5m": "partial", "1h": "partial", "24h": "partial" };
    if (!this.client) return { ok: false, code: "no_client", asOfMs: null, pages: 0, coverage, snapshotIds: [], newObservations: 0 };
    const scopeHash = scopeHashFor(undefined, perPage);
    const req: SmDexReq = { chains: ["solana"], pagination: { page: 1, per_page: perPage }, order_by: [{ field: "block_timestamp", direction: "DESC" }] };
    const res = await this.client.call(SMART_MONEY_DEX, req, { lane: "SMART_MONEY", purpose: "smart_money_global_feed", jobId, persist: true, scopeHash, bypassCache: true });
    if (!res.ok || !res.snapshotId) return { ok: false, code: res.ok ? "not_persisted" : res.code, asOfMs: null, pages: 0, coverage, snapshotIds: [], newObservations: 0 };
    const trades = res.normalized.data.trades;
    const { inserted } = this.ingestTrades(trades, res.snapshotId, scopeHash);
    this.db
      .prepare(
        `INSERT INTO poller_checkpoints (id, session_id, scope, last_page, request_count, last_run_at_ms, updated_at_ms, oldest_block_time_ms, newest_block_time_ms)
         VALUES (?, NULL, 'global', 1, 1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET request_count = poller_checkpoints.request_count + 1, last_run_at_ms = excluded.last_run_at_ms,
           updated_at_ms = excluded.updated_at_ms, oldest_block_time_ms = excluded.oldest_block_time_ms, newest_block_time_ms = excluded.newest_block_time_ms`,
      )
      .run(`${this.namespace}|global`, res.fetchedAtMs, this.clock.now(), res.normalized.data.oldestMs, res.normalized.data.newestMs);
    // Tokens with packs that appear in the feed get a new (partial) metric revision.
    const mints = [...new Set(trades.map((t) => t.tokenBoughtAddress))];
    for (const mint of mints) {
      const hasPack = this.db.prepare("SELECT 1 FROM packs WHERE namespace = ? AND mint = ? LIMIT 1").get(this.namespace, mint);
      if (hasPack) this.recompute(mint, res.fetchedAtMs, coverage, [res.snapshotId]);
    }
    this.outbox.notifyCommitted(this.namespace);
    return { ok: true, code: null, asOfMs: res.fetchedAtMs, pages: 1, coverage, snapshotIds: [res.snapshotId], newObservations: inserted };
  }

  async netflowLookup(mint: string, jobId: string | null): Promise<{ ok: boolean; code: string | null; snapshotId: string | null }> {
    if (!this.client) return { ok: false, code: "no_client", snapshotId: null };
    const res = await this.client.call(
      SMART_MONEY_NETFLOW,
      { chains: ["solana"], filters: { token_address: mint }, pagination: { page: 1, per_page: 100 } },
      { lane: "SMART_MONEY", purpose: "smart_money_netflow", jobId, persist: true, scopeHash: sha256Hex(canonicalJson({ endpoint: "smart-money/netflow", chain: "solana", token: mint })) },
    );
    if (res.ok) this.bumpContextForMint(mint, "netflow");
    return { ok: res.ok, code: res.ok ? null : res.code, snapshotId: res.snapshotId };
  }

  private observationsFor(mint: string, sinceMs: number): ObservationForCount[] {
    return (
      this.db
        .prepare("SELECT * FROM smart_money_observations WHERE namespace = ? AND token_bought_address = ? AND block_time_ms > ?")
        .all(this.namespace, mint, sinceMs) as ObsRow[]
    ).map(toCount);
  }

  /** Recompute token windows and pack confirmations for a mint at one asOf. */
  recompute(mint: string, asOfMs: number, coverage: Record<SmartMoneyWindow, WindowCoverage>, snapshotIds: string[]): void {
    const now = this.clock.now();
    const observations = this.observationsFor(mint, asOfMs - WINDOW_MS["24h"]);
    const metrics = aggregateWindows({
      mint,
      asOfMs,
      observations,
      coverage,
      scopeHash: TOKEN_METRIC_SCOPE,
      snapshotIds,
      fetchedAtMs: asOfMs,
      checked: true,
      freshness: "fresh",
    });
    const rev = (this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS r FROM token_smart_money_metrics WHERE namespace = ? AND mint = ?").get(this.namespace, mint) as { r: number }).r + 1;
    const insert = this.db.prepare(
      `INSERT INTO token_smart_money_metrics (id, namespace, chain, mint, as_of_ms, window, window_start_ms, window_end_ms, observed_unique_buyers, count_qualifier,
         known_buy_usd, missing_valuation_count, ambiguous_trade_count, state_json, scope_hash, revision, source_snapshot_ids_json, created_at_ms)
       VALUES (?, ?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const m of metrics) {
        insert.run(newId("smm"), this.namespace, mint, asOfMs, m.window, Date.parse(m.windowStart), Date.parse(m.windowEnd), m.observedUniqueBuyers, m.countQualifier,
          m.knownBuyUsd, m.missingValuationCount, m.ambiguousTradeCount, JSON.stringify(m.state), m.scopeHash, rev, JSON.stringify(snapshotIds), now);
      }
      this.matchPacksForMint(mint, now);
    })();
    this.outbox.notifyCommitted(this.namespace);
  }

  /** New pack confirmation context versions for every pack of this mint. */
  private matchPacksForMint(mint: string, nowMs: number): void {
    const packs = this.db.prepare("SELECT id, evidence_version FROM packs WHERE namespace = ? AND mint = ?").all(this.namespace, mint) as { id: string; evidence_version: number }[];
    const allObs = (
      this.db
        .prepare(
          `SELECT * FROM smart_money_observations WHERE namespace = ? AND (token_bought_address = ? OR trader_address IN (
             SELECT pm.wallet FROM pack_members pm JOIN packs p ON p.id = pm.pack_id WHERE p.namespace = ? AND p.mint = ?))`,
        )
        .all(this.namespace, mint, this.namespace, mint) as ObsRow[]
    ).map(toCount);
    for (const p of packs) {
      const members = this.db.prepare("SELECT wallet, event_ids_json FROM pack_members WHERE pack_id = ?").all(p.id) as { wallet: string; event_ids_json: string }[];
      const sigStmt = this.db.prepare("SELECT signature FROM trade_events WHERE namespace = ? AND event_id = ?");
      const evidence = members.map((m) => ({
        walletAddress: m.wallet,
        signatures: (JSON.parse(m.event_ids_json) as string[]).map((id) => (sigStmt.get(this.namespace, id) as { signature: string }).signature),
      }));
      const result = matchMembers({ mint, members: evidence, observations: allObs, checked: true, checkedAtMs: nowMs });
      const prev = this.db.prepare("SELECT COALESCE(MAX(context_version), 0) AS v FROM pack_smart_money_contexts WHERE pack_id = ?").get(p.id) as { v: number };
      const version = prev.v + 1;
      const matched = [...new Set(result.matches.flatMap((m) => (m.matchState === "pack_buy_confirmed" ? m.matchedObservationIds : [])))];
      const state: PanelState = {
        availability: result.confirmedMemberCount && result.confirmedMemberCount > 0 ? "available" : "empty",
        coverage: "partial",
        freshness: "fresh",
        fetchedAt: new Date(nowMs).toISOString(),
        periodStart: null,
        periodEnd: null,
        reasonCode: null,
        snapshotIds: [],
      };
      this.db
        .prepare(
          `INSERT INTO pack_smart_money_contexts (pack_id, namespace, context_version, evidence_version, confirmed_member_count, checked_member_count, total_member_count,
             matched_observation_ids_json, member_matches_json, state_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, this.namespace, version, p.evidence_version, result.confirmedMemberCount, result.checkedMemberCount, members.length, JSON.stringify(matched),
          JSON.stringify(result.matches), JSON.stringify(state), nowMs);
      const ev = this.db.prepare(
        "INSERT INTO pack_smart_money_evidence (namespace, pack_id, observation_id, wallet, match_level, created_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      );
      for (const m of result.matches) {
        if (m.matchState === "pack_buy_confirmed" || m.matchState === "ambiguous" || m.matchState === "wallet_seen") {
          for (const oid of m.matchedObservationIds) ev.run(this.namespace, p.id, oid, m.walletAddress, m.matchState, nowMs);
        }
      }
      writeOutbox(this.db, this.namespace, "smart_money.updated", p.id, version, { packId: p.id, contextVersion: version, mint }, nowMs);
    }
  }

  private bumpContextForMint(mint: string, reason: string): void {
    const packs = this.db.prepare("SELECT id FROM packs WHERE namespace = ? AND mint = ?").all(this.namespace, mint) as { id: string }[];
    const now = this.clock.now();
    for (const p of packs) {
      const v = (this.db.prepare("SELECT COALESCE(MAX(context_version), 0) AS v FROM pack_smart_money_contexts WHERE pack_id = ?").get(p.id) as { v: number }).v;
      writeOutbox(this.db, this.namespace, "smart_money.updated", p.id, v, { packId: p.id, mint, reason }, now);
    }
    this.outbox.notifyCommitted(this.namespace);
  }

  /* ---------------------------------------------------------------- */
  /* Read models                                                      */
  /* ---------------------------------------------------------------- */

  latestWindows(mint: string): { asOf: string | null; windows: SmartMoneyWindowMetric[] } {
    const rev = this.db
      .prepare("SELECT MAX(revision) AS r FROM token_smart_money_metrics WHERE namespace = ? AND mint = ?")
      .get(this.namespace, mint) as { r: number | null };
    const now = this.clock.now();
    if (rev.r === null) {
      return { asOf: null, windows: aggregateWindows({ mint, asOfMs: now, observations: [], coverage: { "5m": "unknown", "1h": "unknown", "24h": "unknown" }, scopeHash: TOKEN_METRIC_SCOPE, snapshotIds: [], fetchedAtMs: null, checked: false, freshness: "unknown" }) };
    }
    const rows = this.db
      .prepare("SELECT * FROM token_smart_money_metrics WHERE namespace = ? AND mint = ? AND revision = ?")
      .all(this.namespace, mint, rev.r) as {
      window: SmartMoneyWindow; window_start_ms: number; window_end_ms: number; observed_unique_buyers: number | null; count_qualifier: SmartMoneyWindowMetric["countQualifier"];
      known_buy_usd: string | null; missing_valuation_count: number; ambiguous_trade_count: number; state_json: string; scope_hash: string; as_of_ms: number;
    }[];
    const byWindow = new Map(rows.map((r) => [r.window, r]));
    const asOfMs = rows[0]?.as_of_ms ?? now;
    const stale = now - asOfMs > SM_DEX_FRESH_MS;
    const windows = WINDOWS.map((w) => {
      const r = byWindow.get(w)!;
      const state = JSON.parse(r.state_json) as PanelState;
      // Old snapshots keep their original period and values; only freshness changes.
      state.freshness = stale ? "stale" : "fresh";
      return {
        window: w,
        windowStart: new Date(r.window_start_ms).toISOString(),
        windowEnd: new Date(r.window_end_ms).toISOString(),
        observedUniqueBuyers: r.observed_unique_buyers,
        countQualifier: r.count_qualifier,
        knownBuyUsd: r.known_buy_usd,
        missingValuationCount: r.missing_valuation_count,
        ambiguousTradeCount: r.ambiguous_trade_count,
        state,
        scopeHash: r.scope_hash,
      };
    });
    return { asOf: new Date(asOfMs).toISOString(), windows };
  }

  packContext(packId: string, totalMemberCount: number, members: string[]): PackSmartMoneyContext {
    const row = this.db
      .prepare("SELECT * FROM pack_smart_money_contexts WHERE pack_id = ? ORDER BY context_version DESC LIMIT 1")
      .get(packId) as
      | { context_version: number; evidence_version: number | null; confirmed_member_count: number | null; checked_member_count: number; total_member_count: number; matched_observation_ids_json: string; member_matches_json: string; state_json: string; updated_at_ms: number }
      | undefined;
    if (!row) {
      return {
        packId,
        evidenceVersion: null,
        contextVersion: 0,
        confirmedMemberCount: null,
        checkedMemberCount: 0,
        totalMemberCount,
        matchedObservationIds: [],
        memberMatches: members.map((w) => ({ walletAddress: w, matchState: "not_checked", matchedObservationIds: [], checkedAt: null })),
        state: { availability: "not_requested", coverage: "unknown", freshness: "unknown", fetchedAt: null, periodStart: null, periodEnd: null, reasonCode: null, snapshotIds: [] },
        updatedAt: null,
      };
    }
    const matches = JSON.parse(row.member_matches_json) as PackSmartMoneyContext["memberMatches"];
    // Members added after the last check are shown as not checked.
    const known = new Set(matches.map((m) => m.walletAddress));
    for (const w of members) if (!known.has(w)) matches.push({ walletAddress: w, matchState: "not_checked", matchedObservationIds: [], checkedAt: null });
    return {
      packId,
      evidenceVersion: row.evidence_version,
      contextVersion: row.context_version,
      confirmedMemberCount: row.confirmed_member_count,
      checkedMemberCount: row.checked_member_count,
      totalMemberCount,
      matchedObservationIds: JSON.parse(row.matched_observation_ids_json) as string[],
      memberMatches: matches,
      state: JSON.parse(row.state_json) as PanelState,
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    };
  }
}
