import type { Clock } from "../clock.js";
import type { PriceTimeframe } from "../config.js";
import type { Db } from "../db/connection.js";
import { newId } from "../lib/ids.js";
import type { PriceCandle, PriceSnapshotView } from "../normalization/valuation.js";

export type NewPriceSnapshot = {
  quoteMint: string;
  requestedFromMs: number;
  requestedToMs: number;
  requestStartedAtMs: number;
  responseReceivedAtMs: number;
  candles: PriceCandle[];
  providerRequestId: string | null;
  attemptId: string | null;
  source: string;
  /** Replay/fixture imports keep the recorded availability time. */
  availableAtMs?: number;
  id?: string;
  timeframe?: PriceTimeframe;
  policyVersion?: string;
};

/** "tick" is a published price (Pyth), not a candle: it counts from its publish time. */
const CANDLE_MS_BY_TIMEFRAME: Record<string, number> = { "1m": 60_000, "5m": 300_000, tick: 0 };

const RETAIN_MS = 30 * 60_000;

/**
 * Immutable price snapshots for one namespace. availableAt is set when the
 * normalized snapshot is committed; the in-memory view is updated only after
 * the commit, so no event can observe a snapshot before it was readable.
 */
export class PriceStore {
  private readonly byMint = new Map<string, PriceSnapshotView[]>();

  constructor(
    private readonly db: Db,
    readonly namespace: string,
    private readonly clock: Clock,
  ) {
    const since = clock.now() - RETAIN_MS;
    const rows = db
      .prepare("SELECT id, quote_mint, available_at_ms, candles_json, timeframe FROM price_snapshots WHERE namespace = ? AND available_at_ms >= ? ORDER BY available_at_ms")
      .all(namespace, since) as { id: string; quote_mint: string; available_at_ms: number; candles_json: string; timeframe: string }[];
    for (const r of rows) {
      this.add({ id: r.id, quoteMint: r.quote_mint, availableAtMs: r.available_at_ms, candles: JSON.parse(r.candles_json) as PriceCandle[], candleMs: CANDLE_MS_BY_TIMEFRAME[r.timeframe] ?? 60_000 });
    }
  }

  private add(view: PriceSnapshotView): void {
    const list = this.byMint.get(view.quoteMint) ?? [];
    list.push(view);
    this.byMint.set(view.quoteMint, list);
  }

  snapshotsFor(mint: string): readonly PriceSnapshotView[] {
    return this.byMint.get(mint) ?? [];
  }

  insert(s: NewPriceSnapshot): PriceSnapshotView {
    const id = s.id ?? newId("price");
    const availableAt = s.availableAtMs ?? this.clock.now();
    this.db
      .prepare(
        `INSERT INTO price_snapshots (id, namespace, chain, quote_mint, requested_from_ms, requested_to_ms, request_started_at_ms, response_received_at_ms,
           available_at_ms, candles_json, provider_request_id, attempt_id, source, timeframe, policy_version)
         VALUES (?, ?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.namespace, s.quoteMint, s.requestedFromMs, s.requestedToMs, s.requestStartedAtMs, s.responseReceivedAtMs, availableAt,
        JSON.stringify(s.candles), s.providerRequestId, s.attemptId, s.source, s.timeframe ?? "1m", s.policyVersion ?? "nansen-1m-closed-v1");
    const candleMs = CANDLE_MS_BY_TIMEFRAME[s.timeframe ?? "1m"] ?? 60_000;
    const view: PriceSnapshotView = { id, quoteMint: s.quoteMint, availableAtMs: availableAt, candles: s.candles, candleMs };
    this.add(view);
    this.prune();
    return view;
  }

  latest(mint: string): PriceSnapshotView | null {
    const list = this.byMint.get(mint);
    return list && list.length > 0 ? list[list.length - 1]! : null;
  }

  private prune(): void {
    const cutoff = this.clock.now() - RETAIN_MS;
    for (const [mint, list] of this.byMint) this.byMint.set(mint, list.filter((v) => v.availableAtMs >= cutoff));
  }
}
