import type { Clock } from "../clock.js";
import type { AppConfig, QuoteAsset } from "../config.js";
import { OHLCV, type OhlcvReq } from "../adapters/nansen/endpoints.js";
import type { NansenClient } from "../adapters/nansen/client.js";
import { log } from "../lib/log.js";
import type { SessionManager } from "../scheduler/session.js";
import type { PriceStore } from "./store.js";

export function isoNoMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Quote-price poller (blueprint §5.3, §17.4). One logical worker requests one
 * quote per 30 seconds during an active session: the ten minutes ending at the
 * start of the current minute (`to` is exclusive for 1m), so only closed
 * candles are returned. Late ticks coalesce instead of accumulating.
 */
export class PricePoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private anchorMs: number | null = null;
  private k = 0;
  lastError: string | null = null;
  lastSuccessAtMs: number | null = null;
  polls = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly client: NansenClient,
    private readonly store: PriceStore,
    private readonly session: SessionManager,
  ) {}

  start(): void {
    if (this.timer) return;
    this.scheduleNext(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const session = this.session.current();
    const intervalMs = this.config.price.refreshSeconds * 1000;
    if (!session) {
      this.anchorMs = null;
      this.scheduleNext(1000);
      return;
    }
    if (this.anchorMs === null || this.anchorMs < session.started_at_ms) {
      // Dispatch at start + k × interval while less than end; startup is the first tick.
      this.anchorMs = Math.max(session.started_at_ms, this.clock.now());
      this.k = 0;
    }
    if (!this.running) {
      this.running = true;
      try {
        await Promise.all(this.config.price.quotes.map((q) => this.pollQuote(q)));
      } finally {
        this.running = false;
      }
    }
    // Next tick strictly after now; skipped ticks coalesce.
    const now = this.clock.now();
    do this.k++;
    while (this.anchorMs + this.k * intervalMs <= now);
    const next = this.anchorMs + this.k * intervalMs;
    const current = this.session.current();
    if (current && next < current.ends_at_ms) this.scheduleNext(next - now);
    else this.scheduleNext(1000);
  }

  async pollQuote(q: QuoteAsset): Promise<void> {
    const policy = this.config.price.policy;
    const now = this.clock.now();
    const to = Math.floor(now / policy.candleMs) * policy.candleMs;
    const from = to - policy.rangeMs;
    const req: OhlcvReq = { chain: "solana", token_address: q.priceMint, timeframe: policy.timeframe, date: { from: isoNoMillis(from), to: isoNoMillis(to) } };
    this.polls++;
    const res = await this.client.call(OHLCV, req, { lane: "PRICE", purpose: "quote_price", jobId: null, persist: false, bypassCache: true });
    if (!res.ok) {
      this.lastError = `${res.code}: ${res.message}`;
      log("warn", "price-poller", "Quote price request failed", { code: res.code });
      return;
    }
    if (res.normalized.data.candles.length === 0) {
      this.lastError = "empty: no closed candles returned";
      return;
    }
    this.store.insert({
      quoteMint: q.priceMint,
      requestedFromMs: from,
      requestedToMs: to,
      requestStartedAtMs: res.requestStartedAtMs,
      responseReceivedAtMs: res.fetchedAtMs,
      candles: res.normalized.data.candles,
      providerRequestId: res.providerRequestId,
      attemptId: res.attemptIds[res.attemptIds.length - 1] ?? null,
      source: `nansen:tgm/token-ohlcv:${policy.timeframe}:closed_only`,
      timeframe: policy.timeframe,
      policyVersion: policy.version,
    });
    this.lastError = null;
    this.lastSuccessAtMs = this.clock.now();
  }

  /** Price availability for USD eligibility, evaluated for "now". */
  status(q: QuoteAsset): { state: "valid" | "waiting_for_price" | "stale"; latestCandleStartMs: number | null; latestAvailableAtMs: number | null } {
    const latest = this.store.latest(q.priceMint);
    if (!latest) return { state: "waiting_for_price", latestCandleStartMs: null, latestAvailableAtMs: null };
    const newest = latest.candles.length ? latest.candles[latest.candles.length - 1]!.intervalStartMs : null;
    const now = this.clock.now();
    const p = this.config.price.policy;
    const ok = newest !== null && now - newest <= p.maxCandleAgeMs && now - latest.availableAtMs <= p.maxFetchAgeMs;
    return { state: ok ? "valid" : "stale", latestCandleStartMs: newest, latestAvailableAtMs: latest.availableAtMs };
  }
}
