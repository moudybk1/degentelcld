# Test report

Date: 2026-09-25 · Runtime: Node 24.19.0, npm 11.17.0, SQLite 3.53.4 (better-sqlite3 13.0.3) · Linux.
All figures below come from commands actually run on this date. Offline and live results are reported separately.

## Gate G0: offline verification (passed)

| Command | Result |
|---|---|
| `npm ci` | Clean install from `package-lock.json`; native SQLite loads. |
| `npm run typecheck` | Passed (contracts, server, web, tests; strict mode). |
| `npm run lint` | Passed, including the detector/pattern import boundaries (verified by a probe file that imported Smart Money and `Date.now` inside `detector/`: both rejected). |
| `npm test` | **158 tests passed** in 14 files. |
| `npm run test:e2e` | **15 browser journeys passed** (Chromium, production build, fixture mode, temporary database, `.env` ignored). |
| `npm run build` / `npm run start` | Built and served the SPA and API; used by the e2e suite. |
| `npm run dev` | Server on fixture mode plus Vite with the `/api` proxy; returned 5 fixture packs. |
| `npm run db:schema-doc` | Wrote [`db-schema.md`](db-schema.md) from the migrations. |
| `npm run replay -- --dataset synthetic-demo-v1 --mode historical-event-time` | New replay namespace, 5 packs, digest reported. |

### Mandatory scenarios covered by automated tests

| Area | Tests | File |
|---|---|---|
| Trigger, uniqueness, threshold, dedupe, identity (T01–T08, V01–V05) | Exact 0/7/20 s trigger; 20.001 s does not; repeated wallets; $19.99 vs $20; two $10 buys; duplicate signature+ordinal; two ordinals; identical symbols | `tests/detector/core.test.ts` |
| Expansion and cooldown (T09–T11, V06, V07, T48) | Expansion exactly at 40 s, excluded at 40.001 s; qualifying-window requirement; cooldown before and at expiry; stale checkpoint still triggers | `tests/detector/core.test.ts` |
| Ordering and recovery (T12–T14, T35, T37, T39, T47, T49, T50, T52) | Out-of-order input; late events; backfill; event at expansionEnd before timer; restart restores pending events and cooldown; failed commit publishes nothing; outbox replay; namespace isolation and cross-namespace FK rejection | `tests/detector/pipeline.test.ts` |
| Valuation (T15, T16, T42–T45, T58, T59, V08) | Closed candle only; post-arrival snapshot rejected; stale candle; no retroactive pricing; fee exclusion; unsupported quote; exact decimal precision; 5m fallback limits | `tests/normalization/valuation.test.ts` |
| Decoder | Pinned IDL hash and field order; real mainnet buy, router sell, failed transaction; legacy layouts; foreign program data ignored; real create event total supply and bonding-curve completion | `tests/decoder/decoder.test.ts` |
| After the pack and readout | Latest and peak price against the pack's SOL entry recomputed independently from the dataset; member exits after each member's own first buy; bounded chart series that keeps the true peak and low; pack-buy and pack-sell markers; graduation note; earlier packs share ≥ 2 wallets and never see later packs; no live retention note in fixtures; batched radar summaries with ID validation; readout has no advice or forecast wording and always ends with the unknowns | `tests/api/after-pack.test.ts` |
| Smart Money (T17–T28, T55, V09) | 5m/1h/24h window bounds; repeat buyers; later sellers; seller-only; sub-$20 buys; ambiguity; lower bounds; scanned zero vs partial vs unchecked; member matching levels | `tests/smart-money/aggregate.test.ts` |
| Invariance (T29, T30, V10, T24) | Empty, zero, 100-buyer, errored context and ± netflow leave digest, packs, assessment, and priority identical; confirmation needs matching hashes; one observation from two scopes | `tests/smart-money/invariance.test.ts` |
| Ledger and client (T31–T34, T41, T46, T51, T56, T57, V11) | V11 arithmetic; atomic reservations; call 101 and 301 proceed; timeouts unresolved; 429 with Retry-After; no retry on 400/422 or provider query_timeout; single-flight; cache keys; auth and payment pauses; schema errors never become zero; endpoint-specific address fields | `tests/scheduler/budget.test.ts`, `tests/adapters/nansen-client.test.ts` |
| API and SSE (T36, T38, T53) | Envelopes; input validation; signed cursors; operator 401; idempotency conflict 409; CSRF origin check; login rate limit; zero provider calls from public GET in live mode; SSE replay and resync | `tests/api/api.test.ts` |
| End-to-end live flow | Synthetic pump.fun logs → Nansen-priced valuation → pack → operator enrichment → assessment flags → Smart Money counts and 1-of-3 confirmation → ledger reconciliation → +5 min balance follow-up | `tests/api/live-flow.test.ts` |
| Replay (T16, T40, T60) | Deterministic digests; different inputs differ; pinned prices; recorded admission watermarks; historical mode; co-occurrence never sees the future; dataset price policy independent of live setting; a fixture namespace seeded from an older dataset is rebuilt while other namespaces stay untouched | `tests/replay/replay.test.ts` |
| Config and patterns (T54) | Fixture needs no keys; LLM disabled; live fails clearly; baseline locked; URL redaction; CV, share, co-occurrence; analysis states; concentration denominator; candidate order; retention safety; session price reserve | `tests/config/config.test.ts`, `tests/patterns/patterns.test.ts` |

### Browser journeys (Playwright)

Radar with mode and separate Smart Money metrics · labeled manual filters (never automatic) · radar → pack → wallet → back → refresh · unavailable, update-delayed, budget-paused, and observed-zero states · token without a pack and Smart Money feed that cannot create packs · keyboard navigation · 360 px without horizontal scroll · operator login, cookie, overview, logout · unknown pack and route · radar *after the pack* line · pack reading panel, after-the-pack stats, chart with keyboard reading and table view, earlier packs · graduated token note · info tips (click, Escape) · guide from the top bar and radar, dismissible radar hint · 360 px guide and after section without horizontal scroll.

## Gate G1: live source and provider integration (passed with a documented fallback)

`npm run verify:live` on Solana mainnet (public RPC) and the Nansen API:

- **RPC and decoder:** 15 s sample decoded buys and sells with 0 decode errors; failed transactions ignored; latency p50 about 1.3 s, p90 about 1.65 s; 0% late at 2 s.
- **Price:** 1-minute WSOL OHLCV failed upstream (HTTP 500 `query_timeout`, all attempts). With approval, the documented fallback `nansen-5m-closed-v1` passed.
- **Nansen endpoints:** token information, holders, PnL summary, wallet DEX trades, related wallets, current balance, Smart Money DEX (global and targeted), and netflow all returned schema-valid real data. Result: **11/11 steps passed**. Evidence: [`compatibility/verify-live-latest.json`](compatibility/verify-live-latest.json); notes: [`compatibility/README.md`](compatibility/README.md).

## Gates G3/G4: live usage session

Live run on 2026-09-25, 10:57–11:12 UTC (about 15 minutes), `APP_MODE=live`, public RPC, 5m price fallback, Smart Money enabled, budget 1,000 credits.

| Measure | Result |
|---|---|
| Decoded pump.fun trade events | 24,490 (13,174 buys) |
| Late events (behind the 2 s watermark) | 84 (0.34%) |
| Valued events / unpriced SOL-quoted events | 22,576 / 0 |
| Unsupported quote (USDC and custom pairs) | 1,914 (7.8%), recorded, never valued |
| Eligible buys | 4,098 |
| Packs detected | 149 (138 frozen, 121 expanded; average 13.3 wallets, largest 108) |
| Packs with base analysis | 15 (13 complete, 2 partial) |
| Packs flagged `CHECK_RELATIONSHIP` | 1 (provider-returned relationship between members) |
| Smart Money observations | 136 from 50 traders; 2 pack tokens with observed Smart Money buyers |
| Packs with a confirmed Smart Money member | 1 (1 of 6 members; pack transaction matched by hash, wallet, and mint) |
| Jobs | 217 succeeded, 2 failed (related-wallet timeouts) |
| Restarts during the session | 4 graceful restarts; packs, cooldowns, ledger, and session preserved; each restart recorded as a closed, unrecovered gap |

Nansen usage over the whole campaign (smoke tests plus session), from [`usage-manifest.json`](usage-manifest.json):

| Endpoint | Attempts | Schema-valid | Failed | Actual credits |
|---|---:|---:|---:|---:|
| `profiler/address/current-balance` | 32 | 32 | 0 | 32 |
| `profiler/address/pnl-summary` | 47 | 47 | 0 | 47 |
| `profiler/address/related-wallets` | 37 | 29 | 8 (timeouts) | 29 |
| `profiler/dex-trades` | 47 | 47 | 0 | 47 |
| `smart-money/dex-trades` | 27 | 27 | 0 | 135 |
| `smart-money/netflow` | 15 | 15 | 0 | 75 |
| `tgm/holders` | 17 | 16 | 1 | 80 |
| `tgm/token-information` | 16 | 16 | 0 | 16 |
| `tgm/token-ohlcv` | 34 | 31 | 3 (1m query_timeout) | 31 |
| **Total** | **272** | **260** | **12** | **492 settled + 16 unresolved** |

The internal target of **100 relevant successful responses is met (260)**. Cache hits (6) are not counted as calls. Nansen reported an account balance of 17,206 credits after the session; reconcile against the Nansen usage dashboard. The 16 unresolved credits belong to requests whose cost was not reported (timeouts).

Findings fixed during the live session: holders returned nothing for unpriced new tokens (now `value_usd ≥ 0`); a gap left open by a previous process was never closed (now closed on reconnect); provider `query_timeout` was retried identically (now not retried); automatic enrichment could starve price polling (now reserved for the session); large packs produced very long pages (compact timeline, collapsible tables).

## Remaining limitations

- The P0 baseline 1m price policy is blocked upstream for WSOL; the 5m fallback is a documented deviation.
- No backfill after collector gaps.
- Only SOL-quoted pairs are valued.
- User-comprehension sessions with testers (PRD §12) were not run.
