import { useState } from "react";
import { Link } from "react-router";
import { Eye } from "@phosphor-icons/react";
import type { Netflow, Panel, PackSmartMoneyContext, SmartMoneyActivityRow, SmartMoneyWindowMetric } from "@packlens/contracts";
import { apiGet, track } from "../api/client";
import { dateTimeUtc, signedUsd, timeUtc, usd } from "../lib/format";
import { buyerCountText } from "../lib/labels";
import { useNsHref } from "../state/namespace";
import { PanelStatus } from "./PanelStatus";
import { Address, Note, Tag } from "./ui";

const PERIOD: Record<string, string> = { "5m": "5 minutes", "1h": "1 hour", "24h": "24 hours" };

export function SmartMoneyWindows({ windows, asOf }: { windows: SmartMoneyWindowMetric[]; asOf: string | null }) {
  return (
    <div className="windows" role="group" aria-label="Observed unique Smart Money buyers by window">
      {windows.map((w) => {
        const t = buyerCountText(w, PERIOD[w.window]!);
        const unknown = w.countQualifier === "unknown" || w.observedUniqueBuyers === null;
        return (
          <div className="window-cell" key={w.window}>
            <span className="stat-label">{PERIOD[w.window]}</span>
            <span className="window-count" title="Wallets that bought and later sold remain buyers for the window. Buyer status does not imply current holding.">
              {unknown ? (
                <span style={{ fontSize: 22 }} className="muted">
                  Not checked yet
                </span>
              ) : w.countQualifier === "at_least" && w.observedUniqueBuyers === 0 ? (
                <span style={{ fontSize: 22 }} className="muted">
                  None observed
                </span>
              ) : (
                <>
                  {w.countQualifier === "at_least" && <span className="qual">at least</span>}
                  {w.observedUniqueBuyers}
                </>
              )}
            </span>
            <span className="small muted">{t.detail}</span>
            {!unknown && (
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                {w.state.coverage === "window_scanned" ? <Tag tone="outline">Full window checked</Tag> : <Tag tone="yellow">Partial</Tag>}
                {w.state.freshness === "stale" && <Tag tone="outline">Stale</Tag>}
              </div>
            )}
            {!unknown && (
              <span className="tiny muted" style={{ marginTop: 2 }}>
                Observed buy value: {w.knownBuyUsd === null ? "not available" : usd(w.knownBuyUsd)}
                {w.missingValuationCount > 0 ? ` · ${w.missingValuationCount} without USD value` : ""}
                {w.ambiguousTradeCount > 0 ? ` · ${w.ambiguousTradeCount} ambiguous` : ""}
              </span>
            )}
          </div>
        );
      })}
      <span className="sr-only">{asOf ? `Period ending ${dateTimeUtc(asOf)}` : "Not checked"}</span>
    </div>
  );
}

export function NetflowPanel({ netflow }: { netflow: Panel<Netflow> }) {
  return (
    <div className="card">
      <div className="card-title">
        <h3 className="h3">Smart Money netflow</h3>
        <PanelStatus state={netflow.state} compact />
      </div>
      {netflow.data ? (
        <div className="bento" style={{ gap: 10 }}>
          {netflow.data.values.map((v) => (
            <div key={v.window} className="span-3">
              <div className="stat-label">{v.window}</div>
              <div className="metric-value" style={{ fontSize: 20 }}>
                {signedUsd(v.netFlowUsd)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {netflow.state.availability === "empty" ? "Nansen returned no netflow for this token." : "Netflow has not been checked for this token yet."}
        </p>
      )}
      <p className="tiny muted" style={{ margin: "14px 0 0" }}>
        Nansen's net Smart Money flow, over its own periods. It can include activity beyond DEX buys and never confirms a pack wallet's buy.
        {netflow.data?.traderCount30d != null ? ` Nansen trader count (30 days): ${netflow.data.traderCount30d}.` : ""}
      </p>
      <div style={{ marginTop: 10 }}>
        <PanelStatus state={netflow.state} source="Nansen netflow" />
      </div>
    </div>
  );
}

export function SmartMoneyEvidence({ packId }: { packId: string }) {
  const href = useNsHref();
  const [rows, setRows] = useState<SmartMoneyActivityRow[] | null>(null);
  const [matches, setMatches] = useState<{ observationId: string; wallet: string; matchLevel: string }[]>([]);
  const [open, setOpen] = useState(false);
  const load = () => {
    setOpen(true);
    track("evidence_opened", "pack_detail", packId);
    if (rows) return;
    void apiGet<{ observations: SmartMoneyActivityRow[]; matches: { observationId: string; wallet: string; matchLevel: string }[] }>(`/api/packs/${packId}/smart-money/evidence`).then((r) => {
      setRows(r.data.observations);
      setMatches(r.data.matches);
    });
  };
  const confirmed = new Set(matches.filter((m) => m.matchLevel === "pack_buy_confirmed").map((m) => m.observationId));
  return (
    <div style={{ marginTop: 14 }}>
      {!open ? (
        <button type="button" className="btn sm" onClick={load}>
          <Eye size={14} weight="bold" aria-hidden="true" /> Show the Smart Money trades behind this
        </button>
      ) : rows === null ? (
        <p className="small muted">Loading stored observations…</p>
      ) : rows.length === 0 ? (
        <p className="small muted">No stored Smart Money observations for this token.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Stored Smart Money observations for this token</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Direction</th>
                <th scope="col">Trader</th>
                <th scope="col" className="num">Value</th>
                <th scope="col">Scope</th>
                <th scope="col">Pack match</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.observationId} className={confirmed.has(r.observationId) ? "highlight" : ""}>
                  <td className="mono">{timeUtc(r.blockTime)}</td>
                  <td>{r.direction === "buy" ? <Tag tone="green">Buy</Tag> : <Tag tone="red">Sell</Tag>}</td>
                  <td>
                    <Address value={r.traderAddress} href={href(`/wallets/solana/${r.traderAddress}`)} />
                    {r.traderLabel && <span className="tiny muted"> {r.traderLabel}</span>}
                  </td>
                  <td className="num">{r.tradeValueUsd ? usd(r.tradeValueUsd) : <span className="muted">No USD value</span>}</td>
                  <td className="small muted">{r.scope}</td>
                  <td>{confirmed.has(r.observationId) ? <Tag tone="green">Pack transaction</Tag> : <span className="muted small">n/a</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SmartMoneySection({
  windows,
  asOf,
  confirmation,
  netflow,
  packId,
  tokenHref,
}: {
  windows: SmartMoneyWindowMetric[];
  asOf: string | null;
  confirmation: PackSmartMoneyContext | null;
  netflow: Panel<Netflow>;
  packId: string | null;
  tokenHref?: string;
}) {
  const w24 = windows[2];
  const fetched = windows[0]?.state.fetchedAt ?? null;
  const partial24 = w24 && w24.countQualifier !== "unknown" && w24.state.coverage !== "window_scanned";
  const nothingChecked =
    windows.every((w) => w.countQualifier === "unknown" || w.observedUniqueBuyers === null) &&
    (!confirmation || confirmation.confirmedMemberCount === null) &&
    netflow.state.availability === "not_requested";
  if (nothingChecked) {
    // One sentence instead of five panels that all say "not checked".
    return (
      <div className="unchecked">
        <p>
          <strong>Smart Money has not been checked for this {packId ? "pack" : "token"} yet.</strong> Nansen data is fetched for the largest packs while credits allow. Not checked is different from none.
        </p>
        {tokenHref ? (
          <Link className="text-link small" to={tokenHref}>
            Open the token page
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <SmartMoneyWindows windows={windows} asOf={asOf} />
      <div className="bento">
        {confirmation && (
          <div className="card span-6">
            <div className="card-title">
              <h3 className="h3">Confirmed pack members</h3>
              <PanelStatus state={confirmation.state} compact />
            </div>
            <div className="window-count" style={{ fontSize: 40 }}>
              {confirmation.confirmedMemberCount === null ? (
                <span className="muted" style={{ fontSize: 22 }}>
                  Not checked yet
                </span>
              ) : (
                <>
                  {confirmation.confirmedMemberCount}
                  <span className="qual" style={{ marginLeft: 8 }}>
                    of {confirmation.totalMemberCount} members
                  </span>
                </>
              )}
            </div>
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              A member is confirmed only when a Smart Money observation matches its pack transaction, wallet, and bought token. An unconfirmed member is not proven to be outside Smart Money.
            </p>
          </div>
        )}
        <div className={confirmation ? "span-6" : "span-12"}>
          <NetflowPanel netflow={netflow} />
        </div>
      </div>
      <Note>
        {asOf ? (
          <>
            Period ending {dateTimeUtc(asOf)}
            {fetched ? ` · Fetched ${dateTimeUtc(fetched)}` : ""}. {partial24 ? "24-hour coverage is partial. " : ""}
          </>
        ) : (
          "Smart Money data has not been checked for this token. "
        )}
        Buyers across the whole token and confirmed pack members are separate metrics with different periods. Smart Money does not change pack detection, indicators, or ordering.
        {tokenHref ? (
          <>
            {" "}
            <Link className="text-link" to={tokenHref}>
              Open token context
            </Link>
          </>
        ) : null}
      </Note>
      {packId && <SmartMoneyEvidence packId={packId} />}
    </div>
  );
}
