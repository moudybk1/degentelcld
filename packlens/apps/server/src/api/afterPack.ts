/**
 * "After the pack": what happened on the monitored pump.fun stream after a
 * pack formed. Facts only, computed from stored trade events (no provider
 * calls). Prices are execution prices in SOL per token; changes are measured
 * against the pack's volume-weighted average entry price in SOL, so SOL/USD
 * moves do not distort them. Only SOL-quoted bonding-curve trades are seen.
 */
import type { AfterPackData, AfterPackMarker, AfterPackPoint, AfterPackSummary, EarlierPack, MemberExit } from "@packlens/contracts";
import type { Db } from "../db/connection.js";
import { canonical, Decimal, parseDecimal } from "../lib/decimal.js";

/** Time buckets for the chart; each keeps its low, high, and last trade, so spikes survive downsampling. */
const SERIES_BUCKETS = 240;
const MAX_MARKERS = 300;
const RETENTION_MS = 24 * 60 * 60_000;
const EARLIER_OUTCOME_MS = 15 * 60_000;

type TradeRow = {
  event_id: string;
  t: number;
  wallet: string;
  side: "buy" | "sell";
  tok: string;
  q: string;
  qd: number;
  td: number;
  px: string | null;
};

type Trade = TradeRow & { priceRaw: Decimal; tokens: Decimal; sol: Decimal };

function toTrade(r: TradeRow): Trade | null {
  if (!r.tok || !r.q || r.tok === "0") return null;
  const tokRaw = parseDecimal(r.tok);
  const qRaw = parseDecimal(r.q);
  if (!tokRaw.greaterThan(0)) return null;
  return { ...r, priceRaw: qRaw.div(tokRaw), tokens: tokRaw.div(new Decimal(10).pow(r.td)), sol: qRaw.div(new Decimal(10).pow(r.qd)) };
}

const TRADE_SQL = `SELECT event_id, event_time_ms AS t, wallet, side,
    json_extract(payload_json, '$.tokenAmountRaw') AS tok, json_extract(payload_json, '$.quoteAmountRaw') AS q,
    json_extract(payload_json, '$.quoteDecimals') AS qd, json_extract(payload_json, '$.tokenDecimals') AS td,
    json_extract(payload_json, '$.quoteUsdPrice') AS px
  FROM trade_events WHERE namespace = ? AND mint = ? AND event_time_ms >= ? AND valuation_status <> 'unsupported_quote'
  ORDER BY event_time_ms, slot, signature, event_ordinal`;

function pct(price: Decimal, entry: Decimal): number {
  return Number(price.div(entry).minus(1).times(100).toFixed(4));
}

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Volume-weighted average entry price (raw quote units per raw token) of the pack's evidence buys. */
function entryPrice(db: Db, packId: string): Decimal | null {
  const rows = db
    .prepare(
      `SELECT json_extract(te.payload_json, '$.tokenAmountRaw') AS tok, json_extract(te.payload_json, '$.quoteAmountRaw') AS q
       FROM pack_events pe JOIN trade_events te ON te.namespace = pe.namespace AND te.event_id = pe.event_id WHERE pe.pack_id = ?`,
    )
    .all(packId) as { tok: string; q: string }[];
  let tok = new Decimal(0);
  let q = new Decimal(0);
  for (const r of rows) {
    tok = tok.plus(parseDecimal(r.tok));
    q = q.plus(parseDecimal(r.q));
  }
  return tok.greaterThan(0) ? q.div(tok) : null;
}

type PackBasics = { id: string; namespace: string; mint: string; first_event_time_ms: number; trigger_event_time_ms: number };

function tokenLifecycle(db: Db, namespace: string, mint: string) {
  return db
    .prepare("SELECT created_event_time_ms, completed_at_ms, token_total_supply_raw FROM tokens WHERE namespace = ? AND chain = 'solana' AND mint = ?")
    .get(namespace, mint) as { created_event_time_ms: number | null; completed_at_ms: number | null; token_total_supply_raw: string | null } | undefined;
}

/** Compact view for radar cards. */
export function afterSummary(db: Db, pack: PackBasics, memberCount: number): AfterPackSummary {
  const entry = entryPrice(db, pack.id);
  const life = tokenLifecycle(db, pack.namespace, pack.mint);
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(p) AS maxp FROM (
         SELECT CAST(json_extract(payload_json, '$.quoteAmountRaw') AS REAL) / CAST(json_extract(payload_json, '$.tokenAmountRaw') AS REAL) AS p
         FROM trade_events WHERE namespace = ? AND mint = ? AND event_time_ms > ? AND valuation_status <> 'unsupported_quote'
           AND CAST(json_extract(payload_json, '$.tokenAmountRaw') AS REAL) > 0)`,
    )
    .get(pack.namespace, pack.mint, pack.trigger_event_time_ms) as { n: number; maxp: number | null };
  const last = db
    .prepare(
      `SELECT event_time_ms AS t, json_extract(payload_json, '$.tokenAmountRaw') AS tok, json_extract(payload_json, '$.quoteAmountRaw') AS q
       FROM trade_events WHERE namespace = ? AND mint = ? AND event_time_ms >= ? AND valuation_status <> 'unsupported_quote'
       ORDER BY event_time_ms DESC, slot DESC, signature DESC, event_ordinal DESC LIMIT 1`,
    )
    .get(pack.namespace, pack.mint, pack.first_event_time_ms) as { t: number; tok: string; q: string } | undefined;
  const sold = db
    .prepare(
      `SELECT COUNT(DISTINCT te.wallet) AS n FROM trade_events te JOIN pack_members pm ON pm.pack_id = ? AND pm.wallet = te.wallet
       WHERE te.namespace = ? AND te.mint = ? AND te.side = 'sell' AND te.event_time_ms >= pm.first_entry_time_ms`,
    )
    .get(pack.id, pack.namespace, pack.mint) as { n: number };
  let lastChangePct: number | null = null;
  if (entry && last && last.tok !== "0") lastChangePct = pct(parseDecimal(last.q).div(parseDecimal(last.tok)), entry);
  const peakChangePct = entry && agg.maxp !== null ? Number(((agg.maxp / entry.toNumber() - 1) * 100).toFixed(4)) : null;
  return {
    lastChangePct,
    peakChangePct,
    lastTradeAt: iso(last?.t),
    tradesAfter: agg.n,
    membersSold: sold.n,
    memberCount,
    graduatedAt: iso(life?.completed_at_ms ?? null),
  };
}

/** Full view for pack detail. */
export function afterDetail(db: Db, pack: PackBasics, members: { walletAddress: string; memberKind: "initial" | "expanded"; firstEntryTimeMs: number }[], evidenceIds: string[], nowMs: number): AfterPackData {
  const entry = entryPrice(db, pack.id);
  const life = tokenLifecycle(db, pack.namespace, pack.mint);
  const ns = db.prepare("SELECT first_observed_event_ms FROM namespaces WHERE id = ?").get(pack.namespace) as { first_observed_event_ms: number | null } | undefined;
  const trades = (db.prepare(TRADE_SQL).all(pack.namespace, pack.mint, pack.first_event_time_ms - 30_000) as TradeRow[])
    .map(toTrade)
    .filter((t): t is Trade => t !== null);
  const evidence = new Set(evidenceIds);
  const after = trades.filter((t) => t.t > pack.trigger_event_time_ms);
  const last = trades[trades.length - 1] ?? null;

  let peak: AfterPackData["peak"] = null;
  let trough: AfterPackData["trough"] = null;
  if (entry) {
    for (const t of after) {
      const c = pct(t.priceRaw, entry);
      if (!peak || c > peak.changePct) peak = { changePct: c, at: iso(t.t)! };
      if (!trough || c < trough.changePct) trough = { changePct: c, at: iso(t.t)! };
    }
  }

  // Activity since the pack formed.
  let buySol = new Decimal(0);
  let sellSol = new Decimal(0);
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buys = 0;
  let sells = 0;
  for (const t of after) {
    if (t.side === "buy") {
      buys++;
      buyers.add(t.wallet);
      buySol = buySol.plus(t.sol);
    } else {
      sells++;
      sellers.add(t.wallet);
      sellSol = sellSol.plus(t.sol);
    }
  }

  // Pack wallet exits: sells after each member's own first entry, against what they bought since then.
  const byWallet = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = byWallet.get(t.wallet);
    if (list) list.push(t);
    else byWallet.set(t.wallet, [t]);
  }
  const rows: MemberExit[] = members.map((m) => {
    const own = (byWallet.get(m.walletAddress) ?? []).filter((t) => t.t >= m.firstEntryTimeMs);
    let bought = new Decimal(0);
    let sold = new Decimal(0);
    let firstSell: number | null = null;
    for (const t of own) {
      if (t.side === "buy") bought = bought.plus(t.tokens);
      else {
        sold = sold.plus(t.tokens);
        if (firstSell === null) firstSell = t.t;
      }
    }
    const share = bought.greaterThan(0) ? Math.min(1, sold.div(bought).toNumber()) : sold.greaterThan(0) ? 1 : 0;
    return {
      walletAddress: m.walletAddress,
      memberKind: m.memberKind,
      tokensBought: canonical(bought),
      tokensSold: canonical(sold),
      soldShare: Number(share.toFixed(4)),
      firstSellAt: iso(firstSell),
      secondsToFirstSell: firstSell === null ? null : Math.round((firstSell - m.firstEntryTimeMs) / 1000),
      lastActionAt: iso(own.length ? own[own.length - 1]!.t : null),
    };
  });
  const totalBought = rows.reduce((a, r) => a.plus(parseDecimal(r.tokensBought)), new Decimal(0));
  const totalSold = rows.reduce((a, r) => a.plus(parseDecimal(r.tokensSold)), new Decimal(0));
  const firstSells = rows.map((r) => r.firstSellAt).filter((x): x is string => x !== null).sort();

  // Series: last price per time bucket; markers: pack buys and member sells.
  const series: AfterPackPoint[] = [];
  const markers: AfterPackMarker[] = [];
  if (entry && trades.length > 0) {
    const t0 = trades[0]!.t;
    const t1 = Math.max(trades[trades.length - 1]!.t, t0 + 1);
    const bucketMs = Math.max(1, (t1 - t0) / SERIES_BUCKETS);
    let group: AfterPackPoint[] = [];
    const flush = () => {
      if (group.length === 0) return;
      let lo = group[0]!;
      let hi = group[0]!;
      for (const p of group) {
        if (p.changePct < lo.changePct) lo = p;
        if (p.changePct > hi.changePct) hi = p;
      }
      const keep = new Set([lo, hi, group[group.length - 1]!]);
      for (const p of group) if (keep.has(p)) series.push(p);
      group = [];
    };
    let bucket = -1;
    for (const t of trades) {
      const b = Math.floor((t.t - t0) / bucketMs);
      if (b !== bucket) flush();
      bucket = b;
      group.push({ t: t.t, changePct: pct(t.priceRaw, entry) });
    }
    flush();
    const memberFirst = new Map(members.map((m) => [m.walletAddress, m.firstEntryTimeMs]));
    for (const t of trades) {
      if (evidence.has(t.event_id)) markers.push({ t: t.t, changePct: pct(t.priceRaw, entry), kind: "pack_buy", wallet: t.wallet, solAmount: canonical(t.sol) });
    }
    for (const t of trades) {
      if (markers.length >= MAX_MARKERS) break;
      const first = memberFirst.get(t.wallet);
      if (t.side === "sell" && first !== undefined && t.t >= first) markers.push({ t: t.t, changePct: pct(t.priceRaw, entry), kind: "member_sell", wallet: t.wallet, solAmount: canonical(t.sol) });
    }
  }

  // Prices in SOL and, when a valued price is known, in USD.
  const lastPriceSol = last ? last.priceRaw.times(new Decimal(10).pow(last.td - last.qd)) : null;
  const solUsdRow = db
    .prepare("SELECT json_extract(payload_json, '$.quoteUsdPrice') AS px FROM trade_events WHERE namespace = ? AND valuation_status = 'valued' ORDER BY received_at_ms DESC LIMIT 1")
    .get(pack.namespace) as { px: string | null } | undefined;
  const solUsd = last?.px ?? solUsdRow?.px ?? null;
  const lastPriceUsd = lastPriceSol && solUsd ? lastPriceSol.times(parseDecimal(solUsd)) : null;
  const supply = life?.token_total_supply_raw ? parseDecimal(life.token_total_supply_raw).div(new Decimal(10).pow(last?.td ?? 6)) : null;

  const notes: string[] = [];
  if (life?.completed_at_ms) {
    notes.push(`The token completed its pump.fun bonding curve at ${new Date(life.completed_at_ms).toISOString()}. Trades after that happen on other venues and are not observed here.`);
  }
  notes.push("Only SOL-priced trades on the pump.fun bonding curve are observed. Transfers and other venues are not.");
  if (pack.namespace.startsWith("live:") && nowMs - pack.trigger_event_time_ms > RETENTION_MS) notes.push("Trades older than 24 hours are removed from storage, so the early history after this pack may be incomplete.");
  const gaps = db
    .prepare("SELECT COUNT(*) AS n FROM collector_gaps WHERE namespace = ? AND started_at_ms <= ? AND (ended_at_ms IS NULL OR ended_at_ms >= ?)")
    .get(pack.namespace, nowMs, pack.trigger_event_time_ms) as { n: number };
  if (gaps.n > 0) notes.push("The collector was disconnected for part of this period, so some trades are missing.");

  return {
    asOf: new Date(nowMs).toISOString(),
    entryPriceSol: entry && last ? canonical(new Decimal(entry.times(new Decimal(10).pow(last.td - last.qd)).toPrecision(12))) : null,
    lastPriceSol: lastPriceSol ? canonical(new Decimal(lastPriceSol.toPrecision(12))) : null,
    lastPriceUsd: lastPriceUsd ? canonical(new Decimal(lastPriceUsd.toPrecision(12))) : null,
    lastTradeAt: iso(last?.t),
    lastChangePct: entry && last ? pct(last.priceRaw, entry) : null,
    peak,
    trough,
    marketCapUsd: lastPriceUsd && supply ? canonical(new Decimal(lastPriceUsd.times(supply).toFixed(2))) : null,
    activity: {
      buys,
      sells,
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      buySol: canonical(new Decimal(buySol.toFixed(9))),
      sellSol: canonical(new Decimal(sellSol.toFixed(9))),
      netSol: canonical(new Decimal(buySol.minus(sellSol).toFixed(9))),
    },
    members: {
      count: members.length,
      sold: rows.filter((r) => parseDecimal(r.tokensSold).greaterThan(0)).length,
      exited: rows.filter((r) => r.soldShare >= 0.99).length,
      soldShare: totalBought.greaterThan(0) ? Number(Math.min(1, totalSold.div(totalBought).toNumber()).toFixed(4)) : null,
      firstSellAt: firstSells[0] ?? null,
      rows,
    },
    series,
    markers,
    tokenCreatedAt: iso(life?.created_event_time_ms ?? null),
    graduatedAt: iso(life?.completed_at_ms ?? null),
    observedSince: iso(ns?.first_observed_event_ms ?? null),
    notes,
  };
}

/** Earlier packs sharing at least two of these wallets, with how their token moved in the next 15 minutes. */
export function earlierPacks(db: Db, pack: PackBasics, wallets: string[]): EarlierPack[] {
  if (wallets.length < 2) return [];
  const placeholders = wallets.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT p.id, p.mint, p.trigger_event_time_ms, p.first_event_time_ms, p.total_wallet_count, p.eligible_buy_usd, COUNT(*) AS shared
       FROM pack_members pm JOIN packs p ON p.id = pm.pack_id AND p.namespace = pm.namespace
       WHERE pm.namespace = ? AND pm.wallet IN (${placeholders}) AND p.id <> ? AND p.trigger_event_time_ms < ? AND p.invalidated = 0
       GROUP BY p.id HAVING COUNT(*) >= 2 ORDER BY p.trigger_event_time_ms DESC LIMIT 10`,
    )
    .all(pack.namespace, ...wallets, pack.id, pack.trigger_event_time_ms) as {
    id: string; mint: string; trigger_event_time_ms: number; first_event_time_ms: number; total_wallet_count: number; eligible_buy_usd: string; shared: number;
  }[];
  return rows.map((r) => {
    const entry = entryPrice(db, r.id);
    const trades = (db.prepare(TRADE_SQL).all(pack.namespace, r.mint, r.trigger_event_time_ms + 1) as TradeRow[])
      .filter((t) => t.t <= r.trigger_event_time_ms + EARLIER_OUTCOME_MS)
      .map(toTrade)
      .filter((t): t is Trade => t !== null);
    let peakPct: number | null = null;
    let lastPct: number | null = null;
    if (entry && trades.length > 0) {
      for (const t of trades) {
        const c = pct(t.priceRaw, entry);
        if (peakPct === null || c > peakPct) peakPct = c;
      }
      lastPct = pct(trades[trades.length - 1]!.priceRaw, entry);
    }
    const tok = db.prepare("SELECT name, symbol FROM tokens WHERE namespace = ? AND mint = ?").get(pack.namespace, r.mint) as { name: string | null; symbol: string | null } | undefined;
    return {
      packId: r.id,
      tokenAddress: r.mint,
      tokenName: tok?.name ?? null,
      tokenSymbol: tok?.symbol ?? null,
      triggerEventTimeMs: r.trigger_event_time_ms,
      sharedWallets: r.shared,
      totalWalletCount: r.total_wallet_count,
      eligibleBuyUsd: r.eligible_buy_usd,
      peakChangePct15m: peakPct,
      changePct15m: lastPct,
    };
  });
}
