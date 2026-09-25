/**
 * Quote valuation with Nansen OHLCV closed candles (blueprint §5.3, §17.13).
 *
 * For event time E and first arrival R, only snapshots with availableAt <= R
 * are considered. A candle qualifies when candleEnd = intervalStart + candle
 * length <= E, close is finite and positive, 0 <= E - intervalStart <=
 * maxCandleAge, and 0 <= R - availableAt <= maxFetchAge. Ties: descending
 * (intervalStart, availableAt, snapshotId). The selection is made once and
 * pinned to the event. The baseline policy uses 1m candles and 120 s limits.
 */
import { canonical, fromRaw, parseDecimal, type Decimal } from "../lib/decimal.js";

export const CANDLE_MS = 60_000;
export const VALUATION_FORMULA_VERSION = "quote-close-x-amount-v1";

export type PriceCandle = { intervalStartMs: number; close: string };

export type PriceSnapshotView = {
  id: string;
  quoteMint: string;
  availableAtMs: number;
  candles: PriceCandle[];
  /** Candle length of this snapshot; 1m baseline when omitted. */
  candleMs?: number;
};

export type PriceLimits = { maxCandleAgeMs: number; maxFetchAgeMs: number };

export type PriceSelection =
  | { status: "valued"; snapshotId: string; intervalStartMs: number; candleEndMs: number; close: string }
  | { status: "missing_price" }
  | { status: "stale_price"; newestIntervalStartMs: number };

function validClose(close: string): Decimal | null {
  try {
    const d = parseDecimal(close);
    return d.isFinite() && d.greaterThan(0) ? d : null;
  } catch {
    return null;
  }
}

function toLimits(limits: number | PriceLimits): PriceLimits {
  return typeof limits === "number" ? { maxCandleAgeMs: limits, maxFetchAgeMs: limits } : limits;
}

export function selectPrice(snapshots: readonly PriceSnapshotView[], eventTimeMs: number, receivedAtMs: number, limitsIn: number | PriceLimits): PriceSelection {
  const limits = toLimits(limitsIn);
  type Cand = { snap: PriceSnapshotView; candle: PriceCandle; candleMs: number };
  const closed: Cand[] = [];
  for (const snap of snapshots) {
    if (snap.availableAtMs > receivedAtMs) continue; // not available at first arrival
    const candleMs = snap.candleMs ?? CANDLE_MS;
    for (const candle of snap.candles) {
      if (candle.intervalStartMs + candleMs > eventTimeMs) continue; // open or future candle
      if (validClose(candle.close) === null) continue;
      closed.push({ snap, candle, candleMs });
    }
  }
  if (closed.length === 0) return { status: "missing_price" };
  const valid = closed.filter(({ snap, candle }) => {
    const candleAge = eventTimeMs - candle.intervalStartMs;
    const fetchAge = receivedAtMs - snap.availableAtMs;
    return candleAge >= 0 && candleAge <= limits.maxCandleAgeMs && fetchAge >= 0 && fetchAge <= limits.maxFetchAgeMs;
  });
  if (valid.length === 0) {
    return { status: "stale_price", newestIntervalStartMs: Math.max(...closed.map((c) => c.candle.intervalStartMs)) };
  }
  valid.sort((a, b) => {
    if (a.candle.intervalStartMs !== b.candle.intervalStartMs) return b.candle.intervalStartMs - a.candle.intervalStartMs;
    if (a.snap.availableAtMs !== b.snap.availableAtMs) return b.snap.availableAtMs - a.snap.availableAtMs;
    return a.snap.id < b.snap.id ? 1 : a.snap.id > b.snap.id ? -1 : 0;
  });
  const best = valid[0]!;
  return {
    status: "valued",
    snapshotId: best.snap.id,
    intervalStartMs: best.candle.intervalStartMs,
    candleEndMs: best.candle.intervalStartMs + best.candleMs,
    close: canonical(parseDecimal(best.candle.close)),
  };
}

/** Traded quote amount × close, exact decimal, evaluated before any rounding. */
export function tradeValueUsd(quoteAmountRaw: string, quoteDecimals: number, close: string): string {
  return canonical(fromRaw(quoteAmountRaw, quoteDecimals).times(parseDecimal(close)));
}
