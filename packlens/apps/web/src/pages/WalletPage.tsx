import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { WalletPackRow, WalletPageData } from "@packlens/contracts";
import { track } from "../api/client";
import { useApi, useNow } from "../api/hooks";
import { WalletProfileCard } from "../components/ContextPanels";
import { Address, Empty, ErrorNote, ExtLink, LoadingBlock, ModeBadge, Reveal, Tag, TokenAvatar, type FromState } from "../components/ui";
import { relative, shortAddr, timeUtc, usd, usdCompact } from "../lib/format";
import { accountUrl, nansenWalletUrl } from "../lib/explorer";
import { duration, type FactTone } from "../lib/packFacts";
import { useNsHref } from "../state/namespace";

const DAY = 24 * 3_600_000;
const LAUNCH_MS = 10_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Plain answers about this wallet's pack history, from the rows shown. */
function summary(d: WalletPageData, now: number): { q: string; a: string; detail: string; tone: FactTone }[] {
  const rows = d.packs;
  const n = rows.length;
  const out: { q: string; a: string; detail: string; tone: FactTone }[] = [];
  const times = rows.map((r) => r.triggerEventTimeMs).sort((a, b) => a - b);
  const spanMs = n > 1 ? times[n - 1]! - times[0]! : 0;
  const every = n > 1 ? spanMs / (n - 1) : null;
  out.push({
    q: "How active is it?",
    a: `${d.packCount} ${d.packCount === 1 ? "pack" : "packs"}`,
    detail:
      n > 1
        ? `Between ${timeUtc(times[0]!)} and ${timeUtc(times[n - 1]!)}, about one every ${duration(every!)}.${d.packCount > n ? ` The latest ${n} are shown.` : ""}`
        : n === 1
          ? `Once, ${relative(times[0]!, now)}.`
          : "No packs recorded.",
    tone: every !== null && every <= 10 * 60_000 ? "attention" : "neutral",
  });
  const started = rows.filter((r) => r.memberKind === "initial").length;
  out.push({
    q: "Does it start packs or join them?",
    a: `Started ${started} of ${n}`,
    detail: `It was among the first wallets in ${started} ${started === 1 ? "pack" : "packs"} and joined ${n - started} later.`,
    tone: n > 0 && started / n >= 0.5 ? "attention" : "neutral",
  });
  // Sells older than a day may have been cleaned up, so those rows are not counted either way.
  const known = rows.filter((r) => r.firstSellTimeMs !== null || now - r.firstEntryTimeMs < DAY);
  const sold = known.filter((r) => r.firstSellTimeMs !== null);
  const hold = median(sold.map((r) => r.firstSellTimeMs! - r.firstEntryTimeMs));
  out.push({
    q: "Does it sell quickly?",
    a: known.length === 0 ? "Not known" : `Sold in ${sold.length} of ${known.length}`,
    detail:
      known.length === 0
        ? "Its trades are older than the one day of trades kept."
        : hold === null
          ? "No sells of these tokens observed after its pack buys."
          : `Typically ${duration(hold)} after its first buy (median).${known.length < n ? " Packs older than a day are not counted." : ""}`,
    tone: known.length > 0 && sold.length / known.length >= 0.5 ? "attention" : "neutral",
  });
  const withLaunch = rows.filter((r) => r.tokenCreatedAtMs !== null);
  const atLaunch = withLaunch.filter((r) => r.firstEntryTimeMs - r.tokenCreatedAtMs! <= LAUNCH_MS);
  out.push({
    q: "Does it buy at launch?",
    a: withLaunch.length === 0 ? "Not known" : `${atLaunch.length} of ${withLaunch.length} at launch`,
    detail: withLaunch.length === 0 ? "The tokens' creation was not observed." : "First buy within 10 seconds of the token's creation.",
    tone: withLaunch.length > 0 && atLaunch.length / withLaunch.length >= 0.5 ? "attention" : "neutral",
  });
  const spend = rows.map((r) => Number(r.eligibleBuyUsd)).filter((x) => Number.isFinite(x));
  const total = spend.reduce((a, b) => a + b, 0);
  out.push({
    q: "How much does it spend?",
    a: usdCompact(String(total)),
    detail: `Across ${n} ${n === 1 ? "pack" : "packs"}; ${usd(String(median(spend) ?? 0))} per pack (median).`,
    tone: "neutral",
  });
  return out;
}

function SoldCell({ r, now }: { r: WalletPackRow; now: number }) {
  if (r.firstSellTimeMs !== null) return <span>After {duration(r.firstSellTimeMs - r.firstEntryTimeMs)}</span>;
  if (now - r.firstEntryTimeMs >= DAY) return <span className="muted" title="Trades older than a day are cleaned up, so a sell may not be visible.">Not known</span>;
  return <span className="muted">No sell seen</span>;
}

export function WalletPage() {
  const { address = "" } = useParams();
  const href = useNsHref();
  const now = useNow(10_000);
  const from = (useLocation().state as FromState | null)?.from;
  const { data: raw, meta, error, loading } = useApi<WalletPageData>(`/api/wallets/solana/${address}`);
  // A server older than this page sends rows without sells, launch times, or token identity: show the plain table only.
  const legacy = raw !== null && raw.packCount === undefined;
  const data: WalletPageData | null = raw
    ? {
        ...raw,
        packCount: raw.packCount ?? raw.packs.length,
        packs: raw.packs.map((p) => ({
          ...p,
          token: p.token ?? { chain: "solana", mint: p.tokenAddress, name: null, symbol: p.tokenSymbol, identitySource: null, imageUrl: null },
          firstSellTimeMs: p.firstSellTimeMs ?? null,
          tokenCreatedAtMs: p.tokenCreatedAtMs ?? null,
        })),
      }
    : null;
  useEffect(() => {
    track("wallet_opened", "wallet");
  }, [address]);
  const synthetic = meta?.mode === "fixture";

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
        <span>Wallet {shortAddr(address)}</span>
      </nav>
      <Reveal>
        <header style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 8 }}>
            <ModeBadge mode={meta?.mode} />
            <Tag tone="outline">Solana wallet</Tag>
          </div>
          <h1 className="display mono wallet-title">{address}</h1>
          <div className="row" style={{ gap: 14, marginTop: 10 }}>
            <Address value={address} copyLabel="Copy wallet address" head={6} tail={6} />
            {!synthetic && <ExtLink href={accountUrl(address)}>Solscan</ExtLink>}
            {!synthetic && <ExtLink href={nansenWalletUrl(address)}>Nansen</ExtLink>}
          </div>
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
          {data.packs.length > 0 && !legacy && (
            <section style={{ marginTop: 28 }} aria-labelledby="w-summary">
              <div className="glance-head">
                <h2 className="h2" id="w-summary">
                  This wallet at a glance
                </h2>
                <p className="small muted">From the packs it joined. One wallet is one address, not necessarily one person.</p>
              </div>
              <div className="glance wallet-glance">
                {summary(data, now).map((x) => (
                  <div key={x.q} className={`glance-card ${x.tone}`}>
                    <span className="glance-q">{x.q}</span>
                    <span className="glance-a">{x.a}</span>
                    <span className="glance-detail">{x.detail}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section" aria-labelledby="w-packs">
            <div className="section-head">
              <h2 className="h2" id="w-packs">Packs with this wallet</h2>
              <span className="small muted">
                {data.packCount > data.packs.length ? `Latest ${data.packs.length} of ${data.packCount}` : `${data.packCount} ${data.packCount === 1 ? "pack" : "packs"}`}, newest first
              </span>
            </div>
            {data.packs.length === 0 ? (
              <Empty title="Not in any recorded pack">This wallet has not been part of a pack in the data you are viewing.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table wallet-packs">
                  <caption className="sr-only">Packs this wallet belongs to</caption>
                  <thead>
                    <tr>
                      <th scope="col">Token</th>
                      <th scope="col">Role</th>
                      <th scope="col">First buy</th>
                      {!legacy && <th scope="col">After launch</th>}
                      <th scope="col" className="num">
                        Bought
                      </th>
                      {!legacy && <th scope="col">Sold</th>}
                      <th scope="col">
                        <span className="sr-only">Pack</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.packs.map((p) => {
                      const label = p.token.name || p.token.symbol || shortAddr(p.tokenAddress);
                      const age = p.tokenCreatedAtMs === null ? null : p.firstEntryTimeMs - p.tokenCreatedAtMs;
                      return (
                        <tr key={p.packId}>
                          <td>
                            <div className="feed-token">
                              <TokenAvatar mint={p.tokenAddress} symbol={p.token.symbol} name={p.token.name} image={p.token.imageUrl} />
                              <div className="feed-token-text">
                                <Link className="text-link" to={href(`/tokens/solana/${p.tokenAddress}`)}>
                                  {label}
                                </Link>
                                {p.token.name && p.token.symbol && <span className="tiny muted"> {p.token.symbol}</span>}
                              </div>
                            </div>
                          </td>
                          <td>{p.memberKind === "initial" ? <Tag tone="gray">Started it</Tag> : <Tag tone="yellow">Joined later</Tag>}</td>
                          <td className="nowrap">
                            <div>{relative(p.firstEntryTimeMs, now)}</div>
                            <div className="tiny muted mono">{timeUtc(p.firstEntryTimeMs)}</div>
                          </td>
                          {!legacy && <td className="nowrap">{age === null ? <span className="muted">Not known</span> : age < 1000 ? <strong>Same second</strong> : duration(age)}</td>}
                          <td className="num">{usd(p.eligibleBuyUsd)}</td>
                          {!legacy && (
                            <td className="nowrap">
                              <SoldCell r={p} now={now} />
                            </td>
                          )}
                          <td>
                            <Link className="text-link small" to={href(`/packs/${p.packId}`)}>
                              Open pack
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="section" aria-labelledby="w-context">
            <div className="section-head">
              <h2 className="h2" id="w-context">Nansen profile</h2>
              <span className="small muted">Stored results; opening this page never spends credits.</span>
            </div>
            <WalletProfileCard ctx={data.context} mint={data.packs[0]?.tokenAddress ?? null} synthetic={synthetic} />
          </section>
        </>
      ) : null}
    </div>
  );
}
