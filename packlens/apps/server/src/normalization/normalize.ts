import type { TradeEvent } from "@packlens/contracts";
import type { DecodedTrade } from "../collector/decoder.js";
import { DECODER_VERSION, PUMP_TOKEN_DECIMALS } from "../collector/decoder.js";
import { NATIVE_SOL_DEFAULT_PUBKEY, type QuoteAsset } from "../config.js";
import { eventIdFor } from "../lib/ids.js";
import { selectPrice, tradeValueUsd, type PriceLimits, type PriceSnapshotView } from "./valuation.js";

export type NormalizeContext = {
  namespace: string;
  sourceMode: TradeEvent["sourceMode"];
  signature: string;
  slot: number;
  receivedAtMs: number;
  normalizedAtMs: number;
  quotes: readonly QuoteAsset[];
  /** Price snapshots for a price mint, as committed in this namespace. */
  snapshotsFor: (priceMint: string) => readonly PriceSnapshotView[];
  /** Price age limits from the active policy (a number applies to both). */
  maxPriceAgeMs: number | PriceLimits;
  priceSource: string;
};

/**
 * Canonical TradeEvent from a decoded pump.fun TradeEvent. Event time is the
 * on-chain Clock timestamp emitted by the program (seconds), never arrival time.
 */
export function normalizeTrade(d: DecodedTrade, ctx: NormalizeContext): TradeEvent {
  const quoteMint = d.quoteMint ?? NATIVE_SOL_DEFAULT_PUBKEY;
  const quote = ctx.quotes.find((q) => q.eventMints.includes(quoteMint)) ?? null;
  const blockTimeMs = d.timestampSec * 1000;

  const base = {
    eventId: eventIdFor(ctx.signature, d.ordinal),
    namespace: ctx.namespace,
    chain: "solana" as const,
    source: "pumpfun" as const,
    sourceMode: ctx.sourceMode,
    signature: ctx.signature,
    eventOrdinal: d.ordinal,
    slot: ctx.slot,
    blockTimeMs,
    receivedAtMs: ctx.receivedAtMs,
    walletAddress: d.user,
    tokenAddress: d.mint,
    side: d.isBuy ? ("buy" as const) : ("sell" as const),
    tokenAmountRaw: d.tokenAmountRaw,
    tokenDecimals: PUMP_TOKEN_DECIMALS,
    decoderVersion: DECODER_VERSION,
    normalizedAtMs: ctx.normalizedAtMs,
    coreEligibility: "pending" as const,
  };

  if (!quote) {
    // Unsupported quote: record it, never assume a price. Decimals are unknown (0 = not interpreted).
    return {
      ...base,
      quoteAmountRaw: d.quoteAmountRaw ?? d.solAmountRaw,
      quoteDecimals: 0,
      quoteAssetAddress: quoteMint,
      quoteUsdPrice: null,
      quotePriceAtMs: null,
      priceSnapshotId: null,
      priceCandleEndMs: null,
      valuationStatus: "unsupported_quote",
      tradeValueUsd: null,
      priceSource: null,
    };
  }

  // SOL pairs: sol_amount excludes protocol and creator fees and equals quote_amount.
  const quoteAmountRaw = d.quoteAmountRaw !== null && d.quoteAmountRaw !== "0" ? d.quoteAmountRaw : d.solAmountRaw;
  const selection = selectPrice(ctx.snapshotsFor(quote.priceMint), blockTimeMs, ctx.receivedAtMs, ctx.maxPriceAgeMs);
  if (selection.status !== "valued") {
    return {
      ...base,
      quoteAmountRaw,
      quoteDecimals: quote.decimals,
      quoteAssetAddress: quote.priceMint,
      quoteUsdPrice: null,
      quotePriceAtMs: null,
      priceSnapshotId: null,
      priceCandleEndMs: null,
      valuationStatus: selection.status,
      tradeValueUsd: null,
      priceSource: null,
    };
  }
  return {
    ...base,
    quoteAmountRaw,
    quoteDecimals: quote.decimals,
    quoteAssetAddress: quote.priceMint,
    quoteUsdPrice: selection.close,
    quotePriceAtMs: selection.intervalStartMs,
    priceSnapshotId: selection.snapshotId,
    priceCandleEndMs: selection.candleEndMs,
    valuationStatus: "valued",
    tradeValueUsd: tradeValueUsd(quoteAmountRaw, quote.decimals, selection.close),
    priceSource: ctx.priceSource,
  };
}
