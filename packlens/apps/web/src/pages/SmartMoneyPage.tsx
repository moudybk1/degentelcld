import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { SmartMoneyActivityData, SmartMoneyActivityRow } from "@packlens/contracts";
import { apiGet, track } from "../api/client";
import { useApi, useNow } from "../api/hooks";
import { PanelStatus } from "../components/PanelStatus";
import { Address, Empty, ErrorNote, LoadingBlock, ModeBadge, Note, Reveal, Tag } from "../components/ui";
import { decimal, relative, shortAddr, timeUtc, usd } from "../lib/format";
import { duration } from "../lib/packFacts";
import { useNsHref } from "../state/namespace";

const SCOPES = [
  { key: "pumpfun", label: "pump.fun launches" },
  { key: "all", label: "All tokens" },
] as const;

/** How soon after the token's pump.fun launch the trade happened, when the launch was observed. */
function afterLaunch(r: SmartMoneyActivityRow): string | null {
  if (!r.tokenLaunchedAt) return null;
  const ms = Date.parse(r.blockTime) - Date.parse(r.tokenLaunchedAt);
  return ms >= 0 ? duration(ms) : null;
}

export function SmartMoneyPage() {
  const href = useNsHref();
  const now = useNow(10_000);
  const [scope, setScope] = useState<(typeof SCOPES)[number]["key"]>("pumpfun");
  const params = { pumpfun: scope === "pumpfun" ? "1" : "0" };
  const { data, meta, error, loading, reload } = useApi<SmartMoneyActivityData>("/api/smart-money/activity", params);
  const [extra, setExtra] = useState<SmartMoneyActivityRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    track("smart_money_panel_viewed", "smart_money");
  }, []);
  useEffect(() => {
    setExtra([]);
    setCursor(data?.nextCursor ?? null);
  }, [data]);
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  const rows = [...(data?.rows ?? []), ...extra];
  const more = () => {
    if (!cursor) return;
    void apiGet<SmartMoneyActivityData>("/api/smart-money/activity", { ...params, cursor }).then((r) => {
      setExtra((e) => [...e, ...r.data.rows]);
      setCursor(r.data.nextCursor);
    });
  };

  return (
    <div className="container">
      <Reveal>
        <div className="page-head">
          <div>
            <div className="row" style={{ gap: 8 }}>
              <div className="eyebrow">Nansen Smart Money · new Solana tokens</div>
              <ModeBadge mode={meta?.mode} />
            </div>
            <h1 className="display">Smart Money activity</h1>
            <p className="lede">
              Recent trades by wallets that Nansen labels Smart Money, with pump.fun launches first: who bought, how much, and how soon after the token launched. They add context to a token; they never create or change packs.
            </p>
          </div>
        </div>
      </Reveal>

      <div className="section" style={{ marginTop: 32 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div className="seg" role="group" aria-label="Tokens shown">
            {SCOPES.map((s) => (
              <button key={s.key} type="button" aria-pressed={scope === s.key} className={scope === s.key ? "on" : ""} onClick={() => setScope(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          {data?.asOf && <span className="small muted">Feed checked {relative(data.asOf, now)}</span>}
        </div>
        {data && (
          <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
            <PanelStatus state={data.state} source="Nansen Smart Money trades" />
            <Note>
              {data.scopeDescription} {scope === "pumpfun" ? "Shown: tokens seen in the pump.fun stream. " : ""}A sample of the latest trades, not every Smart Money trade. A wallet listed here is not a pack member unless its own pack transaction
              matches.
            </Note>
          </div>
        )}
        <ErrorNote error={error} what="Smart Money activity" />
        {loading && !data ? (
          <LoadingBlock label="Loading Smart Money activity" lines={6} />
        ) : rows.length === 0 ? (
          <Empty title={data?.state.availability === "not_requested" ? "Smart Money not checked yet" : scope === "pumpfun" ? "No Smart Money trades in pump.fun launches yet" : "No Smart Money observations"}>
            {data?.state.availability === "not_requested"
              ? "The shared feed runs during an active live session with Smart Money enabled."
              : scope === "pumpfun"
                ? "The checked trades include no token from the pump.fun stream. Switch to All tokens to see the rest. This is not a claim that no Smart Money traded."
                : "The checked feed returned no trades. This is not a claim that no Smart Money traded."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Smart Money trades, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Token</th>
                  <th scope="col">After launch</th>
                  <th scope="col">Trader</th>
                  <th scope="col" className="num">Token amount</th>
                  <th scope="col" className="num">Value</th>
                  <th scope="col">Found in</th>
                  <th scope="col">Pack</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.observationId}>
                    <td className="mono small" title={r.blockTime}>
                      {timeUtc(r.blockTime)}
                      <div className="tiny muted" style={{ fontFamily: "var(--font-sans)" }}>
                        {relative(r.blockTime, now)}
                      </div>
                    </td>
                    <td>{r.direction === "buy" ? <Tag tone="green">Buy</Tag> : <Tag tone="red">Sell</Tag>}</td>
                    <td>
                      <Link className="text-link" to={href(`/tokens/solana/${r.tokenAddress}`)}>
                        {r.tokenSymbol ?? shortAddr(r.tokenAddress)}
                      </Link>
                      <div className="tiny muted">for {r.counterTokenSymbol ?? shortAddr(r.counterTokenAddress)}</div>
                    </td>
                    <td className="small">
                      {afterLaunch(r) ?? <span className="muted">{r.pumpfun ? "Launch not observed" : "Not seen on pump.fun"}</span>}
                      {r.pumpfun && afterLaunch(r) && <div className="tiny muted">after pump.fun launch</div>}
                    </td>
                    <td>
                      <Address value={r.traderAddress} href={href(`/wallets/solana/${r.traderAddress}`)} />
                      {r.traderLabel && <div className="tiny muted">{r.traderLabel}</div>}
                    </td>
                    <td className="num">{decimal(r.tokenAmount, 2)}</td>
                    <td className="num">{r.tradeValueUsd ? usd(r.tradeValueUsd) : <span className="muted">No USD value</span>}</td>
                    <td className="small muted">{r.scope === "Global feed" ? "Latest trades" : r.scope}</td>
                    <td>{r.hasPack ? <Tag tone="blue">Pack exists</Tag> : <span className="small muted">No pack</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
            <button type="button" className="btn" onClick={more}>
              <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> Load older activity
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
