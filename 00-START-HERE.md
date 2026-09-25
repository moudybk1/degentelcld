# PackLens — Final Coding-Agent Handoff

**Version 2.1 FINAL — English edition · September 25, 2026**

**Application language: English. Documentation language: English. Demo narration: English.**

This standalone package specifies PackLens: a Solana grouped-purchase investigation radar inspired by public WolfBrain patterns, with additional Nansen Smart Money context. A coding agent does not need the conversation or earlier Indonesian plans. The documents define testable behavior; they do not prove that the application or live integrations already exist.

This edition translates the complete product, engineering, execution, and handoff details. It preserves the detection rules, endpoint identifiers, configuration keys, formulas, and requirement/test IDs. It supersedes the earlier instruction to write application documentation in Indonesian.

## 1. Send these four files together

| Order | Document | Contents and authority |
|---|---|---|
| 1 | [This guide](00-START-HERE.md) | Final decisions, prerequisites, handoff instructions, copy-ready agent prompt. |
| 2 | [PRD](01-PRD-PACKLENS.md) | User problem, 12 invariants, 18 functional requirements, scope, screens, product acceptance. |
| 3 | [Technical blueprint](02-TECHNICAL-BLUEPRINT-PACKLENS.md) | Architecture, detector, prices, DTOs, database, endpoints, queue, credits, Smart Money, configuration, recovery. |
| 4 | [MVP and implementation](03-MVP-AND-IMPLEMENTATION-PACKLENS.md) | 20 tasks, milestones, budget, 60 test scenarios, 11 vectors, gates, demo. |

Send all four files or the accompanying English ZIP. Do not mix v1.x/v2.0 Indonesian plans into the agent's requirements. Synthetic examples are test data, not market observations. Provider payloads are templates, not evidence of successful requests.

**Authority:** PRD owns needs/invariants, blueprint owns technical contracts, MVP owns execution/evidence. Satisfy all three. If a real conflict is found, identify both passages and their impact, continue independent work, and do not silently change core rules. Proven upstream schema differences belong in adapter compatibility notes.

## 2. Final decisions that do not need to be asked again

| Area | Decision |
|---|---|
| Working name | PackLens; independent branding. |
| Chain/source | Solana, actually decoded pump.fun transactions, confirmed commitment. |
| Trigger | At least three unique wallets, each forming purchase at least $20, inclusive window at most 20 seconds. Two $10 trades do not become one eligible $20 trade. |
| Expansion | Until 40 seconds from first evidence; the current rolling window must still contain three eligible wallets. |
| Cooldown | Until 120 seconds after the last newly accepted evidence, not an API response. Exact expiry may trigger if the current window qualifies. |
| Price | Nansen OHLCV 1m, closed candles available before original arrival; default native SOL/WSOL quote; shared polling every 30 seconds in an active session. |
| Price failure | Keep transactions; use only still-valid cache. Unvalued does not pass $20. No retroactive live alert after prices recover. |
| Smart Money | Additional context only; no effect on trigger, membership, indicators, base assessment, cooldown, or automatic priority. |
| Smart Money metrics | Unique token buyers over 5m/1h/24h, observed buy value, confirmed pack members, separate netflow; not transaction counts or automatic current-holder counts. |
| Data quality | Distinguish null, observed zero, partial, stale, unavailable, and error. |
| Nansen usage | Internal minimum: 100 relevant successful responses. Continue above 100 as needed. No fixed total-call cap; rate, session, and credit limits still apply. |
| LLM | Not required for P0; deterministic summaries. Optional P1 LLM requires no model key for P0 build/test/MVP. |
| Scores | Factual P0 indicators; no new combined numeric score or profit probability. |
| Stack | Node 24, TypeScript strict, npm workspaces, React/Vite, Fastify, SQLite WAL, SSE. |
| Runtime | One persistent backend and one database writer. Local demo by default; public deployment is not an offline-coding prerequisite. |
| Language | Every app screen/state, tooltip, error, accessible label, README, supporting document, and demo narration is English. Preserve identifiers/token proper names. No P0 language switcher needed. |
| Ordering | Newest event-trigger first; enrichment does not move the card being read. |
| Modes | Visible, isolated fixture/live/replay; replay makes no provider calls. |

Identical private WolfBrain output is not promised. The testable target is baseline behavior for equal input. Source coverage, valuation, indexing delay, and private algorithms can change observed candidates.

## 3. APIs and other prerequisites

### Required for live integration

1. **Nansen key and account credits** for nine operations: quote OHLCV, token information, holders, wallet PnL, wallet DEX history, related wallets, current balances, Smart Money DEX, Smart Money netflow. Use one backend client. Exact paths/payloads/headers are in blueprint §8/§17.
2. **Solana HTTP and WebSocket RPC** for subscriptions, transaction/time lookup, reconnect, and recovery. Use an available provider whose throughput is verified; no specific brand is mandatory.
3. **Official pump.fun program identity and IDL**, pinned by version/hash and checked against real transactions. This is the decoding contract, not an LLM API or another required paid service.
4. **Runtime and persistent disk**: Node 24, dependency toolchain, SQLite, and capacity for snapshots/datasets/logs. P0 needs neither Redis nor a vector database.

### Values the operator must supply or configure

| Value | Needed when |
|---|---|
| Application repository/directory | At implementation start. If absent, use a new `packlens/` directory in the supplied workspace without overwriting another project. |
| `NANSEN_API_KEY` | Before smoke tests/live sessions; backend secret only. |
| `SOLANA_RPC_HTTP_URL`, `SOLANA_RPC_WS_URL` | Before live collection; redact credential-bearing URLs. |
| `NANSEN_BUDGET_CREDITS` | Before paid calls; based on actual balance/allocation, with no invented default amount. |
| `NANSEN_SESSION_END_AT` | Before live polling; explicit ISO UTC session end. |
| `ADMIN_TOKEN` | Operator controls; generate at least 32 random bytes and store securely. |
| Public host/domain | Only for a public demo; local operation is enough for implementation/testing. |

Missing credentials do not block scaffold, database, detector, fixtures, UI, or offline tests. Do not ask to paste secrets into documentation, source, or reports. Complete live configuration enables SMART_MONEY_ENABLED=true; default fixtures disable paid adapters.

No second price API, LLM key, private wallet key, wallet connection, transaction service, Telegram, or chart subscription is required to finish P0.

## 4. Interpret cost and effort correctly

One-hour example: 100 analytical calls at the illustrated mix cost 228 credits; 120 quote-price polls add 120 credits. Total estimate: **220 calls / 348 credits**, before retries. This is a forecast, not a spending instruction or verified balance. Actual mix/pricing may differ. Relevant price calls count toward the minimum, but wallet/Smart Money features need their own integration evidence.

Nominal effort is **45 active hours**, with a **45–60-hour planning range** and re-estimation after the spike. This is not a coding-agent speed promise or a hackathon calendar schedule. Recheck submission rules when building. Do not solve budget/time constraints by presenting fixture data as live.

## 5. Copy-ready coding-agent prompt

Copy the entire block and attach these four English v2.1 files. Conversation history is unnecessary.

```text
Implement PackLens P0 using these attached v2.1 FINAL English documents:
00-START-HERE.md, 01-PRD-PACKLENS.md,
02-TECHNICAL-BLUEPRINT-PACKLENS.md,
03-MVP-AND-IMPLEMENTATION-PACKLENS.md.

Read all four before changing domain rules. Build the functioning product and
verification evidence, not only a landing page, mockup, or another plan.
Save copies in docs/specs/ in the application repository. If no app repository
exists, create packlens/ without overwriting other work. Follow applicable
repository instructions.

PRODUCT
A Solana grouped-purchase radar from decoded pump.fun transactions: radar,
pack/member detail, explorer evidence, Nansen wallet/token context, Smart Money,
operator usage/session controls, and replay. React/Vite, Fastify on Node 24,
strict TypeScript, npm workspaces, SQLite WAL, SSE, one persistent instance.
Pin compatible dependencies and commit the lockfile. Do not add Next.js,
a serverless collector, Redis, or an LLM as a P0 dependency.

LANGUAGE
The entire app is English: navigation, headings, actions, forms, validation,
loading/empty/error states, tooltips, accessible labels, operator controls,
and generated summaries. README, setup guides, supporting docs, test
explanations, and demo narration are also English. Preserve code identifiers,
addresses, token names, and provider proper names. No P0 language switcher.
Do not retain an earlier instruction to write documentation in Indonesian.

INVARIANTS
- Trigger on at least three unique wallets, each eligible buy at least USD20,
  in an inclusive 20-second window. Two USD10 trades cannot combine eligibility.
- Expansion ends 40 seconds from first evidence and still requires a valid
  rolling window. Cooldown ends 120 seconds after last accepted new evidence.
- Quote price comes from Nansen OHLCV 1m, closed candles in snapshots available
  at original receivedAt. Map native SOL to WSOL for lookup. Exclude separately
  identified fees from traded quote amount. Missing valid price means unvalued,
  never a forced eligible purchase.
- Pin event prices/values. Do not retrospectively use future data.
- Smart Money writes context only. It does not change core, indicators, base
  assessment, cooldown, membership, or automatic ordering/priority.
- Token buyers over 5m/1h/24h differ from confirmed pack members. Count unique
  buyers, including subsequent sellers; exclude seller-only wallets. Observed
  buy value is separate from netflow. Missing/partial does not mean total zero.
- Target at least 100 relevant successful Nansen responses, with no total-call
  cap. Calls 101+ continue if needed, funded, and within session. Cache hits
  are not provider calls. Do not create purposeless requests for a counter.
  Price polling belongs in usage and cost accounting.
- P0 summaries are templates and indicators are factual. No LLM or new combined
  score. P1 must not obstruct P0 completion.

EXECUTION
1. Inspect the workspace/configuration without printing secrets. Use locked
   defaults instead of asking again about stack/formulas. Start fixture mode
   when keys, RPC, budget, or session configuration are missing.
2. Scaffold contracts, runtime schemas, migrations, config validation, fixtures.
   Provide a minimal ledger/guard before any paid integration spike. Never call
   Nansen from frontend code or public GET routes.
3. Follow W01-W20. Demonstrate source decoding and upstream payloads when access
   is available. Implement collection, pricing, admission/watermark, pure
   detection, atomic storage, replay, client/queue, context, APIs, and UI.
   Continue independent offline work if live integration is waiting for access.
4. Honor closed-candle boundaries, exact 40-second behavior, ingress dedupe
   versus processed markers, restart admission, namespace FKs, coreVersion
   versus evidenceVersion, contextVersion, period-aware caching, pagination
   coverage, reserved/settled/unresolved credits, and protected mutations.
5. Validate upstream schemas and real smoke tests. Map address/wallet_address
   per endpoint; invent neither aliases nor filters. Preserve sanitized
   fixtures and compatibility notes. Schema errors are not zero results and
   adapter changes do not authorize different product rules.
6. Run T01-T60, V01-V11, and core browser journeys. Implement and test npm ci,
   dev, build, typecheck, lint, test, test:e2e, db:migrate, start, replay,
   verify:live as specified. Routine tests are offline fixtures. Paid live
   tests require configured key, budget, and session. Do not claim unrun
   commands succeeded. Check English copy across successful and failure states.
7. Verify source-to-UI flow: transaction → valuation → pack → Nansen snapshot
   → counts/matching → browser → refresh/restart. Measure late/unvalued rates;
   do not claim complete coverage when inputs are degraded.
8. Prepare English README, architecture/module notes, data-coverage document,
   DB schema generated from actual migrations, dataset manifests, test report,
   usage manifest, demo script, and draft submission. Evidence and mode labels
   must match real implementation.

EXECUTION BOUNDARIES
Do not invent credentials, balance, live data, passing tests, real signatures,
or identical WolfBrain output. Keep secrets out of logs/repositories.
Do not buy services, publish, deploy publicly, or submit drafts without an
instruction covering that external action. Do not build trading execution
or ask for a private wallet key.

If live testing is blocked, finish independent offline work and report the
exact outstanding configuration and gates. Do not claim the entire MVP is
complete. If specifications materially conflict, identify both passages and
impact, continue independent work, and do not silently alter core invariants.

FINAL REPORT
Include repository/commit, runtime/dependencies, delivered changes, executed
commands and actual results, G0-G4 status, dataset/manifest locations, startup
instructions, real call/credit counts including unresolved amounts, limitations,
and remaining work. Separate verified offline results from verified live ones.
```

## 6. Handoff and completion checklist

**Documentation package:** four English files cover requirements, implementation contracts, and acceptance. Package checks cover local links, JSON/SQL examples, task/test IDs, budgets, boundary examples, and untranslated text. These checks do not count as application tests or live API validation.

**The coding agent must demonstrate:**

- [ ] G0: build, lint, typecheck, migrations, fixtures, offline tests.
- [ ] G1: real decoding, Nansen price, profiles, Smart Money DEX, netflow.
- [ ] G2: correct rules, precision, recovery, isolation, accounting, invariance.
- [ ] G3: usable English UI, data states, refresh/restart, protected controls.
- [ ] G4: reconciled real usage, minimum met, accurate report/demo.

Reading these documents does not complete any implementation checkbox. MVP acceptance requires actual evidence.
