/**
 * Smart Money token-window aggregation (blueprint §9.3, §9.4, §17.7).
 * Pure: counts unique buyer wallets of a mint within (T - D, T]. A wallet that
 * buys and later sells remains a buyer; seller-only wallets never count; the
 * $20 detector threshold does not apply. Unknown is never turned into zero.
 */
import type { PanelState, SmartMoneyWindow, SmartMoneyWindowMetric } from "@packlens/contracts";
import { canonical, Decimal, parseDecimal } from "../lib/decimal.js";

export const WINDOW_MS: Record<SmartMoneyWindow, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 };
export const WINDOWS: SmartMoneyWindow[] = ["5m", "1h", "24h"];

export type ObservationForCount = {
  id: string;
  chain: string;
  transactionHash: string;
  traderAddress: string;
  tokenBoughtAddress: string;
  tokenSoldAddress: string;
  blockTimeMs: number;
  tradeValueUsd: string | null;
  ambiguousSwapIdentity: boolean;
};

export type WindowCoverage = "window_scanned" | "partial" | "unknown";

export type AggregateInput = {
  mint: string;
  asOfMs: number;
  observations: readonly ObservationForCount[];
  /** Coverage per window, decided by the scan that produced the observations. */
  coverage: Record<SmartMoneyWindow, WindowCoverage>;
  scopeHash: string;
  snapshotIds: string[];
  fetchedAtMs: number | null;
  /** True when no scan has ever been attempted (unchecked). */
  checked: boolean;
  freshness: "fresh" | "stale" | "unknown";
};

function state(availability: PanelState["availability"], coverage: PanelState["coverage"], input: AggregateInput, start: number, end: number): PanelState {
  return {
    availability,
    coverage,
    freshness: input.freshness,
    fetchedAt: input.fetchedAtMs === null ? null : new Date(input.fetchedAtMs).toISOString(),
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    reasonCode: null,
    snapshotIds: input.snapshotIds,
  };
}

export function aggregateWindows(input: AggregateInput): SmartMoneyWindowMetric[] {
  return WINDOWS.map((w) => {
    const end = input.asOfMs;
    const start = end - WINDOW_MS[w];
    if (!input.checked) {
      return {
        window: w,
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(end).toISOString(),
        observedUniqueBuyers: null,
        countQualifier: "unknown",
        knownBuyUsd: null,
        missingValuationCount: 0,
        ambiguousTradeCount: 0,
        state: { ...state("not_requested", "unknown", input, start, end), fetchedAt: null, snapshotIds: [] },
        scopeHash: input.scopeHash,
      };
    }
    // Buys of this exact mint on Solana within (start, end].
    const buys = input.observations.filter(
      (o) => o.chain === "solana" && o.tokenBoughtAddress === input.mint && o.blockTimeMs > start && o.blockTimeMs <= end,
    );
    const buyers = new Set(buys.map((o) => o.traderAddress));
    let known = new Decimal(0);
    let knownCount = 0;
    let missing = 0;
    let ambiguous = 0;
    for (const o of buys) {
      if (o.ambiguousSwapIdentity) {
        ambiguous++;
        continue;
      }
      if (o.tradeValueUsd === null) {
        missing++;
        continue;
      }
      known = known.plus(parseDecimal(o.tradeValueUsd));
      knownCount++;
    }
    const coverage = input.coverage[w];
    const qualifier = coverage === "window_scanned" ? "observed" : "at_least";
    const availability: PanelState["availability"] = buyers.size > 0 ? "available" : "empty";
    const valueIsPartial = missing > 0 || ambiguous > 0 || coverage !== "window_scanned";
    return {
      window: w,
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(end).toISOString(),
      observedUniqueBuyers: buyers.size,
      countQualifier: qualifier,
      knownBuyUsd: knownCount > 0 || !valueIsPartial ? canonical(known) : null,
      missingValuationCount: missing,
      ambiguousTradeCount: ambiguous,
      state: state(availability, coverage === "window_scanned" ? "window_scanned" : "partial", input, start, end),
      scopeHash: input.scopeHash,
    };
  });
}
