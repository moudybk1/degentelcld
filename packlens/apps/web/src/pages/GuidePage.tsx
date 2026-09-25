import { Link } from "react-router";
import type { PackListItem } from "@packlens/contracts";
import { PackCard } from "../components/PackCard";
import { Reveal, Tag } from "../components/ui";
import { GLOSSARY } from "../lib/glossary";
import { useNsHref } from "../state/namespace";

const now = Date.now();
const EXAMPLE: PackListItem = {
  core: {
    id: "0".repeat(64),
    namespace: "fixture:example",
    chain: "solana",
    tokenAddress: "Examp1eMint111111111111111111111111111pump",
    state: "frozen",
    configVersion: "pack-baseline-v1",
    firstEventTimeMs: now - 180_000,
    triggerEventTimeMs: now - 174_000,
    triggeredAtMs: now - 172_000,
    lastAcceptedEventTimeMs: now - 150_000,
    initialWalletCount: 3,
    totalWalletCount: 6,
    eligibleBuyUsd: "529.88",
    expansionEndMs: now - 140_000,
    suppressUntilMs: now - 30_000,
    coreVersion: 3,
    evidenceVersion: 2,
  },
  token: { chain: "solana", mint: "Examp1eMint111111111111111111111111111pump", name: "Example Token", symbol: "EXMPL", identitySource: "pumpfun_create_event" },
  patterns: {
    formulaVersion: "patterns-v1",
    initialEntrySpanMs: 6000,
    allMemberEntrySpanMs: 31000,
    memberCount: 6,
    buySizeCV: "0.57",
    largestBuyerShare: "0.3",
    cooccurrencePairCount: 1,
    cooccurrenceCoverageStart: null,
    patternScore: null,
  },
  analysisState: "complete",
  smartMoney1h: {
    window: "1h",
    windowStart: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now).toISOString(),
    observedUniqueBuyers: 12,
    countQualifier: "observed",
    knownBuyUsd: "994.74",
    missingValuationCount: 0,
    ambiguousTradeCount: 0,
    state: { availability: "available", coverage: "window_scanned", freshness: "fresh", fetchedAt: new Date(now).toISOString(), periodStart: null, periodEnd: null, reasonCode: null, snapshotIds: [] },
    scopeHash: "example",
  },
  confirmedMemberCount: 2,
  totalMemberCount: 6,
  invalidated: false,
  after: { lastChangePct: -18.4, peakChangePct: 62.1, lastTradeAt: new Date(now - 20_000).toISOString(), tradesAfter: 140, membersSold: 4, memberCount: 6, graduatedAt: null },
};

const QUESTIONS: { q: string; a: string; where: string }[] = [
  { q: "Has the price already moved?", a: "Compare “now” with “peak”. A pack that already ran far above its entry is a different situation from one still near its entry.", where: "Card: After the pack · Page: After the pack" },
  { q: "Are the pack wallets still holding?", a: "If most pack wallets have sold, the group that created the signal has left. “Holding” wallets have not sold in the observed trades.", where: "Page: Pack wallets sold, and the per-wallet table" },
  { q: "Is it really a group, or one buyer?", a: "A high largest-buyer share or near-identical buy sizes mean the pack may be one actor. Check the evidence rows.", where: "Page: Pattern indicators, Members and evidence" },
  { q: "Has this group done it before, and what happened then?", a: "Earlier packs with the same wallets show how those tokens moved in the next 15 minutes. It is history, not a prediction.", where: "Page: Earlier packs with these wallets" },
  { q: "Is buying continuing?", a: "Buys vs sells and net SOL since the pack formed show whether new money kept arriving or the token is being sold into.", where: "Page: Activity since the pack" },
  { q: "Is Smart Money in the pack, or only near the token?", a: "“Confirmed” pack wallets matched their own pack transaction. Smart Money buyers on the token may be anyone.", where: "Card and page: the two Smart Money lines" },
  { q: "What don't we know?", a: "“Not checked”, “Partial”, gaps, and “Not analyzed yet” all mean missing information, never zero or safe.", where: "Page: Reading this pack → Not known, and Coverage" },
];

export function GuidePage() {
  const href = useNsHref();
  return (
    <div className="container">
      <Reveal>
        <div className="eyebrow">Guide</div>
        <h1 className="display">
          How to read PackLens <em>— in three minutes.</em>
        </h1>
        <p className="lede">
          PackLens shows what happened, with evidence: groups of wallets buying the same pump.fun token at almost the same time, what they did next, and what Nansen knows about them. It does not tell you what will happen next.
        </p>
        <nav className="guide-toc" aria-label="Guide sections">
          <a href="#g-rule">The one rule</a>
          <a href="#g-card">Reading a card</a>
          <a href="#g-page">Reading a pack page</a>
          <a href="#g-questions">Before you act</a>
          <a href="#g-sm">Smart Money</a>
          <a href="#g-labels">Status labels</a>
          <a href="#g-limits">What it cannot tell you</a>
          <a href="#g-glossary">Glossary</a>
        </nav>
      </Reveal>

      <section className="section" id="g-rule" aria-labelledby="g-rule-h">
        <h2 className="h2" id="g-rule-h" style={{ marginBottom: 18 }}>
          The one rule: facts versus context
        </h2>
        <div className="bento">
          <div className="card span-6">
            <Tag>Facts about the pack</Tag>
            <h3 className="h3" style={{ margin: "12px 0 6px" }}>
              From the Solana chain, never changed by Nansen
            </h3>
            <p className="small" style={{ margin: 0 }}>
              Which wallets bought, when, how much, the price afterwards, and who sold. Every pack keeps its transactions, and you can open each one on Solscan.
            </p>
          </div>
          <div className="card span-6">
            <Tag tone="blue">Context from Nansen</Tag>
            <h3 className="h3" style={{ margin: "12px 0 6px" }}>
              Added afterwards, always labeled
            </h3>
            <p className="small" style={{ margin: 0 }}>
              Smart Money, wallet histories, relationships, holders. Each panel says when it was fetched and how complete it is. Smart Money never changes which packs are detected.
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="g-card" aria-labelledby="g-card-h">
        <h2 className="h2" id="g-card-h" style={{ marginBottom: 18 }}>
          Reading a pack card
        </h2>
        <div className="bento">
          <div className="span-6">
            <div inert aria-hidden="true">
              <PackCard item={EXAMPLE} now={now} />
            </div>
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Example card with invented numbers.
            </p>
          </div>
          <div className="span-6">
            <ol className="callouts">
              <li>
                <strong>Token and state.</strong> Name, symbol, and copyable address. <em>Collecting</em> means the pack can still gain wallets; <em>Frozen</em> means it is final.
              </li>
              <li>
                <strong>6 wallets, $529.88, 6 s.</strong> Six distinct addresses bought (3 started it, 3 joined), their qualifying buys total $529.88, and the first three bought within 6 seconds.
              </li>
              <li>
                <strong>Indicators.</strong> Size variation (0 = identical buys), the largest wallet's share, and repeat pairs seen in earlier packs. Facts, not a score.
              </li>
              <li>
                <strong>After the pack.</strong> The token last traded 18.4% below the pack's entry after peaking 62.1% above it, and 4 of 6 pack wallets have sold.
              </li>
              <li>
                <strong>Smart Money buying this token.</strong> 12 Smart Money wallets bought the token in the past hour. They are not necessarily in the pack.
              </li>
              <li>
                <strong>Pack wallets confirmed as Smart Money: 2 of 6.</strong> Two pack wallets' own buys appear in Nansen's Smart Money data. The other four are unconfirmed, not proven otherwise.
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section className="section" id="g-page" aria-labelledby="g-page-h">
        <h2 className="h2" id="g-page-h" style={{ marginBottom: 18 }}>
          Reading a pack page, top to bottom
        </h2>
        <ol className="callouts guide-prose">
          <li>
            <strong>Reading this pack.</strong> Start here: what happened, what is worth checking, and what is not known, in plain sentences.
          </li>
          <li>
            <strong>Formation.</strong> How many wallets started the pack and how many joined, the pack's total, and its cooldown.
          </li>
          <li>
            <strong>Members and evidence.</strong> The timeline, each wallet, and every buy with the price used and a Solscan link.
          </li>
          <li>
            <strong>Pattern indicators.</strong> Timing, size variation, largest buyer, repeat pairs.
          </li>
          <li>
            <strong>After the pack.</strong> Price against the pack's entry, peak and low, which pack wallets sold and when, and buying versus selling since.
          </li>
          <li>
            <strong>Earlier packs with these wallets.</strong> The group's history and how those tokens moved in 15 minutes.
          </li>
          <li>
            <strong>Smart Money.</strong> Token buyers in 5 minutes, 1 hour, 24 hours; confirmed pack wallets; netflow.
          </li>
          <li>
            <strong>Wallet and token context, coverage.</strong> Nansen profiles, relationships, holders, and anything missing.
          </li>
        </ol>
      </section>

      <section className="section" id="g-questions" aria-labelledby="g-questions-h">
        <h2 className="h2" id="g-questions-h">
          Seven questions before you act
        </h2>
        <p className="muted" style={{ margin: "8px 0 20px", maxWidth: 720 }}>
          PackLens is one input to a trading decision. These are the questions it can help answer, and where to look.
        </p>
        <div className="qa">
          {QUESTIONS.map((x, i) => (
            <div className="card" key={x.q}>
              <h3>
                {i + 1}. {x.q}
              </h3>
              <p>{x.a}</p>
              <p className="where">Where: {x.where}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="g-sm" aria-labelledby="g-sm-h">
        <h2 className="h2" id="g-sm-h" style={{ marginBottom: 18 }}>
          Smart Money: two different numbers
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">You see</th>
                <th scope="col">It means</th>
                <th scope="col">It does not mean</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>12 Smart Money buyers, 1 h</td>
                <td>12 Smart Money wallets bought this token in the hour before the last check.</td>
                <td>That they are in the pack, still holding, or that the price will rise.</td>
              </tr>
              <tr>
                <td>2 of 6 pack wallets confirmed</td>
                <td>Two pack wallets' own pack buys appear in Nansen's Smart Money data.</td>
                <td>That the other four are not Smart Money.</td>
              </tr>
              <tr>
                <td>At least 3</td>
                <td>Only part of Nansen's data was checked; there may be more.</td>
                <td>Exactly three.</td>
              </tr>
              <tr>
                <td>0 observed</td>
                <td>Checked, and none were found in that window.</td>
                <td>That no Smart Money wallet ever touched the token.</td>
              </tr>
              <tr>
                <td>Not checked</td>
                <td>Unknown: no lookup has run yet.</td>
                <td>Zero.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" id="g-labels" aria-labelledby="g-labels-h">
        <h2 className="h2" id="g-labels-h" style={{ marginBottom: 18 }}>
          Status labels
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Available", "Data was fetched and is shown with its time."],
                ["Empty", "Checked, and the source returned nothing."],
                ["Partial", "Only part of the data was covered; numbers are lower bounds."],
                ["Window scanned", "The source's full results for the window were checked (not every transaction on the chain)."],
                ["Stale / Last checked", "Older data, kept with its original time."],
                ["Update delayed", "The newest fetch failed; you see the previous snapshot."],
                ["Unavailable from this source", "Nansen has no data for this token yet, common for brand-new tokens."],
                ["Not analyzed yet", "Not picked for automatic analysis; an operator can run it."],
                ["Analysis paused", "The credit budget or session limit was reached. Detection keeps running."],
                ["Fixture / Replay / Live", "Synthetic demo data, a recorded dataset at its original times, or the live stream."],
              ].map(([l, m]) => (
                <tr key={l}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <strong>{l}</strong>
                  </td>
                  <td>{m}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" id="g-limits" aria-labelledby="g-limits-h">
        <h2 className="h2" id="g-limits-h" style={{ marginBottom: 14 }}>
          What PackLens cannot tell you
        </h2>
        <ul className="guide-prose" style={{ paddingLeft: 20 }}>
          <li>What the price will do next. Every number is about the past.</li>
          <li>Whether wallets belong to the same person. A relationship or repeat pairing is a lead, not proof.</li>
          <li>Whether a token is safe. There is no safety or rug-pull check.</li>
          <li>Trades outside the pump.fun bonding curve: after a token graduates, or on other venues.</li>
          <li>Anything during a collector gap; those periods are labeled.</li>
        </ul>
        <p className="guide-prose muted small">Research tool. Not trading advice. Use it with your own judgment and risk limits.</p>
      </section>

      <section className="section" id="g-glossary" aria-labelledby="g-glossary-h">
        <h2 className="h2" id="g-glossary-h" style={{ marginBottom: 18 }}>
          Glossary
        </h2>
        <dl className="stack" style={{ gap: 14, margin: 0, maxWidth: 820 }}>
          {Object.values(GLOSSARY).map((g) => (
            <div key={g.term} className="kv" style={{ alignItems: "flex-start", borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
              <dt style={{ fontWeight: 600, color: "var(--ink)", minWidth: 200 }}>{g.term}</dt>
              <dd style={{ margin: 0, textAlign: "left", flex: 1, color: "var(--ink-2)" }}>{g.text}</dd>
            </div>
          ))}
        </dl>
        <p style={{ marginTop: 28 }}>
          <Link className="btn primary" to={href("/")}>
            Back to Pack Radar
          </Link>
        </p>
      </section>
    </div>
  );
}
