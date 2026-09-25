/**
 * Generates the synthetic fixture dataset and its manifest.
 *
 * Everything here is synthetic: addresses and signatures are derived from
 * hashes of labels, prices are invented, and provider-shaped context is
 * illustrative. None of it is a real market observation or transaction.
 *
 * Usage: npx tsx apps/server/src/scripts/generate-fixtures.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58Encode } from "../lib/base58.js";
import { ROOT_DIR, WSOL_MINT, BASELINE_CONFIG_VERSION } from "../config.js";
import { DECODER_VERSION } from "../collector/decoder.js";
import { sha256Hex } from "../lib/ids.js";

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const MIN = 60_000;
const DATASET_ID = "synthetic-demo-v1";

const addr = (label: string) => base58Encode(createHash("sha256").update(`packlens-fixture:${label}`).digest());
const sig = (label: string) => base58Encode(createHash("sha512").update(`packlens-fixture-sig:${label}`).digest());

const wallets: Record<string, string> = {};
for (let i = 1; i <= 30; i++) wallets[`W${i}`] = addr(`wallet-${i}`);
const W = (n: number) => wallets[`W${n}`]!;
const SM = (n: number) => addr(`smart-money-wallet-${n}`);

const tokens = {
  LMOTH: { mint: addr("token-lantern-moth"), name: "Lantern Moth", symbol: "LMOTH" },
  HARBR: { mint: addr("token-quiet-harbor"), name: "Quiet Harbor", symbol: "HARBR" },
  FINCH: { mint: addr("token-copper-finch"), name: "Copper Finch", symbol: "FINCH" },
  SALTM: { mint: addr("token-salt-meridian"), name: "Salt Meridian", symbol: "SALTM" },
  KITE: { mint: addr("token-paper-kite"), name: "Paper Kite", symbol: "KITE" },
  NOISE1: { mint: addr("token-noise-one"), name: "Gravel Choir", symbol: "GRVL" },
  NOISE2: { mint: addr("token-noise-two"), name: "Tin Orchard", symbol: "TINO" },
};

/* ------------------------------------------------------------------ */
/* Price snapshots: every 30 s, with an outage from +13:40 to +18:00. */
/* ------------------------------------------------------------------ */

const closeFor = (minuteStartMs: number) => {
  const m = Math.floor(minuteStartMs / MIN) % 4;
  return ["200", "200.5", "201", "200.25"][m]!;
};

const priceSnapshots: { id: string; quoteMint: string; availableAtMs: number; requestedFromMs: number; requestedToMs: number; candles: { intervalStartMs: number; close: string }[] }[] = [];
for (let t = T0 - 15 * MIN + 5000; t <= T0 + 31 * MIN; t += 30_000) {
  if (t > T0 + 13 * MIN + 40_000 && t < T0 + 18 * MIN) continue; // simulated Nansen outage
  const to = Math.floor(t / MIN) * MIN;
  const from = to - 10 * MIN;
  const candles = [];
  for (let s = from; s < to; s += MIN) candles.push({ intervalStartMs: s, close: closeFor(s) });
  priceSnapshots.push({ id: `p${priceSnapshots.length + 1}`, quoteMint: WSOL_MINT, availableAtMs: t, requestedFromMs: from, requestedToMs: to, candles });
}

/* ------------------------------------------------------------------ */
/* Trade events                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Invented price paths: price multiple of the launch price over time.   */
/* ------------------------------------------------------------------ */

const TOKENS_PER_SOL_RAW = 35_000_000_000_000; // at the launch price, 6 decimals
const PATHS: Record<string, [number, number][]> = {
  [tokens.LMOTH.mint]: [[0, 1], [100, 1], [141, 1.3], [200, 1.55], [330, 1.9], [420, 1.5], [600, 1.15], [900, 0.95], [1200, 0.88], [1500, 0.8], [1800, 0.86]],
  [tokens.HARBR.mint]: [[0, 1], [300, 1], [318, 1.12], [420, 1.6], [560, 2.3], [700, 3.1], [720, 3.2]],
  [tokens.FINCH.mint]: [[0, 1], [400, 1], [407, 1.15], [470, 1.02], [600, 0.83], [800, 0.74]],
  [tokens.SALTM.mint]: [[0, 1], [500, 1], [511, 1.1], [633, 1.25], [760, 1.18]],
};
function mult(mint: string, tSec: number): number {
  const k = PATHS[mint];
  if (!k) return 1;
  if (tSec <= k[0]![0]) return k[0]![1];
  for (let i = 1; i < k.length; i++) {
    const [t1, v1] = k[i]!;
    const [t0, v0] = k[i - 1]!;
    if (tSec <= t1) return v0 + ((v1 - v0) * (tSec - t0)) / (t1 - t0);
  }
  return k[k.length - 1]![1];
}
const holdings = new Map<string, number>();

type Ev = {
  signature: string; ordinal: number; slot: number; blockTimeMs: number; receivedAtMs: number; wallet: string; mint: string;
  side: "buy" | "sell"; tokenAmountRaw: string; quoteAmountRaw: string; quoteMint: string; quoteDecimals: number;
};
const events: Ev[] = [];
const slot = 400_000_000;
const lamports = (sol: number) => String(Math.round(sol * 1e9));
function ev(label: string, tSec: number, wallet: string, mint: string, side: "buy" | "sell", sol: number, opts: { delayMs?: number; tokensRaw?: number } = {}) {
  const blockTimeMs = T0 + Math.round(tSec * 1000);
  const tokensRaw = opts.tokensRaw ?? Math.round((sol * TOKENS_PER_SOL_RAW) / mult(mint, tSec));
  const key = `${wallet}|${mint}`;
  holdings.set(key, Math.max(0, (holdings.get(key) ?? 0) + (side === "buy" ? tokensRaw : -tokensRaw)));
  const jitter = 1100 + (Number.parseInt(sha256Hex(label).slice(0, 4), 16) % 700);
  events.push({
    signature: sig(label),
    ordinal: 0,
    slot: slot + Math.floor(tSec * 2.5),
    blockTimeMs,
    receivedAtMs: blockTimeMs + (opts.delayMs ?? jitter),
    wallet,
    mint,
    side,
    tokenAmountRaw: String(tokensRaw),
    quoteAmountRaw: lamports(sol),
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
  });
}

/** Sells a share of the wallet's observed holding at the path price. */
function sellShare(label: string, tSec: number, wallet: string, mint: string, share: number) {
  const tokensRaw = Math.round((holdings.get(`${wallet}|${mint}`) ?? 0) * share);
  ev(label, tSec, wallet, mint, "sell", (tokensRaw * mult(mint, tSec)) / TOKENS_PER_SOL_RAW, { tokensRaw });
}
const trader = (n: number) => addr(`trader-wallet-${n}`);
/**
 * Market activity after a pack: alternating buys and sells by outside
 * wallets. Eligible buys (at least 0.1 SOL, about $20) are 11 s or more
 * apart, so no 20 s window can hold three of them and no new pack forms.
 */
function market(prefix: string, mint: string, fromSec: number, toSec: number, stepSec: number, seed: number) {
  let n = 0;
  for (let t = fromSec; t <= toSec; t += stepSec, n++) {
    const h = Number.parseInt(sha256Hex(`${prefix}-${n}`).slice(0, 6), 16);
    const w = trader(seed + (n % 23));
    const rising = mult(mint, t + stepSec) >= mult(mint, t);
    const isBuy = rising ? h % 4 !== 0 : h % 3 === 0;
    const sol = isBuy ? 0.04 + (h % 60) / 100 : 0.05 + (h % 45) / 100;
    if (isBuy) ev(`${prefix}-b${n}`, t, w, mint, "buy", sol);
    else if ((holdings.get(`${w}|${mint}`) ?? 0) > 0) sellShare(`${prefix}-s${n}`, t, w, mint, 0.5 + (h % 50) / 100);
    else ev(`${prefix}-s${n}`, t, w, mint, "sell", sol);
  }
}

// Lantern Moth: trigger at +106 s with W1-W3, expansion adds W4, W5, W6 and a second W2 buy; W7 arrives after 40 s.
ev("lm-w1", 100, W(1), tokens.LMOTH.mint, "buy", 0.35);
ev("lm-w2", 103, W(2), tokens.LMOTH.mint, "buy", 0.52);
ev("lm-w3", 106, W(3), tokens.LMOTH.mint, "buy", 0.21);
ev("lm-w8-small", 108, W(8), tokens.LMOTH.mint, "buy", 0.07); // below $20
ev("lm-w4", 110, W(4), tokens.LMOTH.mint, "buy", 0.8);
ev("lm-w5", 114, W(5), tokens.LMOTH.mint, "buy", 0.15);
ev("lm-w2-again", 120, W(2), tokens.LMOTH.mint, "buy", 0.3);
ev("lm-w1-sell", 125, W(1), tokens.LMOTH.mint, "sell", 0.1);
ev("lm-w6", 131, W(6), tokens.LMOTH.mint, "buy", 0.44);
ev("lm-w7-late-window", 141, W(7), tokens.LMOTH.mint, "buy", 0.6);

// Lantern Moth after the pack: the price peaks near +330 s, four of six
// pack wallets sell (W4 all, W2 in two steps, W6 all, W1 the rest), then it fades.
market("lm-mkt", tokens.LMOTH.mint, 152, 1790, 26, 0);
sellShare("lm-w4-exit", 262, W(4), tokens.LMOTH.mint, 1);
sellShare("lm-w2-part", 301, W(2), tokens.LMOTH.mint, 0.6);
sellShare("lm-w6-exit", 347, W(6), tokens.LMOTH.mint, 1);
sellShare("lm-w1-rest", 705, W(1), tokens.LMOTH.mint, 1);
sellShare("lm-w2-rest", 1297, W(2), tokens.LMOTH.mint, 1);

// Quiet Harbor: three wallets across 18 s; the price climbs and the token
// completes its bonding curve at +720 s (graduation).
ev("qh-w9", 300, W(9), tokens.HARBR.mint, "buy", 0.18);
ev("qh-w10", 309, W(10), tokens.HARBR.mint, "buy", 0.25);
ev("qh-w11", 318, W(11), tokens.HARBR.mint, "buy", 0.12);
market("qh-mkt", tokens.HARBR.mint, 346, 714, 12, 40);
sellShare("qh-w9-exit", 655, W(9), tokens.HARBR.mint, 1);

// Copper Finch: four wallets; W16 arrives after the reorder tolerance and is late.
ev("cf-w12", 400, W(12), tokens.FINCH.mint, "buy", 0.2);
ev("cf-w13", 401, W(13), tokens.FINCH.mint, "buy", 0.2);
ev("cf-w14", 405, W(14), tokens.FINCH.mint, "buy", 0.31);
ev("cf-w16-late", 406, W(16), tokens.FINCH.mint, "buy", 0.4, { delayMs: 3400 });
ev("cf-w15", 407, W(15), tokens.FINCH.mint, "buy", 0.22);
market("cf-mkt", tokens.FINCH.mint, 452, 800, 29, 70);
sellShare("cf-w12-exit", 471, W(12), tokens.FINCH.mint, 1);

// Salt Meridian: pack 1 (W1, W3 co-occur with Lantern Moth), buys during cooldown, then pack 2.
ev("sm-w1", 500, W(1), tokens.SALTM.mint, "buy", 0.4);
ev("sm-w3", 504, W(3), tokens.SALTM.mint, "buy", 0.26);
ev("sm-w17", 511, W(17), tokens.SALTM.mint, "buy", 0.33);
ev("sm-w18-cooldown", 600, W(18), tokens.SALTM.mint, "buy", 0.2);
ev("sm-w19-cooldown", 606, W(19), tokens.SALTM.mint, "buy", 0.2);
ev("sm-w20-cooldown", 612, W(20), tokens.SALTM.mint, "buy", 0.2);
ev("sm-w22", 625, W(22), tokens.SALTM.mint, "buy", 0.5);
ev("sm-w23", 628, W(23), tokens.SALTM.mint, "buy", 0.19);
ev("sm-w24", 633, W(24), tokens.SALTM.mint, "buy", 0.27);
market("sm-mkt", tokens.SALTM.mint, 690, 760, 14, 100);

// Paper Kite: buys during the price outage stay unvalued; no pack forms.
ev("pk-w25", 910, W(25), tokens.KITE.mint, "buy", 0.5);
ev("pk-w26", 914, W(26), tokens.KITE.mint, "buy", 0.5);
ev("pk-w27", 918, W(27), tokens.KITE.mint, "buy", 0.5);
ev("pk-w28", 925, W(28), tokens.KITE.mint, "buy", 0.5);

// Background activity: sells and small buys on other tokens.
for (let i = 0; i < 24; i++) {
  const mint = i % 2 === 0 ? tokens.NOISE1.mint : tokens.NOISE2.mint;
  const side = i % 3 === 0 ? "sell" : "buy";
  const sol = side === "buy" ? (i % 4 === 0 ? 0.3 : 0.05) : 0.2;
  ev(`noise-${i}`, 60 + i * 37, W(29 + (i % 2)), mint, side, sol);
}

/* ------------------------------------------------------------------ */
/* Fixture context: provider-shaped, synthetic                          */
/* ------------------------------------------------------------------ */

const sigOf = (label: string) => sig(label);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fetchedAt = T0 + 30 * MIN;

type Snap = {
  key: string; endpoint: string; subjectType: "token" | "wallet" | "global"; subjectId: string; params: Record<string, unknown>; fetchedAtMs: number;
  availability: "available" | "empty" | "unavailable" | "error" | "budget_paused"; coverage: "window_scanned" | "partial" | "unknown";
  reasonCode?: string | null; page?: number | null; isLastPage?: boolean | null; periodStartMs?: number | null; periodEndMs?: number | null; result: unknown;
};
const snapshots: Snap[] = [];
const snap = (s: Snap) => (snapshots.push(s), s.key);

function tokenInfo(key: string, t: { mint: string; name: string; symbol: string }, mcap: string, holders: number) {
  return snap({
    key, endpoint: "tgm/token-information", subjectType: "token", subjectId: t.mint, params: { chain: "solana", token_address: t.mint, timeframe: "1h" },
    fetchedAtMs: fetchedAt, availability: "available", coverage: "unknown",
    result: {
      name: t.name, symbol: t.symbol, logo: null, deploymentDate: iso(T0 + 90_000), website: null, x: null, telegram: null,
      marketCapUsd: mcap, fdvUsd: mcap, circulatingSupply: "1000000000", totalSupply: "1000000000", timeframe: "1h",
      spot: { volumeTotalUsd: "48210.4", buyVolumeUsd: "30112.9", sellVolumeUsd: "18097.5", totalBuys: 412, totalSells: 233, uniqueBuyers: 188, uniqueSellers: 97, liquidityUsd: "12840.2", totalHolders: holders },
    },
  });
}

function pnl(key: string, wallet: string, pnlUsd: string, win: string, trades: number) {
  const to = Math.floor(fetchedAt / HOUR) * HOUR;
  return snap({
    key, endpoint: "profiler/address/pnl-summary", subjectType: "wallet", subjectId: wallet,
    params: { chain: "solana", wallet_address: wallet, date: { from: iso(to - 30 * DAY), to: iso(to) } }, fetchedAtMs: fetchedAt, availability: "available", coverage: "unknown",
    periodStartMs: to - 30 * DAY, periodEndMs: to,
    result: {
      periodStart: iso(to - 30 * DAY), periodEnd: iso(to), realizedPnlUsd: pnlUsd, realizedPnlPercent: "0.182", winRate: win, tradedTimes: trades, tradedTokenCount: Math.max(1, Math.round(trades / 3)),
      top5Tokens: [{ tokenAddress: tokens.NOISE1.mint, tokenSymbol: "GRVL", realizedPnl: "412.5", realizedRoi: "1.4" }],
    },
  });
}

function dex(key: string, wallet: string, mintBought: string, symbol: string, n: number) {
  const to = Math.floor(fetchedAt / (5 * MIN)) * (5 * MIN);
  const trades = Array.from({ length: n }, (_, i) => ({
    transactionHash: sig(`dex-${wallet}-${i}`), blockTimestamp: new Date(T0 - i * 3 * HOUR).toISOString(),
    tokenBoughtAddress: i === 0 ? mintBought : tokens.NOISE1.mint, tokenBoughtSymbol: i === 0 ? symbol : "GRVL",
    tokenSoldAddress: WSOL_MINT, tokenSoldSymbol: "SOL", tokenBoughtAmount: "1250000", tokenSoldAmount: "0.4", tradeValueUsd: "80.2",
  }));
  return snap({
    key, endpoint: "profiler/dex-trades", subjectType: "wallet", subjectId: wallet,
    params: { chain: "solana", address: wallet, date: { from: iso(to - 7 * DAY), to: iso(to) }, pagination: { page: 1, per_page: 100 } },
    fetchedAtMs: fetchedAt, availability: "available", coverage: "window_scanned", page: 1, isLastPage: true, periodStartMs: to - 7 * DAY, periodEndMs: to,
    result: { periodStart: iso(to - 7 * DAY), periodEnd: iso(to), trades, sampleSize: n, page: 1, isLastPage: true },
  });
}

function related(key: string, wallet: string, rows: { address: string; label: string | null; relation: string }[]) {
  return snap({
    key, endpoint: "profiler/address/related-wallets", subjectType: "wallet", subjectId: wallet,
    params: { chain: "solana", wallet_address: wallet, pagination: { page: 1, per_page: 100 } }, fetchedAtMs: fetchedAt,
    availability: rows.length ? "available" : "empty", coverage: "window_scanned", page: 1, isLastPage: true,
    result: { related: rows.map((r, i) => ({ ...r, transactionHash: sig(`rel-${wallet}-${i}`), blockTimestamp: new Date(T0 - (i + 1) * DAY).toISOString(), order: i + 1 })), page: 1, isLastPage: true },
  });
}

function balance(key: string, wallet: string, mint: string, amount: string | null, value: string | null) {
  return snap({
    key, endpoint: "profiler/address/current-balance", subjectType: "wallet", subjectId: wallet,
    params: { chain: "solana", address: wallet, hide_spam_token: false, filters: { token_address: mint }, pagination: { page: 1, per_page: 100 } },
    fetchedAtMs: T0 + 111_000 + 5 * MIN, availability: amount ? "available" : "empty", coverage: "window_scanned", page: 1, isLastPage: true,
    result: {
      balances: amount ? [{ tokenAddress: mint, tokenSymbol: "LMOTH", tokenAmount: amount, priceUsd: "0.0000191", valueUsd: value }] : [],
      packToken: { tokenAddress: mint, tokenAmount: amount, valueUsd: value, observedOnFetchedPages: amount !== null }, page: 1, isLastPage: true,
    },
  });
}

// Lantern Moth: complete analysis with a direct relationship between members.
const lm = tokens.LMOTH;
tokenInfo("lm-info", lm, "19120.44", 211);
snap({
  key: "lm-holders", endpoint: "tgm/holders", subjectType: "token", subjectId: lm.mint,
  params: { chain: "solana", token_address: lm.mint, premium_labels: false, aggregate_by_entity: false, label_type: "all_holders", pagination: { page: 1, per_page: 20 }, order_by: [{ field: "token_amount", direction: "DESC" }] },
  fetchedAtMs: fetchedAt, availability: "available", coverage: "partial", page: 1, isLastPage: false,
  result: {
    holders: [
      { address: addr("lm-bonding-curve"), label: "pump.fun bonding curve", tokenAmount: "612000000", ownershipPercentage: "61.2", valueUsd: "11700.1", balanceChange24h: "-38000000" },
      { address: W(4), label: null, tokenAmount: "27900000", ownershipPercentage: "2.79", valueUsd: "533.2", balanceChange24h: "27900000" },
      { address: W(2), label: null, tokenAmount: "25100000", ownershipPercentage: "2.51", valueUsd: "479.7", balanceChange24h: "25100000" },
      ...Array.from({ length: 17 }, (_, i) => ({ address: addr(`lm-holder-${i}`), label: null, tokenAmount: String(20_000_000 - i * 900_000), ownershipPercentage: ((20 - i * 0.9) / 10).toFixed(2), valueUsd: String(380 - i * 17), balanceChange24h: null })),
    ],
    page: 1, perPage: 20, isLastPage: false, warnings: [], observedHolderCount: 20,
  },
});
const lmProfile = [W(1), W(2), W(3)];
pnl("lm-pnl-1", W(1), "2210.4", "0.61", 94);
pnl("lm-pnl-2", W(2), "-310.9", "0.38", 41);
pnl("lm-pnl-3", W(3), "95.2", "0.52", 18);
dex("lm-dex-1", W(1), lm.mint, "LMOTH", 12);
dex("lm-dex-2", W(2), lm.mint, "LMOTH", 7);
dex("lm-dex-3", W(3), lm.mint, "LMOTH", 3);
related("lm-rel-1", W(1), [
  { address: W(3), label: null, relation: "First Funder" },
  { address: addr("exchange-hot-wallet"), label: "Exchange hot wallet", relation: "Received from" },
]);
related("lm-rel-2", W(2), []);
balance("lm-bal-1", W(1), lm.mint, "9800000", "187.2");
balance("lm-bal-2", W(2), lm.mint, null, null);

// Quiet Harbor: partial analysis (empty holders, one PnL error, one budget pause).
const qh = tokens.HARBR;
tokenInfo("qh-info", qh, "6210.9", 64);
snap({
  key: "qh-holders", endpoint: "tgm/holders", subjectType: "token", subjectId: qh.mint,
  params: { chain: "solana", token_address: qh.mint, premium_labels: false, aggregate_by_entity: false, label_type: "all_holders", pagination: { page: 1, per_page: 20 }, order_by: [{ field: "token_amount", direction: "DESC" }] },
  fetchedAtMs: fetchedAt, availability: "empty", coverage: "window_scanned", page: 1, isLastPage: true,
  result: { holders: [], page: 1, perPage: 20, isLastPage: true, warnings: ["Token has no USD price data; the default value_usd filter may exclude holders."], observedHolderCount: 0 },
});
pnl("qh-pnl-9", W(9), "12.7", "0.5", 4);
snap({ key: "qh-pnl-10", endpoint: "profiler/address/pnl-summary", subjectType: "wallet", subjectId: W(10), params: { chain: "solana", wallet_address: W(10) }, fetchedAtMs: fetchedAt, availability: "error", coverage: "unknown", reasonCode: "schema_error", result: null });
pnl("qh-pnl-11", W(11), "0", "0", 0);
dex("qh-dex-9", W(9), qh.mint, "HARBR", 2);
dex("qh-dex-10", W(10), qh.mint, "HARBR", 1);
dex("qh-dex-11", W(11), qh.mint, "HARBR", 1);
related("qh-rel-9", W(9), []);
related("qh-rel-10", W(10), [{ address: addr("unrelated-wallet"), label: null, relation: "Sent to" }]);

// Salt Meridian pack 1: token not indexed by the provider.
const sm = tokens.SALTM;
snap({ key: "sm-info", endpoint: "tgm/token-information", subjectType: "token", subjectId: sm.mint, params: { chain: "solana", token_address: sm.mint, timeframe: "1h" }, fetchedAtMs: fetchedAt, availability: "unavailable", coverage: "unknown", reasonCode: "not_found", result: null });
snap({ key: "sm-netflow", endpoint: "smart-money/netflow", subjectType: "token", subjectId: sm.mint, params: { chains: ["solana"], filters: { token_address: sm.mint } }, fetchedAtMs: fetchedAt, availability: "error", coverage: "unknown", reasonCode: "http_error", result: null });

// Netflow: Lantern Moth available; Quiet Harbor observed without a provider row.
snap({
  key: "lm-netflow", endpoint: "smart-money/netflow", subjectType: "token", subjectId: lm.mint, params: { chains: ["solana"], filters: { token_address: lm.mint }, pagination: { page: 1, per_page: 100 } },
  fetchedAtMs: fetchedAt, availability: "available", coverage: "window_scanned", page: 1, isLastPage: true,
  result: { asOf: null, values: [{ window: "1h", netFlowUsd: "4210.55" }, { window: "24h", netFlowUsd: "9880.1" }, { window: "7d", netFlowUsd: "9880.1" }, { window: "30d", netFlowUsd: "9880.1" }], traderCount30d: 14, tokenSymbol: "LMOTH", rowFound: true },
});
snap({
  key: "qh-netflow", endpoint: "smart-money/netflow", subjectType: "token", subjectId: qh.mint, params: { chains: ["solana"], filters: { token_address: qh.mint }, pagination: { page: 1, per_page: 100 } },
  fetchedAtMs: fetchedAt, availability: "empty", coverage: "window_scanned", page: 1, isLastPage: true,
  result: { asOf: null, values: [{ window: "1h", netFlowUsd: null }, { window: "24h", netFlowUsd: null }, { window: "7d", netFlowUsd: null }, { window: "30d", netFlowUsd: null }], traderCount30d: null, tokenSymbol: null, rowFound: false },
});

// Smart Money trades: Lantern Moth has 12 unique buyers in 1 hour; 2 match pack evidence.
type SmTradeFx = {
  chain: "solana"; transactionHash: string; blockTimeMs: number; traderAddress: string; traderLabel: string | null; tokenBoughtAddress: string; tokenSoldAddress: string;
  tokenBoughtSymbol: string | null; tokenSoldSymbol: string | null; tokenBoughtAmount: string | null; tokenSoldAmount: string | null; tradeValueUsd: string | null; scope: "global" | "token";
};
const smTrades: SmTradeFx[] = [];
const buy = (hash: string, t: number, trader: string, label: string | null, mint: string, symbol: string, usd: string | null, scope: "global" | "token") =>
  smTrades.push({ chain: "solana", transactionHash: hash, blockTimeMs: t, traderAddress: trader, traderLabel: label, tokenBoughtAddress: mint, tokenSoldAddress: WSOL_MINT, tokenBoughtSymbol: symbol, tokenSoldSymbol: "SOL", tokenBoughtAmount: "1400000", tokenSoldAmount: "0.3", tradeValueUsd: usd, scope });
const sell = (hash: string, t: number, trader: string, label: string | null, mint: string, symbol: string, usd: string, scope: "global" | "token") =>
  smTrades.push({ chain: "solana", transactionHash: hash, blockTimeMs: t, traderAddress: trader, traderLabel: label, tokenBoughtAddress: WSOL_MINT, tokenSoldAddress: mint, tokenBoughtSymbol: "SOL", tokenSoldSymbol: symbol, tokenBoughtAmount: "0.5", tokenSoldAmount: "2100000", tradeValueUsd: usd, scope });

// Pack members W2 and W5 bought in pack transactions that also appear in the Smart Money feed.
buy(sigOf("lm-w2"), T0 + 103_000, W(2), "Smart Trader", lm.mint, "LMOTH", "104.26", "token");
buy(sigOf("lm-w5"), T0 + 114_000, W(5), "30D Smart Trader", lm.mint, "LMOTH", "30.08", "token");
const lmBuyTimes = [150, 240, 380, 610, 890, 1120, 1405, 1530, 1650, 1745];
lmBuyTimes.forEach((s, i) => buy(sig(`sm-lm-${i}`), T0 + s * 1000, SM(i + 1), i % 3 === 0 ? "Fund" : "Smart Trader", lm.mint, "LMOTH", i === 4 ? null : String(40 + i * 11.5), "token"));
buy(sig("sm-lm-repeat-a"), T0 + 1700_000, SM(1), "Fund", lm.mint, "LMOTH", "22.5", "token"); // repeat buyer
buy(sig("sm-lm-small"), T0 + 1760_000, SM(3), "Smart Trader", lm.mint, "LMOTH", "6.4", "token"); // below $20 still counts
sell(sig("sm-lm-sell-only"), T0 + 1720_000, SM(20), "Smart Trader", lm.mint, "LMOTH", "55.2", "global"); // seller only
sell(sig("sm-lm-sell-after-buy"), T0 + 1780_000, SM(2), "Smart Trader", lm.mint, "LMOTH", "61.2", "global"); // buyer later sells
// W4 is a Smart Money wallet on another token only: wallet_seen, not a pack confirmation.
buy(sig("sm-w4-other"), T0 + 800_000, W(4), "Smart Trader", tokens.NOISE1.mint, "GRVL", "88.1", "global");
// Salt Meridian: global feed only (partial coverage).
buy(sig("sm-salt-1"), T0 + 1500_000, SM(21), "Smart Trader", sm.mint, "SALTM", "51.0", "global");
buy(sig("sm-salt-2"), T0 + 1600_000, SM(22), "Fund", sm.mint, "SALTM", "140.0", "global");
// Other global feed activity.
for (let i = 0; i < 14; i++) {
  const t = T0 + (1200 + i * 41) * 1000;
  if (i % 3 === 0) sell(sig(`sm-g-${i}`), t, SM(30 + i), i % 2 ? "Fund" : "Smart Trader", tokens.NOISE2.mint, "TINO", String(120 + i * 7), "global");
  else buy(sig(`sm-g-${i}`), t, SM(30 + i), i % 2 ? "Fund" : "Smart Trader", tokens.NOISE1.mint, "GRVL", String(75 + i * 9), "global");
}

snap({
  key: "lm-sm-dex", endpoint: "smart-money/dex-trades", subjectType: "token", subjectId: lm.mint,
  params: { chains: ["solana"], filters: { token_bought_address: lm.mint }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] },
  fetchedAtMs: fetchedAt, availability: "available", coverage: "window_scanned", page: 1, isLastPage: true, result: null,
});
snap({
  key: "qh-sm-dex", endpoint: "smart-money/dex-trades", subjectType: "token", subjectId: qh.mint,
  params: { chains: ["solana"], filters: { token_bought_address: qh.mint }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] },
  fetchedAtMs: T0 + 400_000, availability: "empty", coverage: "window_scanned", page: 1, isLastPage: true, result: null,
});
snap({
  key: "global-sm-dex", endpoint: "smart-money/dex-trades", subjectType: "global", subjectId: "global",
  params: { chains: ["solana"], pagination: { page: 1, per_page: 100 }, order_by: [{ field: "block_timestamp", direction: "DESC" }] },
  fetchedAtMs: fetchedAt, availability: "available", coverage: "partial", page: 1, isLastPage: false, result: null,
});

const job = (mint: string, packIndex: number, type: string, subject: string, status: "succeeded" | "failed" | "cancelled" | "budget_paused", snapshotKey: string | null, reason: string | null = null) => ({ mint, packIndex, type, subject, status, snapshotKey, reason });
const jobs = [
  job(lm.mint, 0, "token_info", lm.mint, "succeeded", "lm-info"),
  job(lm.mint, 0, "holders", lm.mint, "succeeded", "lm-holders"),
  ...lmProfile.flatMap((w, i) => [job(lm.mint, 0, "wallet_pnl", w, "succeeded", `lm-pnl-${i + 1}`), job(lm.mint, 0, "wallet_dex", w, "succeeded", `lm-dex-${i + 1}`)]),
  job(lm.mint, 0, "related_wallets", W(1), "succeeded", "lm-rel-1"),
  job(lm.mint, 0, "related_wallets", W(2), "succeeded", "lm-rel-2"),
  job(lm.mint, 0, "balance_followup", W(1), "succeeded", "lm-bal-1"),
  job(lm.mint, 0, "balance_followup", W(2), "succeeded", "lm-bal-2"),
  job(qh.mint, 0, "token_info", qh.mint, "succeeded", "qh-info"),
  job(qh.mint, 0, "holders", qh.mint, "succeeded", "qh-holders"),
  job(qh.mint, 0, "wallet_pnl", W(9), "succeeded", "qh-pnl-9"),
  job(qh.mint, 0, "wallet_pnl", W(10), "failed", "qh-pnl-10", "schema_error"),
  job(qh.mint, 0, "wallet_pnl", W(11), "succeeded", "qh-pnl-11"),
  job(qh.mint, 0, "wallet_dex", W(9), "succeeded", "qh-dex-9"),
  job(qh.mint, 0, "wallet_dex", W(10), "succeeded", "qh-dex-10"),
  job(qh.mint, 0, "wallet_dex", W(11), "succeeded", "qh-dex-11"),
  job(qh.mint, 0, "related_wallets", W(9), "succeeded", "qh-rel-9"),
  job(qh.mint, 0, "related_wallets", W(10), "succeeded", "qh-rel-10"),
  job(qh.mint, 0, "balance_followup", W(9), "budget_paused", null, "budget_paused"),
  job(qh.mint, 0, "balance_followup", W(10), "budget_paused", null, "budget_paused"),
  job(sm.mint, 0, "token_info", sm.mint, "succeeded", "sm-info", "unavailable"),
];

const context = {
  snapshots,
  smartMoney: {
    trades: smTrades,
    scans: [
      { mint: lm.mint, asOfMs: fetchedAt, coverage: { "5m": "window_scanned", "1h": "window_scanned", "24h": "partial" } },
      { mint: qh.mint, asOfMs: T0 + 400_000, coverage: { "5m": "window_scanned", "1h": "window_scanned", "24h": "window_scanned" } },
      { mint: sm.mint, asOfMs: fetchedAt, coverage: { "5m": "partial", "1h": "partial", "24h": "partial" } },
    ],
  },
  enrichedPacks: [
    { mint: lm.mint, packIndex: 0 },
    { mint: qh.mint, packIndex: 0 },
    { mint: sm.mint, packIndex: 0 },
  ],
  demoPins: [lm.mint],
  jobs,
};

const CREATED: Record<string, number> = {
  [tokens.LMOTH.mint]: T0 + 90_000,
  [tokens.HARBR.mint]: T0 + 240_000,
  [tokens.FINCH.mint]: T0 + 395_000,
  [tokens.SALTM.mint]: T0 + 470_000,
  [tokens.KITE.mint]: T0 + 880_000,
};

events.sort((a, b) => a.blockTimeMs - b.blockTimeMs || a.signature.localeCompare(b.signature));

const dataset = {
  datasetId: DATASET_ID,
  label: "Synthetic demo: five tokens, four packs, one price outage",
  mode: "fixture",
  origin: "synthetic",
  chain: "solana",
  source: "pumpfun",
  decoderVersion: DECODER_VERSION,
  configVersion: BASELINE_CONFIG_VERSION,
  createdAt: "2026-09-24T00:00:00Z",
  description:
    "Synthetic fixture for offline development and tests. Addresses and signatures are derived from hashes of labels and are not real transactions. Prices and provider context are invented and labeled fixture.",
  pricePolicy: "nansen-1m-closed-v1",
  events,
  priceSnapshots,
  tokens: Object.values(tokens).map((t) => ({
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    totalSupplyRaw: "1000000000000000",
    createdAtMs: CREATED[t.mint] ?? null,
    completedAtMs: t.mint === tokens.HARBR.mint ? T0 + 720_000 : null,
  })),
  context,
};

const dir = join(ROOT_DIR, "fixtures");
mkdirSync(join(dir, "synthetic"), { recursive: true });
mkdirSync(join(dir, "manifests"), { recursive: true });
const text = JSON.stringify(dataset, null, 1) + "\n";
const file = `fixtures/synthetic/${DATASET_ID}.json`;
writeFileSync(join(ROOT_DIR, file), text);
const manifest = {
  datasetId: DATASET_ID,
  label: dataset.label,
  mode: "fixture",
  origin: "synthetic",
  chain: "solana",
  source: "pumpfun",
  decoderVersion: DECODER_VERSION,
  configVersion: BASELINE_CONFIG_VERSION,
  createdAt: dataset.createdAt,
  file,
  sha256: sha256Hex(text),
  eventCount: events.length,
};
writeFileSync(join(dir, "manifests", `${DATASET_ID}.json`), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Wrote ${file} (${events.length} events, ${priceSnapshots.length} price snapshots)\n`);
