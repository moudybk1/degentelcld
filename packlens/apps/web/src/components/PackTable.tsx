import { Link, useNavigate } from "react-router";
import { CaretRight } from "@phosphor-icons/react";
import type { PackListItem } from "@packlens/contracts";
import { relative, timeUtc, usd } from "../lib/format";
import { analysisLabel, buyerCountText, confirmedText } from "../lib/labels";
import { entryWindow, groupSold, rowFlags } from "../lib/packFacts";
import { useNsHref } from "../state/namespace";
import { Delta } from "./AfterSection";
import { InfoTip } from "./InfoTip";
import { Address, Tag, TokenAvatar } from "./ui";

/**
 * The radar feed as a dense table: one pack per row, newest first. The token
 * name is the row's link (keyboard and screen readers); a click anywhere else
 * on the row opens the pack too.
 */
export function PackTable({ items, now, showSmartMoney = true }: { items: PackListItem[]; now: number; showSmartMoney?: boolean }) {
  const href = useNsHref();
  const navigate = useNavigate();
  return (
    <div className="table-wrap feed-wrap">
      <table className="table feed">
        <caption className="sr-only">Packs, newest trigger first</caption>
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Triggered</th>
            <th scope="col" className="num">
              Wallets
              <InfoTip k="uniqueWallets" />
            </th>
            <th scope="col" className="num">
              Bought
              <InfoTip k="packBuys" />
            </th>
            <th scope="col" className="num">
              Entry window
              <InfoTip k="entrySpread" />
            </th>
            <th scope="col" className="num">
              Price vs entry
              <InfoTip k="sinceEntry" />
            </th>
            <th scope="col" className="num">
              Peak since
              <InfoTip k="peak" />
            </th>
            <th scope="col">
              Group sold
              <InfoTip k="membersSold" />
            </th>
            {showSmartMoney && (
              <th scope="col">
                Smart Money, 1 h
                <InfoTip k="smTokenBuyers" />
              </th>
            )}
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <PackRow key={item.core.id} item={item} now={now} showSmartMoney={showSmartMoney} to={href(`/packs/${item.core.id}`)} onOpen={(to) => navigate(to)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PackRow({ item, now, to, onOpen, showSmartMoney }: { item: PackListItem; now: number; to: string; onOpen: (to: string) => void; showSmartMoney: boolean }) {
  const { core, token, patterns, after } = item;
  const expanded = core.totalWalletCount - core.initialWalletCount;
  const name = token.name || "Unknown token";
  const sm = buyerCountText(item.smartMoney1h, "1 hour");
  const analysis = analysisLabel(item.analysisState);
  const smUnknown = item.smartMoney1h.countQualifier === "unknown" || item.smartMoney1h.observedUniqueBuyers === null;
  const soldShare = after && after.memberCount > 0 ? after.membersSold / after.memberCount : 0;
  const status = after ? groupSold(after.membersSold, after.memberCount) : null;
  const flags = rowFlags(item);
  return (
    <tr
      className={`row-link${item.invalidated ? " invalid" : ""}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input, select, summary")) return;
        if (window.getSelection()?.toString()) return;
        onOpen(to);
      }}
    >
      <td>
        <div className="feed-token">
          <TokenAvatar mint={core.tokenAddress} symbol={token.symbol} name={token.name} image={token.imageUrl} />
          <div className="feed-token-text">
            <div className="feed-token-name">
              <Link to={to}>
                {name}
                {token.symbol && <span className="sym">{token.symbol}</span>}
              </Link>
              {core.state === "collecting" && (
                <Tag tone="blue" dot pulse title="The pack can still gain wallets">
                  Forming
                </Tag>
              )}
              {item.invalidated && <Tag tone="red">Invalidated</Tag>}
            </div>
            <div className="feed-token-sub">
              <Address value={core.tokenAddress} copyLabel="Copy token address" />
              {flags.map((f) => (
                <span key={f.label} className="flag" title={f.title}>
                  {f.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </td>
      <td className="nowrap">
        <div>{relative(core.triggerEventTimeMs, now)}</div>
        <div className="tiny muted mono">{timeUtc(core.triggerEventTimeMs)}</div>
      </td>
      <td className="num">
        <div className="strong">{core.totalWalletCount}</div>
        {expanded > 0 && <div className="tiny muted">+{expanded} joined</div>}
      </td>
      <td className="num strong">{usd(core.eligibleBuyUsd)}</td>
      <td className={`num${patterns.initialEntrySpanMs === 0 ? " strong" : ""}`}>{entryWindow(patterns.initialEntrySpanMs)}</td>
      {after && after.tradesAfter > 0 ? (
        <>
          <td className="num">
            <Delta pct={after.lastChangePct} />
          </td>
          <td className="num">
            <Delta pct={after.peakChangePct} />
          </td>
        </>
      ) : (
        <td className="num muted" colSpan={2}>
          {after ? "No trades since" : "n/a"}
        </td>
      )}
      <td className="nowrap">
        {after && status ? (
          <div className="sold" title={status.title}>
            <Tag tone={status.tone}>{status.label}</Tag>
            <span className="meter sold-meter" aria-hidden="true">
              <span className="settled" style={{ width: `${soldShare * 100}%` }} />
            </span>
          </div>
        ) : (
          "n/a"
        )}
      </td>
      {showSmartMoney && (
      <td>
        {smUnknown && item.analysisState === "not_requested" ? (
          <span className="muted small">Not checked yet</span>
        ) : (
          <div className="sm-cell">
            <span className={smUnknown ? "muted small" : "small"} title={sm.detail}>
              {sm.headline}
              {!smUnknown ? (item.smartMoney1h.observedUniqueBuyers === 1 ? " buyer" : " buyers") : ""}
            </span>
            <span className="tiny muted" title="Pack wallets confirmed as Smart Money buyers of this pack, and the wallet analysis state">
              {item.confirmedMemberCount !== null ? `${confirmedText(item.confirmedMemberCount, item.totalMemberCount)} confirmed · ` : ""}
              {analysis.text}
            </span>
          </div>
        )}
      </td>
      )}
      <td className="chev" aria-hidden="true">
        <CaretRight size={14} weight="bold" />
      </td>
    </tr>
  );
}
