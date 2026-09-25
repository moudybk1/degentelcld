import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, PushPin, Play } from "@phosphor-icons/react";
import type { PackDetail } from "@packlens/contracts";
import { apiPost, apiRaw, ApiError, track } from "../api/client";
import { useEventListener } from "../api/events";
import { useApi, useNow } from "../api/hooks";
import { Timeline } from "../components/Timeline";
import { SmartMoneySection } from "../components/SmartMoneyPanel";
import { HoldersCard, TokenInfoCard, WalletProfileCard } from "../components/ContextPanels";
import { AfterSection, EarlierPacksTable, ReadoutPanel } from "../components/AfterSection";
import { InfoTip } from "../components/InfoTip";
import { Address, Empty, ErrorNote, ExtLink, KV, LoadingBlock, ModeBadge, Note, Reveal, Stat, Tag, TokenAvatar, useRowLimit } from "../components/ui";
import { dateTimeUtc, pct, rawAmount, relative, seconds, timeUtc, titleCase, usd } from "../lib/format";
import { analysisLabel, matchLabel, REVIEW_FLAG_TEXT } from "../lib/labels";
import { tokenUrl, txUrl } from "../lib/explorer";
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

export function PackDetailPage() {
  const { id = "" } = useParams();
  const href = useNsHref();
  const now = useNow(5000);
  const { data, meta, error, loading, reload } = useApi<PackDetail>(`/api/packs/${id}`);
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
        <div style={{ marginTop: 24 }}>{error.status === 404 ? <Empty title="Pack not found">This pack does not exist in the selected namespace.</Empty> : <ErrorNote error={error} what="This pack" />}</div>
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

  return (
    <div className="container">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={href("/")}>Pack Radar</Link>
        <span aria-hidden="true">/</span>
        <span>{tokenName}</span>
      </nav>

      {/* 1. Identity, source, mode, time, persistence */}
      <Reveal>
        <header className="page-head" style={{ marginTop: 20, alignItems: "flex-start" }}>
          <div className="row" style={{ gap: 18, alignItems: "flex-start", flexWrap: "nowrap", minWidth: 0 }}>
            <TokenAvatar mint={d.core.tokenAddress} symbol={d.token.symbol} name={d.token.name} large />
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <ModeBadge mode={meta?.mode} />
                {d.core.state === "collecting" ? <Tag tone="blue" dot pulse>Collecting</Tag> : <Tag tone="outline">Frozen</Tag>}
                <Tag tone="outline">Stored</Tag>
                {d.isDemoPinned && <Tag tone="yellow">Demo pinned</Tag>}
                {d.coverage.auditedInvalidated && <Tag tone="red">Invalidated</Tag>}
              </div>
              <h1 className="display" style={{ fontSize: "clamp(34px, 5vw, 54px)" }}>
                {tokenName} {d.token.symbol && <em>{d.token.symbol}</em>}
              </h1>
              <div className="row" style={{ gap: 14, marginTop: 8 }}>
                <Address value={d.core.tokenAddress} href={href(`/tokens/solana/${d.core.tokenAddress}`)} external={synthetic ? null : tokenUrl(d.core.tokenAddress)} head={6} tail={6} copyLabel="Copy token address" />
                <span className="small muted">
                  Triggered {dateTimeUtc(d.core.triggerEventTimeMs)} · {relative(d.core.triggerEventTimeMs, now)}
                </span>
                <span className="small muted">Source: pump.fun · confirmed commitment</span>
              </div>
              {d.token.identitySource && (
                <p className="tiny muted" style={{ margin: "6px 0 0" }}>
                  Name and symbol from {d.token.identitySource === "pumpfun_create_event" ? "the pump.fun create event" : "Nansen token information"}; token text is shown as untrusted data.
                </p>
              )}
            </div>
          </div>
          <OperatorActions detail={d} onChange={reload} />
        </header>
      </Reveal>

      <nav className="section-nav" aria-label="Sections on this page">
        {[
          ["sec-reading", "Reading"],
          ["sec-formation", "Formation"],
          ["sec-members", "Members and evidence"],
          ["sec-patterns", "Indicators"],
          ...(d.after ? [["sec-after", "After the pack"], ["sec-earlier", "Earlier packs"]] : []),
          ["sec-sm", "Smart Money"],
          ["sec-context", "Context"],
          ["sec-coverage", "Coverage"],
        ].map(([idx, label]) => (
          <a key={idx} href={`#${idx}`}>
            {label}
          </a>
        ))}
      </nav>

      <Reveal index={1}>
        <section id="sec-reading" style={{ marginTop: 28 }} aria-label="Reading this pack">
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Reading this pack <InfoTip text="A plain-language reading built from the facts on this page with fixed rules. It shows what happened and what to check; it never recommends buying or selling." label="Reading this pack" />
          </div>
          {d.readout ? <ReadoutPanel items={d.readout} summary={d.summary} /> : <p className="summary-quote">{d.summary}</p>}
          {synthetic && (
            <div style={{ marginTop: 14 }}>
              <Note tone="blue">Fixture data: every address, signature, price, and provider value on this page is synthetic.</Note>
            </div>
          )}
        </section>
      </Reveal>

      {/* 2. Initial versus expanded */}
      <section className="section" aria-labelledby="sec-formation">
        <div className="section-head">
          <div>
            <h2 className="h2" id="sec-formation">Formation</h2>
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              Initial members formed the trigger window. Expanded members joined while a qualifying window stayed open, up to 40 seconds from the first evidence.
            </p>
          </div>
        </div>
        <div className="bento">
          <div className="card span-3">
            <Stat label={<>Initial wallets <InfoTip k="initialExpanded" /></>} value={initial.length} note={`Trigger at ${timeUtc(d.core.triggerEventTimeMs)}`} serif />
          </div>
          <div className="card span-3">
            <Stat label={<>Expanded wallets <InfoTip k="packState" /></>} value={expanded.length} note={`Window closes ${timeUtc(d.core.expansionEndMs)}`} serif />
          </div>
          <div className="card span-3">
            <Stat label={<>Pack buys <InfoTip k="packBuys" /></>} value={usd(d.core.eligibleBuyUsd)} note={`${d.evidence.length} evidence ${d.evidence.length === 1 ? "event" : "events"}`} serif />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Cooldown until <InfoTip text="After a pack, the same token cannot start a new pack until 120 seconds after the pack's last accepted buy." label="Cooldown" /></>}
              value={timeUtc(d.core.suppressUntilMs).replace(" UTC", "")}
              note="120 s after the last accepted buy (UTC)"
              serif
            />
          </div>
        </div>
      </section>

      {/* 3. Member timeline, table, evidence */}
      <section className="section" aria-labelledby="sec-members">
        <div className="section-head">
          <h2 className="h2" id="sec-members">Members and evidence</h2>
          <span className="small muted">{d.core.totalWalletCount} unique wallets · entry uses the first evidence time</span>
        </div>
        <div className="card">
          <Timeline core={d.core} members={d.members} evidence={d.evidence} meta={d.evidenceMeta} />
        </div>
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="table">
            <caption className="sr-only">Pack members</caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Member</th>
                <th scope="col">First entry</th>
                <th scope="col" className="num">Eligible buys</th>
                <th scope="col" className="num">Value</th>
                <th scope="col">Smart Money match</th>
              </tr>
            </thead>
            <tbody>
              {memberRows.visible.map((m) => {
                const match = matchByWallet.get(m.walletAddress);
                const ml = matchLabel(match?.matchState ?? "not_checked");
                return (
                  <tr key={m.walletAddress}>
                    <td>
                      <Address value={m.walletAddress} href={href(`/wallets/solana/${m.walletAddress}`)} head={6} tail={4} />
                      {profileWallets.has(m.walletAddress) && <span className="tiny muted"> · profiled</span>}
                    </td>
                    <td>{m.memberKind === "initial" ? <Tag tone="gray">Initial</Tag> : <Tag tone="yellow">Expanded</Tag>}</td>
                    <td className="mono small">
                      {timeUtc(m.firstEntryTimeMs)} <span className="muted">+{seconds(m.firstEntryTimeMs - d.core.firstEventTimeMs)}</span>
                      {m.memberKind === "expanded" && m.joinedAtEventTimeMs !== m.firstEntryTimeMs && (
                        <div className="tiny muted" style={{ fontFamily: "var(--font-sans)" }}>
                          Joined when the window at {timeUtc(m.joinedAtEventTimeMs)} qualified
                        </div>
                      )}
                    </td>
                    <td className="num">{m.eventIds.length}</td>
                    <td className="num">{usd(m.eligibleBuyUsd)}</td>
                    <td>
                      <span title={ml.help}>
                        <Tag tone={ml.tone}>{ml.text}</Tag>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {memberRows.toggle}

        <h3 className="h3" style={{ margin: "28px 0 12px" }}>
          Transaction evidence
        </h3>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Evidence events that formed this pack</caption>
            <thead>
              <tr>
                <th scope="col">Chain time</th>
                <th scope="col">Wallet</th>
                <th scope="col" className="num">Paid (SOL)</th>
                <th scope="col" className="num">USD value</th>
                <th scope="col">Price used</th>
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
                      <Address value={e.walletAddress} href={href(`/wallets/solana/${e.walletAddress}`)} />
                    </td>
                    <td className="num">{rawAmount(e.quoteAmountRaw, e.quoteDecimals)}</td>
                    <td className="num">{usd(e.tradeValueUsd)}</td>
                    <td className="small">
                      {e.quoteUsdPrice ? (
                        <span title={`Snapshot ${e.priceSnapshotId ?? "—"} · ${e.priceSource ?? ""}`}>
                          SOL {usd(e.quoteUsdPrice)}{" "}
                          <span className="muted">
                            · {e.priceSource?.includes(":5m:") ? "5m" : "1m"} candle {e.quotePriceAtMs ? timeUtc(e.quotePriceAtMs).replace(":00 UTC", " UTC") : "—"}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">{titleCase(e.valuationStatus)}</span>
                      )}
                    </td>
                    <td className="small">
                      {em?.role === "expansion" ? "Expansion" : "Initial"}
                      {em?.acceptedAtExpansion ? <span className="muted"> · accepted later</span> : null}
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
          USD value = traded SOL (excluding separately reported fees) × the Nansen close of the latest closed candle available when the event first arrived (1-minute baseline, or the 5-minute fallback where labeled). It is an estimate from a preceding candle, pinned to the event.
        </p>
      </section>

      {/* 4. Pattern indicators */}
      <section className="section" aria-labelledby="sec-patterns">
        <div className="section-head">
          <h2 className="h2" id="sec-patterns">Pattern indicators</h2>
          <span className="small muted">Formula {d.patterns.formulaVersion} · factual values, no combined score · Smart Money is not an input</span>
        </div>
        <div className="bento">
          <div className="card span-3">
            <Stat label={<>Entry spread <InfoTip k="entrySpread" /></>} value={seconds(d.patterns.initialEntrySpanMs)} note={`All members: ${seconds(d.patterns.allMemberEntrySpanMs)}. Latest minus earliest first entry.`} />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Buy-size variation <InfoTip k="sizeCV" /></>}
              value={d.patterns.buySizeCV === null ? "—" : Number(d.patterns.buySizeCV).toFixed(3)}
              note={`n = ${d.patterns.memberCount}. Population standard deviation of per-member eligible value ÷ mean.`}
            />
          </div>
          <div className="card span-3">
            <Stat label={<>Largest buyer <InfoTip k="largestBuyer" /></>} value={pct(d.patterns.largestBuyerShare)} note="Largest member value ÷ total eligible pack value. Not supply concentration." />
          </div>
          <div className="card span-3">
            <Stat
              label={<>Repeat pairs <InfoTip k="cooccurrence" /></>}
              value={`${d.patterns.cooccurrencePairCount} ${d.patterns.cooccurrencePairCount === 1 ? "pair" : "pairs"}`}
              note={`Member pairs seen together in earlier packs on other tokens within 24 h${d.patterns.cooccurrenceCoverageStart ? `; observed since ${dateTimeUtc(d.patterns.cooccurrenceCoverageStart)}` : ""}.`}
            />
          </div>
        </div>
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
              Base analysis profiles the first {d.context.selectedProfileWallets.length} initial members; relationships and balance follow-ups cover the first {d.context.selectedRelationshipWallets.length}. Other members are not profiled automatically.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Tag tone={analysis.tone}>{analysis.text}</Tag>
            <span className="small muted">
              {d.assessment.scheduledMemberCount} of {d.assessment.totalMemberCount} members scheduled
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
                <WalletProfileCard ctx={w} mint={d.core.tokenAddress} synthetic={synthetic} title={initial.some((m) => m.walletAddress === w.walletAddress) ? "Initial member" : "Member"} />
              </Reveal>
            ))}
          </div>
        ) : null}
      </section>

      {/* 7. Coverage and history */}
      <section className="section" aria-labelledby="sec-coverage">
        <div className="section-head">
          <h2 className="h2" id="sec-coverage">Coverage and history</h2>
        </div>
        <div className="bento">
          <div className="card span-5">
            <h3 className="h3" style={{ marginBottom: 12 }}>
              Coverage limits
            </h3>
            <div className="stack" style={{ gap: 8 }}>
              <KV k="Source">pump.fun bonding curve · confirmed</KV>
              <KV k="Quote asset">Native SOL (priced via WSOL)</KV>
              <KV k="Price policy">
                {(() => {
                  const src = d.evidence.find((e) => e.priceSource)?.priceSource ?? "";
                  const v = /nansen-(1m|5m)-closed-v1/.exec(src)?.[0];
                  return v ? `${v}${v.includes("5m") ? " (documented fallback)" : " (baseline)"}` : src.includes(":5m:") ? "5-minute closed candles" : "1-minute closed candles";
                })()}
              </KV>
              <KV k="Configuration">{d.core.configVersion}</KV>
              <KV k="Late events near window">{d.coverage.lateEventCount}</KV>
              <KV k="Unvalued buys near window">{d.coverage.unvaluedEventCount}</KV>
              <KV k="Collector gaps near window">{d.coverage.gapIds.length === 0 ? "None recorded" : d.coverage.gapIds.length}</KV>
              <KV k="Core version">
                {d.core.coreVersion} · evidence version {d.core.evidenceVersion}
              </KV>
            </div>
            {d.coverage.gapIds.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Note tone="yellow" icon="warn">The collector was disconnected near this pack. Buys during the gap were not observed; membership may be incomplete.</Note>
              </div>
            )}
          </div>
          <div className="card span-7">
            <h3 className="h3" style={{ marginBottom: 12 }}>
              Update history
            </h3>
            <ol className="stack" style={{ gap: 10, margin: 0, padding: 0, listStyle: "none" }}>
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
