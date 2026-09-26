import { useEffect, useState } from "react";
import type { RepeatWalletRow, RepeatWalletsData } from "@packlens/contracts";
import { track } from "../api/client";
import { useApi, useNow } from "../api/hooks";
import { PanelStatus } from "../components/PanelStatus";
import { Address, Empty, ErrorNote, ExtLink, LoadingBlock, ModeBadge, Note, Reveal, Tag } from "../components/ui";
import { int, pct, relative, signedUsd } from "../lib/format";
import { nansenWalletUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";

const RANGES = [
  { key: "24h", label: "Active 24 h" },
  { key: "7d", label: "7 days" },
  { key: "all", label: "All time" },
] as const;

function PnlCell({ row }: { row: RepeatWalletRow }) {
  const p = row.pnl.data;
  if (!p) {
    const a = row.pnl.state.availability;
    return <span className="small muted">{a === "queued" ? "Profiling…" : a === "budget_paused" ? "Paused (credit limit)" : "Not profiled yet"}</span>;
  }
  const n = p.realizedPnlUsd ? Number(p.realizedPnlUsd) : 0;
  const tone = n < 0 ? "down" : n > 0 ? "up" : "flat";
  return (
    <span className={`delta ${p.realizedPnlUsd ? tone : "flat"}`} title={`Realized PnL ${p.periodStart.slice(0, 10)} to ${p.periodEnd.slice(0, 10)} (Nansen)`}>
      {p.realizedPnlUsd ? signedUsd(p.realizedPnlUsd) : "n/a"}
      {p.realizedPnlPercent ? <span className="tiny muted"> {pct(p.realizedPnlPercent)}</span> : null}
    </span>
  );
}

export function RepeatWalletsPage() {
  const href = useNsHref();
  const now = useNow(15_000);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("24h");
  const { data, meta, error, loading, reload } = useApi<RepeatWalletsData>("/api/wallets/repeat", { active: range });
  useEffect(() => {
    track("wallet_opened", "repeat_wallets");
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  const rows = data?.items ?? [];
  const profiled = rows.filter((r) => r.pnl.data).length;

  return (
    <div className="container">
      <Reveal>
        <div className="page-head">
          <div>
            <div className="row" style={{ gap: 8 }}>
              <div className="eyebrow">Pack wallets · profiled by Nansen</div>
              <ModeBadge mode={meta?.mode} />
            </div>
            <h1 className="display">Repeat wallets</h1>
            <p className="lede">
              Wallets that keep showing up in packs, with Nansen&apos;s view of each one: 30-day realized profit, win rate, related wallets, and Smart Money labels. Showing up often is a pattern to check, not a
              signal to copy.
            </p>
          </div>
        </div>
      </Reveal>

      <div className="section" style={{ marginTop: 28 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div className="seg" role="group" aria-label="Activity range">
            {RANGES.map((r) => (
              <button key={r.key} type="button" aria-pressed={range === r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          {data && (
            <span className="small muted">
              {int(data.totalRepeatWallets)} wallets joined {data.minPacks}+ packs · {profiled} of {rows.length} shown have a Nansen profile · updated {relative(data.asOf, now)}
            </span>
          )}
        </div>
        <Note>
          Nansen profiles the most active repeat wallets automatically while the daily credit limit allows, and reuses each profile for a day across every pack the wallet joins. Pack counts come from the chain;
          profiles, labels, and relationships come from Nansen.
        </Note>
        <div style={{ marginTop: 14 }}>
          <ErrorNote error={error} what="repeat wallets" />
        </div>
        {loading && !data ? (
          <LoadingBlock label="Loading repeat wallets" lines={6} />
        ) : rows.length === 0 ? (
          <Empty title="No repeat wallets in this range">
            {range === "all" ? "No wallet has joined three or more packs yet." : "Try a longer range; wallets need three or more packs to appear."}
          </Empty>
        ) : (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table className="table">
              <caption className="sr-only">Wallets that joined the most packs, with Nansen profiles</caption>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  <th scope="col" className="num">Packs</th>
                  <th scope="col">Last in a pack</th>
                  <th scope="col" className="num">Nansen 30-day realized PnL</th>
                  <th scope="col" className="num">Win rate</th>
                  <th scope="col" className="num">Tokens traded</th>
                  <th scope="col" className="num">Related wallets</th>
                  <th scope="col">Nansen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.wallet}>
                    <td>
                      <Address value={r.wallet} href={href(`/wallets/solana/${r.wallet}`)} head={5} tail={5} />
                      {r.smartMoneyLabel && (
                        <div style={{ marginTop: 4 }}>
                          <Tag tone="blue" title="Label on this wallet's trades in Nansen Smart Money data">
                            {r.smartMoneyLabel}
                          </Tag>
                        </div>
                      )}
                    </td>
                    <td className="num">{int(r.packs)}</td>
                    <td className="small">{relative(r.lastSeenAt, now)}</td>
                    <td className="num">
                      <PnlCell row={r} />
                    </td>
                    <td className="num">{r.pnl.data?.winRate ? pct(r.pnl.data.winRate, 0) : <span className="muted">n/a</span>}</td>
                    <td className="num">{r.pnl.data?.tradedTokenCount != null ? int(r.pnl.data.tradedTokenCount) : <span className="muted">n/a</span>}</td>
                    <td className="num">{r.related.count !== null ? int(r.related.count) : <span className="muted">n/a</span>}</td>
                    <td className="small">
                      <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                        <PanelStatus state={r.pnl.state} compact />
                        <ExtLink href={nansenWalletUrl(r.wallet)}>Profile</ExtLink>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
