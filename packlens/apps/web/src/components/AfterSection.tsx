import { Link } from "react-router";
import { CheckCircle, Question, WarningCircle } from "@phosphor-icons/react";
import type { AfterPackData, EarlierPack, Pack, ReadoutItem } from "@packlens/contracts";
import { dateTimeUtc, decimal, relative, shortAddr, timeUtc, usd, usdCompact, usdPrice } from "../lib/format";
import { useNsHref } from "../state/namespace";
import { AfterChart, signed } from "./AfterChart";
import { InfoTip } from "./InfoTip";
import { Address, Empty, Note, Tag, useRowLimit } from "./ui";

export function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="delta flat">n/a</span>;
  const cls = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  return <span className={`delta ${cls}`}>{signed(pct)}</span>;
}

function secondsLabel(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function ReadoutPanel({ items, summary }: { items: ReadoutItem[]; summary: string }) {
  const groups: { key: ReadoutItem["group"]; title: string; icon: React.ReactNode }[] = [
    { key: "happened", title: "What happened", icon: <CheckCircle size={15} weight="bold" aria-hidden="true" /> },
    { key: "check", title: "Worth checking", icon: <WarningCircle size={15} weight="bold" aria-hidden="true" /> },
    { key: "unknown", title: "Not known", icon: <Question size={15} weight="bold" aria-hidden="true" /> },
  ];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="summary-quote">{summary}</p>
      <div className="readout">
        {groups.map((g) => {
          const list = items.filter((i) => i.group === g.key);
          return (
            <div className={`readout-col ${g.key}`} key={g.key}>
              <h3>
                {g.icon}
                {g.title}
              </h3>
              {list.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  {g.key === "check" ? "Nothing stands out in the checked facts." : "Nothing to add."}
                </p>
              ) : (
                <ul>
                  {list.map((i, n) => (
                    <li key={n}>{i.text}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AfterSection({ core, after, synthetic }: { core: Pack; after: AfterPackData; synthetic: boolean }) {
  const href = useNsHref();
  const rows = useRowLimit(after.members.rows, 25);
  const tradesAfter = after.activity.buys + after.activity.sells;
  const net = Number(after.activity.netSol);
  const graduatedMs = after.graduatedAt ? Date.parse(after.graduatedAt) : null;
  return (
    <div className="stack" style={{ gap: 14 }}>
      {graduatedMs !== null && (
        <Note tone="yellow" icon="warn">
          <strong>
            Observation ends at {timeUtc(graduatedMs)}
            {graduatedMs > core.triggerEventTimeMs ? `, ${secondsLabel(Math.round((graduatedMs - core.triggerEventTimeMs) / 1000))} after the pack formed` : ""}.
          </strong>{" "}
          The token left the pump.fun bonding curve then. Trades and sells after that happen on other venues and are not in these figures or the chart.
        </Note>
      )}
      <div className="bento">
        <div className="card span-3">
          <div className="stat">
            <span className="stat-label">
              Now vs pack entry
              <InfoTip k="sinceEntry" />
            </span>
            <span className="stat-value">
              <Delta pct={after.lastChangePct} />
            </span>
            <span className="stat-note">{after.lastTradeAt ? `Latest trade ${timeUtc(after.lastTradeAt)} (${relative(after.lastTradeAt)})` : "No trades observed yet"}</span>
          </div>
        </div>
        <div className="card span-3">
          <div className="stat">
            <span className="stat-label">
              Peak after the pack
              <InfoTip k="peak" />
            </span>
            <span className="stat-value">{after.peak ? <Delta pct={after.peak.changePct} /> : <span className="delta flat">n/a</span>}</span>
            <span className="stat-note">
              {after.peak ? `${secondsLabel(Math.round((Date.parse(after.peak.at) - core.triggerEventTimeMs) / 1000))} after it formed` : "No trades after the pack yet"}
              {after.trough ? ` · low ${signed(after.trough.changePct)}` : ""}
            </span>
          </div>
        </div>
        <div className="card span-3">
          <div className="stat">
            <span className="stat-label">
              Pack wallets that sold some
              <InfoTip k="membersSold" />
            </span>
            <span className="stat-value">
              {after.members.sold} <span className="muted" style={{ fontSize: 16 }}>of {after.members.count}</span>
            </span>
            <span className="stat-note">
              {after.members.soldShare === null ? "No observed buys to compare" : `${Math.round(after.members.soldShare * 100)}% of the tokens they bought sold · ${after.members.exited} sold all they bought`}
            </span>
          </div>
        </div>
        <div className="card span-3">
          <div className="stat">
            <span className="stat-label">
              Activity since the pack
              <InfoTip k="activity" />
            </span>
            <span className="stat-value" style={{ fontSize: 22 }}>
              {after.activity.buys} buys · {after.activity.sells} sells
            </span>
            <span className="stat-note">
              {tradesAfter === 0 ? "No trades yet" : `Net ${Math.abs(net).toFixed(2)} SOL ${net >= 0 ? "more bought" : "more sold"} · ${after.activity.uniqueBuyers} buyers, ${after.activity.uniqueSellers} sellers`}
            </span>
          </div>
        </div>
      </div>

      <div className="card chart-card">
        <div className="card-title" style={{ marginBottom: 6 }}>
          <h3 className="h3">Price since the pack formed</h3>
          <span className="small muted">
            {after.lastPriceUsd ? `Last trade ${usdPrice(after.lastPriceUsd)} per token` : ""}
            {after.marketCapUsd ? ` · implied market cap ${usdCompact(after.marketCapUsd)}` : ""}
          </span>
        </div>
        {after.series.length > 1 ? (
          <AfterChart series={after.series} markers={after.markers} triggerMs={core.triggerEventTimeMs} peak={after.peak} />
        ) : (
          <Empty title="Not enough trades to draw a price line yet">The chart appears once trades are observed after the pack formed.</Empty>
        )}
      </div>

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">What each pack wallet did after its first buy</caption>
          <thead>
            <tr>
              <th scope="col">Pack wallet</th>
              <th scope="col">Member</th>
              <th scope="col" className="num">Tokens bought</th>
              <th scope="col" className="num">Sold</th>
              <th scope="col">First sale</th>
              <th scope="col">Last action</th>
            </tr>
          </thead>
          <tbody>
            {rows.visible.map((r) => (
              <tr key={r.walletAddress}>
                <td>
                  <Address value={r.walletAddress} href={href(`/wallets/solana/${r.walletAddress}`)} />
                </td>
                <td>{r.memberKind === "initial" ? <Tag>Initial</Tag> : <Tag tone="outline">Expanded</Tag>}</td>
                <td className="num">{decimal(r.tokensBought, 0)}</td>
                <td className="num">
                  {r.soldShare >= 0.99 ? (
                    <Tag tone="red" title="Sold at least 99% of the tokens it bought in the observed pump.fun trades. Transfers and trades on other venues are not seen.">
                      Sold all bought
                    </Tag>
                  ) : r.soldShare > 0 ? <span>{Math.round(r.soldShare * 100)}%</span> : <span className="muted" title="No sell of this token observed; tokens moved by transfer are not seen.">None seen</span>}
                </td>
                <td className="small">
                  {r.secondsToFirstSell === null ? <span className="muted">No sale observed</span> : r.secondsToFirstSell === 0 ? "Same second as first buy" : `${secondsLabel(r.secondsToFirstSell)} after first buy`}
                </td>
                <td className="mono small">{r.lastActionAt ? timeUtc(r.lastActionAt) : "n/a"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.toggle}
      <Note>
        {after.notes.join(" ")} {synthetic ? "Fixture data: these trades are synthetic." : ""} Past moves describe what happened; they do not predict what happens next.
      </Note>
    </div>
  );
}

const OUTCOME_NOTE: Record<"gap" | "graduated" | "data_ended", string> = {
  gap: "The collector was disconnected during these 15 minutes, so trades may be missing.",
  graduated: "The token left the bonding curve during these 15 minutes; trades after that happen elsewhere and are not observed.",
  data_ended: "The recorded data ends before these 15 minutes did.",
};

/** "+14:52": time after a pack formed. */
function afterClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function PeakCell({ p }: { p: EarlierPack }) {
  if (p.outcomeState === "observing") {
    return p.peakSoFarPct === null || p.peakSoFarPct === undefined ? <span className="muted">No trades yet</span> : (
      <span title="Highest price so far; the 15 minutes are not over.">
        <span className="tiny muted">so far </span>
        <Delta pct={p.peakSoFarPct} />
      </span>
    );
  }
  return p.peakChangePct15m === null ? <span className="muted">No trades</span> : <Delta pct={p.peakChangePct15m} />;
}

function AtCutoffCell({ p }: { p: EarlierPack }) {
  if (p.outcomeState === "observing") {
    const mins = Math.floor((p.observedMs ?? 0) / 60_000);
    return (
      <span className="outcome-observing" title="These 15 minutes are not over yet, so there is no 15-minute result.">
        <Tag tone="outline">Observing · {mins}/15 min</Tag>
        {p.outcomeNote === "gap" && (
          <Tag tone="yellow" title={OUTCOME_NOTE.gap}>
            Gap
          </Tag>
        )}
        {p.changeSoFarPct !== null && p.changeSoFarPct !== undefined && (
          <span className="tiny muted">
            latest <Delta pct={p.changeSoFarPct} />
          </span>
        )}
      </span>
    );
  }
  if (p.changePct15m === null) return <span className="muted">No trades</span>;
  const at = p.priceAtMs !== null && p.priceAtMs !== undefined ? afterClock(p.priceAtMs - p.triggerEventTimeMs) : null;
  return (
    <span className="outcome-cell">
      <Delta pct={p.changePct15m} />
      {at && <span className="tiny muted" title="Time of the last observed trade at or before 15:00 after that pack formed.">at {at}</span>}
      {p.outcomeState === "partial" && p.outcomeNote && (
        <Tag tone="yellow" title={OUTCOME_NOTE[p.outcomeNote]}>
          Partial
        </Tag>
      )}
    </span>
  );
}

export function EarlierPacksTable({ packs }: { packs: EarlierPack[] }) {
  const href = useNsHref();
  if (packs.length === 0) {
    return <Empty title="No earlier packs with two or more of these wallets">In the data observed so far, this group of wallets has not bought together before.</Empty>;
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Earlier packs from the previous 7 days that share at least two wallets with this pack</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Formed</th>
              <th scope="col" className="num">Shared wallets</th>
              <th scope="col" className="num">Pack buys</th>
              <th scope="col" className="num">Peak in 15 min</th>
              <th scope="col" className="num">At 15 min</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => (
              <tr key={p.packId}>
                <td>
                  <Link className="text-link" to={href(`/packs/${p.packId}`)}>
                    {p.tokenSymbol || p.tokenName || shortAddr(p.tokenAddress)}
                  </Link>
                </td>
                <td className="mono small">{dateTimeUtc(p.triggerEventTimeMs)}</td>
                <td className="num">
                  {p.sharedWallets} of {p.totalWalletCount}
                </td>
                <td className="num">{usd(p.eligibleBuyUsd)}</td>
                <td className="num">
                  <PeakCell p={p} />
                </td>
                <td className="num">
                  <AtCutoffCell p={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        At 15 min: the last observed trade at or before 15:00 after that pack formed, against that pack&apos;s own entry price. A pack less than 15 minutes old shows Observing until its
        15 minutes are over; Partial means a gap, the end of the bonding curve, or the end of the data cut the 15 minutes short.
      </p>
    </div>
  );
}
