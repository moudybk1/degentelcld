import { useEffect } from "react";
import { Link, useParams } from "react-router";
import type { WalletPageData } from "@packlens/contracts";
import { track } from "../api/client";
import { useApi } from "../api/hooks";
import { WalletProfileCard } from "../components/ContextPanels";
import { Address, Empty, ErrorNote, ExtLink, LoadingBlock, ModeBadge, Reveal, Tag } from "../components/ui";
import { dateTimeUtc, shortAddr, usd } from "../lib/format";
import { accountUrl, nansenWalletUrl } from "../lib/explorer";
import { useNsHref } from "../state/namespace";

export function WalletPage() {
  const { address = "" } = useParams();
  const href = useNsHref();
  const { data, meta, error, loading } = useApi<WalletPageData>(`/api/wallets/solana/${address}`);
  useEffect(() => {
    track("wallet_opened", "wallet");
  }, [address]);
  const synthetic = meta?.mode === "fixture";

  return (
    <div className="container">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={href("/")}>Pack Radar</Link>
        <span aria-hidden="true">/</span>
        <span>Wallet</span>
      </nav>
      <Reveal>
        <header style={{ marginTop: 20 }}>
          <div className="row" style={{ gap: 8 }}>
            <ModeBadge mode={meta?.mode} />
            <Tag tone="outline">Solana wallet</Tag>
          </div>
          <h1 className="display mono" style={{ fontFamily: "var(--font-mono)", fontSize: "clamp(22px, 3.4vw, 34px)", letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>
            {address}
          </h1>
          <div className="row" style={{ gap: 14, marginTop: 10 }}>
            <Address value={address} copyLabel="Copy wallet address" head={6} tail={6} />
            {!synthetic && <ExtLink href={accountUrl(address)}>Solscan</ExtLink>}
            {!synthetic && <ExtLink href={nansenWalletUrl(address)}>Nansen profiler</ExtLink>}
          </div>
          <p className="lede">A unique wallet is a distinct address on Solana, not a count of people or beneficial owners.</p>
        </header>
      </Reveal>

      {error && !data ? (
        <div className="section">
          <ErrorNote error={error} what="This wallet" />
        </div>
      ) : loading && !data ? (
        <div className="section">
          <LoadingBlock label="Loading wallet" />
        </div>
      ) : data ? (
        <>
          <section className="section" aria-labelledby="w-packs">
            <div className="section-head">
              <h2 className="h2" id="w-packs">Packs with this wallet</h2>
              <span className="small muted">{data.packs.length} in this namespace</span>
            </div>
            {data.packs.length === 0 ? (
              <Empty title="Not a member of any stored pack">This wallet has not appeared as pack evidence in this namespace.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Packs this wallet belongs to</caption>
                  <thead>
                    <tr>
                      <th scope="col">Token</th>
                      <th scope="col">Member</th>
                      <th scope="col">First entry</th>
                      <th scope="col" className="num">Eligible value</th>
                      <th scope="col">Pack</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.packs.map((p) => (
                      <tr key={p.packId}>
                        <td>
                          <Link className="text-link" to={href(`/tokens/solana/${p.tokenAddress}`)}>
                            {p.tokenSymbol ?? shortAddr(p.tokenAddress)}
                          </Link>
                        </td>
                        <td>{p.memberKind === "initial" ? <Tag>Initial</Tag> : <Tag tone="yellow">Expanded</Tag>}</td>
                        <td className="mono small">{dateTimeUtc(p.firstEntryTimeMs)}</td>
                        <td className="num">{usd(p.eligibleBuyUsd)}</td>
                        <td>
                          <Link className="text-link small" to={href(`/packs/${p.packId}`)}>
                            Open pack
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="section" aria-labelledby="w-context">
            <div className="section-head">
              <h2 className="h2" id="w-context">Stored profile</h2>
              <span className="small muted">Read from stored snapshots; opening this page never triggers a paid request.</span>
            </div>
            <WalletProfileCard ctx={data.context} mint={data.packs[0]?.tokenAddress ?? null} synthetic={synthetic} />
          </section>
        </>
      ) : null}
    </div>
  );
}
