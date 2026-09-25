# PackLens MVP and Implementation Plan

**Version 2.1 FINAL — English edition · September 25, 2026**

**Execution package.** Build P0 against the v2.1 contracts. Nansen pricing is core work and must be included in costs. One hundred calls is a minimum; neither an LLM nor a combined score is required. All implementation checkboxes remain unchecked. Document validation is not application-test completion. All UI, README, documentation, and demo narration are English.

Companions: [PRD](01-PRD-PACKLENS.md) · [Blueprint](02-TECHNICAL-BLUEPRINT-PACKLENS.md) · [Handoff](00-START-HERE.md).

## Contents

1. [MVP definition](#1-mvp-definition)
2. [Required scope](#2-required-scope)
3. [Prerequisites and proof-of-integration stage](#3-prerequisites-and-proof-of-integration-stage)
4. [Ordered implementation backlog](#4-ordered-implementation-backlog)
5. [Milestones and estimates](#5-milestones-and-estimates)
6. [Nansen budget and usage evidence](#6-nansen-budget-and-usage-evidence)
7. [Datasets and test scenarios](#7-datasets-and-test-scenarios)
8. [Acceptance mapping](#8-acceptance-mapping)
9. [Scope-reduction rules](#9-scope-reduction-rules)
10. [Demo runbook](#10-demo-runbook)
11. [README and submission package](#11-readme-and-submission-package)
12. [Definition of Done](#12-definition-of-done)
13. [After the MVP](#13-after-the-mvp)
14. [Normative test vectors](#14-normative-test-vectors)
15. [Implementation gates and reporting](#15-implementation-gates-and-reporting)

## 1. MVP definition

The MVP is complete when a user can open a real pack, inspect its forming transactions and Nansen context, and see how many Smart Money wallets bought the token without changing primary detection logic.

```text
Real pump.fun transactions
  → normalization and valuation
  → pack: 3 wallets / $20 per trade / 20 seconds
  → persisted evidence and radar
  → members and explorer links
  → Nansen wallet/token context
  → unique Smart Money buyers: 5m / 1h / 24h
  → member confirmation and separate netflow
  → evidence preserved through refresh, restart, and replay
```

Expansion remains 40 seconds from the first evidence event; cooldown remains 120 seconds from the last accepted new evidence. Smart Money only adds context. Empty, zero, large, failed, or delayed context must not change core output for identical event/price/clock/configuration input. Price failure is different: retain unvalued observations but do not trigger without USD eligibility.

### 1.1 Required demo evidence

- At least one pack has inspectable real transactions.
- Unique-wallet count differs from transaction count.
- Token-wide Smart Money buyers differ from confirmed pack members.
- Periods, fetch times, and partial coverage are visible.
- Nansen integration actually runs; a logo or fixture number is insufficient.
- The interface remains useful if a panel is unavailable.

### 1.2 Not required for MVP completion

A new combined score, AI predictions, elaborate graphs, all Solana tokens, every wallet profiled, 24/7 polling, public-user authentication, automated trades, and exact score equivalence with WolfBrain are not required.

## 2. Required scope

| Workstream | Minimum result |
|---|---|
| Source | Decode real buys/sells, reject failed transactions, use timestamped Nansen quote prices without look-ahead. |
| Detector | Correct thresholds/boundaries, deduplication, expansion, cooldown, versioning. |
| Persistence | Packs, members, events, snapshots, checkpoints, and ledger survive restart. |
| Radar | Cards, basic filters, source state, data mode, stable updates. |
| Detail | Timeline, members, indicators, evidence, analysis coverage. |
| Base Nansen | Token/holder context and selected period-specific wallet profiles. |
| Smart Money | Separate feed, buyer counts, member matching, observed buy value, selected netflow. |
| Operations | Cache, rate limits, credit guard, single poller, operator controls. |
| Verification | Unit/contract/integration/browser tests for failures affecting product correctness. |
| Demo | Primary/backup scenarios, README, recording, API-usage evidence. |

A complete page does not require every field to contain a number. Correct unavailable/partial states are acceptable for unavailable subjects, but real examples must prove the primary integrations.

## 3. Prerequisites and proof-of-integration stage

### 3.1 Before implementation

- [ ] Choose the application repository/directory; these files are planning deliverables.
- [ ] Use Node 24 and npm workspaces; pin compatible dependency patches.
- [ ] Configure RPC HTTP/WS securely, including credential-bearing URLs.
- [ ] Configure Nansen OHLCV 1m and validate closed-candle/no-look-ahead policy.
- [ ] Configure the backend Nansen key and inspect available account balance.
- [ ] Set a credit budget before paid requests; no fixed total-call ceiling.
- [ ] Use a local demo or choose persistent hosting if a public URL is needed.

Missing keys do not block scaffolding, fixtures, detector tests, or other offline work. They block live proof. Never store secrets in PRDs, issues, screenshots, or repositories.

### 3.2 Early integration spike

During Stage A, produce one buy and one sell that can be compared with source transactions. Then verify relevant Nansen payloads against real subjects, including Smart Money DEX and netflow. Record nullable fields, parameter names, freshness, states, and actual costs.

**Pass:** decoding is trustworthy and core endpoint access is demonstrated. **Not passed:** fix access/decoding; continue clearly labeled fixture UI work, but do not build a demo that misrepresents placeholders as live data.

## 4. Ordered implementation backlog

Hours are nominal active effort for a builder with environment/access ready, not measured outcomes or calendar promises. All W01–W20 tasks are P0. Split into smaller commits as needed.

### Stage A — sources and contracts: 4 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W01 | Scaffold, configuration, fixture/live contracts | 0.75 | None |
| W02 | RPC/IDL buy-sell and price spike | 2.25 | W01 |
| W03 | Nansen schema/cost spike | 1 | W01, account access |

**W01 acceptance**

- [ ] Fixture mode starts without keys.
- [ ] Validate environment; never export secrets to the browser.
- [ ] Blueprint module structure, formatting, lint, and typecheck exist.
- [ ] Record baseline configuration and version.

**W02 acceptance**

- [ ] One buy and sell match source signature, mint, wallet, amount, and direction.
- [ ] Failed transactions are not eligible.
- [ ] Timestamp/price provenance is clear; stale quote prices are detected.
- [ ] Pin the program/IDL version rather than tracking unreviewed upstream changes.

**W03 acceptance**

- [ ] Used payloads are accepted, including endpoint-specific address/wallet_address names.
- [ ] Solana Smart Money DEX/netflow responses can be normalized.
- [ ] Save sanitized internal examples of empty/null data and pagination.
- [ ] All spike calls enter the ledger and budget. Before paid spikes, build a minimal client with key/budget/session validation and attempt accounting; evolve it into W09/W12, rather than bypassing guards with an ad hoc script.

### Stage B — collector, normalization, persistence: 8 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W04 | Collector, reconnect, bounded lookup, gaps | 2 | W02 |
| W05 | Event contract, dedupe, valuation, ordering buffer | 4 | W04 |
| W06 | Migrations, repositories, checkpoints, outbox | 2 | W01, W05 contracts |

**W04:** record health/gaps, recover from disconnect, distinguish backfill from live, cache timestamp lookups to avoid repeated slot requests.

**W05:** use price fixtures until W12's live guard is ready, except already-accounted W03 spikes. IDs are unique, large amounts remain precise, missing prices are null, and replay uses pinned valuations. Late data cannot silently become retroactive live alerts. Duplicate and $20 boundary tests pass.

**W06:** enforce foreign keys and live/replay namespace isolation. Database writes are atomic; outbox publishes only committed changes. Versioned migration reruns preserve demo data.

### Stage C — detector and indicators: 5 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W07 | Windows, state, membership, cooldown | 3 | W05, W06 |
| W08 | Factual indicators and deterministic replay | 2 | W07 |

**W07:** pass T01–T12; separate initial/expanded members; exclude ineligible purchases from pack value; only new valid evidence extends cooldown. Timers freeze packs even without another trade.

**W08:** implement blueprint timing, size variation, dominance, and co-occurrence formulas with clear denominator/period. No P0 combined score. Identical event/price/config/clock replay yields identical core semantics. Co-occurrence cannot see the future.

**Stage C checkpoint:** a persisted pack with inspectable evidence must exist. Defer scores and graphs if they obstruct this result.

### Stage D — Nansen integrations and context: 9 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W09 | Nansen client, schema, cache, single-flight | 2 | W03, W06 |
| W10 | Profiles, tokens, holders, relationships, base assessment | 1.5 | W09, W07 |
| W11 | Smart Money feed/counts/matching/netflow | 3 | W09, W07 |
| W12 | Queue, ledger, credit reservations, limits, sessions | 2.5 | W09, W06 |

**W09:** schema failure is not successful normalization. Retry only transient failures. Cache keys include period/filter/page. Identical concurrent work produces one upstream request.

**W10:** automatically profile at most three initial members, with visible coverage. Use holders premium_labels=false. Assessment follows documented relationship/holder rules; profile statistics remain facts. Never read Smart Money for base assessment.

**W11 checklist**

- [ ] Count unique wallets by mint/event time for 5m/1h/24h.
- [ ] Handle repeated buys, different pools, and later selling correctly.
- [ ] Exclude seller-only wallets; do not apply $20 to token-wide counts.
- [ ] Sum only deduplicated, adequately valued trades; record ambiguity.
- [ ] Global feed and token lookup do not double-count volume.
- [ ] Confirm members by matching pack transactions, not wallet labels alone.
- [ ] Partial pagination produces lower bounds; unknown does not become zero.
- [ ] Netflow is separate and cannot raise automatic priority.

**W12:** every attempt, retry, and page enters the ledger; one backend poller; atomic reservations. Calls 101+ continue when relevant. Concurrent jobs cannot oversubscribe the known configured budget. Unknown cost remains unresolved.

Enable W12 before recurring live sessions. W09/W11 may use fixtures first; do not run an unguarded live poller because the guard is unfinished.

### Stage E — interface workflow: 6 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W13 | Radar, filters, health, SSE | 2 | W07, read API |
| W14 | Pack/wallet/token detail and Smart Money panels | 2.5 | W10, W11 |
| W15 | Operator usage/session/replay | 1.5 | W12, W08 |

**W13:** preserve reading position, default to newest triggers, label manual filters, support SSE resync. Never automatically enable a Smart Money filter.

**W14:** evidence links work; initial/expanded and token/pack counts are distinct. Cover loading, empty, partial, stale, unavailable, error. Support mobile and keyboard. Every UI string, tooltip, accessible label, validation message, and summary is English.

**W15:** require operator auth; public GET never calls Nansen. Distinguish actual/reserved/unresolved credits. Replay creates a clearly labeled separate namespace.

### Stage F — verification: 7 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W16 | Contracts/integration, budgets, invariance, recovery | 5 | W07–W12 |
| W17 | Browser journeys, real data, critical UX fixes | 2 | W13–W16 |

**W16:** all mandatory tests in §7 pass, including network failure, unresolved credits, cooldown restart, and invariance. Fix evidence/accounting failures before demo.

**W17:** radar → detail → wallet → explorer → back works without dead ends. Refresh/restart preserve packs. Internal screenshots/video show accurate mode and failure states, not only the happy path. Check English copy across all screens.

### Stage G — demo runtime: 3 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W18 | Runtime package, storage, startup/shutdown, smoke test | 3 | W16, W17 |

**W18:** clean-start instructions work, database uses persistent disk, health/status is useful, demo backups exist. Public hosting requires verified TLS/operator auth; local demos need a documented runbook. A plan mentioning hosting does not itself authorize buying hosting or publishing.

### Stage H — materials and submission: 3 hours

| ID | Task | Hours | Dependencies |
|---|---|---:|---|
| W19 | README, test evidence, usage manifest | 1.5 | W18 |
| W20 | Demo recording, description, submission checklist | 1.5 | W19 |

**W19:** another builder can run fixtures without keys and understand live setup. Document endpoints, coverage, Smart Money's role, and limitations in English. Do not publish credentials or unsuitable raw provider snapshots.

**W20:** prepare a 30–60-second demo and consistent description/repository references. Draft posts/forms for review; send externally only when instructed.

## 5. Milestones and estimates

| Milestone | Cumulative nominal hours | Exit evidence |
|---|---:|---|
| M1: sources demonstrated | 4 | Real events and API spike results. |
| M2: persisted events | 12 | Dedup, valuation, DB, checkpoints. |
| M3: reproducible packs | 17 | Boundary tests and replay. |
| M4: working Nansen context | 26 | Smart Money/profiles linked to evidence; guard active. |
| M5: complete user flow | 32 | Radar, details, wallet, operator usable. |
| M6: core verification passes | 39 | Test report and demo data. |
| M7: stable runtime | 42 | Startup/restart runbook. |
| M8: materials ready | 45 | README, video, usage manifest, draft submission. |

**Nominal total: 45 active hours. Planning range: 45–60 active hours**, allowing integration, decoding, and fixes. Excludes access delays and rest. Re-estimate after the spike. This is neither a calendar promise nor a prediction of coding-agent speed.

Recheck deadline/submission conditions in the [official competition FAQ](https://academy.nansen.ai/articles/3540155-nansen-meridian-buildathon-sep-14-27) when implementation starts. Do not rely on old hardcoded dates. If time is insufficient, report unpassed scope; never loosen core rules or present fixtures as live proof.

## 6. Nansen budget and usage evidence

### 6.1 Target and forecast

Target at least **100 relevant calls** and continue above 100 for actual analysis, refresh, and pagination. The initial analytical planning estimate is **300 calls**, not a cap. This first-100 example assumes one page per call and **excludes price polling**, added in §6.5.

| Activity | Calls | Credits/call | Credits |
|---|---:|---:|---:|
| Smoke tests/valid payload variants on one-credit endpoints | 6 | 1 | 6 |
| Smart Money DEX feed, token counts, matching, pagination | 16 | 5 | 80 |
| Selected-token Smart Money Netflow | 4 | 5 | 20 |
| Candidate token information | 12 | 1 | 12 |
| Candidate holders, premium labels disabled | 12 | 5 | 60 |
| Selected-wallet PnL | 18 | 1 | 18 |
| Selected-wallet DEX history | 12 | 1 | 12 |
| Selected related wallets | 8 | 1 | 8 |
| Balance/context follow-up and demo verification | 12 | 1 | 12 |
| **Illustrative first 100 analytical calls** | **100** | | **228** |

Pricing basis: [Nansen credits guide](https://docs.nansen.ai/getting-started/credits), reviewed for the source edition on September 25, 2026. Set the operational credit budget separately; the product does not impose a fixed 300-credit ceiling. Account balance is unverified; no purchase has been made. RPC/hosting cost is separate. Nansen price costs are added below. LLM cost is zero in P0 because it is not used.

| Analytical scenario | Calls | Credits at the same mix | Meaning |
|---|---:|---:|---|
| Initial minimum | 100 | 228 | Acceptance threshold; continue useful work. |
| Initial working estimate | 300 | 684 | Broader analysis/updates. |
| Broader usage example | 500 | 1,140 | Illustration, not a ceiling. |

The average 2.28 credits/call only holds for that endpoint mix. More Smart Money/holder queries, retries, or pricing changes alter actual costs. Choose a reserve from the actual session forecast. Crossing 100 alone neither requires stopping nor renewed approval.

Keep premium_labels=false on holders; enabling premium labels materially changes cost. Planned Smart Money queries use dedicated endpoints and do not require premium holder labels.

### 6.2 Smart Money beyond the minimum

The example 16 DEX calls could be 4 feed and 12 targeted/pagination calls, plus 4 Netflow requests. These are not quotas. Record spikes, retries, and additional pages in actual totals. DEX call 17, Netflow call 5, and total call 101 may proceed when needed and funded.

Pagination follows coverage needs, not a fixed three-page limit. Continue until the needed window or last page, subject to progress/session/budget. Incomplete results remain partial. Derive all three windows from shared observations; tab switching does not require three new requests.

Keep cache enabled. Meet usage targets through relevant subjects and refreshes, not purposeless identical requests.

### 6.3 Failures and the minimum target

One hundred attempts need not be 100 successful or competition-eligible calls. For conservative internal acceptance, collect at least **100 relevant successful responses**, then continue necessary work. Reconcile provider usage and track schema success separately. The threshold does not deactivate collection, enrichment, polling, or refresh.

Retries still consume session budget and obey per-job limits. If credits are insufficient, pause and report the requirement. Rate, session, and cost limits remain distinct from a total-call cap. No loop may generate work solely to reach 100, 300, or another number.

### 6.4 Usage manifest

```text
campaign_id, attempt_id, started_at, endpoint, parameter_hash,
purpose, subject_id, http_status, normalization_status,
provider_request_id, quoted_credits, actual_credits,
reservation_status, retry_of_attempt_id, snapshot_id
```

The public manifest should be aggregate and omit secrets or unnecessary raw data. Separate successful/failed calls, unresolved attempts, cache hits, and actual credits. Account usage is reconciliation evidence; do not rely exclusively on local counters.

### 6.5 Add Nansen price cost

The analysis baseline is not the total price-inclusive runtime estimate. With duration D seconds, interval I=30 seconds, and Q active quote assets:

```text
scheduled_price_calls = ceil(D / I) * Q
estimated_total_calls = analysis_calls + scheduled_price_calls + retry_calls
estimated_total_credits = analysis_credits
                        + scheduled_price_calls * price_call_credit
                        + actual_retry_credits
```

The referenced standard OHLCV estimate is 1 credit/request. Capture actual account/header cost. Use one token per request in P0, without assuming batch equivalence.

| Session, no retries | Analysis | Price, one quote every 30s | Total calls | Estimated credits |
|---|---:|---:|---:|---:|
| 1 hour; 100 analytical calls | 100 / 228 credits | 120 / 120 credits | 220 | 348 |
| 2 hours; 300 analytical calls | 300 / 684 credits | 240 / 240 credits | 540 | 924 |
| 4 hours; 500 analytical calls | 500 / 1,140 credits | 480 / 480 credits | 980 | 1,620 |

These are scenarios, not spending targets. Actual counts follow relevant work, sessions, and cache. Relevant price calls count toward the minimum. The requirement is not 100 analysis calls **plus** 100 price calls. However, price requests alone cannot demonstrate wallet/Smart Money integration.

Configure budget for the selected session plus an operator-chosen reserve. No default fixed total ceiling. Keep the scheduler's two-poll price reserve. Session end stops polling without resetting the campaign ledger.

## 7. Datasets and test scenarios

### 7.1 Dataset package

| Dataset | Contents | Purpose |
|---|---|---|
| D1 synthetic boundaries | A/B/C wallets, fixed times, exact threshold amounts | Detector and dedupe. |
| D2 expansion/cooldown | New members and repeated windows | State/timers/restart. |
| D3 synthetic Smart Money | Repeat buyers, sellers, different mints with identical symbols, null USD, member/nonmember matches | Buyer counts and confirmation. |
| D4 sanitized provider responses | Selected real responses, nulls, pages, errors, partial coverage | Internal adapter/contract tests and honest data-quality states. |
| D5 recorded real chain data | Signatures and valuation provenance | Labeled real replay/demo. |
| D6 failures | Timeouts, 429, invalid schema, DB failure, disconnect | Resilience and accounting. |

Each manifest includes mode, origin, time, chain, decoder/config version, and file hashes. Do not claim fabricated fixture signatures are real transactions. Internal provider data is not automatically publishable; public fixtures may be synthetic with equivalent schemas.

### 7.2 Mandatory test matrix

| ID | Scenario | Required outcome |
|---|---|---|
| T01 | A/B/C at 0/7/20 seconds, $20 each | One pack triggers. |
| T02 | A/B/C at 0/7/20.001 seconds | Those three do not trigger. |
| T03 | Five A transactions, one B | Two unique wallets. |
| T04 | $19.99 versus $20 purchases | Only threshold-passing trades are eligible. |
| T05 | Two $10 purchases from one wallet | Do not combine eligibility. |
| T06 | Repeated signature+ordinal | No extra value/member. |
| T07 | Two ordinals in one signature | Preserve distinct events. |
| T08 | Two mints with identical symbols | Keep separate. |
| T09 | Valid expansion exactly at 40 seconds | Accept new member. |
| T10 | Expansion at 40.001 seconds | Exclude from formation membership. |
| T11 | Just before/exact cooldown expiry | Suppress before; permit at boundary if window qualifies. |
| T12 | Nansen/duplicate arrives after trigger | Core and cooldown unchanged. |
| T13 | Out-of-order events within tolerance | Deterministic buffered result. |
| T14 | Backfill/late event | No silent new live alert. |
| T15 | Null/stale price | Neither fake price nor financial zero. |
| T16 | Today's price differs during replay | Use recorded price. |
| T17 | One Smart Money wallet buys ten times | One buyer per applicable window. |
| T18 | Buyer later sells | Remains buyer; no current-holding claim. |
| T19 | Seller-only wallet | Does not add a token buyer. |
| T20 | Smart Money buy below $20 | Counts for token context if valid; does not alter pack. |
| T21 | Nonmember buys token | Token count rises; pack membership does not. |
| T22 | Wallet appears on another token | No automatic pack-buy badge. |
| T23 | Pack bought mint/wallet/hash match | Confirm one member. |
| T24 | Same trade in global and targeted feed | No duplicate volume/count. |
| T25 | Ambiguous multiple swaps | Unique wallets may remain countable; do not claim exact USD. |
| T26 | First page with more pages | Lower bound/partial, not complete total. |
| T27 | 5m covered but 24h incomplete | Separate window coverage. |
| T28 | Scanned empty versus error/partial empty | Distinguish observed zero, null, incomplete. |
| T29 | Smart Money empty/zero/large/error | Identical core output and automatic priority. |
| T30 | Netflow changes sign | Only context changes. |
| T31 | Three browsers and identical requests | One poller; single-flight avoids duplicates. |
| T32 | Two jobs compete for remaining credits | Atomic local reservations prevent oversubscription. |
| T33 | Timeout after send | Keep unresolved attempt/reservation. |
| T34 | 429, retry, extra page | Every attempt follows rate/session/budget and ledger. |
| T35 | Restart during cooldown/running job | Recover state and idempotent leased jobs. |
| T36 | SSE reconnect with stale cursor | Resync; accept freeze's new coreVersion even if evidenceVersion is unchanged; context has its own version. |
| T37 | Database commit fails | Do not publish a persisted pack. |
| T38 | Admin access without auth | Reject; public GET spends no credits. |
| T39 | Same input in live/replay | Separate namespaces; no cross-dedupe or mutation. |
| T40 | Replay co-occurrence | No future packs. |
| T41 | Total 100→101, 300→301; DEX 16→17; Netflow 4→5 | Continue relevant funded work in active session; minimum is reporting only. |
| T42 | Open versus closed OHLCV candle | Use only candleEnd≤eventTime. |
| T43 | Price snapshot available after arrival | Reject for old event; no look-ahead. |
| T44 | Fresh fetch repeats old candle | Still stale by intervalStart. |
| T45 | Price missing then arrives later | Original live event stays unvalued; reconstruct separately. |
| T46 | Analysis plus price costs | Price calls enter ledger/total; example arithmetic and PRICE reserve are correct. |
| T47 | Buffered event exactly at expansionEnd | Process before timer; freeze only when watermark>end. |
| T48 | Event freezes old pack after cooldown | Consider the same event for a new trigger; no early-return loss. |
| T49 | Crash after ingress, before core commit | Process admitted pending event once using original admission; restart alone does not make it late. |
| T50 | Crash after core commit, before SSE | Outbox/resync restores UI without double-counting. |
| T51 | Endpoint-specific address/wallet_address | Use schema/smoke-tested payload mapping; domain subject remains stable. |
| T52 | Cross-namespace price/pack/context/outbox references | Reject or isolate according to schema; replay cannot modify live. |
| T53 | UI login/logout and mutation idempotency | No token leak/duplicate job; same key with different body→409. |
| T54 | LLM disabled and no model key | Build/tests/fixtures/P0 still work. |
| T55 | Smart Money never checked | Confirmation null/not_checked, not misleading zero. |
| T56 | Cache namespace/timeframe/scope differ | No snapshot mix-up; identical work single-flights. |
| T57 | Nansen price/auth and enrichment fail | Old packs readable, collector records, new eligibility only while price valid. |
| T58 | Fees make balance decrease exceed traded amount | Threshold excludes separately identified network/program fees. |
| T59 | Unsupported quote or decimal mismatch | Unsupported quote→unsupported_quote; mismatch→normalization error. Neither is eligible or assumed $1/SOL. |
| T60 | Arrival replay versus historical mode | Equal digests only for equal inputs/mode/clock/prices; no false equivalence across modes. |

### 7.3 Browser verification

- Open radar in loading, empty, available, and disconnected states.
- Open detail, wallet, explorer, return, and refresh.
- Verify long addresses, large amounts, long labels, and tables do not break layout.
- Complete the core journey with keyboard and a narrow viewport.
- Fail Nansen after a snapshot exists; retain its old timestamp visibly.
- Verify Smart Money updates do not move the card being read.
- Restart backend and repeat the journey on a stored pack.
- Check English copy in all states, including forms, errors, tooltips, accessibility labels, and operator controls.

No screenshot test is needed for every cosmetic variation. Prioritize correct metrics, usable journeys, and states that could mislead users.

## 8. Acceptance mapping

| PRD requirement | Tasks | Main evidence |
|---|---|---|
| FR-01–02 | W02, W04, W05 | Real signatures; T04–08, T13–16, T42–45, T58–59. |
| FR-03–04 | W07, W08 | T01–12, T47–50; replay manifest. |
| FR-05–06 | W13, W14 | Radar/detail browser flows and evidence links. |
| FR-07 | W03, W09, W10 | Real snapshots/coverage; T51, T56–57. |
| FR-08–11 | W11 | T17–27, T30; selected provider responses. |
| FR-12 | W09, W11, W14 | T26–28, T44, T55, T57; stale/error UI. |
| FR-13–14 | W06, W08, W18 | T35–37, T39–40, T49–50, T52, T60; restart/replay. |
| FR-15 | W12 | T31–34, T41, T46; ledger reconciliation. |
| FR-16 | W07, W10, W11, W16 | T12, T29, T30; core-output comparison. |
| FR-17 | W15, W18 | T38, T53; operator configuration. |
| FR-18 | W19, W20 | README/video/manifest/checklist; T54. |

Record each milestone using:

```text
Milestone:
Commit/revision:
Environment and mode:
Dataset/manifest:
Detector configuration:
Commands/tests run and actual results:
Evidence references:
API usage since the previous milestone:
Outstanding issues and impact:
Decision: continue / fix / defer scope:
```

## 9. Scope-reduction rules

### 9.1 What may be reduced under time pressure

Automatically analyzed subject counts, graphs, animation, export, behavior classification, demo-example count, refresh frequency, and acquisition breadth may be reduced. Expose the coverage consequences.

Cut in this order: all P1 → visual polish → additional enrichment subjects → refresh frequency. Preserve one correct end-to-end workflow. A combined score must not displace the requested Smart Money information.

### 9.2 What must remain

Core thresholds/windows, dedupe, unique buyers versus trades, Smart Money separation, partial/null/live/replay labels, transaction evidence, secret protection, a budget guard before recurring paid polling, and tests affecting correctness cannot be removed.

### 9.3 Release blockers

Wrong wallet/direction decoding; precision loss or double-counting; partial Smart Money counts presented as exact totals; Smart Money changing triggers/scores/automatic priority; exposed keys; uncontrolled paid calls on browser refresh; false persistence claims after failed commits; or fixtures presented as live data.

If unresolved, present an honestly limited prototype rather than claiming MVP acceptance.

## 10. Demo runbook

### 10.1 Preparation

1. Choose one real main pack and two backups if available.
2. Verify signatures, members, valuation, snapshots, and mode provenance.
3. Prepare a token with real Smart Money data; every pack member need not match.
4. Pin demo data/snapshots against retention cleanup.
5. Check balance, credit budget, and session end in operator controls; end the session when demo work finishes.
6. Check viewport, English status copy, and explorer links.
7. Replay video must retain the original date and Replay badge.

If no member is confirmed, show unconfirmed honestly and use available real token activity. Do not add fixture badges to complete a narrative.

### 10.2 A 55-second walkthrough

| Time | Action | Message |
|---|---|---|
| 0–6s | Radar and mode | Observe grouped purchases. |
| 6–15s | Open a pack | Several wallets bought the same token in a short window. |
| 15–25s | Timeline and evidence | Every alert has inspectable transactions. |
| 25–38s | Smart Money panel | Period-based token buyers differ from confirmed pack members. |
| 38–48s | Profile/holders/relationships | Add context for investigation. |
| 48–55s | Sources, time, project | Coverage is explicit; core detection is unchanged. |

### 10.3 English narration

> PackLens finds wallets buying the same Solana token almost simultaneously. Every pack has transaction evidence. Nansen adds wallet and token context, including Smart Money buyer counts across several time windows. Those counts are separate from confirmed pack members, and partial data is clearly labeled. Pack detection stays unchanged; Smart Money provides additional context for the user.

### 10.4 Backup demo

If the live source is quiet/disconnected, use labeled real recordings with dated snapshots. If Nansen is unavailable, show stored data with its fetch time. If no core integration snapshot exists, do not claim the integration has been proven.

## 11. README and submission package

### 11.1 Application README structure

1. User problem and concrete product result.
2. Screenshot/short video of actual implementation.
3. Transaction source, pack rules, coverage limits.
4. Smart Money periods, matching, netflow, partial data.
5. Actual architecture and stack.
6. Runtime requirements and lockfile installation.
7. Credential-free fixture startup.
8. Secure live environment setup.
9. Migrations, start, replay, core tests.
10. Nansen endpoints, cache, and cost controls.
11. Limitations, design choices, WolfBrain inspiration.
12. Actual P0/P1 status.

Write the README and supporting docs in English. Required command names are specified in the blueprint, but do not claim they work until implemented and run in a clean environment.

### 11.2 Materials checklist

- [ ] Final name and short description.
- [ ] Repository free from secrets and local runtime data.
- [ ] Reproducible fixture/live README.
- [ ] Completed 30–60-second video with readable mode badges and English narration.
- [ ] Usage summary and Nansen evidence ready for review.
- [ ] Verified project/repository links intended for publication.
- [ ] Draft X post describes implemented functionality.
- [ ] Submission form and current official FAQ checked.

The 100-call minimum is a user-defined project target. Relevant usage beyond it needs no new approval solely because of call count. Publication format and competition eligibility depend on organizer rules at submission time. This plan does not send posts, messages, or forms.

## 12. Definition of Done

### Product and data

- [ ] One complete real-pack workflow can be demonstrated; target three saved packs for variety.
- [ ] Member transactions are traceable and not double-counted.
- [ ] Pattern indicators and initial/expanded membership satisfy the rules.
- [ ] Nansen wallet/token panels show period and coverage.
- [ ] Smart Money 5m/1h/24h metrics exist or show truthful unavailable/partial states.
- [ ] Token count, pack confirmation, buy value, and netflow are clearly separate.
- [ ] All app text and delivery materials are English.

### Correctness and resilience

- [ ] All T01–T60 pass without unresolved correctness failures.
- [ ] Runtime tests prove Smart Money invariance.
- [ ] Restart, reconnect, provider failure, and replay preserve evidence.
- [ ] Public GET makes no paid requests.
- [ ] Secrets are absent from UI, public logs, and repository.
- [ ] Budget/rate/session/reservations are tested before sustained live use; no total-call cap or stop at 100.

### Operations and delivery

- [ ] Relevant usage is reconciled against ledger/account; any shortfall is explicit.
- [ ] Necessary analysis/refresh continues after reaching the minimum, within budget/session.
- [ ] Actual/reserved/unresolved credits are distinct.
- [ ] Runtime is reproducible from instructions.
- [ ] README/video/feature list match implementation.
- [ ] Material limitations are disclosed where relevant.
- [ ] Materials are ready for review before authorized publication/submission.

Demo-ready does not mean trading-ready or identical to WolfBrain. The deliverable is the PRD's investigation tool.

## 13. After the MVP

With evidence of user needs: improve source coverage → evaluate Smart Money quality/cost → add Holdings/history → refine investigation visuals → consider notifications and additional chains.

Preserve baseline versioning. A combined score requires a dataset and evaluation method. Smart Money cannot enter primary logic without an explicitly agreed product change.

## 14. Normative test vectors

These are synthetic, not real transactions. Domain tests may use A/B/C/M identifiers; API adapters still test valid 32-byte Base58 fixtures. Unless stated otherwise, all events are BUYs of mint M with pinned USD20. Times are seconds relative to a fixture epoch; convert to milliseconds before the domain. Each row has a unique event ID.

### V01 — exact trigger boundary

```json
{
  "vectorId":"V01",
  "events":[
    {"id":"e1","wallet":"A","t":0,"usd":"20"},
    {"id":"e2","wallet":"B","t":7,"usd":"20"},
    {"id":"e3","wallet":"C","t":20,"usd":"20"}
  ],
  "expected":{
    "packCount":1,"triggerAt":20,"firstTime":0,
    "initialMembers":["A","B","C"],"totalBuyUsd":"60",
    "expansionEnd":40,"suppressUntil":140
  }
}
```

V02: set e3.t=20.001; expected packCount=0. V03: all wallets A except e3=B; expected 0. V04: e2.usd=19.99; expected 0. V05: duplicate e3 after trigger; value stays 60 and suppressUntil stays 140.

### V06 — a genuinely qualifying expansion window

Extend V01 with e4=A at t=25, USD20: window [5,25] contains B/C/A and qualifies. Add e5=D at t=40, USD20: [20,40] contains C/A/D and qualifies.

Expected: initialMembers A/B/C unchanged, expandedMembers=[D], total wallets=4, totalBuyUsd=100, lastAccepted=40, expansionEnd=40, suppressUntil=160.

e6=E at t=40.001 does not become a member. Without e4, D at t=40 has only C/D in the current window and cannot expand the pack. A timer at W=40 does not freeze; W=40.001 freezes after the t=40 event is processed.

### V07 — cooldown and freezing old state

Continue V06 with F at 150, G at 155, H at 160, USD20 each. F/G remain buffered but cannot trigger during cooldown. At H, window [140,160] contains F/G/H. Pack two: firstTime=150, trigger=160, expansionEnd=190, suppressUntil=280.

Also test a stale checkpoint still holding activePackId when H is consumed directly: freeze the old state and still consider H. In a normal sequence, F/G or timers may freeze earlier; the final result must match.

### V08 — price without look-ahead

```json
{
  "vectorId":"V08",
  "eventTime":"2026-09-25T12:02:10Z",
  "receivedAt":"2026-09-25T12:02:11Z",
  "quoteAmount":"0.1",
  "snapshots":[
    {"id":"p1","availableAt":"2026-09-25T12:02:05Z","start":"2026-09-25T12:01:00Z","close":"200"},
    {"id":"p2","availableAt":"2026-09-25T12:02:05Z","start":"2026-09-25T12:02:00Z","close":"250"},
    {"id":"p3","availableAt":"2026-09-25T12:02:12Z","start":"2026-09-25T12:01:00Z","close":"210"}
  ],
  "expected":{"selectedSnapshot":"p1","tradeValueUsd":"20","eligible":true}
}
```

Remove p1: p2 is open at event time and p3 was unavailable on arrival. Expect missing_price, tradeValueUsd=null, eligible=false. A closed, available but too-old candle instead produces stale_price. Never modify p1 retrospectively; save a new version and retain the event's old reference.

### V09 — three Smart Money windows

asOf=12:00 UTC, `(start,end]`; same mint M and scope:

| Wallet | UTC time | Direction against M | Outcome |
|---|---|---|---|
| A | 11:59 | buy | In all windows. |
| A | 11:58 | buy | No additional unique buyer. |
| B | Exactly 11:55 | buy | Excluded from 5m; included in 1h/24h. |
| C | Exactly 11:00 | buy | Excluded from 1h; included in 24h. |
| D | Exactly 12:00 previous day | buy | Excluded from 24h. |
| E | 11:59 | sell only | No buyer. |
| F | Buy 11:57, sell 11:59 | both | Still a buyer. |
| G | Exactly 12:00 | buy | In all windows. |
| H | 12:00:01 | buy | Beyond asOf, excluded. |

Expected: 5m=3 (A/F/G), 1h=4 (A/B/F/G), 24h=5 (A/B/C/F/G). If these observations came from an incomplete first page, counts are lower bounds. Null USD for A does not remove A as a buyer.

### V10 — context cannot change the core

Replay V01/V06 with empty context, token count=100/positive netflow, and token count=0/negative netflow. Keep prices/clock/events/config equal. Core semantic digests must match. Member confirmation changes only with matching hash/wallet/mint evidence; a token-count change cannot fabricate matching evidence.

### V11 — credit ledger

Budget=10, settled=5, active reservation=1, unresolved=1, price reserve=2. Accounting remaining=3; enrichment may spend only 1. Reject an enrichment estimate of 5. A price request costing 1 may use the reserve. Settlement replaces its reservation, not a second debit. Timeout without actual cost keeps an unresolved reservation until reconciliation.

Request 101 does not affect these decisions. Use a fake provider to prove the counter is not a cap; this test need not spend actual credits.

## 15. Implementation gates and reporting

### G0 — offline preparation

Build, typecheck, lint, migrations, unit/contract tests, and fixture UI work without keys. Do not stop independent implementation because live credentials are missing. State which live checks remain pending.

### G1 — source integration

Verify buy/sell/failure decoding, closed-candle quote pricing, token/profile response, Smart Money DEX, and netflow. Record cost headers/coverage; pin schemas/IDL. If timestamp lookup exceeds the two-second tolerance, measure and report degraded coverage rather than claiming equivalent real-time alerts.

### G2 — correctness and recovery

Pass T01–T60 and V01–V11 on the implementation. Before browser tests, verify namespace SQL constraints, processed-marker crashes, exact 40-second behavior, causal prices, and credit accounting. Valid documents or JSON do not constitute this gate passing.

### G3 — product workflow

Radar → pack → wallet/token → evidence → refresh → restart works. Show modes, waiting/stale prices, partial/null counts, and timestamps. Public GET does not call Nansen. Switch fixture/live without source edits or browser secrets. English copy must cover every user-visible state.

### G4 — usage proof and application handoff

Report actual calls, successful HTTP, schema-valid results, cache hits, and credits; reconcile account usage. The 100 minimum is meaningful real usage, not purposeless spending. Without access/balance, report “Offline verified; live blocked,” not “MVP complete.” If only some endpoints succeeded live, name them accurately.

The coding agent's final report includes commit, runtime/dependency versions, executed commands/results, dataset/manifest paths, startup instructions, missing configuration, actual limitations, and G0–G4 statuses. Do not publish repositories/posts/forms or buy services without instructions covering those actions.
