# PackLens Product Requirements Document

**Version 2.1 FINAL — English edition · September 25, 2026**

Status: final specification for a coding agent. The application and live integrations have not been implemented by this documentation package. Version 2.1 is the standalone English handoff; do not treat earlier Indonesian plans as additional requirements. Nansen supplies price and analytical data, Solana RPC supplies the primary transaction stream, and an LLM is not a P0 dependency.

**MUST** identifies an acceptance requirement. **DEFAULT** identifies a decision to implement without asking again. **P1** work follows successful P0 delivery. The PRD owns product requirements, the blueprint owns technical contracts, and the MVP plan owns execution and acceptance evidence. If a material conflict is found, identify the conflicting passages and continue independent work; do not silently change core rules.

Companion documents: [Technical blueprint](02-TECHNICAL-BLUEPRINT-PACKLENS.md) · [MVP and implementation](03-MVP-AND-IMPLEMENTATION-PACKLENS.md) · [Handoff guide](00-START-HERE.md).

## Contents

1. [Product overview](#1-product-overview)
2. [Locked decisions](#2-locked-decisions)
3. [Users and their jobs](#3-users-and-their-jobs)
4. [Goals and success measures](#4-goals-and-success-measures)
5. [Product scope](#5-product-scope)
6. [Terminology and metric definitions](#6-terminology-and-metric-definitions)
7. [User journeys](#7-user-journeys)
8. [Functional requirements](#8-functional-requirements)
9. [Screen specifications](#9-screen-specifications)
10. [Information and interpretation rules](#10-information-and-interpretation-rules)
11. [Quality requirements](#11-quality-requirements)
12. [Product analytics and evaluation](#12-product-analytics-and-evaluation)
13. [Risks and product decisions](#13-risks-and-product-decisions)
14. [Release acceptance](#14-release-acceptance)

## 1. Product overview

PackLens is an investigation radar for grouped token purchases on Solana. It detects wallets buying the same token within a short period, preserves the transactions that formed the group, and adds wallet and token context from Nansen.

The central question is:

> A group of wallets bought this token almost simultaneously. Who participated, which transactions prove it, and how many Smart Money wallets also bought the token?

The workflow is inspired by WolfBrain. The intended similarity concerns detection patterns and how users investigate events. Identical output, AI scores, and reference-system coverage are not promised. PackLens uses its own implementation, branding, and interface.

The product reduces the number of transactions users must inspect manually, connects alerts to evidence, and presents Nansen context with its observational limits. Users make their own decisions. The MVP does not execute trades.

### 1.1 Product statement

For Solana token researchers facing a busy transaction feed, PackLens groups closely timed purchases into traceable events. Users inspect the underlying pattern first, then consider wallet history, relationships, holder distribution, and Smart Money activity.

### 1.2 Assumptions to validate

| Hypothesis | Validation | Response if unsupported |
|---|---|---|
| Grouping transactions helps investigation | A user can explain a pack and open its evidence | Simplify cards and details. |
| Nansen has relevant context for some candidates | Test real tokens and wallets early | Show coverage honestly; retain tokens not yet indexed. |
| Smart Money buyer counts help users | Users distinguish token buyers from pack members | Improve the labels and placement of the two counts. |
| Integration fits the available hackathon time | Milestones produce a demonstrable vertical workflow | Defer P1 and visual extras. |

## 2. Locked decisions

These decisions apply across the package. Changes require an explicit specification revision.

| ID | Decision |
|---|---|
| INV-01 | Initial detection covers Solana pump.fun transactions that are actually decoded. |
| INV-02 | Trigger on at least **3 unique wallets**, each contributing an eligible purchase of at least **$20 per transaction**, within an inclusive **20-second maximum window**. |
| INV-03 | Expansion lasts until **40 seconds from the first evidence event**, subject to the same qualifying rolling window. Suppress new token alerts until **120 seconds after the last newly accepted detector evidence**. |
| INV-04 | Smart Money status, buyer counts, and netflow do not change triggers, membership, pattern indicators/scores, or automatic priority. |
| INV-05 | Enrichment or Smart Money failure does not remove a pack. New USD eligibility requires a valid Nansen price snapshot. Otherwise record the transaction as unvalued and do not treat it as passing $20. |
| INV-06 | Token-wide Smart Money buyers and confirmed pack members are separate metrics. |
| INV-07 | Null, observed zero, partial data, and old snapshots are distinct states. |
| INV-08 | Target at least **100 relevant Nansen calls** and continue above that as needed. There is no fixed total-call ceiling; a cache hit is not a provider call. |
| INV-09 | Replay, synthetic fixtures, and live data have visible, separate modes and evidence. |
| INV-10 | These documents specify a build; they do not prove implementation. Credentials, account balance, and authenticated live responses remain unverified. |
| INV-11 | Quote-asset prices come from Nansen OHLCV 1m, using closed candles without look-ahead, under blueprint §5.3. |
| INV-12 | P0 uses neither an LLM nor a new combined numeric score. Summaries use deterministic templates. |

The baseline derives from prior analysis of [WolfBrain's public logic](https://www.wolfbrain.online/assets/intel.js?v=20260924h) and [public engine](https://www.wolfbrain.online/engine.js?v=20260924a). PackLens aggregation follows the explicit, testable contracts in this package.

## 3. Users and their jobs

### 3.1 Primary user: token researcher

This user understands wallets, token mints, and explorers. They need quick context but will inspect evidence. Their jobs are to:

- Find closely timed purchases of the same token.
- Verify that wallet counts are unique addresses.
- Identify participants using available data.
- See how many Smart Money wallets bought the token in a stated period.
- Inspect relationships or ownership concentration that warrant further investigation.

The product finds events worth reviewing; it does not require reading the entire stream.

### 3.2 Operational user: builder or demo operator

The operator configures sources, starts polling sessions, checks credits, chooses real recordings, and makes the demo reproducible. Operational controls belong in a separate panel rather than dominating the research interface.

### 3.3 Evaluation user: judge or repository reader

This user needs a concise problem statement, evidence of Nansen usage, a clear demo, and reproducible setup instructions. They must be able to distinguish working functionality, development fixtures, and future work.

## 4. Goals and success measures

### 4.1 Product goals

1. Trace each alert to its forming transactions.
2. Make the distinction between transaction patterns and Smart Money context understandable.
3. Preserve investigations across refreshes and restarts.
4. Give Nansen usage a real product purpose and measurable cost.
5. Prevent data failures from creating false claims or changing core rules.

### 4.2 MVP acceptance targets

| Measure | Initial target | Evidence |
|---|---|---|
| Boundary-rule correctness | All mandatory cases pass | Deterministic tests in the MVP plan. |
| Persisted real packs | Target 3, including 1 suitable for the main demo | Inspectable dataset and signatures; depends on source activity. |
| Traceability | Every pack member has transaction references | Detail page and database inspection. |
| Smart Money separation | All invariance tests pass | Identical replay with different Smart Money context. |
| Persistence | Packs survive refresh and restart | User-flow and backend-restart tests. |
| Nansen usage | Minimum 100; initial analytical planning estimate 300 relevant calls, possibly more | Reconcile ledger and account usage; reaching the minimum does not stop service. |
| User understanding | Testers explain the difference between 12 token buyers and 2 pack members | Short sessions with 2–3 people where available. |

Pack-count targets do not guarantee market events. Real recordings are acceptable when their original time and Replay mode are visible. Profit and price-prediction accuracy are not MVP success metrics.

## 5. Product scope

### 5.1 P0: included in the MVP

| Area | Included |
|---|---|
| Primary data | pump.fun collector and decoder, Nansen OHLCV 1m quote prices, deduplication, gap tracking. Default quote: native SOL/WSOL; additional quotes require validated adapters and explicit configuration. |
| Patterns | 3-wallet/$20/20-second detector, expansion, cooldown, timing, size variation, co-occurrence, and purchase dominance indicators. |
| Experience | Radar, pack detail, wallet panel, token context, Smart Money Activity. |
| Nansen | Token information, holders, PnL summary, wallet DEX history, selected related-wallet queries, selected balance follow-up. |
| Smart Money | DEX feed, unique token buyers over 5m/1h/24h, observed buy value, member matching, selected-token netflow. |
| Reliability | Persistence, snapshots, cache, request ledger, credit guard, replay, error states. |
| Delivery | README, labeled public fixtures, demo materials, and test evidence. |

### 5.2 P1: after P0 is stable

A combined numeric pattern score, fuller wallet-behavior classification, interactive relationship graphs, Smart Money Holdings, card export, saved filters, LLM-generated explanations, and broader periodic follow-up are P1.

P0 displays factual pattern indicators with blueprint-defined formulas. Smart Money and LLM output are not inputs to those formulas. P0 does not generate a combined numeric score.

### 5.3 Out of scope

Multiple chains, every Solana DEX, wallet connection, automated execution, copy trading, private-key management, return predictions, unexplained AI scoring, public-user authentication, product billing, Telegram, and multiple backend instances are outside the MVP.

A price chart is not required to finish the core workflow. Users can open relevant evidence sources from detail pages.

## 6. Terminology and metric definitions

| Term | Product definition |
|---|---|
| Pack | An event satisfying grouped-purchase rules from the primary detection source. |
| Unique wallet | A distinct address on the same chain; not a count of people or beneficial owners. |
| Initial member | A wallet in the qualifying window when the pack first triggers. |
| Expanded member | A newly accepted wallet during the expansion period. |
| Pack purchase value | Sum of unique eligible USD transactions accepted as pack evidence. |
| Entry span | Difference between the earliest and latest first-entry event times in the stated member set. |
| Smart Money | The group returned by Nansen Smart Money endpoints under the stored scope; not inferred from wallet size. |
| Token Smart Money buyer | A unique wallet with an observed purchase of the mint during the specified window. |
| Confirmed Smart Money pack member | A member whose pack purchase matches a Smart Money observation by chain, wallet, bought mint, and transaction. |
| Observed Smart Money buy value | Sum of purchases with usable valuation and deduplicated identity; not net new capital. |
| Smart Money netflow | A separate provider metric with its own period and coverage. |
| Window scanned | The relevant provider-response window has been examined without known gaps; not a census of all on-chain activity. |
| Partial data | Some pages, periods, valuations, or continuity evidence are missing or uncertain. |

### 6.1 Smart Money counting rules

Provide **5-minute, 1-hour, and 24-hour** windows. Cards use 1 hour; detail shows all three. A wallet buying ten times counts once in each window containing a purchase. Do not add counts across windows.

A wallet that buys and later sells remains a buyer for that window. Buyer status does not imply current ownership. A seller-only wallet does not increase buyer count. Buying during the window does not mean the wallet entered the token for the first time ever.

The detector's $20 threshold does not apply to token-wide Smart Money buyer counts. Small observed purchases from the appropriate source still count.

Buyers outside the pack count toward the token metric. A pack badge requires a matching pack transaction, not merely a wallet observed elsewhere. Token-window and pack-confirmation counts have different periods and evidence; for an old pack they need not describe nested sets.

### 6.2 Interpretation example

Synthetic example:

> Pack: 5 wallets. Smart Money token buyers over 1 hour: 12 wallets. Confirmed pack members: 2 of 5. The other three members are not confirmed in the checked data.

This does not mean 14 buyers, 12 pack members, or three members proven not to be Smart Money. Twelve describes the token window; two describes pack evidence.

## 7. User journeys

### 7.1 Radar to evidence

1. Open the radar and see mode, source, and the age of the latest event.
2. A pack appears after the primary rules pass; enrichment may still be pending.
3. Open it without waiting for all APIs.
4. Inspect the timeline, members, purchase value, and source transactions.
5. Nansen panels arrive independently, each with period, fetch time, and state.
6. Consider Smart Money as additional information.
7. Open a wallet or explorer and return to the same persisted pack.

### 7.2 Smart Money Activity to token

The feed contains observations from the Smart Money endpoint. Clicking a token opens stored context. If the primary detector has found no pack, show “No pack detected in the monitored source.” Several nearby Nansen rows do not themselves create a pack.

### 7.3 During data failures

Persisted packs and evidence remain readable. Each failing panel states its own condition. Public users do not receive controls that silently trigger paid requests. Authenticated operators may explicitly refresh through protected controls.

### 7.4 Older packs

Initially show analysis saved with the pack. Newer token context, if available, has its own timestamp and is not presented as the state at trigger time. Later labels do not rewrite alert history.

## 8. Functional requirements

Every FR below is P0 unless explicitly stated otherwise. IDs map to implementation and tests.

| ID | Requirement | Acceptance |
|---|---|---|
| FR-01 | Consume the primary transaction source | Decode real buys and sells; failed transactions do not enter the detector. |
| FR-02 | Normalize identity and valuation | Events have mint, wallet, signature, ordinal, time, direction, amounts, and valuation provenance. |
| FR-03 | Detect packs | Events at 0/7/20 seconds trigger; 0/7/21 do not. Repeated wallets do not inflate uniqueness. |
| FR-04 | Expansion and cooldown | Honor 40-second expansion and 120 seconds from the last valid accepted evidence. |
| FR-05 | Radar | Filterable, cursor-paginated list remains readable while updates arrive. |
| FR-06 | Detail and evidence | Every member traces to events; initial and expanded members are distinct. |
| FR-07 | Base Nansen context | Wallet/token/holder/relationship data shows coverage; one panel failure does not clear others. |
| FR-08 | Smart Money feed | Activity includes source, time, buy/sell direction, and scope; it does not automatically create packs. |
| FR-09 | Smart Money buyer counts | Count distinct wallets by mint for 5m/1h/24h; duplicates and seller-only activity do not add buyers. |
| FR-10 | Member matching | Confirmation requires matching transaction evidence; wallet-only observation is insufficient. |
| FR-11 | Purchase value and netflow | Separate observed buy value from netflow; missing USD valuation is partial. |
| FR-12 | Data-quality states | Distinguish unchecked, observed empty, partial, stale, error, and paused states. |
| FR-13 | Persistence | Refresh/restart preserve packs, evidence, cooldowns, and usage accounting. |
| FR-14 | Replay | Identical event, clock, price, mode, and configuration inputs reproduce the same pack semantics; isolate live data. |
| FR-15 | API usage and cost | Reserve credits for retries/pages; call 101 and later proceed when needed and funded within the active session. |
| FR-16 | Smart Money separation | Changing all Smart Money context leaves core output and automatic priority unchanged. |
| FR-17 | Operator controls | Protect enrichment/replay mutations; public endpoints only read snapshots. |
| FR-18 | Documentation and demo | README accurately explains startup, sources, limitations, and data modes. |

### 8.1 Priority user stories

**US-01 — Inspect an alert.** As a researcher, I want the transactions forming a pack so I can check its basis. Accept when radar opens detail and every member has traceable evidence. Depends on FR-01–06 and FR-13.

**US-02 — Consider Smart Money activity.** As a researcher, I want token buyer counts and their periods so I can compare broader activity with the pack. Accept when token and member counts are separate and partial coverage is visible. Depends on FR-08–12 and FR-16.

**US-03 — Understand uncertainty.** As a researcher, I want to know what has not been analyzed so missing data is not mistaken for a negative result. Accept when API failure preserves packs and gives panel-specific reasons. Depends on FR-07, FR-12, FR-13.

**US-04 — Run a cost-aware demo.** As an operator, I want one polling session and an auditable ledger so browsers share data and analysis continues beyond 100 calls. Accept with rate limits, shared cache, configured credit budget, and account reconciliation, without a total-call cap. Depends on FR-14, FR-15, FR-17–18.

## 9. Screen specifications

### 9.1 Radar

The header identifies PackLens, Solana, pump.fun, mode, and collector health. Main tabs are **Pack Radar** and **Smart Money Activity**. Operational credit totals belong in the operator panel.

A card contains token identity, a copyable address, unique wallet count, eligible purchase value, entry span, trigger time, pattern indicators, analysis state, and a 1-hour Smart Money summary. The primary link opens detail.

Default order is newest event-trigger time first, with ID as tie-breaker. Manual filters may change the visible subset. A user-selected Smart Money filter is visibly active; the system does not automatically enable it or reorder by Smart Money.

Enrichment does not move the card being read. Buffer arrivals behind a **New packs available** control. Distinguish **No packs detected yet** from **Source disconnected**.

### 9.2 Pack detail

Display in this order:

1. Pack identity, source, mode, time, and persistence state.
2. Initial versus expanded summary.
3. Member timeline and table with transaction evidence.
4. Event-derived pattern indicators.
5. Token Smart Money and member confirmation.
6. Available profiles, relationships, holders, liquidity, and follow-up.
7. Coverage limits and analysis-update history.

The member table includes address, first entry, eligible event count, value, initial/expanded classification, and confirmation state. Missing information has meaningful text rather than unexplained blank cells.

### 9.3 Smart Money panel

**All application copy MUST be English:** navigation, headings, buttons, forms, validation, tooltips, accessibility labels, loading/empty/error states, operator screens, and generated summaries. Keep identifiers, addresses, token names, and provider proper names intact. P0 requires no language switcher. Documentation and demo narration in this edition are also English.

Illustrative wireframe:

```text
SMART MONEY ON THIS TOKEN
Observed unique buyers
5 minutes: 3      1 hour: 12      24 hours: at least 28

Observed buy value, 1 hour: $24,500
Confirmed pack members: 2 of 5
1-hour netflow: shown separately

Period ending: 06:00 UTC | Fetched: 06:02 UTC
24-hour coverage is partial. This does not change pack detection or indicators.
```

This is synthetic. The buyer tooltip explains that subsequent sellers remain buyers for the window. Users can open stored evidence without triggering a paid fetch. Use English number formatting; display time zones explicitly and retain ISO UTC in API/storage.

### 9.4 Wallet and token panels

Wallet panels show PnL/history periods, sample size, known values, and provider-returned relationships. Behavioral labels are not required in P0. Token identity is chain plus mint even if name or image is unavailable.

Holder concentration requires compatible balances and supply. A partial holder list describes the observed portion. Pack purchase dominance is a separate metric and is not token-supply distribution.

### 9.5 Operator panel

Show source health, decoder version, jobs, errors, session end times, credit use, successful/failed requests, cache hits, and replay controls. Only authenticated operators can trigger work. Never redisplay secrets.

## 10. Information and interpretation rules

| Condition | Recommended English copy | Behavior |
|---|---|---|
| Not checked | Not analyzed yet | Missing numeric result is null. |
| Window scanned, no buyers | 0 buyers observed in the checked data | Show period and scope. |
| Partial with buyers | At least N buyers observed | Keep the partial label visible. |
| Partial without buyers | No buyers observed; data is incomplete | Do not claim total zero. |
| Old snapshot | Last checked … | Keep the original period. |
| Token unavailable | Token data is unavailable from this source | Retain the pack. |
| API error | Update delayed | Keep a previous snapshot readable. |
| Budget exhausted | Analysis paused | Continue healthy collection; new USD eligibility waits for valid prices if the price reserve also runs out. |

Do not automatically conclude “insider,” “definitely a bot,” “safe,” “guaranteed to rise,” or “profit probability.” A transfer relationship does not prove common ownership. Smart Money is a source category, not a guarantee about future trades.

Netflow may include activity beyond DEX purchases. Keep it separate from buyer counts; positive netflow does not confirm a member's entry. See the [Nansen netflow contract](https://docs.nansen.ai/api/smart-money/netflows).

## 11. Quality requirements

| ID | Area | Design target and verification |
|---|---|---|
| NFR-01 | Correctness | All mandatory boundaries pass; do not round before threshold evaluation. |
| NFR-02 | Determinism | Identical events, clock, prices, mode, and configuration reproduce evidence. |
| NFR-03 | Interface responsiveness | Local snapshot API p95 below 500 ms on the demo dataset; measure before claiming. |
| NFR-04 | Internal processing | Eligible event leaving the buffer to persisted/published update p95 below 1 second, excluding provider delays. |
| NFR-05 | Resilience | Reconnect does not duplicate events; restart restores packs and cooldowns. |
| NFR-06 | Operational security | Backend-only keys and protected credit-spending operations. |
| NFR-07 | Accessibility | Keyboard access to cards/details; states are not conveyed by color alone. |
| NFR-08 | Responsive layout | Core flow works at 360 px and desktop; long tables have clear scrolling. |
| NFR-09 | Observability | Trace requests to jobs/snapshots/usage without exposing secrets. |
| NFR-10 | Context separation | No detector dependency on Smart Money; runtime tests prove invariance. |

Latency targets are not end-to-end real-time guarantees. Nansen has its own indexing and caching; show panel age under the [data coverage documentation](https://docs.nansen.ai/api/data-coverage).

## 12. Product analytics and evaluation

Record simple local events: `radar_viewed`, `pack_opened`, `wallet_opened`, `evidence_opened`, `smart_money_panel_viewed`, and `data_state_visible`. No external analytics service is required.

Store time, mode, screen type, and pack ID where relevant. Do not store secrets, header contents, or users' browser addresses. Aggregate local demo counts suffice; identity tracking is unnecessary.

After a trial, ask:

1. Which transactions made this pack appear?
2. Do 12 Smart Money buyers mean 12 pack members?
3. Can you distinguish zero, unchecked, and partial data?
4. Does Smart Money change detection/indicators or only provide context?
5. Which evidence would you inspect before drawing a conclusion?

Use answers to improve labels and information order. A small sample cannot substantiate trading-performance claims.

## 13. Risks and product decisions

| Risk | Early signal | Product response |
|---|---|---|
| Very new tokens not indexed | Many empty candidate responses | Retain packs, show available wallet analysis, choose a real demo with sufficient context. |
| Partial Smart Money coverage | Incomplete or unstable pages | Continue relevant pagination within session/budget; show lower bounds until adequately covered. |
| Transaction source disconnects | Collector gap | Show the outage and label recovered data. |
| Development time runs short | Core milestones remain unpassed | Defer P1 and visual extras. |
| Buyers mistaken for holders | Testers conflate metrics | Clarify labels and periods; do not infer current positions. |
| Expectation of exact WolfBrain output | Scores/candidates differ | Compare inputs, scope, valuation, and rules; do not promise private-server equivalence. |
| Call estimates are insufficient | More subjects, refreshes, or pages are needed | Revise the forecast and continue within credits; neither stop at 100 nor generate purposeless requests. |

Nansen OHLCV 1m is already selected for price. Runtime, package manager, and defaults follow the blueprint. Resolve actual RPC access, compatible dependency patches, credentials, budget, and hosting during implementation; local demo is the default. Authenticated account access and balance have not been verified.

## 14. Release acceptance

The MVP implements this PRD when every P0 functional requirement and critical quality requirement has recorded evidence, radar → pack → wallet → evidence works, and Smart Money adds information without changing the core.

- [ ] Trigger and time boundaries satisfy INV-02/03.
- [ ] Persisted packs remain visible without enrichment. Stale price clearly prevents new USD eligibility without discarding transactions.
- [ ] Token buyers and confirmed pack members are distinct.
- [ ] Relevant panels show source, period, and data state.
- [ ] Smart Money adds no automatic score or priority bonus.
- [ ] Refresh, restart, and replay preserve traceable evidence.
- [ ] Ledger supports proof of the required relevant Nansen usage.
- [ ] README and demo reflect actual implementation.
- [ ] All app copy, documentation, and demo narration are English.

See the [MVP plan](03-MVP-AND-IMPLEMENTATION-PACKLENS.md) for backlog, fixtures, scope cuts, and acceptance evidence; see the [blueprint](02-TECHNICAL-BLUEPRINT-PACKLENS.md) for module and data contracts.
