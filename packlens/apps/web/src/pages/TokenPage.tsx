import { Link, useLocation, useParams } from "react-router";
import type { TokenPageData } from "@packlens/contracts";
import { useEventListener } from "../api/events";
import { useApi, useDocumentTitle, useNow } from "../api/hooks";
import { HoldersCard, TokenInfoCard } from "../components/ContextPanels";
import { PackCard } from "../components/PackCard";
import { SmartMoneySection } from "../components/SmartMoneyPanel";
import { Address, Empty, ErrorNote, ExtLink, LoadingBlock, ModeBadge, Reveal, Tag, TokenAvatar, TradeLink, type FromState } from "../components/ui";
import { dateTimeUtc, relative, shortAddr } from "../lib/format";
import { dexScreenerUrl, nansenTokenUrl, pumpFunUrl, tokenUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";

export function TokenPage() {
  const { mint = "" } = useParams();
  const href = useNsHref();
  const now = useNow(5000);
  const { data, meta, error, loading, reload } = useApi<TokenPageData>(`/api/tokens/solana/${mint}`);
  useDocumentTitle(data ? `${data.token.symbol || data.token.name || shortAddr(mint)} on pump.fun · Degentellegence` : null);
  useEventListener(
    (msg) => {
      if (msg.type === "resync_required" || (msg.payload as { mint?: string }).mint === mint) reload();
    },
    [mint, reload],
  );
  const from = (useLocation().state as FromState | null)?.from;
  const synthetic = meta?.mode === "fixture";
  const name = data?.token.name || "Unknown token";
  const contextUnchecked = data ? data.tokenInfo.state.availability === "not_requested" && data.holders.state.availability === "not_requested" : false;

  return (
    <div className="container">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={href("/")}>Pack Radar</Link>
        {from && (
          <>
            <span aria-hidden="true">/</span>
            <Link to={from.href}>{from.label}</Link>
          </>
        )}
        <span aria-hidden="true">/</span>
        <span>{data?.token.symbol ?? data?.token.name ?? `Token ${shortAddr(mint)}`}</span>
      </nav>
      {error && !data ? (
        <div className="section">
          <ErrorNote error={error} what="This token" />
        </div>
      ) : loading && !data ? (
        <div className="section">
          <LoadingBlock label="Loading token" />
        </div>
      ) : data ? (
        <>
          <header className="id-head">
            <div className="row" style={{ gap: "14px 22px", alignItems: "flex-end", minWidth: 0 }}>
              <TokenAvatar mint={mint} symbol={data.token.symbol} name={data.token.name} image={data.token.imageUrl} large />
              <div className="row" style={{ gap: 8 }}>
                <ModeBadge mode={meta?.mode} />
                <Tag tone="outline">Solana token</Tag>
                {data.isDemoPinned && <Tag tone="yellow">Demo pinned</Tag>}
              </div>
            </div>
            <h1 className="display">
              {name} {data.token.symbol && <em>{data.token.symbol}</em>}
            </h1>
            <div className="id-meta">
              <Address value={mint} copyLabel="Copy token address" head={6} tail={6} />
              {!synthetic && <ExtLink href={pumpFunUrl(mint)}>pump.fun</ExtLink>}
              {!synthetic && <ExtLink href={dexScreenerUrl(mint)}>DexScreener</ExtLink>}
              {!synthetic && <ExtLink href={tokenUrl(mint)}>Solscan</ExtLink>}
              {!synthetic && <TradeLink href={nansenTokenUrl(mint)} />}
            </div>
            <p className="small muted token-facts">
              {data.createdAt ? `Created ${dateTimeUtc(data.createdAt)} (${relative(data.createdAt, now)})` : data.firstSeenInSource ? `First seen ${dateTimeUtc(data.firstSeenInSource)}; its creation was not observed` : "Not seen in the monitored pump.fun stream"}
              {data.graduatedAt ? ` · Left the bonding curve ${dateTimeUtc(data.graduatedAt)}; later trades happen elsewhere and are not observed here` : ""}
              {` · ${data.packs.length} ${data.packs.length === 1 ? "pack" : "packs"} recorded`}
            </p>
          </header>

          <section className="section" aria-labelledby="t-packs">
            <div className="section-head">
              <h2 className="h2" id="t-packs">Packs on this token</h2>
            </div>
            {data.packs.length === 0 ? (
              <Empty title="No pack detected in the monitored source">No group of wallets bought this token together in the data you are viewing. Smart Money activity alone never creates a pack.</Empty>
            ) : (
              <div className="pack-grid">
                {data.packs.map((p, i) => (
                  <Reveal key={p.core.id} index={i}>
                    <PackCard item={p} now={now} />
                  </Reveal>
                ))}
              </div>
            )}
          </section>

          <section className="section" aria-labelledby="t-sm">
            <div className="section-head">
              <div>
                <div className="eyebrow">Additional context</div>
                <h2 className="h2" id="t-sm" style={{ marginTop: 6 }}>
                  Smart Money on this token
                </h2>
              </div>
            </div>
            <SmartMoneySection windows={data.smartMoney.windows} asOf={data.smartMoney.asOf} confirmation={null} netflow={data.smartMoney.netflow} packId={null} />
          </section>

          <section className="section" aria-labelledby="t-context">
            <div className="section-head">
              <h2 className="h2" id="t-context">Token context</h2>
              <span className="small muted">From Nansen, each with its own fetch time.</span>
            </div>
            {contextUnchecked ? (
              <div className="unchecked">
                <p>
                  <strong>Nansen token facts and top holders have not been checked yet.</strong> They are fetched for the largest packs while credits allow.
                </p>
              </div>
            ) : (
            <div className="bento">
              <div className="span-5">
                <TokenInfoCard panel={data.tokenInfo} synthetic={synthetic} />
              </div>
              <div className="span-7">
                <HoldersCard panel={data.holders} synthetic={synthetic} />
              </div>
            </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
