/**
 * Read models for public GET routes. Everything here reads committed storage;
 * no function in this file can reach a provider or spend credits.
 */
import type {
  Assessment,
  EvidenceMeta,
  HoldersData,
  Netflow,
  Pack,
  PackDetail,
  PackListData,
  PackListItem,
  PackMember,
  Panel,
  PatternMetrics,
  RadarFilters,
  RelatedData,
  SmartMoneyActivityData,
  SmartMoneyActivityRow,
  TokenIdentity,
  TokenInfoData,
  TokenPageData,
  TradeEvent,
  WalletContext,
  WalletPageData,
  BalanceData,
  PnlData,
  DexHistoryData,
  AnalysisState,
} from "@packlens/contracts";
import type { Clock } from "../clock.js";
import { WSOL_MINT, type AppConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { canonical, Decimal, parseDecimal } from "../lib/decimal.js";
import { sha256Hex } from "../lib/ids.js";
import { canonicalJson } from "../lib/json.js";
import { observedTopShare } from "../assessment/assessment.js";
import { NETFLOW_FRESH_MS, SmartMoneyService } from "../smart-money/service.js";
import type { OutboxBus } from "../ingest/outbox.js";
import { buildPanel } from "./panels.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { packSentence, smartMoneySentence } from "./templates.js";
import { afterDetail, afterSummary, earlierPacks } from "./afterPack.js";
import { buildReadout } from "./readout.js";

const QUOTE_LIKE = new Set([
  WSOL_MINT,
  "11111111111111111111111111111111",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export type PackRow = {
  id: string;
  namespace: string;
  mint: string;
  state: "collecting" | "frozen";
  config_version: string;
  evidence_version: number;
  core_version: number;
  first_event_time_ms: number;
  trigger_event_time_ms: number;
  trigger_event_id: string;
  triggered_at_ms: number;
  last_accepted_event_time_ms: number;
  initial_wallet_count: number;
  total_wallet_count: number;
  eligible_buy_usd: string;
  expansion_end_ms: number;
  suppress_until_ms: number;
  frozen_at_ms: number | null;
  invalidated: number;
  patterns_json: string;
};

export function toPack(r: PackRow): Pack {
  return {
    id: r.id,
    namespace: r.namespace,
    chain: "solana",
    tokenAddress: r.mint,
    state: r.state,
    configVersion: r.config_version,
    firstEventTimeMs: r.first_event_time_ms,
    triggerEventTimeMs: r.trigger_event_time_ms,
    triggeredAtMs: r.triggered_at_ms,
    lastAcceptedEventTimeMs: r.last_accepted_event_time_ms,
    initialWalletCount: r.initial_wallet_count,
    totalWalletCount: r.total_wallet_count,
    eligibleBuyUsd: r.eligible_buy_usd,
    expansionEndMs: r.expansion_end_ms,
    suppressUntilMs: r.suppress_until_ms,
    coreVersion: r.core_version,
    evidenceVersion: r.evidence_version,
  };
}

export class InvalidInputError extends Error {}

const WALLET_TTL = { pnl: 60 * 60_000, dex: 5 * 60_000, related: 15 * 60_000, balance: 60_000 };

export class ReadModels {
  private readonly smCache = new Map<string, SmartMoneyService>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly outbox: OutboxBus,
    private readonly cursorKey: Buffer,
  ) {}

  private sm(namespace: string): SmartMoneyService {
    let s = this.smCache.get(namespace);
    if (!s) {
      s = new SmartMoneyService(this.db, namespace, this.clock, this.outbox, null);
      this.smCache.set(namespace, s);
    }
    return s;
  }

  namespaceMode(namespace: string): "fixture" | "live" | "replay" | null {
    const row = this.db.prepare("SELECT mode FROM namespaces WHERE id = ?").get(namespace) as { mode: "fixture" | "live" | "replay" } | undefined;
    return row?.mode ?? null;
  }

  tokenIdentity(namespace: string, mint: string): TokenIdentity {
    const t = this.db.prepare("SELECT name, symbol FROM tokens WHERE namespace = ? AND chain = 'solana' AND mint = ?").get(namespace, mint) as
      | { name: string | null; symbol: string | null }
      | undefined;
    if (t && (t.name || t.symbol)) return { chain: "solana", mint, name: t.name, symbol: t.symbol, identitySource: "pumpfun_create_event" };
    const s = this.db
      .prepare("SELECT result_json FROM enrichment_snapshots WHERE namespace = ? AND endpoint = 'tgm/token-information' AND subject_id = ? AND availability = 'available' ORDER BY fetched_at_ms DESC LIMIT 1")
      .get(namespace, mint) as { result_json: string } | undefined;
    if (s) {
      const d = JSON.parse(s.result_json) as TokenInfoData | null;
      if (d && (d.name || d.symbol)) return { chain: "solana", mint, name: d.name, symbol: d.symbol, identitySource: "nansen_token_information" };
    }
    return { chain: "solana", mint, name: null, symbol: null, identitySource: null };
  }

  private latestAssessment(packId: string, totalMemberCount: number): Assessment {
    const r = this.db
      .prepare("SELECT version, analysis_state, review_flags_json, scheduled_member_count, snapshot_ids_json FROM pack_assessments WHERE pack_id = ? ORDER BY version DESC LIMIT 1")
      .get(packId) as { version: number; analysis_state: AnalysisState; review_flags_json: string; scheduled_member_count: number; snapshot_ids_json: string } | undefined;
    if (!r) return { version: 0, analysisState: "not_requested", reviewFlags: [], scheduledMemberCount: 0, totalMemberCount, snapshotIds: [] };
    return {
      version: r.version,
      analysisState: r.analysis_state,
      reviewFlags: JSON.parse(r.review_flags_json) as Assessment["reviewFlags"],
      scheduledMemberCount: r.scheduled_member_count,
      totalMemberCount,
      snapshotIds: JSON.parse(r.snapshot_ids_json) as string[],
    };
  }

  private memberWallets(packId: string): string[] {
    return (this.db.prepare("SELECT wallet FROM pack_members WHERE pack_id = ? ORDER BY member_kind DESC, first_entry_time_ms, wallet").all(packId) as { wallet: string }[]).map((m) => m.wallet);
  }

  listItem(r: PackRow): PackListItem {
    const core = toPack(r);
    const windows = this.sm(r.namespace).latestWindows(r.mint);
    const ctx = this.sm(r.namespace).packContext(r.id, r.total_wallet_count, this.memberWallets(r.id));
    return {
      core,
      token: this.tokenIdentity(r.namespace, r.mint),
      patterns: JSON.parse(r.patterns_json) as PatternMetrics,
      analysisState: this.latestAssessment(r.id, r.total_wallet_count).analysisState,
      smartMoney1h: windows.windows[1]!,
      confirmedMemberCount: ctx.confirmedMemberCount,
      totalMemberCount: r.total_wallet_count,
      invalidated: r.invalidated === 1,
      after: afterSummary(this.db, r, r.total_wallet_count),
    };
  }

  /** Radar refresh: compact after-pack facts for visible cards. */
  afterSummaries(ids: string[]): Record<string, import("@packlens/contracts").AfterPackSummary> {
    const out: Record<string, import("@packlens/contracts").AfterPackSummary> = {};
    const stmt = this.db.prepare("SELECT * FROM packs WHERE id = ?");
    for (const id of ids) {
      const r = stmt.get(id) as PackRow | undefined;
      if (r) out[id] = afterSummary(this.db, r, r.total_wallet_count);
    }
    return out;
  }

  listPacks(namespace: string, filters: RadarFilters, cursor: string | null, limit: number): PackListData {
    const filterHash = sha256Hex(canonicalJson(filters));
    // The page snapshot covers every pack processed so far (virtual clocks may run ahead of wall time).
    const newest = this.db.prepare("SELECT MAX(triggered_at_ms) AS t FROM packs WHERE namespace = ?").get(namespace) as { t: number | null };
    let asOf = Math.max(this.clock.now(), newest.t ?? 0);
    let after: { t: number; id: string } | null = null;
    if (cursor) {
      const c = decodeCursor(this.cursorKey, cursor);
      if (!c || c.ns !== namespace || c.fh !== filterHash) throw new InvalidInputError("The cursor does not match this namespace or filter set.");
      asOf = c.asOf;
      after = { t: c.t, id: c.id };
    }
    const where: string[] = ["p.namespace = ?", "p.total_wallet_count >= ?", "p.triggered_at_ms <= ?"];
    const args: unknown[] = [namespace, filters.minWallets, asOf];
    if (!filters.includeInvalidated) where.push("p.invalidated = 0");
    if (filters.mint) {
      where.push("p.mint = ?");
      args.push(filters.mint);
    }
    if (filters.from) {
      where.push("p.trigger_event_time_ms >= ?");
      args.push(Date.parse(filters.from));
    }
    if (filters.to) {
      where.push("p.trigger_event_time_ms <= ?");
      args.push(Date.parse(filters.to));
    }
    const minUsd = parseDecimal(filters.minUsd);
    if (minUsd.greaterThan(0)) {
      // Approximate prefilter; the exact decimal comparison happens below.
      where.push("p.eligible_buy_usd_approx >= ?");
      args.push(minUsd.toNumber() * (1 - 1e-9));
    }
    if (filters.confirmedSmartMoneyOnly) {
      where.push(
        `EXISTS (SELECT 1 FROM pack_smart_money_contexts c WHERE c.pack_id = p.id AND c.confirmed_member_count > 0
           AND c.context_version = (SELECT MAX(context_version) FROM pack_smart_money_contexts c2 WHERE c2.pack_id = p.id))`,
      );
    }
    const afterClause = "(p.trigger_event_time_ms < ? OR (p.trigger_event_time_ms = ? AND p.id < ?))";
    const batchStmt = this.db.prepare(`SELECT p.* FROM packs p WHERE ${where.join(" AND ")} AND ${afterClause} ORDER BY p.trigger_event_time_ms DESC, p.id DESC LIMIT ?`);
    const firstStmt = this.db.prepare(`SELECT p.* FROM packs p WHERE ${where.join(" AND ")} ORDER BY p.trigger_event_time_ms DESC, p.id DESC LIMIT ?`);
    const existsStmt = this.db.prepare(`SELECT 1 FROM packs p WHERE ${where.join(" AND ")} AND ${afterClause} LIMIT 1`);
    const batchSize = limit + 1;
    const items: PackListItem[] = [];
    let lastScanned: PackRow | null = null;
    let position = after;
    // Scan in (trigger time, id) order; the exact USD post-filter may skip rows.
    for (;;) {
      const rows = (position ? batchStmt.all(...args, position.t, position.t, position.id, batchSize) : firstStmt.all(...args, batchSize)) as PackRow[];
      for (const r of rows) {
        lastScanned = r;
        if (minUsd.greaterThan(0) && parseDecimal(r.eligible_buy_usd).lessThan(minUsd)) continue;
        items.push(this.listItem(r));
        if (items.length === limit) break;
      }
      if (items.length === limit || rows.length < batchSize || !lastScanned) break;
      position = { t: lastScanned.trigger_event_time_ms, id: lastScanned.id };
    }
    let nextCursor: string | null = null;
    if (items.length === limit && lastScanned) {
      const more = existsStmt.get(...args, lastScanned.trigger_event_time_ms, lastScanned.trigger_event_time_ms, lastScanned.id);
      if (more) nextCursor = encodeCursor(this.cursorKey, { ns: namespace, fh: filterHash, t: lastScanned.trigger_event_time_ms, id: lastScanned.id, asOf });
    }
    return { items, nextCursor, asOf: new Date(asOf).toISOString(), filters };
  }

  private walletContext(namespace: string, wallet: string, mint: string | null, members: Set<string>): WalletContext {
    const now = this.clock.now();
    const related = buildPanel<Omit<RelatedData, "related"> & { related: Omit<RelatedData["related"][number], "isPackMember">[] }>(this.db, now, {
      namespace, endpoint: "profiler/address/related-wallets", subjectId: wallet, ttlMs: WALLET_TTL.related, jobType: "related_wallets",
    });
    const balance = buildPanel<Omit<BalanceData, "scheduledAt">>(this.db, now, {
      namespace, endpoint: "profiler/address/current-balance", subjectId: wallet, ttlMs: WALLET_TTL.balance, jobType: "balance_followup",
      ...(mint ? { paramFilter: { path: "$.filters.token_address", value: mint } } : {}),
    });
    let scheduledAt: string | null = null;
    if (mint) {
      const job = this.db
        .prepare("SELECT payload_json FROM jobs WHERE namespace = ? AND type = 'balance_followup' AND subject = ? AND json_extract(payload_json, '$.mint') = ? ORDER BY enqueued_at_ms DESC LIMIT 1")
        .get(namespace, wallet, mint) as { payload_json: string } | undefined;
      if (job) {
        const at = (JSON.parse(job.payload_json) as { scheduledAtMs?: number }).scheduledAtMs;
        scheduledAt = typeof at === "number" ? new Date(at).toISOString() : null;
      }
    }
    return {
      walletAddress: wallet,
      pnl: buildPanel<PnlData>(this.db, now, { namespace, endpoint: "profiler/address/pnl-summary", subjectId: wallet, ttlMs: WALLET_TTL.pnl, jobType: "wallet_pnl" }),
      dexHistory: buildPanel<DexHistoryData>(this.db, now, { namespace, endpoint: "profiler/dex-trades", subjectId: wallet, ttlMs: WALLET_TTL.dex, jobType: "wallet_dex" }),
      related: {
        state: related.state,
        data: related.data ? { ...related.data, related: related.data.related.map((r) => ({ ...r, isPackMember: members.has(r.address) && r.address !== wallet })) } : null,
      },
      balance: { state: balance.state, data: balance.data ? { ...balance.data, scheduledAt } : null },
    };
  }

  private tokenPanels(namespace: string, mint: string, members: Set<string>): { tokenInfo: Panel<TokenInfoData>; holders: Panel<HoldersData> } {
    const now = this.clock.now();
    const tokenInfo = buildPanel<TokenInfoData>(this.db, now, { namespace, endpoint: "tgm/token-information", subjectId: mint, ttlMs: 120_000, jobType: "token_info" });
    const raw = buildPanel<Omit<HoldersData, "observedTopShare" | "totalSupplyUsed" | "holders"> & { holders: Omit<HoldersData["holders"][number], "isPackMember">[] }>(
      this.db, now, { namespace, endpoint: "tgm/holders", subjectId: mint, ttlMs: 300_000, jobType: "holders" },
    );
    let holders: Panel<HoldersData> = { state: raw.state, data: null };
    if (raw.data) {
      const supply = tokenInfo.data?.totalSupply ?? null;
      holders = {
        state: raw.state,
        data: {
          ...raw.data,
          holders: raw.data.holders.map((h) => ({ ...h, isPackMember: members.has(h.address) })),
          observedTopShare: observedTopShare(raw.data.holders.map((h) => h.tokenAmount), supply, true),
          totalSupplyUsed: supply,
        },
      };
    }
    return { tokenInfo, holders };
  }

  private netflowPanel(namespace: string, mint: string): Panel<Netflow> {
    const p = buildPanel<Omit<Netflow, "fetchedAt" | "scopeHash"> & { rowFound: boolean }>(this.db, this.clock.now(), {
      namespace, endpoint: "smart-money/netflow", subjectId: mint, ttlMs: NETFLOW_FRESH_MS, jobType: "sm_netflow",
    });
    if (!p.data) return { state: p.state, data: null };
    return {
      state: p.state,
      data: { asOf: null, fetchedAt: p.state.fetchedAt!, values: p.data.values, scopeHash: sha256Hex(canonicalJson({ endpoint: "smart-money/netflow", chain: "solana", token: mint })), traderCount30d: p.data.traderCount30d ?? null },
    };
  }

  packDetail(packId: string): PackDetail | null {
    const r = this.db.prepare("SELECT * FROM packs WHERE id = ?").get(packId) as PackRow | undefined;
    if (!r) return null;
    const ns = r.namespace;
    const core = toPack(r);
    const members = (
      this.db.prepare("SELECT * FROM pack_members WHERE pack_id = ?").all(packId) as {
        wallet: string; member_kind: "initial" | "expanded"; first_entry_time_ms: number; initial_first_entry_time_ms: number | null; joined_at_event_time_ms: number; eligible_buy_usd: string; event_ids_json: string;
      }[]
    )
      .map(
        (m): PackMember => ({
          packId,
          walletAddress: m.wallet,
          memberKind: m.member_kind,
          firstEntryTimeMs: m.first_entry_time_ms,
          initialFirstEntryTimeMs: m.initial_first_entry_time_ms,
          joinedAtEventTimeMs: m.joined_at_event_time_ms,
          eligibleBuyUsd: m.eligible_buy_usd,
          eventIds: JSON.parse(m.event_ids_json) as string[],
        }),
      )
      .sort((a, b) => (a.memberKind !== b.memberKind ? (a.memberKind === "initial" ? -1 : 1) : a.firstEntryTimeMs - b.firstEntryTimeMs || (a.walletAddress < b.walletAddress ? -1 : 1)));
    const evRows = this.db
      .prepare(
        `SELECT te.payload_json, te.eligibility, pe.event_id, pe.evidence_role, pe.accepted_at_event_time_ms, pe.accepted_at_expansion
         FROM pack_events pe JOIN trade_events te ON te.namespace = pe.namespace AND te.event_id = pe.event_id
         WHERE pe.pack_id = ? ORDER BY te.event_time_ms, te.slot, te.signature, te.event_ordinal`,
      )
      .all(packId) as { payload_json: string; eligibility: TradeEvent["coreEligibility"]; event_id: string; evidence_role: "initial" | "expansion"; accepted_at_event_time_ms: number; accepted_at_expansion: number }[];
    const evidence = evRows.map((e) => ({ ...(JSON.parse(e.payload_json) as TradeEvent), coreEligibility: e.eligibility }));
    const evidenceMeta: EvidenceMeta[] = evRows.map((e) => ({ eventId: e.event_id, role: e.evidence_role, acceptedAtEventTimeMs: e.accepted_at_event_time_ms, acceptedAtExpansion: e.accepted_at_expansion === 1 }));
    const patterns = JSON.parse(r.patterns_json) as PatternMetrics;
    const assessment = this.latestAssessment(packId, r.total_wallet_count);
    const memberSet = new Set(members.map((m) => m.walletAddress));
    const windows = this.sm(ns).latestWindows(r.mint);
    const packConfirmation = this.sm(ns).packContext(packId, r.total_wallet_count, members.map((m) => m.walletAddress));
    const enr = this.db.prepare("SELECT profile_wallets_json, relationship_wallets_json FROM pack_enrichment WHERE pack_id = ?").get(packId) as
      | { profile_wallets_json: string; relationship_wallets_json: string }
      | undefined;
    const profileWallets = enr ? (JSON.parse(enr.profile_wallets_json) as string[]) : [];
    const relWallets = enr ? (JSON.parse(enr.relationship_wallets_json) as string[]) : [];
    const { tokenInfo, holders } = this.tokenPanels(ns, r.mint, memberSet);

    const windowLow = r.first_event_time_ms - 20_000;
    const windowHigh = r.expansion_end_ms;
    const gaps = this.db
      .prepare("SELECT id FROM collector_gaps WHERE namespace = ? AND started_at_ms <= ? AND (ended_at_ms IS NULL OR ended_at_ms >= ?)")
      .all(ns, windowHigh, windowLow - 60_000) as { id: string }[];
    const late = this.db
      .prepare("SELECT COUNT(*) AS n FROM trade_events WHERE namespace = ? AND mint = ? AND admission = 'late' AND event_time_ms BETWEEN ? AND ?")
      .get(ns, r.mint, windowLow, windowHigh) as { n: number };
    const unvalued = this.db
      .prepare("SELECT COUNT(*) AS n FROM trade_events WHERE namespace = ? AND mint = ? AND side = 'buy' AND valuation_status <> 'valued' AND event_time_ms BETWEEN ? AND ?")
      .get(ns, r.mint, windowLow, windowHigh) as { n: number };

    const pinned = this.db.prepare("SELECT enabled FROM demo_pins WHERE namespace = ? AND chain = 'solana' AND mint = ?").get(ns, r.mint) as { enabled: number } | undefined;

    const history: { at: string; kind: string; detail: string }[] = [];
    history.push({ at: new Date(r.triggered_at_ms).toISOString(), kind: "pack", detail: `Pack triggered with ${r.initial_wallet_count} initial wallets.` });
    const expansions = this.db
      .prepare("SELECT evidence_version, MIN(accepted_at_event_time_ms) AS at, COUNT(*) AS n FROM pack_events WHERE pack_id = ? AND evidence_role = 'expansion' GROUP BY evidence_version ORDER BY evidence_version")
      .all(packId) as { evidence_version: number; at: number; n: number }[];
    for (const e of expansions) history.push({ at: new Date(e.at).toISOString(), kind: "pack", detail: `Expansion accepted ${e.n} new evidence ${e.n === 1 ? "event" : "events"} (evidence version ${e.evidence_version}).` });
    if (r.frozen_at_ms) history.push({ at: new Date(r.frozen_at_ms).toISOString(), kind: "pack", detail: "Expansion window closed; pack frozen." });
    const assessments = this.db.prepare("SELECT version, analysis_state, created_at_ms FROM pack_assessments WHERE pack_id = ? ORDER BY version").all(packId) as { version: number; analysis_state: string; created_at_ms: number }[];
    for (const a of assessments.slice(1)) history.push({ at: new Date(a.created_at_ms).toISOString(), kind: "analysis", detail: `Base analysis ${a.analysis_state.replace(/_/g, " ")} (version ${a.version}).` });
    const contexts = this.db.prepare("SELECT context_version, confirmed_member_count, updated_at_ms FROM pack_smart_money_contexts WHERE pack_id = ? ORDER BY context_version").all(packId) as { context_version: number; confirmed_member_count: number | null; updated_at_ms: number }[];
    for (const c of contexts) history.push({ at: new Date(c.updated_at_ms).toISOString(), kind: "smart_money", detail: `Smart Money context checked (version ${c.context_version}); ${c.confirmed_member_count ?? 0} confirmed ${c.confirmed_member_count === 1 ? "member" : "members"}.` });
    history.sort((a, b) => a.at.localeCompare(b.at));

    const summary = `${packSentence(core, patterns)} ${smartMoneySentence(windows.windows[1], packConfirmation)}`;
    const after = afterDetail(this.db, r, members, evRows.map((e) => e.event_id), this.clock.now());
    const earlier = earlierPacks(this.db, r, members.map((m) => m.walletAddress));
    const coverage: PackDetail["coverage"] = {
      source: "pumpfun",
      commitment: "confirmed",
      quoteMints: this.config.price.quotes.map((q) => q.priceMint),
      gapIds: gaps.map((g) => g.id),
      lateEventCount: late.n,
      unvaluedEventCount: unvalued.n,
      auditedInvalidated: r.invalidated === 1,
    };
    const token = this.tokenIdentity(ns, r.mint);
    const readout = buildReadout({ core, token, patterns, after, earlier, oneHour: windows.windows[1], confirmation: packConfirmation, assessment, coverage });

    return {
      core,
      members,
      evidence,
      patterns,
      assessment,
      smartMoney: {
        contextVersion: packConfirmation.contextVersion,
        asOf: windows.asOf,
        windows: windows.windows,
        packConfirmation,
        netflow: this.netflowPanel(ns, r.mint),
      },
      coverage,
      evidenceMeta,
      token,
      context: {
        tokenInfo,
        holders,
        wallets: [...new Set([...profileWallets, ...relWallets])].map((w) => this.walletContext(ns, w, r.mint, memberSet)),
        selectedProfileWallets: profileWallets,
        selectedRelationshipWallets: relWallets,
      },
      summary,
      history,
      isDemoPinned: pinned?.enabled === 1,
      after,
      earlierPacks: earlier,
      readout,
    };
  }

  walletPage(namespace: string, wallet: string): WalletPageData {
    const packs = this.db
      .prepare(
        `SELECT pm.pack_id, p.mint, pm.member_kind, pm.first_entry_time_ms, pm.eligible_buy_usd, p.trigger_event_time_ms FROM pack_members pm
         JOIN packs p ON p.id = pm.pack_id WHERE pm.namespace = ? AND pm.wallet = ? ORDER BY p.trigger_event_time_ms DESC LIMIT 100`,
      )
      .all(namespace, wallet) as { pack_id: string; mint: string; member_kind: "initial" | "expanded"; first_entry_time_ms: number; eligible_buy_usd: string; trigger_event_time_ms: number }[];
    const latestMint = packs[0]?.mint ?? null;
    const members = new Set<string>();
    if (packs[0]) for (const w of this.memberWallets(packs[0].pack_id)) members.add(w);
    return {
      walletAddress: wallet,
      context: this.walletContext(namespace, wallet, latestMint, members),
      packs: packs.map((p) => ({
        packId: p.pack_id,
        tokenAddress: p.mint,
        tokenSymbol: this.tokenIdentity(namespace, p.mint).symbol,
        memberKind: p.member_kind,
        firstEntryTimeMs: p.first_entry_time_ms,
        eligibleBuyUsd: p.eligible_buy_usd,
        triggerEventTimeMs: p.trigger_event_time_ms,
      })),
    };
  }

  tokenPage(namespace: string, mint: string): TokenPageData {
    const packRows = this.db.prepare("SELECT * FROM packs WHERE namespace = ? AND mint = ? ORDER BY trigger_event_time_ms DESC, id DESC LIMIT 50").all(namespace, mint) as PackRow[];
    const members = new Set<string>();
    for (const p of packRows) for (const w of this.memberWallets(p.id)) members.add(w);
    const { tokenInfo, holders } = this.tokenPanels(namespace, mint, members);
    const windows = this.sm(namespace).latestWindows(mint);
    const first = this.db.prepare("SELECT MIN(event_time_ms) AS t FROM trade_events WHERE namespace = ? AND mint = ?").get(namespace, mint) as { t: number | null };
    const pinned = this.db.prepare("SELECT enabled FROM demo_pins WHERE namespace = ? AND chain = 'solana' AND mint = ?").get(namespace, mint) as { enabled: number } | undefined;
    return {
      token: this.tokenIdentity(namespace, mint),
      tokenInfo,
      holders,
      smartMoney: { asOf: windows.asOf, windows: windows.windows, netflow: this.netflowPanel(namespace, mint) },
      packs: packRows.map((p) => this.listItem(p)),
      isDemoPinned: pinned?.enabled === 1,
      firstSeenInSource: first.t === null ? null : new Date(first.t).toISOString(),
    };
  }

  smartMoneyActivity(namespace: string, cursor: string | null, token: string | null, limit = 50): SmartMoneyActivityData {
    const fh = sha256Hex(canonicalJson({ token }));
    let asOf = this.clock.now();
    let after: { t: number; id: string } | null = null;
    if (cursor) {
      const c = decodeCursor(this.cursorKey, cursor);
      if (!c || c.ns !== namespace || c.fh !== fh) throw new InvalidInputError("The cursor does not match this feed.");
      asOf = c.asOf;
      after = { t: c.t, id: c.id };
    }
    const where = ["o.namespace = ?", "o.first_seen_at_ms <= ?"];
    const args: unknown[] = [namespace, asOf];
    if (token) {
      where.push("(o.token_bought_address = ? OR o.token_sold_address = ?)");
      args.push(token, token);
    }
    if (after) {
      where.push("(o.block_time_ms < ? OR (o.block_time_ms = ? AND o.id < ?))");
      args.push(after.t, after.t, after.id);
    }
    const rows = this.db
      .prepare(`SELECT o.* FROM smart_money_observations o WHERE ${where.join(" AND ")} ORDER BY o.block_time_ms DESC, o.id DESC LIMIT ?`)
      .all(...args, limit + 1) as {
      id: string; transaction_hash: string; trader_address: string; trader_label: string | null; token_bought_address: string; token_sold_address: string;
      token_bought_symbol: string | null; token_sold_symbol: string | null; token_bought_amount: string | null; token_sold_amount: string | null; block_time_ms: number; trade_value_usd: string | null;
    }[];
    const page = rows.slice(0, limit);
    const sourceStmt = this.db.prepare(
      `SELECT s.snapshot_id, e.params_json FROM smart_money_observation_sources s JOIN enrichment_snapshots e ON e.id = s.snapshot_id WHERE s.observation_id = ? ORDER BY e.fetched_at_ms LIMIT 1`,
    );
    const hasPackStmt = this.db.prepare("SELECT 1 FROM packs WHERE namespace = ? AND mint = ? LIMIT 1");
    const out: SmartMoneyActivityRow[] = page.map((o) => {
      const sellOfToken = QUOTE_LIKE.has(o.token_bought_address) && !QUOTE_LIKE.has(o.token_sold_address);
      const direction: "buy" | "sell" = sellOfToken ? "sell" : "buy";
      const tokenAddress = sellOfToken ? o.token_sold_address : o.token_bought_address;
      const src = sourceStmt.get(o.id) as { snapshot_id: string; params_json: string } | undefined;
      const scope = src && (JSON.parse(src.params_json) as { filters?: unknown }).filters ? "Token lookup" : "Global feed";
      return {
        observationId: o.id,
        transactionHash: o.transaction_hash,
        traderAddress: o.trader_address,
        traderLabel: o.trader_label,
        direction,
        tokenAddress,
        tokenSymbol: sellOfToken ? o.token_sold_symbol : o.token_bought_symbol,
        counterTokenAddress: sellOfToken ? o.token_bought_address : o.token_sold_address,
        counterTokenSymbol: sellOfToken ? o.token_bought_symbol : o.token_sold_symbol,
        tokenAmount: sellOfToken ? o.token_sold_amount : o.token_bought_amount,
        tradeValueUsd: o.trade_value_usd,
        blockTime: new Date(o.block_time_ms).toISOString(),
        snapshotId: src?.snapshot_id ?? "",
        scope,
        hasPack: hasPackStmt.get(namespace, tokenAddress) !== undefined,
      };
    });
    const lastRow = page[page.length - 1];
    const latestFeed = this.db
      .prepare("SELECT id, fetched_at_ms FROM enrichment_snapshots WHERE namespace = ? AND endpoint = 'smart-money/dex-trades' AND subject_id = 'global' AND availability IN ('available','empty') ORDER BY fetched_at_ms DESC LIMIT 1")
      .get(namespace) as { id: string; fetched_at_ms: number } | undefined;
    const anyObs = this.db.prepare("SELECT 1 FROM smart_money_observations WHERE namespace = ? LIMIT 1").get(namespace);
    const now = this.clock.now();
    return {
      rows: out,
      nextCursor: rows.length > limit && lastRow ? encodeCursor(this.cursorKey, { ns: namespace, fh, t: lastRow.block_time_ms, id: lastRow.id, asOf }) : null,
      asOf: latestFeed ? new Date(latestFeed.fetched_at_ms).toISOString() : null,
      state: {
        availability: out.length > 0 ? "available" : anyObs || latestFeed ? "empty" : "not_requested",
        coverage: anyObs || latestFeed ? "partial" : "unknown",
        freshness: latestFeed ? (now - latestFeed.fetched_at_ms > 240_000 ? "stale" : "fresh") : "unknown",
        fetchedAt: latestFeed ? new Date(latestFeed.fetched_at_ms).toISOString() : null,
        periodStart: null,
        periodEnd: null,
        reasonCode: null,
        snapshotIds: latestFeed ? [latestFeed.id] : [],
      },
      scopeDescription: "Nansen Smart Money DEX trades on Solana (endpoint default Smart Money group, rolling 24 hours). Global feed pages are partial; token lookups add targeted rows.",
    };
  }

  packSmartMoneyEvidence(packId: string): { observations: SmartMoneyActivityRow[]; matches: { observationId: string; wallet: string; matchLevel: string }[] } | null {
    const p = this.db.prepare("SELECT namespace, mint FROM packs WHERE id = ?").get(packId) as { namespace: string; mint: string } | undefined;
    if (!p) return null;
    const matches = this.db.prepare("SELECT observation_id, wallet, match_level FROM pack_smart_money_evidence WHERE pack_id = ?").all(packId) as { observation_id: string; wallet: string; match_level: string }[];
    const feed = this.smartMoneyActivity(p.namespace, null, p.mint, 100);
    return { observations: feed.rows, matches: matches.map((m) => ({ observationId: m.observation_id, wallet: m.wallet, matchLevel: m.match_level })) };
  }
}

export function sumUsd(values: string[]): string {
  return canonical(values.reduce((a, v) => a.plus(parseDecimal(v)), new Decimal(0)));
}
