/**
 * Dataset runner for fixture seeding and replay (blueprint §5.4, §17.5).
 *
 * - recorded-arrival: events are fed in original arrival order. Recorded
 *   datasets reproduce each event's admission watermark and pinned valuation;
 *   synthetic datasets simulate 250 ms ticks from their arrival times.
 * - historical-event-time: the complete dataset is evaluated by event time on
 *   a virtual clock; it does not claim equivalence with a live run.
 *
 * Replay never calls providers and writes only to its own namespace.
 */
import type { TradeEvent } from "@packlens/contracts";
import { VirtualClock } from "../clock.js";
import { detectorConfigForVersion, policyForVersion, type AppConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { DECODER_VERSION, PUMP_TOKEN_DECIMALS } from "../collector/decoder.js";
import { DetectorEngine } from "../ingest/engine.js";
import { IngestPipeline } from "../ingest/pipeline.js";
import type { OutboxBus } from "../ingest/outbox.js";
import { eventIdFor, sha256Hex } from "../lib/ids.js";
import { canonicalJson } from "../lib/json.js";
import { selectPrice, tradeValueUsd, type PriceLimits } from "../normalization/valuation.js";
import { PriceStore } from "../prices/store.js";
import type { Dataset, DatasetEvent } from "./dataset.js";

export type ReplayMode = "recorded-arrival" | "historical-event-time";

export function ensureNamespace(db: Db, id: string, mode: "fixture" | "live" | "replay", label: string, datasetHash: string | null, nowMs: number): void {
  db.prepare("INSERT INTO namespaces (id, mode, created_at_ms, dataset_hash, label) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, mode, nowMs, datasetHash, label);
  const row = db.prepare("SELECT mode FROM namespaces WHERE id = ?").get(id) as { mode: string };
  if (row.mode !== mode) throw new Error(`Namespace ${id} already exists with mode ${row.mode}`);
}

function buildEvent(e: DatasetEvent, namespace: string, sourceMode: TradeEvent["sourceMode"], store: PriceStore, maxAgeMs: PriceLimits, snapshotIdMap: Map<string, string>, normalizedAtMs: number): TradeEvent {
  const base = {
    eventId: eventIdFor(e.signature, e.ordinal),
    namespace,
    chain: "solana" as const,
    source: "pumpfun" as const,
    sourceMode,
    signature: e.signature,
    eventOrdinal: e.ordinal,
    slot: e.slot,
    blockTimeMs: e.blockTimeMs,
    receivedAtMs: e.receivedAtMs,
    walletAddress: e.wallet,
    tokenAddress: e.mint,
    side: e.side,
    tokenAmountRaw: e.tokenAmountRaw,
    tokenDecimals: PUMP_TOKEN_DECIMALS,
    quoteAmountRaw: e.quoteAmountRaw,
    quoteDecimals: e.quoteDecimals,
    quoteAssetAddress: e.quoteMint,
    decoderVersion: DECODER_VERSION,
    normalizedAtMs,
    coreEligibility: "pending" as const,
  };
  if (e.pinned) {
    // Recorded valuation is pinned; replay never re-prices with later data (T16).
    return {
      ...base,
      quoteUsdPrice: e.pinned.quoteUsdPrice,
      quotePriceAtMs: e.pinned.quotePriceAtMs,
      priceSnapshotId: e.pinned.priceSnapshotId ? snapshotIdMap.get(e.pinned.priceSnapshotId) ?? null : null,
      priceCandleEndMs: e.pinned.priceCandleEndMs,
      valuationStatus: e.pinned.valuationStatus,
      tradeValueUsd: e.pinned.tradeValueUsd,
      priceSource: e.pinned.priceSource,
    };
  }
  const sel = selectPrice(store.snapshotsFor(e.quoteMint), e.blockTimeMs, e.receivedAtMs, maxAgeMs);
  if (sel.status !== "valued") {
    return { ...base, quoteUsdPrice: null, quotePriceAtMs: null, priceSnapshotId: null, priceCandleEndMs: null, valuationStatus: sel.status, tradeValueUsd: null, priceSource: null };
  }
  return {
    ...base,
    quoteUsdPrice: sel.close,
    quotePriceAtMs: sel.intervalStartMs,
    priceSnapshotId: sel.snapshotId,
    priceCandleEndMs: sel.candleEndMs,
    valuationStatus: "valued",
    tradeValueUsd: tradeValueUsd(e.quoteAmountRaw, e.quoteDecimals, sel.close),
    priceSource: "dataset:price-snapshot",
  };
}

export type RunResult = { namespace: string; packIds: string[]; digest: string; events: number; late: number; eligible: number; duplicates: number };

export function runDataset(opts: {
  db: Db;
  outbox: OutboxBus;
  config: AppConfig;
  dataset: Dataset;
  datasetHash: string;
  namespace: string;
  namespaceMode: "fixture" | "replay";
  replayMode: ReplayMode;
  label: string;
}): RunResult {
  const { db, outbox, config, dataset, namespace } = opts;
  // A dataset replays under the rule it names, whatever rule live detection uses now.
  const detector = detectorConfigForVersion(dataset.configVersion);
  if (!detector) throw new Error(`Dataset config ${dataset.configVersion} is not a known detection rule`);
  const events = [...dataset.events];
  if (events.length === 0) throw new Error("Dataset has no events");
  // A loop, not Math.min(...events): spreading a recorded live hour (~140k events) overflows the stack.
  const startMs = events.reduce((m, e) => Math.min(m, e.receivedAtMs, e.blockTimeMs), Infinity) - 5000;
  const clock = new VirtualClock(startMs);
  ensureNamespace(db, namespace, opts.namespaceMode, opts.label, opts.datasetHash, Date.now());
  const existing = db.prepare("SELECT COUNT(*) AS n FROM trade_events WHERE namespace = ?").get(namespace) as { n: number };
  if (existing.n > 0) throw new Error(`Namespace ${namespace} already holds events; runs never mutate an existing namespace`);

  for (const t of dataset.tokens) {
    db.prepare(
      "INSERT INTO tokens (namespace, chain, mint, name, symbol, first_seen_at_ms, token_total_supply_raw, created_event_time_ms, completed_at_ms) VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(namespace, t.mint, t.name, t.symbol, startMs, t.totalSupplyRaw ?? null, t.createdAtMs ?? null, t.completedAtMs ?? null);
  }
  const store = new PriceStore(db, namespace, clock);
  const idMap = new Map<string, string>();
  for (const s of dataset.priceSnapshots) {
    // Snapshot IDs are namespaced copies; the digest ignores copied snapshot IDs.
    const newId = `${namespace}/${s.id}`;
    idMap.set(s.id, newId);
    store.insert({
      id: newId,
      quoteMint: s.quoteMint,
      requestedFromMs: s.requestedFromMs ?? s.availableAtMs - 11 * 60_000,
      requestedToMs: s.requestedToMs ?? s.availableAtMs,
      requestStartedAtMs: s.availableAtMs,
      responseReceivedAtMs: s.availableAtMs,
      candles: s.candles,
      providerRequestId: null,
      attemptId: null,
      source: dataset.origin === "synthetic" ? "fixture:synthetic" : s.timeframe === "tick" ? "recorded:pyth" : "recorded:nansen",
      availableAtMs: s.availableAtMs,
      timeframe: s.timeframe ?? "1m",
      policyVersion: s.timeframe === "tick" ? "pyth-onchain-v1" : s.timeframe === "5m" ? "nansen-5m-closed-v1" : "nansen-1m-closed-v1",
    });
  }
  const engine = new DetectorEngine(db, namespace, detector, clock, outbox);
  const pipeline = new IngestPipeline(db, namespace, clock, engine, detector.reorderToleranceMs);
  // Value with the dataset's own price policy so results never depend on the operator's live setting.
  const policy = policyForVersion(dataset.pricePolicy, config.price.maxAgeSeconds);
  const maxAge: PriceLimits = { maxCandleAgeMs: policy.maxCandleAgeMs, maxFetchAgeMs: policy.maxFetchAgeMs };
  const sourceMode: TradeEvent["sourceMode"] = opts.namespaceMode === "fixture" ? "fixture" : "replay";
  const packIds: string[] = [];

  if (opts.replayMode === "recorded-arrival") {
    events.sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.blockTimeMs - b.blockTimeMs || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) || a.ordinal - b.ordinal);
    let tickAt = startMs;
    for (const e of events) {
      if (e.admissionWatermarkMs !== undefined && e.admissionWatermarkMs !== null) {
        if (pipeline.watermark === null || e.admissionWatermarkMs > pipeline.watermark) packIds.push(...pipeline.advanceTo(e.admissionWatermarkMs).createdPackIds);
      } else {
        // Ticks with nothing to drain or close only move the watermark, and the next tick moves it as
        // far, so jump to the next tick with work. The last tick before an arrival always runs so
        // admission sees the same watermark as ticking every 250 ms.
        const lastTickAt = tickAt + Math.floor((e.receivedAtMs - tickAt) / 250) * 250;
        while (tickAt + 250 <= e.receivedAtMs) {
          const workAt = pipeline.nextWorkAtMs();
          const workTickAt = workAt === null ? Infinity : clock.now() >= workAt ? tickAt + 250 : tickAt + Math.ceil((workAt - tickAt) / 250) * 250;
          tickAt = Math.min(workTickAt, lastTickAt);
          clock.set(Math.max(clock.now(), tickAt));
          packIds.push(...pipeline.tick().createdPackIds);
        }
      }
      clock.set(Math.max(clock.now(), e.receivedAtMs));
      pipeline.ingest(buildEvent(e, namespace, e.sourceMode === "backfill" ? "backfill" : sourceMode, store, maxAge, idMap, clock.now()));
    }
  } else {
    events.sort((a, b) => a.blockTimeMs - b.blockTimeMs || a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) || a.ordinal - b.ordinal);
    for (const e of events) {
      clock.set(Math.max(clock.now(), e.blockTimeMs));
      pipeline.ingest(buildEvent(e, namespace, e.sourceMode === "backfill" ? "backfill" : sourceMode, store, maxAge, idMap, clock.now()));
    }
  }
  // Drain everything and close every expansion window.
  const endMs = events.reduce((m, e) => Math.max(m, e.blockTimeMs, e.receivedAtMs), -Infinity) + detector.expansionFromStartMs + detector.reorderToleranceMs + 1000;
  clock.set(Math.max(clock.now(), endMs));
  packIds.push(...pipeline.advanceTo(endMs).createdPackIds);

  return {
    namespace,
    packIds,
    digest: semanticDigest(db, namespace),
    events: pipeline.counters.received,
    late: pipeline.counters.late,
    eligible: pipeline.counters.eligible,
    duplicates: pipeline.counters.duplicates,
  };
}

/**
 * Semantic digest across namespaces (§17.5): chain, mint, trigger event ID,
 * config, sorted evidence IDs, member kinds, entry times, decimal values,
 * cooldown, and pattern metrics. Transport IDs, namespace, processing times,
 * and copied snapshot IDs are excluded.
 */
export function semanticDigest(db: Db, namespace: string): string {
  const packs = db
    .prepare("SELECT * FROM packs WHERE namespace = ? ORDER BY trigger_event_time_ms, trigger_event_id")
    .all(namespace) as Record<string, unknown>[];
  const out = packs.map((p) => {
    const evidence = (db.prepare("SELECT event_id, evidence_role FROM pack_events WHERE pack_id = ? ORDER BY event_id").all(p.id as string) as { event_id: string; evidence_role: string }[]).map((e) => [e.event_id, e.evidence_role]);
    const members = (
      db.prepare("SELECT wallet, member_kind, first_entry_time_ms, initial_first_entry_time_ms, joined_at_event_time_ms, eligible_buy_usd FROM pack_members WHERE pack_id = ? ORDER BY wallet").all(p.id as string) as Record<string, unknown>[]
    ).map((m) => [m.wallet, m.member_kind, m.first_entry_time_ms, m.initial_first_entry_time_ms, m.joined_at_event_time_ms, m.eligible_buy_usd]);
    return {
      chain: p.chain,
      mint: p.mint,
      triggerEventId: p.trigger_event_id,
      configVersion: p.config_version,
      state: p.state,
      firstEventTimeMs: p.first_event_time_ms,
      triggerEventTimeMs: p.trigger_event_time_ms,
      lastAcceptedEventTimeMs: p.last_accepted_event_time_ms,
      expansionEndMs: p.expansion_end_ms,
      suppressUntilMs: p.suppress_until_ms,
      initialWalletCount: p.initial_wallet_count,
      totalWalletCount: p.total_wallet_count,
      eligibleBuyUsd: p.eligible_buy_usd,
      coreVersion: p.core_version,
      evidenceVersion: p.evidence_version,
      evidence,
      members,
      patterns: JSON.parse(p.patterns_json as string),
    };
  });
  return sha256Hex(canonicalJson(out));
}
