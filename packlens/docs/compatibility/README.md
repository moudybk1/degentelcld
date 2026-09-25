# Upstream compatibility notes

Findings from authenticated smoke tests (`npm run verify:live`) and the first live session on **2026-09-25**. Adapter changes that follow from these notes do not change product rules. The latest machine-readable evidence is in [`verify-live-latest.json`](verify-live-latest.json).

## Solana RPC (public mainnet endpoint)

- `logsSubscribe` with `mentions: [6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P]` at `confirmed` delivered about 30 pump.fun trades per second.
- Measured chain-timestamp-to-arrival latency: p50 about 1.3 s, p90 about 1.65 s. Under 1% of events exceeded the 2 s reorder tolerance.
- Most notifications are failed transactions (between 25% and 70% by sample). They are ignored before decoding.
- `getTransaction` needs `maxSupportedTransactionVersion: 1` for newer transaction versions. PackLens does not call it in P0; event time comes from the TradeEvent clock timestamp, which matched `blockTime` in every sampled transaction.

## pump.fun TradeEvent layout

- Pinned IDL (`pump-public-docs` commit `81091419`) now includes `quote_mint` and `quote_amount`. SOL-paired coins report `quote_mint = 11111111111111111111111111111111` (the default pubkey) and `quote_amount = sol_amount`.
- `sol_amount` excludes the protocol fee and creator fee. For a sampled buy, sol_amount + fee + creator_fee + network fee equalled the signer's exact balance change.
- Older logs are shorter; the decoder reads missing trailing fields as absent, as the pump.fun docs specify.

## Nansen `tgm/token-ohlcv`

- **1m WSOL fails upstream.** Every 1-minute request for `So11111111111111111111111111111111111111112` returned HTTP 500 `query_timeout` after about 30 s (10-, 3-, 2-, and 1-minute ranges). `X-Nansen-Credits-Cost: 1` was present; `X-Nansen-Credits-Used` was absent, so PackLens keeps those attempts **unresolved**.
- 1m candles for ordinary pump.fun tokens returned in under 1 s, and 5m WSOL candles returned in about 0.6 s.
- 5m responses include the current open candle at the inclusive `to` boundary; the adapter drops any candle starting at or after `to`.
- Consequence: live runs use the documented fallback policy `nansen-5m-closed-v1` (`PRICE_TIMEFRAME=5m`). See the README section on quote pricing.
- `interval_start` values are ISO strings without milliseconds; some provider timestamps omit the `Z` suffix and are treated as UTC.

## Nansen `tgm/holders`

- For newly launched tokens without USD price data, the default `value_usd >= 1` dust filter excluded **every** holder and returned a warning recommending `{"value_usd": {"min": 0}}`.
- PackLens now sends the documented filter `filters.value_usd.min = 0` with `premium_labels = false`. Cost stayed 5 credits.

## Nansen `tgm/token-information`

- For brand-new pump.fun tokens, the response can have an empty `symbol`, and `market_cap_usd` and `total_supply` of `0`. PackLens prefers the name and symbol from the pump.fun `CreateEvent` and never divides by a zero supply (concentration shows *Not computable*).

## Nansen profiler endpoints

- `profiler/address/related-wallets` occasionally exceeded the 15 s client timeout for busy wallets. These attempts are recorded as timeouts with unresolved reservations and the job is marked failed after three attempts.
- `profiler/address/pnl-summary` accepted `wallet_address`; `profiler/dex-trades` and `profiler/address/current-balance` accepted `address`. The two names were never sent together.

## Nansen Smart Money endpoints

- `smart-money/dex-trades` returned 100 rows per page with `is_last_page`; the global feed is treated as partial coverage.
- Targeted lookups with `filters.token_bought_address` returned only rows for that mint.
- `smart-money/netflow` with `filters.token_address` returns no row for tokens without Smart Money activity; PackLens shows *no netflow row in the checked data*, not zero.

## Credit headers

- Successful responses carried `X-Nansen-Credits-Cost`, `X-Nansen-Credits-Used`, `X-Nansen-Credits-Remaining`, and `X-Request-Id`. Costs matched the public pricing table: 1 credit for OHLCV, token information, and profiler calls; 5 for holders, Smart Money DEX trades, and netflow.
