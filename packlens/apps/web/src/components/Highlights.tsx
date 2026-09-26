import type { ReactNode } from "react";
import { Link } from "react-router";
import type { OverviewData, OverviewPack, OverviewToken } from "@packlens/contracts";
import { int, relative, shortAddr, usd, usdCompact } from "../lib/format";
import { useNsHref } from "../state/namespace";
import { TokenAvatar } from "./ui";

function tokenLabel(t: OverviewPack["token"]): { name: string; sym: string | null } {
  return { name: t.name || t.symbol || shortAddr(t.mint), sym: t.name && t.symbol ? t.symbol : null };
}

function Row({ to, token, meta, value, unit }: { to: string; token: OverviewPack["token"]; meta: ReactNode; value: string; unit: string }) {
  const l = tokenLabel(token);
  return (
    <li>
      <Link to={to} className="rank-row">
        <TokenAvatar mint={token.mint} symbol={token.symbol} name={token.name} image={token.imageUrl} />
        <span className="rank-main">
          <span className="rank-name">
            {l.name}
            {l.sym && <span className="sym">{l.sym}</span>}
          </span>
          <span className="rank-meta">{meta}</span>
        </span>
        <span className="rank-value">
          {value}
          <span className="unit">{unit}</span>
        </span>
      </Link>
    </li>
  );
}

function Panel({ title, sub, children, empty }: { title: string; sub: string; children: ReactNode[]; empty: string }) {
  return (
    <section className="panel rank-panel" aria-label={title}>
      <header className="panel-head">
        <h3 className="h3">{title}</h3>
        <span className="tiny muted">{sub}</span>
      </header>
      {children.length === 0 ? <p className="small muted panel-empty">{empty}</p> : <ol className="rank-list">{children}</ol>}
    </section>
  );
}

export function Highlights({ top, now }: { top: OverviewData["top"]; now: number }) {
  const href = useNsHref();
  const packMeta = (p: OverviewPack, other: string) => (
    <>
      {relative(p.triggerEventTimeMs, now)} · {other}
    </>
  );
  return (
    <div className="highlights">
      <Panel title="Largest packs" sub="Most unique wallets" empty="No packs in this range.">
        {top.byWallets.map((p) => (
          <Row key={p.id} to={href(`/packs/${p.id}`)} token={p.token} meta={packMeta(p, `${usdCompact(p.eligibleBuyUsd)} pack buys`)} value={int(p.totalWalletCount)} unit="wallets" />
        ))}
      </Panel>
      <Panel title="Largest pack buys" sub="Total of the pack's own buys" empty="No packs in this range.">
        {top.byUsd.map((p) => (
          <Row key={p.id} to={href(`/packs/${p.id}`)} token={p.token} meta={packMeta(p, `${p.totalWalletCount} wallets`)} value={usdCompact(p.eligibleBuyUsd)} unit="" />
        ))}
      </Panel>
      <Panel title="Packed repeatedly" sub="Tokens with more than one pack" empty="No token has more than one pack in this range.">
        {top.repeatTokens.map((t: OverviewToken) => (
          <Row
            key={t.token.mint}
            to={href(`/tokens/solana/${t.token.mint}`)}
            token={t.token}
            meta={
              <>
                latest {relative(t.latestTriggerMs, now)} · {usd(t.eligibleBuyUsd)} total
              </>
            }
            value={int(t.packs)}
            unit="packs"
          />
        ))}
      </Panel>
    </div>
  );
}
