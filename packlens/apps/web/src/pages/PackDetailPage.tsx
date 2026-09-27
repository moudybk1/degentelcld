import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, PushPin, Play } from "@phosphor-icons/react";
import type { PackDetail } from "@packlens/contracts";
import { apiPost, apiRaw, ApiError, track } from "../api/client";
import { useEventListener } from "../api/events";
import { useApi, useDocumentTitle, useNow } from "../api/hooks";
import { Timeline } from "../components/Timeline";
import { SmartMoneySection } from "../components/SmartMoneyPanel";
import { HoldersCard, TokenInfoCard, WalletProfileCard } from "../components/ContextPanels";
import { AfterSection, EarlierPacksTable, ReadoutPanel } from "../components/AfterSection";
import { PackGlance } from "../components/PackGlance";
import { packLead } from "../lib/packFacts";
import { ruleUsd, useRule } from "../lib/rule";
import { InfoTip } from "../components/InfoTip";
import { Address, Empty, ErrorNote, ExtLink, KV, LoadingBlock, ModeBadge, Note, Reveal, ShareLink, Stat, Tag, TokenAvatar, TradeLink, useRowLimit, type FromState } from "../components/ui";
import { dateTimeUtc, pct, rawAmount, relative, seconds, timeUtc, titleCase, usd } from "../lib/format";
import { analysisLabel, matchLabel, REVIEW_FLAG_TEXT } from "../lib/labels";
import { nansenTokenUrl, tokenUrl, txUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";

function OperatorActions({ detail, onChange }: { detail: PackDetail; onChange: () => void }) {
  const [me, setMe] = useState<{ authenticated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void apiRaw<{ authenticated: boolean }>("/api/admin/me").then(setMe).catch(() => setMe(null));
  }, []);
  if (!me?.authenticated || !detail.core.namespace.startsWith("live:")) return null;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      onChange();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ gap: 8 }}>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => apiPost(`/api/admin/enrich/${detail.core.id}`, {}, { idempotent: true }), "Analysis queued.")}>
        <Play size={13} weight="bold" aria-hidden="true" /> Run base analysis
      </button>
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={() => void run(() => apiPost("/api/admin/demo-pins", { chain: "solana", mint: detail.core.tokenAddress, enabled: !detail.isDemoPinned }, { idempotent: true }), detail.isDemoPinned ? "Demo pin removed." : "Token pinned for demo refresh.")}
      >
        <PushPin size={13} weight="bold" aria-hidden="true" /> {detail.isDemoPinned ? "Unpin token" : "Pin token for demo"}
      </button>
      {message && <span className="small muted" role="status">{message}</span>}
    </div>
  );
}

/**
 * The page's section index. The link for the section currently under the
 * sticky bars is marked, so readers always know where they are.
 */
function SectionNav({ items }: { items: string[][] }) {
  const [active, setActive] = useState<string | null>(null);
  const key = items.map((i) => i[0]).join(",");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map(([id]) => document.getElementById(id!)).filter((e): e is HTMLElement => e !== null);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find(([id]) => seen.get(id!));
        if (first) setActive(first[0]!);
        // Above the first section (the page header), no section is current.
        else if (els[0] && els[0].getBoundingClientRect().top > 140) setActive(null);
      },
      { rootMargin: "-140px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // The id list (key) is the dependency; the array itself is rebuilt every render.
  }, [key]);
  return (
    <nav className="section-nav" aria-label="Sections on this page">
      {items.map(([idx, label]) => (
        <a key={idx} href={`#${idx}`} className={active === idx ? "on" : undefined} aria-current={active === idx ? "location" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

export function PackDetailPage() {
  const { id = "" } = useParams();
  const href = useNsHref();
  const now = useNow(5000);
  const rule = useRule();
  const { data, meta, error, loading, reload } = useApi<PackDetail>(`/api/packs/${id}`);
  useDocumentTitle(data ? `${data.token.symbol || data.token.name || "Token"} pack · ${data.core.totalWalletCount} wallets · ${dateTimeUtc(data.core.triggerEventTimeMs)} · Degentellegence` : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memberRows = useRowLimit(data?.members ?? [], 25);
  const evidenceRows = useRowLimit(data?.evidence ?? [], 25);

  useEffect(() => {
    track("pack_opened", "pack_detail", id);
  }, [id]);
  // Recent packs keep changing after they form: refresh the stored snapshot every 20 s while visible.
  const recent = data ? Date.now() - data.core.triggerEventTimeMs < 3 * 3_600_000 : false;
  useEffect(() => {
    if (!recent) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 20_000);
    return () => clearInterval(t);
  }, [recent, reload]);
  useEffect(() => {
    if (data) track("smart_money_panel_viewed", "pack_detail", id);
  }, [Boolean(data), id]);

  // Links to a section (…#sec-after) land on it once the pack has loaded.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || scrolledFor.current === id) return;
    scrolledFor.current = id;
    const target = window.location.hash.slice(1);
    if (target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
  }, [data, id]);

  useEventListener(
    (msg) => {
      if (msg.type === "resync_required" || msg.aggregateId === id || (msg.payload as { packId?: string }).packId === id) {
        if (!timer.current) {
          timer.current = setTimeout(() => {
            timer.current = null;
            reload();
          }, 800);
        }
      }
    },
    [id, reload],
  );

  if (error && !data) {
    return (
      <div className="container">
        <Link to={href("/")} className="breadcrumb">
          <ArrowLeft size={14} weight="bold" aria-hidden="true" /> Pack Radar
        </Link>
        <div style={{ marginTop: 24 }}>{error.status === 404 ? <Empty title="Pack not found">This pack does not exist in the data you are viewing.</Empty> : <ErrorNote error={error} what="This pack" />}</div>
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className="container">
        <LoadingBlock label="Loading pack" lines={5} />
      </div>
    );
  }
  if (!data) return null;

  const d = data;
  const synthetic = meta?.mode === "fixture" || d.evidence.every((e) => e.sourceMode === "fixture");
  const tokenName = d.token.name || "Unknown token";
  const initial = d.members.filter((m) => m.memberKind === "initial");
  const expanded = d.members.filter((m) => m.memberKind === "expanded");
  const metaById = new Map(d.evidenceMeta.map((m) => [m.eventId, m]));
  const matchByWallet = new Map(d.smartMoney.packConfirmation.memberMatches.map((m) => [m.walletAddress, m]));
  const analysis = analysisLabel(d.assessment.analysisState);
  const profileWallets = new Set(d.context.selectedProfileWallets);
  const profileTitle = (wallet: string): string => {
    const extra = d.context.extraProfileWallets.find((x) => x.wallet === wallet);
    if (extra?.reason === "largest_buyer") return "Largest buyer";
    if (extra) return `Seen in ${extra.earlierPacks} earlier pack${extra.earlierPacks === 1 ? "" : "s"}`;
    return d.members.some((m) => m.walletAddress === wallet && m.memberKind === "initial") ? "Started the pack" : "Joined later";
  };
  const smChecked = d.members.some((m) => (matchByWallet.get(m.walletAddress)?.matchState ?? "not_checked") !== "not_checked");
  const fromHere: FromState = { from: { label: tokenName, href: href(`/packs/${d.core.id}`) } };

  return (
    <div className="container">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={href("/")}>Pack Radar</Link>
        <span aria-hidden="true">/</span>
        <span>{tokenName}</span>
      </nav>

      {/* 1. Identity, source, mode, time, persistence */}
      <header className="id-head">
        <div className="row" style={{ gap: "14px 22px", alignItems: "flex-end", minWidth: 0 }}>
          <TokenAvatar mint={d.core.tokenAddress} symbol={d.token.symbol} name={d.token.name} image={d.token.imageUrl} large />
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <ModeBadge mode={meta?.mode} />
            {d.core.state === "collecting" ? (
              <Tag tone="blue" dot pulse title="The pack can still gain wallets">
                Forming
              </Tag>
            ) : (
              <Tag tone="outline" title="The list of wallets is final">
                Final
              </Tag>
            )}
            {d.isDemoPinned && <Tag tone="yellow">Demo pinned</Tag>}
            {d.coverage.auditedInvalidated && <Tag tone="red">Invalidated</Tag>}
          </div>
          <span className="spacer" />
          <OperatorActions detail={d} onChange={reload} />
        </div>
        <h1 className="display">
          {tokenName} {d.token.symbol && <em>{d.token.symbol}</em>}
        </h1>
        <div className="id-meta">
          <Address value={d.core.tokenAddress} href={href(`/tokens/solana/${d.core.tokenAddress}`)} external={synthetic ? null : tokenUrl(d.core.tokenAddress)} head={6} tail={6} copyLabel="Copy token address" state={fromHere} />
          <span>
            Triggered {dateTimeUtc(d.core.triggerEventTimeMs)} · {relative(d.core.triggerEventTimeMs, now)}
          </span>
          <span>Source: pump.fun</span>
          <ShareLink label="Copy pack link" />
          {!synthetic && <TradeLink href={nansenTokenUrl(d.core.tokenAddress)} />}
        </div>
        {d.token.identitySource && (
          <p className="tiny muted" style={{ margin: "10px 0 0" }}>
            Name and symbol from {d.token.identitySource === "pumpfun_create_event" ? "the pump.fun create event" : "Nansen token information"}; token text is shown as untrusted data.
          </p>
        )}
      </header>

      <SectionNav
        items={[
          ...(d.after ? [["sec-glance", "At a glance"], ["sec-after", "After the pack"], ["sec-earlier", "Earlier packs"]] : []),
          ["sec-members", "Wallets"],
          ["sec-sm", "Smart Money"],
          ["sec-context", "Context"],
          ["sec-technical", "Technical details"],
        ]}
      />

      {d.after && (
        <section id="sec-glance" style={{ marginTop: 28 }} aria-labelledby="sec-glance-h">
          <div className="glance-head">
            <h2 className="h2" id="sec-glance-h">
              Pack at a glance
            </h2>
            <p className="small muted">
              <strong>{packLead(d.core, d.patterns, ruleUsd(rule))}</strong> These answers come from the observed trades and describe what happened, not what the price will do next.
            </p>
          </div>
          <PackGlance detail={d} />
        </section>
      )}

      <section id="sec-reading" className="reading" aria-label="Reading this pack">
        <details className="reading-toggle">
          <summary>
            Read the full written summary <InfoTip text="A reading in plain language, built from the facts on this page with fixed rules. It shows what happened and what to check; it never recommends buying or selling." label="Reading this pack" />
          </summary>
          <div style={{ marginTop: 16 }}>{d.readout ? <ReadoutPanel items={d.readout} summary={d.summary} /> : <p className="summary-quote">{d.summary}</p>}</div>
        </details>
        {synthetic && (
          <div style={{ marginTop: 14 }}>
            <Note tone="blue">Example data: every address, signature, price, and Nansen value on this page is synthetic.</Note>
          </div>
        )}
      </section>

      {d.after && (
        <section className="section" aria-labelledby="sec-after">
          <div className="section-head">
            <div>
              <div className="eyebrow">For your decision</div>
              <h2 className="h2" id="sec-after" style={{ marginTop: 6 }}>
                After the pack
              </h2>
              <p className="muted small" style={{ margin: "6px 0 0", maxWidth: 720 }}>
                What happened on pump.fun after this pack formed: price against the pack's own entry, whether the pack wallets are still holding, and whether buying continued. Facts from the monitored stream, not predictions.
              </p>
            </div>
            <span className="small muted">Updated {relative(d.after.asOf, now)}</span>
          </div>
          <AfterSection core={d.core} after={d.after} synthetic={synthetic} />
        </section>
      )}

      {d.earlierPacks && (
        <section className="section" aria-labelledby="sec-earlier">
          <div className="section-head">
            <div>
              <h2 className="h2" id="sec-earlier">
                Earlier packs with these wallets <InfoTip k="earlierPacks" />
              </h2>
              <p className="muted small" style={{ margin: "6px 0 0", maxWidth: 720 }}>
                Has this group bought together before, and what did those tokens do in the next 15 minutes?
              </p>
            </div>
          </div>
          <EarlierPacksTable packs={d.earlierPacks} />
        </section>
      )}

      <section className="section" aria-labelledby="sec-members">
        <div className="section-head">
          <h2 className="h2" id="sec-members">Wallets and transactions</h2>
          <span className="small muted">{d.core.totalWalletCount} wallets · times are each wallet's first buy in the pack</span>
        </div>
        <div className="card">
          <Timeline core={d.core} members={d.members} evidence={d.evidence} meta={d.evidenceMeta} />
        </div>
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="table">
            <caption className="sr-only">Pack wallets</caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Role</th>
                <th scope="col">First buy</th>
                <th scope="col" className="num">Buys</th>
                <th scope="col" className="num">Bought</th>
                {smChecked && <th scope="col">Smart Money match</th>}
              </tr>
            </thead>
            <tbody>
              {memberRows.visible.map((m) => {
                const match = matchByWallet.get(m.walletAddress);
                const ml = matchLabel(match?.matchState ?? "not_checked");
                return (
                  <tr key={m.walletAddress}>
                    <td>
                      <Address value={m.walletAddress} href={href(`/wallets/solana/${m.walletAddress}`)} head={6} tail={4} state={fromHere} />
                      {profileWallets.has(m.walletAddress) && <span className="tiny muted"> · Nansen profile below</span>}
                    </td>
                    <td>{m.memberKind === "initial" ? <Tag tone="gray">Started it</Tag> : <Tag tone="outline">Joined later</Tag>}</td>
                    <td className="mono small">
                      {timeUtc(m.firstEntryTimeMs)} <span className="muted">+{seconds(m.firstEntryTimeMs - d.core.firstEventTimeMs)}</span>
                      {m.memberKind === "expanded" && m.joinedAtEventTimeMs !== m.firstEntryTimeMs && (
                        <div className="tiny muted" style={{ fontFamily: "var(--font-sans)" }}>
                          Counted when the group qualified again at {timeUtc(m.joinedAtEventTimeMs)}
                        </div>
                      )}
                    </td>
                    <td className="num">{m.eventIds.length}</td>
                    <td className="num">{usd(m.eligibleBuyUsd)}</td>
                    {smChecked && (
                      <td>
                        <span title={ml.help}>
                          <Tag tone={ml.tone}>{ml.text}</Tag>
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {memberRows.toggle}
        {!smChecked && <p className="tiny muted" style={{ marginTop: 8 }}>Smart Money matches for these wallets have not been checked yet.</p>}

        <h3 className="h3" style={{ margin: "28px 0 12px" }}>
          Every buy in the pack
        </h3>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">The buys that formed this pack</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Wallet</th>
                <th scope="col" className="num">Paid (SOL)</th>
                <th scope="col" className="num">USD value</th>
                <th scope="col">SOL price used</th>
                <th scope="col">Role</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {evidenceRows.visible.map((e) => {
                const em = metaById.get(e.eventId);
                const link = synthetic ? null : txUrl(e.signature);
                return (
                  <tr key={e.eventId}>
                    <td className="mono small">{timeUtc(e.blockTimeMs)}</td>
                    <td>
                      <Address value={e.walletAddress} href={href(`/wallets/solana/${e.walletAddress}`)} state={fromHere} />
                    </td>
                    <td className="num">{rawAmount(e.quoteAmountRaw, e.quoteDecimals)}</td>
                    <td className="num">{usd(e.tradeValueUsd)}</td>
                    <td className="small">
                      {e.quoteUsdPrice ? (
                        <span title={`Snapshot ${e.priceSnapshotId ?? "n/a"} · ${e.priceSource ?? ""}`}>
                          SOL {usd(e.quoteUsdPrice)}{" "}
                          <span className="muted">
                            {e.priceSource?.startsWith("pyth:")
                              ? `· Pyth ${e.quotePriceAtMs ? timeUtc(e.quotePriceAtMs) : "n/a"}`
                              : `· ${e.priceSource?.includes(":5m:") ? "5m" : "1m"} candle ${e.quotePriceAtMs ? timeUtc(e.quotePriceAtMs).replace(":00 UTC", " UTC") : "n/a"}`}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">{titleCase(e.valuationStatus)}</span>
                      )}
                    </td>
                    <td className="small">
                      {em?.role === "expansion" ? "Joined later" : "Started it"}
                      {em?.acceptedAtExpansion ? <span className="muted"> · counted later</span> : null}
                    </td>
                    <td>
                      {link ? (
                        <span onClick={() => track("evidence_opened", "pack_detail", d.core.id)}>
                          <ExtLink href={link}>
                            <span className="mono small">{e.signature.slice(0, 8)}…</span>
                          </ExtLink>
                        </span>
                      ) : (
                        <span className="mono small muted" title={e.signature}>
                          {e.signature.slice(0, 8)}… synthetic
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {evidenceRows.toggle}
        <p className="tiny muted" style={{ marginTop: 10 }}>
          {d.evidence.some((e) => e.priceSource?.startsWith("pyth:"))
            ? "USD values multiply the SOL paid (fees excluded) by Pyth's on-chain SOL/USD price published before each buy, fixed when the buy arrived. They are estimates."
            : "USD values multiply the SOL paid (fees excluded) by Nansen's SOL price from a recent closed candle, fixed when each buy arrived. They are estimates."}
        </p>
      </section>

      {/* 5. Smart Money */}
      <section className="section" aria-labelledby="sec-sm">
        <div className="section-head">
          <div>
            <div className="eyebrow">Additional context</div>
            <h2 className="h2" id="sec-sm" style={{ marginTop: 6 }}>
              Smart Money on this token <InfoTip k="smTokenBuyers" />
            </h2>
          </div>
        </div>
        <SmartMoneySection
          windows={d.smartMoney.windows}
          asOf={d.smartMoney.asOf}
          confirmation={d.smartMoney.packConfirmation}
          netflow={d.smartMoney.netflow}
          packId={d.core.id}
          tokenHref={href(`/tokens/solana/${d.core.tokenAddress}`)}
        />
      </section>

      {/* 6. Profiles, relationships, holders, liquidity, follow-up */}
      <section className="section" aria-labelledby="sec-context">
        <div className="section-head">
          <div>
            <h2 className="h2" id="sec-context">Wallet and token context</h2>
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              Nansen profiles the first {d.context.selectedProfileWallets.length} wallets that started the pack and checks relationships for the first {d.context.selectedRelationshipWallets.length}
              {d.context.extraProfileWallets.length > 0 ? ", plus the largest buyer and the wallet seen in the most earlier packs" : ""}. A wallet profiled in the last day is reused, not fetched again.
              Whether wallets still hold comes from on-chain trades in After the pack.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Tag tone={analysis.tone}>{analysis.text}</Tag>
            <span className="small muted">
              {d.assessment.scheduledMemberCount} of {d.assessment.totalMemberCount} wallets queued for Nansen checks
            </span>
          </div>
        </div>
        {d.assessment.reviewFlags.length > 0 && (
          <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
            {d.assessment.reviewFlags.map((f) => (
              <Note key={f} tone="yellow" icon="warn">
                {REVIEW_FLAG_TEXT[f] ?? f}
              </Note>
            ))}
          </div>
        )}
        <div className="bento">
          <div className="span-5">
            <TokenInfoCard panel={d.context.tokenInfo} synthetic={synthetic} />
          </div>
          <div className="span-7">
            <HoldersCard panel={d.context.holders} synthetic={synthetic} />
          </div>
        </div>
        {d.context.wallets.length > 0 ? (
          <div className="pack-grid" style={{ marginTop: 14 }}>
            {d.context.wallets.map((w, i) => (
              <Reveal key={w.walletAddress} index={i}>
                <WalletProfileCard ctx={w} mint={d.core.tokenAddress} synthetic={synthetic} title={profileTitle(w.walletAddress)} />
              </Reveal>
            ))}
          </div>
        ) : null}
      </section>

      <div className="technical-head" id="sec-technical">
        <h2 className="h2">Technical details</h2>
        <p className="small muted">How the pack was detected and measured, and what the data covers.</p>
      </div>

      <section className="section tech" aria-labelledby="sec-formation">
        <div className="section-head">
          <div>
            <h2 className="h2" id="sec-formation">How the pack formed</h2>
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              The wallets that started it bought within 20 seconds of each other. Others joined while the group was still buying, up to 40 seconds after the first buy.
            </p>
          </div>
        </div>
        <div className="bento">
          <div className="card span-3">
            <Stat label={<>Started it <InfoTip k="initialExpanded" /></>} value={initial.length} note={`Pack formed at ${timeUtc(d.core.triggerEventTimeMs)}`} serif />
          </div>
          <div className="card span-3">
            <Stat label={<>Joined later <InfoTip k="packState" /></>} value={expanded.length} note={`Joining closed at ${timeUtc(d.core.expansionEndMs)}`} serif />
          </div>
          <div className="card span-3">
            <Stat label={<>Pack buys <InfoTip k="packBuys" /></>} value={usd(d.core.eligibleBuyUsd)} note={`${d.evidence.length} qualifying ${d.evidence.length === 1 ? "buy" : "buys"}`} serif />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Next pack possible <InfoTip text="The same token cannot start a new pack until 120 seconds after the last buy counted in this one." label="Next pack possible" /></>}
              value={timeUtc(d.core.suppressUntilMs).replace(" UTC", "")}
              note="UTC, 120 s after this pack's last buy"
              serif
            />
          </div>
        </div>
      </section>

      <section className="section tech" aria-labelledby="sec-patterns">
        <div className="section-head">
          <h2 className="h2" id="sec-patterns">Pattern details</h2>
          <span className="small muted">Measured facts, not a score. Smart Money is not used here.</span>
        </div>
        <div className="bento">
          <div className="card span-3">
            <Stat label={<>Entry window <InfoTip k="entrySpread" /></>} value={seconds(d.patterns.initialEntrySpanMs)} note={`All wallets: ${seconds(d.patterns.allMemberEntrySpanMs)}, from the first to the last first buy.`} />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Buy size variation <InfoTip k="sizeCV" /></>}
              value={d.patterns.buySizeCV === null ? "n/a" : Number(d.patterns.buySizeCV).toFixed(3)}
              note={`0 means every wallet spent the same; above 1 means very uneven. Across ${d.patterns.memberCount} wallets.`}
            />
          </div>
          <div className="card span-3">
            <Stat label={<>Largest buyer <InfoTip k="largestBuyer" /></>} value={pct(d.patterns.largestBuyerShare)} note="The biggest wallet's share of the pack's buying. Not a share of the token's supply." />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Repeat pairs <InfoTip k="cooccurrence" /></>}
              value={`${d.patterns.cooccurrencePairCount} ${d.patterns.cooccurrencePairCount === 1 ? "pair" : "pairs"}`}
              note={`Pairs of these wallets that also bought together in earlier packs on other tokens in the last 24 h${d.patterns.cooccurrenceCoverageStart ? `, watched since ${dateTimeUtc(d.patterns.cooccurrenceCoverageStart)}` : ""}.`}
            />
          </div>
        </div>
      </section>

      <section className="section tech" aria-labelledby="sec-coverage">
        <div className="section-head">
          <h2 className="h2" id="sec-coverage">Data coverage and history</h2>
        </div>
        <div className="bento">
          <div className="card span-5">
            <h3 className="h3" style={{ marginBottom: 12 }}>
              Coverage limits
            </h3>
            <div className="stack" style={{ gap: 8 }}>
              <KV k="Source">pump.fun bonding curve · confirmed</KV>
              <KV k="Priced in">SOL (via wrapped SOL)</KV>
              <KV k="SOL price source">
                {(() => {
                  const src = d.evidence.find((e) => e.priceSource)?.priceSource ?? "";
                  if (src.startsWith("pyth:")) return "pyth-onchain-v1 (Pyth on-chain SOL/USD)";
                  const v = /nansen-(1m|5m)-closed-v1/.exec(src)?.[0];
                  return v ? `${v}${v.includes("5m") ? " (documented fallback)" : " (baseline)"}` : src.includes(":5m:") ? "5m closed candles" : "1m closed candles";
                })()}
              </KV>
              <KV k="Detection rules">{d.core.configVersion}</KV>
              <KV k="Buys that arrived too late to count">{d.coverage.lateEventCount}</KV>
              <KV k="Buys without a USD value">{d.coverage.unvaluedEventCount}</KV>
              <KV k="Stream disconnects nearby">{d.coverage.gapIds.length === 0 ? "None recorded" : d.coverage.gapIds.length}</KV>
              <KV k="Record version">
                {d.core.coreVersion} (buys {d.core.evidenceVersion})
              </KV>
            </div>
            {d.coverage.gapIds.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Note tone="yellow" icon="warn">The stream was disconnected near this pack. Buys during the gap were not seen, so the list of wallets may be incomplete.</Note>
              </div>
            )}
          </div>
          <div className="card span-7">
            <h3 className="h3" style={{ marginBottom: 12 }}>
              Update history
            </h3>
            <ol className="stack history-list" style={{ gap: 10, margin: 0, padding: 0, listStyle: "none" }}>
              {d.history.map((h, i) => (
                <li key={i} className="kv small">
                  <span className="k mono">{dateTimeUtc(h.at)}</span>
                  <span className="v">{h.detail}</span>
                </li>
              ))}
            </ol>
            <p className="tiny muted" style={{ margin: "12px 0 0" }}>
              Later context carries its own timestamp and is not presented as the state at trigger time. Later labels never rewrite this pack.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
