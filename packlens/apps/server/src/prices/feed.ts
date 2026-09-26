import type { PricePolicy, QuoteAsset } from "../config.js";
import type { PriceStore } from "./store.js";

export type QuotePriceState = "valid" | "waiting_for_price" | "stale";
export type QuotePriceStatus = { state: QuotePriceState; latestCandleStartMs: number | null; latestAvailableAtMs: number | null };

/** A source of quote-price snapshots for live valuation (Nansen candles or Pyth on-chain prices). */
export interface QuotePriceFeed {
  start(): void;
  stop(): void;
  status(q: QuoteAsset): QuotePriceStatus;
  /** One read for one quote, outside the timer (tests and diagnostics). */
  pollQuote(q: QuoteAsset): Promise<unknown>;
  readonly lastError: string | null;
  readonly lastSuccessAtMs: number | null;
  readonly polls: number;
}

/** Price availability for USD eligibility, evaluated for "now" with the same limits valuation uses. */
export function quotePriceStatus(store: PriceStore, q: QuoteAsset, policy: PricePolicy, now: number): QuotePriceStatus {
  const latest = store.latest(q.priceMint);
  if (!latest) return { state: "waiting_for_price", latestCandleStartMs: null, latestAvailableAtMs: null };
  const newest = latest.candles.length ? latest.candles[latest.candles.length - 1]!.intervalStartMs : null;
  const ok = newest !== null && now - newest <= policy.maxCandleAgeMs && now - latest.availableAtMs <= policy.maxFetchAgeMs;
  return { state: ok ? "valid" : "stale", latestCandleStartMs: newest, latestAvailableAtMs: latest.availableAtMs };
}
