import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID, type AppConfig, type QuoteAsset } from "../config.js";
import type { FetchLike } from "../adapters/nansen/client.js";
import { canonical, fromRaw, parseDecimal } from "../lib/decimal.js";
import { log } from "../lib/log.js";
import { quotePriceStatus, type QuotePriceFeed, type QuotePriceStatus } from "./feed.js";
import type { PriceStore } from "./store.js";

/**
 * Pyth quote price (policy pyth-onchain-v1). Reads Pyth's sponsored SOL/USD
 * price account on Solana through the configured RPC, the same chain the
 * trades come from, so it needs no key and costs no Nansen credits. Pyth
 * updates the account about once a minute. A new snapshot is stored only when
 * the publish time advances; valuation then accepts a price published at or
 * before the trade and at most PRICE_MAX_AGE_SECONDS earlier.
 *
 * Every read is checked: account owner (Pyth Solana Receiver), account type,
 * full Wormhole verification, feed ID, a positive price, and a confidence
 * interval of at most 1% of the price.
 */

const PRICE_UPDATE_V2_DISCRIMINATOR = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);
/** Largest accepted confidence interval, as a share of the price. */
const MAX_CONF_RATIO = "0.01";
const RPC_TIMEOUT_MS = 5000;

export class PythPriceError extends Error {}

export type PythPrice = { feedId: string; price: string; conf: string; publishTimeMs: number; postedSlot: string };

/**
 * Decode a Pyth Solana Receiver `PriceUpdateV2` account: discriminator (8),
 * write authority (32), verification level (Partial: 2 bytes, Full: 1),
 * then feed ID (32), price i64, conf u64, exponent i32, publish time i64,
 * previous publish time i64, EMA price i64, EMA conf u64, posted slot u64.
 */
export function decodePriceUpdateV2(data: Buffer): PythPrice {
  if (data.length < 41 || !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) throw new PythPriceError("Not a Pyth PriceUpdateV2 account");
  let o = 40;
  const level = data[o]!;
  if (level === 0) throw new PythPriceError("Price update is only partially verified");
  if (level !== 1) throw new PythPriceError(`Unknown verification level ${level}`);
  o += 1;
  if (data.length < o + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8) throw new PythPriceError("Price update account is truncated");
  const feedId = data.subarray(o, o + 32).toString("hex");
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const expo = data.readInt32LE(o);
  o += 4;
  const publishTime = data.readBigInt64LE(o);
  o += 8 + 8 + 8 + 8; // publish time, previous publish time, EMA price, EMA conf
  const postedSlot = data.readBigUInt64LE(o);
  if (price <= 0n) throw new PythPriceError("Price is not positive");
  if (expo > 0 || expo < -18) throw new PythPriceError(`Unexpected price exponent ${expo}`);
  if (publishTime <= 0n) throw new PythPriceError("Missing publish time");
  return {
    feedId,
    price: canonical(fromRaw(price.toString(), -expo)),
    conf: canonical(fromRaw(conf.toString(), -expo)),
    publishTimeMs: Number(publishTime) * 1000,
    postedSlot: postedSlot.toString(),
  };
}

/** Check an RPC `getAccountInfo` result and return the SOL/USD price it holds. */
export function readSolUsdAccount(value: unknown): PythPrice {
  const v = value as { owner?: unknown; data?: unknown } | null;
  if (!v) throw new PythPriceError("Pyth SOL/USD account not found");
  if (v.owner !== PYTH_RECEIVER_PROGRAM) throw new PythPriceError("Pyth SOL/USD account has an unexpected owner");
  if (!Array.isArray(v.data) || typeof v.data[0] !== "string" || v.data[1] !== "base64") throw new PythPriceError("Unexpected account encoding");
  const p = decodePriceUpdateV2(Buffer.from(v.data[0], "base64"));
  if (p.feedId !== PYTH_SOL_USD_FEED_ID) throw new PythPriceError("Account holds a different Pyth feed");
  if (parseDecimal(p.conf).greaterThan(parseDecimal(p.price).times(MAX_CONF_RATIO))) throw new PythPriceError("Confidence interval is wider than 1% of the price");
  return p;
}

export class PythPriceFeed implements QuotePriceFeed {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastPublishMs: number;
  lastError: string | null = null;
  lastSuccessAtMs: number | null = null;
  polls = 0;
  /** True while reads succeed only through SOLANA_RPC_HTTP_FALLBACK_URL. */
  usingFallback = false;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly store: PriceStore,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {
    if (config.price.policy.provider !== "pyth") throw new Error("PythPriceFeed requires PRICE_PROVIDER=pyth");
    if (!config.rpc.httpUrl) throw new Error("PythPriceFeed requires SOLANA_RPC_HTTP_URL");
    const q = config.price.quotes[0]!;
    const latest = store.latest(q.priceMint);
    this.lastPublishMs = latest?.candles.at(-1)?.intervalStartMs ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.running) {
      this.running = true;
      try {
        for (const q of this.config.price.quotes) await this.pollQuote(q);
      } finally {
        this.running = false;
      }
    }
    this.scheduleNext(this.config.price.refreshSeconds * 1000);
  }

  /** The price account as the RPC returns it (`result.value`). */
  private async fetchAccount(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PYTH_SOL_USD_ACCOUNT, { encoding: "base64", commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new PythPriceError(`RPC HTTP ${res.status}`);
    const body = JSON.parse(await res.text()) as { result?: { value?: unknown }; error?: { message?: string } };
    if (body.error) throw new PythPriceError(`RPC error: ${body.error.message ?? "unknown"}`);
    return body.result?.value ?? null;
  }

  /** Reads through the primary RPC, then through the fallback when the primary fails. */
  private async fetchAccountWithFallback(): Promise<unknown> {
    const fallback = this.config.rpc.httpFallbackUrl;
    try {
      const value = await this.fetchAccount(this.config.rpc.httpUrl!);
      if (this.usingFallback) log("info", "price-pyth", "Pyth reads are back on the primary RPC", {});
      this.usingFallback = false;
      return value;
    } catch (err) {
      if (!fallback || fallback === this.config.rpc.httpUrl) throw err;
      const value = await this.fetchAccount(fallback);
      if (!this.usingFallback) log("warn", "price-pyth", "Primary RPC failed; Pyth reads use the fallback RPC", { error: err instanceof Error ? err.message : String(err) });
      this.usingFallback = true;
      return value;
    }
  }

  /** One RPC read. Returns true when a new price was stored. */
  async pollQuote(q: QuoteAsset): Promise<boolean> {
    this.polls++;
    const startedAt = this.clock.now();
    try {
      const p = readSolUsdAccount(await this.fetchAccountWithFallback());
      const receivedAt = this.clock.now();
      let stored = false;
      if (p.publishTimeMs > this.lastPublishMs) {
        this.store.insert({
          quoteMint: q.priceMint,
          requestedFromMs: p.publishTimeMs,
          requestedToMs: p.publishTimeMs,
          requestStartedAtMs: startedAt,
          responseReceivedAtMs: receivedAt,
          candles: [{ intervalStartMs: p.publishTimeMs, close: p.price }],
          providerRequestId: `slot:${p.postedSlot}`,
          attemptId: null,
          source: `pyth:onchain:${PYTH_SOL_USD_ACCOUNT}`,
          timeframe: "tick",
          policyVersion: "pyth-onchain-v1",
        });
        this.lastPublishMs = p.publishTimeMs;
        stored = true;
      }
      if (this.lastError !== null) log("info", "price-pyth", "Pyth SOL/USD price reads recovered", {});
      this.lastError = null;
      this.lastSuccessAtMs = receivedAt;
      return stored;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log once per distinct problem; a 5 s poll would otherwise repeat it constantly.
      if (message !== this.lastError) log("warn", "price-pyth", "Pyth SOL/USD price read failed", { error: message });
      this.lastError = message;
      return false;
    }
  }

  status(q: QuoteAsset): QuotePriceStatus {
    return quotePriceStatus(this.store, q, this.config.price.policy, this.clock.now());
  }
}
