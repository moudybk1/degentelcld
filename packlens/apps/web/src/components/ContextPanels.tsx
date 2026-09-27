import { Link } from "react-router";
import type { HoldersData, Panel, TokenInfoData, WalletContext } from "@packlens/contracts";
import { dateTimeUtc, decimal, int, pct, shortAddr, timeUtc, usd, usdCompact } from "../lib/format";
import { accountUrl, nansenWalletUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";
import { PanelStatus } from "./PanelStatus";
import { Address, ExtLink, KV, Tag } from "./ui";

export function TokenInfoCard({ panel, synthetic }: { panel: Panel<TokenInfoData>; synthetic: boolean }) {
  const d = panel.data;
  return (
    <div className="card">
      <div className="card-title">
        <h3 className="h3">Token facts</h3>
        <PanelStatus state={panel.state} compact />
      </div>
      {d ? (
        <div className="stack" style={{ gap: 8 }}>
          <KV k="Market cap">{usdCompact(d.marketCapUsd)}</KV>
          <KV k="Fully diluted value">{usdCompact(d.fdvUsd)}</KV>
          <KV k="Liquidity">{usdCompact(d.spot?.liquidityUsd)}</KV>
          <KV k="Holders (provider)">{int(d.spot?.totalHolders ?? null)}</KV>
          <KV k={`Volume (${d.timeframe})`}>{usdCompact(d.spot?.volumeTotalUsd)}</KV>
          <KV k={`Buys / sells (${d.timeframe})`}>
            {int(d.spot?.totalBuys ?? null)} / {int(d.spot?.totalSells ?? null)}
          </KV>
          <KV k={`Unique buyers (${d.timeframe})`}>{int(d.spot?.uniqueBuyers ?? null)}</KV>
          <KV k="Total supply">{decimal(d.totalSupply, 0)}</KV>
          {d.deploymentDate && <KV k="Deployed">{dateTimeUtc(d.deploymentDate)}</KV>}
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {panel.state.availability === "unavailable" ? "Token data is unavailable from this source. The pack is retained." : panel.state.availability === "not_requested" ? "Not checked yet." : "No token facts to show."}
        </p>
      )}
      <div style={{ marginTop: 14 }}>
        <PanelStatus state={panel.state} source={synthetic ? "Example data" : "Nansen token information"} />
      </div>
    </div>
  );
}

export function HoldersCard({ panel, synthetic }: { panel: Panel<HoldersData>; synthetic: boolean }) {
  const href = useNsHref();
  const d = panel.data;
  return (
    <div className="card">
      <div className="card-title">
        <h3 className="h3">Top holders</h3>
        <PanelStatus state={panel.state} compact />
      </div>
      {d && d.holders.length > 0 ? (
        <>
          <div className="row small" style={{ gap: 18, marginBottom: 12 }}>
            <span>
              <span className="muted">Observed top {d.observedHolderCount} share of supply: </span>
              <strong className="num">{d.observedTopShare === null ? "Not computable" : pct(d.observedTopShare)}</strong>
            </span>
            {d.isLastPage === false && <Tag tone="yellow">First page only</Tag>}
          </div>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table className="table compact">
              <caption className="sr-only">Top holders from the first provider page</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Holder</th>
                  <th scope="col" className="num">Tokens</th>
                  <th scope="col" className="num">Share of supply</th>
                  <th scope="col" className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {d.holders.map((h, i) => {
                  const share = d.totalSupplyUsed && h.tokenAmount ? Number(h.tokenAmount) / Number(d.totalSupplyUsed) : null;
                  return (
                    <tr key={h.address} className={h.isPackMember ? "highlight" : ""}>
                      <td className="muted num">{i + 1}</td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <Address value={h.address} href={href(`/wallets/solana/${h.address}`)} />
                          {h.isPackMember && <Tag tone="blue">Pack member</Tag>}
                          {h.label && <span className="tiny muted">{h.label}</span>}
                        </div>
                      </td>
                      <td className="num">{decimal(h.tokenAmount, 0)}</td>
                      <td className="num">{share === null ? "n/a" : `${(share * 100).toFixed(2)}%`}</td>
                      <td className="num">{usd(h.valueUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.warnings.length > 0 && <p className="tiny muted">{d.warnings.join(" ")}</p>}
          <p className="tiny muted" style={{ margin: "10px 0 0" }}>
            Share uses verified total supply as the denominator. A partial holder list describes only the observed portion; pack purchase dominance is a different metric.
          </p>
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {panel.state.availability === "empty"
            ? "No holders were returned in the checked data."
            : panel.state.availability === "not_requested"
              ? "Not checked yet."
              : panel.state.availability === "unavailable"
                ? "Holder data is unavailable from this source."
                : "Holder data is not available."}
          {d?.warnings.length ? ` ${d.warnings.join(" ")}` : ""}
        </p>
      )}
      <div style={{ marginTop: 14 }}>
        <PanelStatus state={panel.state} source={synthetic ? "Example data" : "Nansen top holders"} />
      </div>
    </div>
  );
}

export function WalletProfileCard({ ctx, mint, synthetic, title }: { ctx: WalletContext; mint: string | null; synthetic: boolean; title?: string }) {
  const href = useNsHref();
  const pnl = ctx.pnl.data;
  const dex = ctx.dexHistory.data;
  const rel = ctx.related.data;
  const bal = ctx.balance.data;
  const src = (s: string) => (synthetic ? "Example data" : s);
  const deployed = (rel?.related ?? []).filter((r) => /deploy/i.test(r.relation) && /token/i.test(r.label ?? "")).length;
  return (
    <div className="card">
      <div className="card-title">
        <div className="stack" style={{ gap: 2 }}>
          <span className="stat-label">{title ?? "Wallet"}</span>
          <div className="row" style={{ gap: 6 }}>
            <Address value={ctx.walletAddress} href={href(`/wallets/solana/${ctx.walletAddress}`)} head={6} tail={6} />
          </div>
        </div>
        {!synthetic && (
          <div className="row" style={{ gap: 12 }}>
            <ExtLink href={accountUrl(ctx.walletAddress)}>Solscan</ExtLink>
            <ExtLink href={nansenWalletUrl(ctx.walletAddress)}>Nansen</ExtLink>
          </div>
        )}
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="h3" style={{ fontSize: 13.5 }}>
              Profit and loss{pnl ? `, ${dateTimeUtc(pnl.periodStart).split(",")[0]} to ${dateTimeUtc(pnl.periodEnd).split(",")[0]}` : ", 30 days"}
            </span>
            <PanelStatus state={ctx.pnl.state} compact />
          </div>
          {pnl ? (
            <div className="bento" style={{ gap: 10, marginTop: 8 }}>
              <div className="span-3">
                <div className="stat-label">Realized PnL</div>
                <div className="metric-value" style={{ fontSize: 18 }}>{usd(pnl.realizedPnlUsd)}</div>
              </div>
              <div className="span-3">
                <div className="stat-label">Win rate</div>
                <div className="metric-value" style={{ fontSize: 18 }}>
                  {pnl.tradedTimes === 0 ? (
                    <span className="muted" title="Nansen counted no sells in this period, so there is no win rate (not 0%).">
                      N/A · no sells
                    </span>
                  ) : (
                    pct(pnl.winRate, 0)
                  )}
                </div>
              </div>
              <div className="span-3">
                <div className="stat-label">Sells counted</div>
                <div className="metric-value" style={{ fontSize: 18 }}>{int(pnl.tradedTimes)}</div>
              </div>
              <div className="span-3">
                <div className="stat-label">Tokens traded</div>
                <div className="metric-value" style={{ fontSize: 18 }}>{int(pnl.tradedTokenCount)}</div>
              </div>
            </div>
          ) : (
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              {ctx.pnl.state.availability === "error" ? "Update delayed: Nansen's response could not be used." : ctx.pnl.state.availability === "not_requested" ? "Not checked yet." : "No profit and loss data."}
            </p>
          )}
          <p className="tiny muted" style={{ margin: "6px 0 0" }}>
            Win rate describes this period's sells only; it is not a probability for this token. Nansen&apos;s figures cover what Nansen indexed for this wallet in the period, which can differ from
            the pack trades observed here; a zero is not a verified full history.
          </p>
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="h3" style={{ fontSize: 13.5 }}>Recent trades, 7 days</span>
            <PanelStatus state={ctx.dexHistory.state} compact />
          </div>
          {dex && dex.trades.length > 0 ? (
            <>
              <p className="small muted" style={{ margin: "6px 0 8px" }}>
                {dex.sampleSize} {dex.sampleSize === 1 ? "trade" : "trades"} shown
                {dex.isLastPage === false ? " (a sample; the wallet made more)" : ""}.
              </p>
              <div className="stack" style={{ gap: 6 }}>
                {dex.trades.slice(0, 5).map((t) => (
                  <div className="kv small" key={t.transactionHash}>
                    <span className="k mono">{timeUtc(t.blockTimestamp)}</span>
                    <span className="v">
                      {t.tokenBoughtSymbol ?? shortAddr(t.tokenBoughtAddress)} for {t.tokenSoldSymbol ?? shortAddr(t.tokenSoldAddress)} · {usd(t.tradeValueUsd)}
                      {mint && t.tokenBoughtAddress === mint ? " · this token" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              {ctx.dexHistory.state.availability === "empty" ? "No DEX trades in the checked period." : ctx.dexHistory.state.availability === "not_requested" ? "Not checked yet." : "No trade history available."}
            </p>
          )}
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="h3" style={{ fontSize: 13.5 }}>Related wallets</span>
            <PanelStatus state={ctx.related.state} compact />
          </div>
          {deployed > 0 && (
            <p className="small deploy-note">
              <strong>
                Nansen links this wallet to {deployed} deployed token {deployed === 1 ? "contract" : "contracts"}.
              </strong>{" "}
              A wallet that launches tokens and also joins packs is worth a closer look.
            </p>
          )}
          {rel && rel.related.length > 0 ? (
            <div className="stack" style={{ gap: 6, marginTop: 8 }}>
              {rel.related.slice(0, 8).map((r) => (
                <div className="kv small" key={`${r.address}-${r.transactionHash}`}>
                  <span className="k" title={relationHelp(r.relation)}>
                    {r.relation}
                  </span>
                  <span className="v row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <Address value={r.address} href={href(`/wallets/solana/${r.address}`)} />
                    {r.isPackMember && <Tag tone="blue">Pack member</Tag>}
                    {r.label && <span className="tiny muted">{r.label}</span>}
                  </span>
                </div>
              ))}
              <p className="tiny muted" style={{ margin: "4px 0 0" }}>
                Relationships come from Nansen. A transfer between wallets does not prove they share an owner.
              </p>
            </div>
          ) : (
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              {ctx.related.state.availability === "empty" ? "No related wallets returned in the checked data." : ctx.related.state.availability === "not_requested" ? "Not checked for this wallet." : "Relationship data is not available."}
            </p>
          )}
        </div>

        {bal || ctx.balance.state.availability !== "not_requested" ? (
          <div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="h3" style={{ fontSize: 13.5 }}>Later balance check</span>
              <PanelStatus state={ctx.balance.state} compact />
            </div>
            {bal ? (
              <p className="small" style={{ margin: "6px 0 0" }}>
                {bal.packToken?.observedOnFetchedPages ? (
                  <>
                    Holding {decimal(bal.packToken.tokenAmount, 0)} tokens ({usd(bal.packToken.valueUsd)}) when checked
                    {ctx.balance.state.fetchedAt ? ` at ${timeUtc(ctx.balance.state.fetchedAt)}` : ""}.
                  </>
                ) : (
                  <>This token was not on the balance page Nansen returned{ctx.balance.state.fetchedAt ? ` at ${timeUtc(ctx.balance.state.fetchedAt)}` : ""}.</>
                )}
                <span className="muted"> A balance observed in a later check, not a change or proof of selling.</span>
              </p>
            ) : (
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                {ctx.balance.state.availability === "budget_paused"
                  ? "Checks paused before the later balance check ran."
                  : ctx.balance.state.availability === "queued"
                    ? "Scheduled for five minutes after the pack formed."
                    : ctx.balance.state.availability === "not_requested"
                      ? "Not scheduled for this wallet."
                      : "No balance data."}
              </p>
            )}
          </div>
        ) : null}
      </div>
      <div style={{ marginTop: 14 }} className="tiny muted">
        Source: {src("Nansen wallet profiler")}
      </div>
    </div>
  );
}

/** Plain meaning of Nansen's relationship names, where it is known. */
function relationHelp(relation: string): string {
  if (/first funder/i.test(relation)) return "The wallet that first sent SOL to this wallet.";
  if (/deployed program/i.test(relation)) return "A program or token contract that this wallet deployed.";
  if (/deployer|deployed by/i.test(relation)) return "The wallet that deployed this one.";
  if (/sent|received|transfer/i.test(relation)) return "A wallet this one transferred funds with.";
  return "A relationship reported by Nansen.";
}

export function MemberLink({ address }: { address: string }) {
  const href = useNsHref();
  return (
    <Link className="text-link mono small" to={href(`/wallets/solana/${address}`)}>
      {shortAddr(address)}
    </Link>
  );
}
