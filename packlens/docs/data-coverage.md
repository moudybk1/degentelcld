# Data coverage

What PackLens observes, what it does not, and how each gap is shown. Measurements come from the live session on 2026-09-25 (public Solana RPC, Nansen API).

## Transactions

| Covered | Not covered |
|---|---|
| pump.fun bonding-curve program `6EF8rr…F6P`, `TradeEvent` and `CreateEvent` logs at `confirmed` commitment | PumpSwap (graduated tokens), Raydium, Jupiter routes that do not call the bonding curve, other chains |
| Buys and sells in successful transactions, including router-initiated calls (pump.fun at invoke depth ≥ 2) | Failed transactions (ignored by design) |
| SOL-quoted trades (quote mint = default pubkey or WSOL) | Other quote assets (USDC and custom-quote coins were about 7% of trades on 2026-09-25); recorded as `unsupported_quote`, never valued |

- **Arrival latency** from on-chain timestamp to receipt was p50 ≈ 1.3 s and p90 ≈ 1.65 s on the public RPC. Events older than the 2 s watermark on arrival are recorded as *late* and excluded from live detection (0 to 1% observed).
- **Gaps:** disconnects, restarts, and silent streams (30 s without messages) open a collector gap that closes as `closed_unrecovered` when the stream resumes. P0 performs no backfill. Pack coverage lists gaps near the pack window.
- **Event time** is the program's on-chain clock timestamp in whole seconds. Buys in the same second are ordered deterministically by (time, slot, signature, log ordinal).

## Prices

- The only price source is Nansen `tgm/token-ohlcv` for WSOL. The baseline uses 1-minute closed candles; the live campaign uses the documented 5-minute fallback (`nansen-5m-closed-v1`) because 1-minute WSOL queries time out upstream. See [compatibility notes](compatibility/README.md).
- A buy without a valid closed candle available at first arrival is *missing_price* or *stale_price* and cannot pass the $20 check. Prices that arrive later never revalue it.
- On 2026-09-25 the fallback valued every SOL-quoted trade after the first poll (no missing or stale prices observed while the session ran).

## Nansen context

| Panel | Coverage |
|---|---|
| Token facts | Nansen token information (1h timeframe). New pump.fun tokens may report empty symbols and zero supply or market cap until indexed. |
| Holders | First page of 20, ordered by token amount, `premium_labels=false`, dust filter disabled (`value_usd ≥ 0`). A first page is not the full distribution. |
| Wallet profiles | First three initial members (30-day PnL, 7-day DEX sample of up to 100 trades). Other members are not profiled automatically. |
| Relationships and balance | First two initial members; balance checked once, five minutes after the trigger. Some busy wallets time out; the panel says so. |
| Smart Money buyers | Targeted lookup per pack token (one or more pages, newest first) plus the shared global feed. Single last-page lookups are *window scanned*; everything else is *partial* (at least N). |
| Netflow | Nansen's per-token netflow; no row means no Smart Money flow in the checked data, not zero. |

Nansen has its own indexing delay. Every panel shows fetch time and period; nothing claims to be on-chain now.

## Budget-driven coverage

Automatic analysis covers up to `ENRICHMENT_AUTO_PACKS_PER_CYCLE` packs every 5 minutes, largest first (never ordered by Smart Money), and only while the credit budget keeps enough headroom to fund price polling until the session ends. Packs outside that coverage stay *Not analyzed yet* and can be analyzed by an operator. The Smart Money global feed pauses under the same rule.
