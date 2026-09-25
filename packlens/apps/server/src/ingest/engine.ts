import type { DetectorConfig, PackMember, TradeEvent } from "@packlens/contracts";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import {
  advanceWatermark,
  classifyEligibility,
  consumeOrdered,
  deriveMembers,
  isDisposable,
  newTokenState,
  packTotalUsd,
  selectProfileWallets,
  type ActivePack,
  type BufferedEvent,
  type CoreEffect,
  type DetectorInput,
  type TokenState,
} from "../detector/core.js";
import { computePatterns, COOCCURRENCE_LOOKBACK_MS, type EarlierPackMembership } from "../patterns/indicators.js";
import { parseDecimal } from "../lib/decimal.js";
import { OutboxBus, writeOutbox } from "./outbox.js";

export type EngineHooks = {
  /** Called after a successful commit that created packs. Must not mutate core state. */
  onPacksCreated?: (packIds: string[]) => void;
};

type CheckpointRow = {
  buffer_json: string;
  active_pack_id: string | null;
  suppress_until_ms: number | null;
  config_version: string;
};

export function toDetectorInput(e: TradeEvent, admission: DetectorInput["admission"]): DetectorInput {
  return {
    eventId: e.eventId,
    walletAddress: e.walletAddress,
    tokenAddress: e.tokenAddress,
    timeMs: e.blockTimeMs,
    slot: e.slot,
    signature: e.signature,
    ordinal: e.eventOrdinal,
    side: e.side,
    valuationStatus: e.valuationStatus,
    tradeValueUsd: e.tradeValueUsd,
    admission,
  };
}

/**
 * One writer per namespace. Consumption, timers, checkpoints, evidence, and
 * outbox rows commit in a single DB transaction; in-memory state is replaced
 * only after the commit succeeds.
 */
export class DetectorEngine {
  private readonly states = new Map<string, TokenState>();

  constructor(
    private readonly db: Db,
    readonly namespace: string,
    private readonly config: DetectorConfig,
    private readonly clock: Clock,
    private readonly outbox: OutboxBus,
    private readonly hooks: EngineHooks = {},
  ) {}

  /** Drop cached state (used after a failed commit or in tests). */
  resetCache(): void {
    this.states.clear();
  }

  private loadState(mint: string): TokenState {
    const cached = this.states.get(mint);
    if (cached) return cached;
    const row = this.db
      .prepare("SELECT buffer_json, active_pack_id, suppress_until_ms, config_version FROM detector_checkpoints WHERE namespace = ? AND chain = 'solana' AND mint = ?")
      .get(this.namespace, mint) as CheckpointRow | undefined;
    const state = newTokenState(this.namespace, mint, this.config.version);
    if (row) {
      if (row.config_version !== this.config.version) throw new Error(`Checkpoint for ${mint} uses config ${row.config_version}`);
      state.buffer = JSON.parse(row.buffer_json) as BufferedEvent[];
      state.suppressUntilMs = row.suppress_until_ms;
      state.active = row.active_pack_id ? this.loadActivePack(row.active_pack_id) : null;
    }
    return state;
  }

  /** Reconstruct an active pack from persisted pack, member, and evidence rows. */
  private loadActivePack(packId: string): ActivePack | null {
    const p = this.db
      .prepare("SELECT * FROM packs WHERE id = ? AND namespace = ? AND state = 'collecting'")
      .get(packId, this.namespace) as Record<string, unknown> | undefined;
    if (!p) return null;
    const members = this.db
      .prepare("SELECT wallet, member_kind, initial_first_entry_time_ms, joined_at_event_time_ms FROM pack_members WHERE pack_id = ?")
      .all(packId) as { wallet: string; member_kind: "initial" | "expanded"; initial_first_entry_time_ms: number | null; joined_at_event_time_ms: number }[];
    const evidence = this.db
      .prepare(
        `SELECT pe.event_id, pe.evidence_role, pe.accepted_at_event_time_ms, pe.accepted_at_expansion, pe.evidence_version,
                te.wallet, te.event_time_ms, te.trade_value_usd, te.slot, te.signature, te.event_ordinal
         FROM pack_events pe JOIN trade_events te ON te.namespace = pe.namespace AND te.event_id = pe.event_id
         WHERE pe.pack_id = ? ORDER BY te.event_time_ms, te.slot, te.signature, te.event_ordinal`,
      )
      .all(packId) as {
      event_id: string; evidence_role: "initial" | "expansion"; accepted_at_event_time_ms: number; accepted_at_expansion: number; evidence_version: number;
      wallet: string; event_time_ms: number; trade_value_usd: string; slot: number; signature: string; event_ordinal: number;
    }[];
    const memberKinds: Record<string, "initial" | "expanded"> = {};
    const joinedAt: Record<string, number> = {};
    const initialFirstEntry: Record<string, number> = {};
    const initialWallets: string[] = [];
    for (const m of members) {
      memberKinds[m.wallet] = m.member_kind;
      joinedAt[m.wallet] = m.joined_at_event_time_ms;
      if (m.member_kind === "initial") {
        initialWallets.push(m.wallet);
        initialFirstEntry[m.wallet] = m.initial_first_entry_time_ms!;
      }
    }
    initialWallets.sort((a, b) => initialFirstEntry[a]! - initialFirstEntry[b]! || (a < b ? -1 : a > b ? 1 : 0));
    return {
      id: packId,
      mint: p.mint as string,
      firstEventTimeMs: p.first_event_time_ms as number,
      triggerEventTimeMs: p.trigger_event_time_ms as number,
      triggerEventId: p.trigger_event_id as string,
      triggeredAtMs: p.triggered_at_ms as number,
      expansionEndMs: p.expansion_end_ms as number,
      lastAcceptedEventTimeMs: p.last_accepted_event_time_ms as number,
      suppressUntilMs: p.suppress_until_ms as number,
      initialWallets,
      initialFirstEntry,
      memberKinds,
      joinedAt,
      evidence: evidence.map((e) => ({
        eventId: e.event_id,
        wallet: e.wallet,
        timeMs: e.event_time_ms,
        usd: e.trade_value_usd,
        slot: e.slot,
        signature: e.signature,
        ordinal: e.event_ordinal,
        role: e.evidence_role,
        acceptedAtEventTimeMs: e.accepted_at_event_time_ms,
        acceptedAtExpansion: e.accepted_at_expansion === 1,
        evidenceVersion: e.evidence_version,
      })),
      coreVersion: p.core_version as number,
      evidenceVersion: p.evidence_version as number,
    };
  }

  /**
   * Apply ordered, admitted events with E <= newWatermark, then timers, then
   * persist the watermark. Everything commits atomically.
   */
  applyTick(events: readonly TradeEvent[], newWatermarkMs: number): { createdPackIds: string[]; eligible: number } {
    const working = new Map<string, TokenState>();
    const dirty = new Set<string>();
    const createdPackIds: string[] = [];
    let eligibleCount = 0;
    const now = this.clock.now();
    const getWorking = (mint: string): TokenState => {
      let s = working.get(mint);
      if (!s) {
        s = structuredClone(this.loadState(mint));
        working.set(mint, s);
      }
      return s;
    };

    const markApplied = this.db.prepare(
      "UPDATE trade_events SET detector_applied = 1, eligibility = ?, eligibility_reason = ? WHERE namespace = ? AND event_id = ? AND detector_applied = 0",
    );

    const tx = this.db.transaction(() => {
      for (const ev of events) {
        const input = toDetectorInput(ev, "admitted");
        const pre = classifyEligibility(input, this.config);
        if (!pre.eligible) {
          markApplied.run("ineligible", pre.reason, this.namespace, ev.eventId);
          continue;
        }
        const state = getWorking(ev.tokenAddress);
        const result = consumeOrdered(state, input, this.config, now);
        eligibleCount++;
        const info = markApplied.run("eligible", "eligible", this.namespace, ev.eventId);
        if (info.changes !== 1) throw new Error(`Event ${ev.eventId} was already applied or is missing`);
        dirty.add(ev.tokenAddress);
        for (const effect of result.effects) this.persistEffect(effect, now, createdPackIds);
      }
      // Timers after draining events at or below the watermark.
      const collecting = this.db
        .prepare("SELECT mint FROM packs WHERE namespace = ? AND state = 'collecting' AND expansion_end_ms < ?")
        .all(this.namespace, newWatermarkMs) as { mint: string }[];
      for (const { mint } of collecting) {
        const state = getWorking(mint);
        for (const effect of advanceWatermark(state, newWatermarkMs)) {
          this.persistEffect(effect, now, createdPackIds);
          dirty.add(mint);
        }
      }
      const upsert = this.db.prepare(
        `INSERT INTO detector_checkpoints (namespace, chain, mint, buffer_json, active_pack_id, first_event_time_ms, last_accepted_time_ms, suppress_until_ms, config_version, updated_at_ms)
         VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, chain, mint) DO UPDATE SET buffer_json = excluded.buffer_json, active_pack_id = excluded.active_pack_id,
           first_event_time_ms = excluded.first_event_time_ms, last_accepted_time_ms = excluded.last_accepted_time_ms,
           suppress_until_ms = excluded.suppress_until_ms, config_version = excluded.config_version, updated_at_ms = excluded.updated_at_ms`,
      );
      const del = this.db.prepare("DELETE FROM detector_checkpoints WHERE namespace = ? AND chain = 'solana' AND mint = ?");
      for (const mint of dirty) {
        const s = working.get(mint)!;
        if (isDisposable(s, newWatermarkMs, this.config)) {
          del.run(this.namespace, mint);
        } else {
          upsert.run(
            this.namespace,
            mint,
            JSON.stringify(s.buffer),
            s.active?.id ?? null,
            s.active?.firstEventTimeMs ?? null,
            s.active?.lastAcceptedEventTimeMs ?? null,
            s.suppressUntilMs,
            this.config.version,
            now,
          );
        }
      }
      this.db.prepare("UPDATE namespaces SET watermark_ms = ? WHERE id = ?").run(newWatermarkMs, this.namespace);
    });

    // If the transaction throws, nothing was committed and the cached state stays untouched (T37).
    tx();
    for (const [mint, s] of working) {
      if (dirty.has(mint) && isDisposable(s, newWatermarkMs, this.config)) this.states.delete(mint);
      else this.states.set(mint, s);
    }
    if (this.states.size > 5000) this.pruneCache(newWatermarkMs);
    this.outbox.notifyCommitted(this.namespace);
    if (createdPackIds.length > 0) this.hooks.onPacksCreated?.(createdPackIds);
    return { createdPackIds, eligible: eligibleCount };
  }

  private pruneCache(watermarkMs: number): void {
    for (const [mint, s] of this.states) if (isDisposable(s, watermarkMs, this.config)) this.states.delete(mint);
  }

  private earlierPacks(pack: ActivePack, wallets: string[]): EarlierPackMembership[] {
    if (wallets.length === 0) return [];
    const placeholders = wallets.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT p.id, p.mint, p.trigger_event_time_ms, pm.wallet FROM pack_members pm
         JOIN packs p ON p.id = pm.pack_id AND p.namespace = pm.namespace
         WHERE pm.namespace = ? AND pm.wallet IN (${placeholders}) AND p.mint <> ? AND p.invalidated = 0
           AND p.trigger_event_time_ms < ? AND p.trigger_event_time_ms >= ?`,
      )
      .all(this.namespace, ...wallets, pack.mint, pack.triggerEventTimeMs, pack.triggerEventTimeMs - COOCCURRENCE_LOOKBACK_MS) as {
      id: string; mint: string; trigger_event_time_ms: number; wallet: string;
    }[];
    const map = new Map<string, EarlierPackMembership>();
    for (const r of rows) {
      const m = map.get(r.id) ?? { packId: r.id, mint: r.mint, triggerEventTimeMs: r.trigger_event_time_ms, wallets: [] };
      m.wallets.push(r.wallet);
      map.set(r.id, m);
    }
    return [...map.values()];
  }

  private patternsFor(pack: ActivePack, members: PackMember[]) {
    const ns = this.db.prepare("SELECT first_observed_event_ms FROM namespaces WHERE id = ?").get(this.namespace) as { first_observed_event_ms: number | null };
    return computePatterns({
      mint: pack.mint,
      triggerEventTimeMs: pack.triggerEventTimeMs,
      members,
      earlierPacks: this.earlierPacks(pack, members.map((m) => m.walletAddress)),
      namespaceFirstObservedMs: ns.first_observed_event_ms,
    });
  }

  private persistEffect(effect: CoreEffect, nowMs: number, created: string[]): void {
    const pack = effect.pack;
    if (effect.kind === "pack.frozen") {
      const info = this.db
        .prepare("UPDATE packs SET state = 'frozen', core_version = ?, frozen_at_ms = ? WHERE id = ? AND namespace = ? AND state = 'collecting'")
        .run(pack.coreVersion, nowMs, pack.id, this.namespace);
      if (info.changes !== 1) throw new Error(`Pack ${pack.id} could not be frozen`);
      writeOutbox(this.db, this.namespace, "pack.updated", pack.id, pack.coreVersion, { packId: pack.id, coreVersion: pack.coreVersion, evidenceVersion: pack.evidenceVersion, state: "frozen" }, nowMs);
      return;
    }
    const members = deriveMembers(pack);
    const patterns = this.patternsFor(pack, members);
    const total = packTotalUsd(pack);
    const summary = {
      template: "pack-summary-v1",
      initialWalletCount: pack.initialWallets.length,
      totalWalletCount: members.length,
      eligibleBuyUsd: total,
      triggerWindowSeconds: this.config.triggerWindowMs / 1000,
      evidenceCount: pack.evidence.length,
    };
    const insertEvidence = this.db.prepare(
      "INSERT INTO pack_events (pack_id, namespace, event_id, evidence_role, accepted_at_event_time_ms, accepted_at_expansion, evidence_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const upsertMember = this.db.prepare(
      `INSERT INTO pack_members (pack_id, namespace, wallet, member_kind, first_entry_time_ms, initial_first_entry_time_ms, joined_at_event_time_ms, eligible_buy_usd, event_ids_json, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
       ON CONFLICT(pack_id, wallet) DO UPDATE SET first_entry_time_ms = excluded.first_entry_time_ms,
         eligible_buy_usd = excluded.eligible_buy_usd, event_ids_json = excluded.event_ids_json`,
    );

    if (effect.kind === "pack.created") {
      this.db
        .prepare(
          `INSERT INTO packs (id, namespace, chain, mint, state, config_version, evidence_version, core_version, first_event_time_ms,
             trigger_event_time_ms, trigger_event_id, triggered_at_ms, last_accepted_event_time_ms, initial_wallet_count, total_wallet_count,
             eligible_buy_usd, eligible_buy_usd_approx, expansion_end_ms, suppress_until_ms, patterns_json, summary_json)
           VALUES (?, ?, 'solana', ?, 'collecting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pack.id, this.namespace, pack.mint, this.config.version, pack.evidenceVersion, pack.coreVersion, pack.firstEventTimeMs,
          pack.triggerEventTimeMs, pack.triggerEventId, pack.triggeredAtMs, pack.lastAcceptedEventTimeMs, pack.initialWallets.length, members.length,
          total, parseDecimal(total).toNumber(), pack.expansionEndMs, pack.suppressUntilMs, JSON.stringify(patterns), JSON.stringify(summary),
        );
      for (const e of pack.evidence) insertEvidence.run(pack.id, this.namespace, e.eventId, e.role, e.acceptedAtEventTimeMs, e.acceptedAtExpansion ? 1 : 0, e.evidenceVersion);
      for (const m of members) {
        upsertMember.run(pack.id, this.namespace, m.walletAddress, m.memberKind, m.firstEntryTimeMs, m.initialFirstEntryTimeMs, m.joinedAtEventTimeMs, m.eligibleBuyUsd, JSON.stringify(m.eventIds));
      }
      const profileWallets = selectProfileWallets(pack, 3);
      if (profileWallets.length < 3) throw new Error("A pack must have at least three selected initial members");
      this.db
        .prepare(
          "INSERT INTO pack_enrichment (pack_id, namespace, status, profile_wallets_json, relationship_wallets_json, created_at_ms) VALUES (?, ?, 'not_requested', ?, ?, ?)",
        )
        .run(pack.id, this.namespace, JSON.stringify(profileWallets), JSON.stringify(profileWallets.slice(0, 2)), nowMs);
      this.db
        .prepare(
          `INSERT INTO pack_assessments (pack_id, namespace, version, analysis_state, review_flags_json, scheduled_member_count, total_member_count, snapshot_ids_json, reasons_json, created_at_ms)
           VALUES (?, ?, 1, 'not_requested', '[]', 0, ?, '[]', '[]', ?)`,
        )
        .run(pack.id, this.namespace, members.length, nowMs);
      writeOutbox(this.db, this.namespace, "pack.created", pack.id, pack.coreVersion, {
        packId: pack.id, coreVersion: pack.coreVersion, evidenceVersion: pack.evidenceVersion, mint: pack.mint, triggerEventTimeMs: pack.triggerEventTimeMs,
      }, nowMs);
      created.push(pack.id);
      return;
    }

    // pack.expanded
    const info = this.db
      .prepare(
        `UPDATE packs SET evidence_version = ?, core_version = ?, last_accepted_event_time_ms = ?, total_wallet_count = ?, eligible_buy_usd = ?,
           eligible_buy_usd_approx = ?, suppress_until_ms = ?, patterns_json = ?, summary_json = ? WHERE id = ? AND namespace = ? AND state = 'collecting'`,
      )
      .run(pack.evidenceVersion, pack.coreVersion, pack.lastAcceptedEventTimeMs, members.length, total, parseDecimal(total).toNumber(), pack.suppressUntilMs,
        JSON.stringify(patterns), JSON.stringify(summary), pack.id, this.namespace);
    if (info.changes !== 1) throw new Error(`Pack ${pack.id} could not be expanded`);
    for (const e of effect.added) insertEvidence.run(pack.id, this.namespace, e.eventId, e.role, e.acceptedAtEventTimeMs, e.acceptedAtExpansion ? 1 : 0, e.evidenceVersion);
    for (const m of members) {
      upsertMember.run(pack.id, this.namespace, m.walletAddress, m.memberKind, m.firstEntryTimeMs, m.initialFirstEntryTimeMs, m.joinedAtEventTimeMs, m.eligibleBuyUsd, JSON.stringify(m.eventIds));
    }
    writeOutbox(this.db, this.namespace, "pack.updated", pack.id, pack.coreVersion, {
      packId: pack.id, coreVersion: pack.coreVersion, evidenceVersion: pack.evidenceVersion, newWallets: effect.newWallets.length,
    }, nowMs);
  }
}
