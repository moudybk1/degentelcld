import { Link } from "react-router";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { PackListItem } from "@packlens/contracts";
import { pct, relative, timeUtc, usd, usdCompact } from "../lib/format";
import { analysisLabel, buyerCountText, confirmedText } from "../lib/labels";
import { entryWindow, groupSold } from "../lib/packFacts";
import { InfoTip } from "./InfoTip";
import { Delta } from "./AfterSection";
import { useNsHref } from "../state/namespace";
import { Address, Tag, TokenAvatar } from "./ui";

export function PackCard({ item, now }: { item: PackListItem; now: number }) {
  const href = useNsHref();
  const { core, token, patterns } = item;
  const sm = buyerCountText(item.smartMoney1h, "1 hour");
  const analysis = analysisLabel(item.analysisState);
  const smUnknown = item.smartMoney1h.countQualifier === "unknown" || item.smartMoney1h.observedUniqueBuyers === null;
  const nothingChecked = smUnknown && item.confirmedMemberCount === null && item.analysisState === "not_requested";
  const expanded = core.totalWalletCount - core.initialWalletCount;
  const name = token.name || "Unknown token";
  return (
    <article className="card link pack-card" aria-labelledby={`pack-${core.id}`}>
      <div className="pack-top">
        <TokenAvatar mint={core.tokenAddress} symbol={token.symbol} name={token.name} image={token.imageUrl} />
        <div className="pack-token">
          <h3 className="pack-token-name" id={`pack-${core.id}`} style={{ margin: 0 }}>
            <Link to={href(`/packs/${core.id}`)} className="stretched">
              {name}
              {token.symbol && <span className="sym">{token.symbol}</span>}
            </Link>
          </h3>
          <div className="row" style={{ gap: 6, marginTop: 2 }}>
            <span className="above">
              <Address value={core.tokenAddress} copyLabel="Copy token address" />
            </span>
            <span className="tiny muted" title={new Date(core.triggerEventTimeMs).toISOString()}>
              Formed {timeUtc(core.triggerEventTimeMs)} · {relative(core.triggerEventTimeMs, now)}
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {core.state === "collecting" ? (
            <Tag tone="blue" dot pulse title="The pack can still gain wallets">
              Forming
            </Tag>
          ) : (
            <Tag tone="outline" title="The list of wallets is final">
              Final
            </Tag>
          )}
          <ArrowUpRight className="pack-open" size={18} weight="bold" aria-hidden="true" />
        </div>
      </div>

      <div className="pack-metrics">
        <div>
          <div className="metric-value">{core.totalWalletCount}</div>
          <div className="metric-label">
            wallets
            <span className="above">
              <InfoTip k="uniqueWallets" />
            </span>
            {expanded > 0 ? <div>{`${core.initialWalletCount} initial + ${expanded} joined`}</div> : null}
          </div>
        </div>
        <div>
          <div className="metric-value" title={usd(core.eligibleBuyUsd)}>{usdCompact(core.eligibleBuyUsd)}</div>
          <div className="metric-label">
            pack buys
            <span className="above">
              <InfoTip k="packBuys" />
            </span>
          </div>
        </div>
        <div>
          <div className="metric-value">{entryWindow(patterns.initialEntrySpanMs)}</div>
          <div className="metric-label">
            entry window
            <span className="above">
              <InfoTip k="entrySpread" />
            </span>
          </div>
        </div>
      </div>

      <div className="indicator-line" aria-label="Pattern indicators">
        <span>
          Size variation <b>{patterns.buySizeCV === null ? "n/a" : Number(patterns.buySizeCV).toFixed(2)}</b>
        </span>
        <span>
          Largest buyer <b>{pct(patterns.largestBuyerShare, 0)}</b>
        </span>
        <span>
          Repeat pairs <b>{patterns.cooccurrencePairCount}</b>
        </span>
        <span className="above">
          <InfoTip text="Size variation: how different the buy sizes are (0 = identical). Largest buyer: the biggest wallet's share of the pack. Repeat pairs: wallet pairs that also bought together in earlier packs." label="these indicators" />
        </span>
      </div>

      <div className="pack-foot">
        {item.after && (
          <div className="kv">
            <span className="k">
              After the pack
              <span className="above">
                <InfoTip text="Latest observed trade price vs the pack's average entry (in SOL), the highest point since the pack formed, and how many pack wallets have sold. Facts, not a forecast." label="After the pack" />
              </span>
            </span>
            <span className="v after-row" style={{ justifyContent: "flex-end" }}>
              {item.after.tradesAfter === 0 ? (
                <span>No trades since</span>
              ) : (
                <>
                  <span>
                    now <Delta pct={item.after.lastChangePct} />
                  </span>
                  <span>
                    peak <Delta pct={item.after.peakChangePct} />
                  </span>
                </>
              )}
              {(() => {
                const g = groupSold(item.after.membersSold, item.after.memberCount);
                return (
                  <Tag tone={g.tone} title={g.title}>
                    {g.label}
                  </Tag>
                );
              })()}
            </span>
          </div>
        )}
        {nothingChecked ? (
          <div className="kv">
            <span className="k">
              Smart Money and Nansen checks
              <span className="above">
                <InfoTip k="analysis" />
              </span>
            </span>
            <span className="v muted">Not checked yet</span>
          </div>
        ) : (
          <>
        <div className="kv">
          <span className="k">
            Smart Money buying this token, 1 h
            <span className="above">
              <InfoTip k="smTokenBuyers" />
            </span>
          </span>
          <span className="v" title={sm.detail}>
            {sm.headline} {!smUnknown ? (item.smartMoney1h.observedUniqueBuyers === 1 ? "buyer" : "buyers") : ""}
          </span>
        </div>
        <div className="kv">
          <span className="k">
            Pack wallets confirmed as Smart Money
            <span className="above">
              <InfoTip k="smConfirmed" />
            </span>
          </span>
          <span className="v">{confirmedText(item.confirmedMemberCount, item.totalMemberCount)}</span>
        </div>
        <div className="kv">
          <span className="k">
            Nansen checks
            <span className="above">
              <InfoTip k="analysis" />
            </span>
          </span>
          <span className="v">
            <Tag tone={analysis.tone}>{analysis.text}</Tag>
          </span>
        </div>
          </>
        )}
      </div>
      {item.invalidated && <Tag tone="red">Invalidated after audit</Tag>}
    </article>
  );
}
