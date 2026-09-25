import { Link, useParams } from "react-router";
import type { TokenPageData } from "@packlens/contracts";
import { useEventListener } from "../api/events";
import { useApi, useNow } from "../api/hooks";
import { HoldersCard, TokenInfoCard } from "../components/ContextPanels";
import { PackCard } from "../components/PackCard";
import { SmartMoneySection } from "../components/SmartMoneyPanel";
import { Address, Empty, ErrorNote, ExtLink, LoadingBlock, ModeBadge, Reveal, Tag, TokenAvatar } from "../components/ui";
import { dateTimeUtc } from "../lib/format";
import { tokenUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";

export function TokenPage() {
  const { mint = "" } = useParams();
  const href = useNsHref();
  const now = useNow(5000);
  const { data, meta, error, loading, reload } = useApi<TokenPageData>(`/api/tokens/solana/${mint}`);
  useEventListener(
    (msg) => {
      if (msg.type === "resync_required" || (msg.payload as { mint?: string }).mint === mint) reload();
    },
    [mint, reload],
  );
  const synthetic = meta?.mode === "fixture";
  const name = data?.token.name || "Unknown token";

  return (
    <div className="container">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={href("/")}>Pack Radar</Link>
        <span aria-hidden="true">/</span>
        <span>Token</span>
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
          <Reveal>
            <header className="row" style={{ gap: 18, marginTop: 20, alignItems: "flex-start", flexWrap: "nowrap" }}>
              <TokenAvatar mint={mint} symbol={data.token.symbol} name={data.token.name} large />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <ModeBadge mode={meta?.mode} />
                  {data.isDemoPinned && <Tag tone="yellow">Demo pinned</Tag>}
                </div>
                <h1 className="display" style={{ fontSize: "clamp(34px, 5vw, 54px)" }}>
                  {name} {data.token.symbol && <em>{data.token.symbol}</em>}
                </h1>
                <div className="row" style={{ gap: 14, marginTop: 8 }}>
                  <Address value={mint} copyLabel="Copy token address" head={6} tail={6} />
                  {!synthetic && <ExtLink href={tokenUrl(mint)}>Solscan</ExtLink>}
                  <span className="small muted">{data.firstSeenInSource ? `First seen in source ${dateTimeUtc(data.firstSeenInSource)}` : "Not seen in the monitored source"}</span>
                </div>
              </div>
            </header>
          </Reveal>

          <section className="section" aria-labelledby="t-packs">
            <div className="section-head">
              <h2 className="h2" id="t-packs">Packs on this token</h2>
            </div>
            {data.packs.length === 0 ? (
              <Empty title="No pack detected in the monitored source">Smart Money activity alone never creates a pack. Packs come only from decoded pump.fun buys.</Empty>
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
              <span className="small muted">Latest stored snapshots, each with its own fetch time.</span>
            </div>
            <div className="bento">
              <div className="span-5">
                <TokenInfoCard panel={data.tokenInfo} synthetic={synthetic} />
              </div>
              <div className="span-7">
                <HoldersCard panel={data.holders} synthetic={synthetic} />
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
