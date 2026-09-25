/**
 * Nansen endpoint adapters (blueprint §8, §17.3, §17.12). Request shapes and
 * response fields follow the public OpenAPI schemas reviewed on 2026-09-25.
 * Each endpoint maps the internal subject to its own upstream field name
 * (`address` vs `wallet_address`); they are never sent together.
 */
import { z } from "zod";
import type {
  BalanceData,
  DexHistoryData,
  HoldersData,
  Netflow,
  PnlData,
  RelatedData,
  TokenInfoData,
} from "@packlens/contracts";
import { canonical, parseDecimal } from "../../lib/decimal.js";
import { ProviderNumber } from "../../lib/json.js";

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

export type EndpointName =
  | "tgm/token-ohlcv"
  | "tgm/token-information"
  | "tgm/holders"
  | "profiler/address/pnl-summary"
  | "profiler/dex-trades"
  | "profiler/address/related-wallets"
  | "profiler/address/current-balance"
  | "smart-money/dex-trades"
  | "smart-money/netflow";

export type Normalized<T> = {
  availability: "available" | "empty";
  data: T;
  page: number | null;
  isLastPage: boolean | null;
  periodStartMs: number | null;
  periodEndMs: number | null;
};

export type EndpointDef<Req, T> = {
  name: EndpointName;
  path: string;
  /** Credits per call from the public pricing table (verified against headers at runtime). */
  expectedCredits: number;
  subjectType: "token" | "wallet" | "global";
  subjectId: (req: Req) => string;
  /** Cache TTL; null disables caching (price polling). */
  ttlMs: number | null;
  schema: z.ZodType;
  normalize: (res: unknown, req: Req) => Normalized<T>;
};

/* ------------------------------------------------------------------ */
/* Lossless field helpers                                              */
/* ------------------------------------------------------------------ */

const Num = z.instanceof(ProviderNumber);
const NumN = Num.nullable().optional();
const StrN = z.string().nullable().optional();
const BoolN = z.boolean().nullable().optional();

const Pagination = z.object({ page: NumN, per_page: NumN, is_last_page: BoolN }).nullable().optional();

function dec(n: ProviderNumber | null | undefined, field: string): string | null {
  if (n === null || n === undefined) return null;
  try {
    return canonical(parseDecimal(n.raw));
  } catch {
    throw new SchemaMismatchError(`Field ${field} is not a finite decimal`);
  }
}

function int(n: ProviderNumber | null | undefined, field: string): number | null {
  if (n === null || n === undefined) return null;
  if (!/^-?\d+$/.test(n.raw)) throw new SchemaMismatchError(`Field ${field} is not an integer`);
  const v = Number(n.raw);
  if (!Number.isSafeInteger(v)) throw new SchemaMismatchError(`Field ${field} exceeds safe integer range`);
  return v;
}

function isoMs(text: string, field: string): number {
  // Provider timestamps may omit the zone; they are documented as UTC.
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) throw new SchemaMismatchError(`Field ${field} is not a valid timestamp`);
  return ms;
}

function page(p: z.infer<typeof Pagination>): { page: number | null; isLastPage: boolean | null } {
  return { page: p ? int(p.page ?? null, "pagination.page") : null, isLastPage: p?.is_last_page ?? null };
}

function parse<T extends z.ZodType>(schema: T, res: unknown): z.infer<T> {
  const r = schema.safeParse(res);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new SchemaMismatchError(`Response schema mismatch at ${first?.path.join(".") ?? "?"}: ${first?.message ?? "invalid"}`);
  }
  return r.data;
}

/* ------------------------------------------------------------------ */
/* 1. Quote OHLCV                                                      */
/* ------------------------------------------------------------------ */

export type OhlcvReq = { chain: "solana"; token_address: string; timeframe: "1m" | "5m"; date: { from: string; to: string } };
export type OhlcvData = { candles: { intervalStartMs: number; close: string }[]; skippedCandles: number; truncated: boolean };

const OhlcvSchema = z.object({
  chain: z.string(),
  token_address: z.string(),
  timeframe: z.string(),
  data: z.array(z.object({ interval_start: z.string(), open: NumN, high: NumN, low: NumN, close: NumN, volume_usd: NumN })),
  truncated: BoolN,
  truncation_note: StrN,
});

export const OHLCV: EndpointDef<OhlcvReq, OhlcvData> = {
  name: "tgm/token-ohlcv",
  path: "/api/v1/tgm/token-ohlcv",
  expectedCredits: 1,
  subjectType: "token",
  subjectId: (r) => r.token_address,
  ttlMs: null,
  schema: OhlcvSchema,
  normalize(res, req) {
    const r = parse(OhlcvSchema, res);
    if (r.chain !== req.chain) throw new SchemaMismatchError("OHLCV chain does not match request");
    if (r.token_address !== req.token_address) throw new SchemaMismatchError("OHLCV token does not match request");
    if (r.timeframe !== req.timeframe) throw new SchemaMismatchError("OHLCV timeframe does not match request");
    const candleMs = req.timeframe === "5m" ? 300_000 : 60_000;
    if (r.truncated === true) throw new SchemaMismatchError("OHLCV response truncated; narrow the range");
    const fromMs = isoMs(req.date.from, "date.from");
    const toMs = isoMs(req.date.to, "date.to");
    let skipped = 0;
    const candles: { intervalStartMs: number; close: string }[] = [];
    for (const c of r.data) {
      const start = isoMs(c.interval_start, "interval_start");
      const close = c.close === null || c.close === undefined ? null : dec(c.close, "close");
      // Keep candles starting in [from, to): with `to` at the current candle boundary they are all closed
      // (1m treats `to` as exclusive; 5m treats it as inclusive, so the open candle at `to` is dropped here).
      if (close === null || !(parseDecimal(close).greaterThan(0)) || start < fromMs || start >= toMs || start % candleMs !== 0) {
        skipped++;
        continue;
      }
      candles.push({ intervalStartMs: start, close });
    }
    candles.sort((a, b) => a.intervalStartMs - b.intervalStartMs);
    return {
      availability: candles.length > 0 ? "available" : "empty",
      data: { candles, skippedCandles: skipped, truncated: false },
      page: null,
      isLastPage: null,
      periodStartMs: fromMs,
      periodEndMs: toMs,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 2. Token information                                                */
/* ------------------------------------------------------------------ */

export type TokenInfoReq = { chain: "solana"; token_address: string; timeframe: "1h" };

const TokenInfoSchema = z.object({
  data: z
    .object({
      name: StrN,
      symbol: StrN,
      contract_address: StrN,
      logo: StrN,
      token_details: z
        .object({
          token_deployment_date: StrN,
          website: StrN,
          x: StrN,
          telegram: StrN,
          market_cap_usd: NumN,
          fdv_usd: NumN,
          circulating_supply: NumN,
          total_supply: NumN,
        })
        .nullable()
        .optional(),
      spot_metrics: z
        .object({
          volume_total_usd: NumN,
          buy_volume_usd: NumN,
          sell_volume_usd: NumN,
          total_buys: NumN,
          total_sells: NumN,
          unique_buyers: NumN,
          unique_sellers: NumN,
          liquidity_usd: NumN,
          total_holders: NumN,
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

export const TOKEN_INFORMATION: EndpointDef<TokenInfoReq, TokenInfoData | null> = {
  name: "tgm/token-information",
  path: "/api/v1/tgm/token-information",
  expectedCredits: 1,
  subjectType: "token",
  subjectId: (r) => r.token_address,
  ttlMs: 120_000,
  schema: TokenInfoSchema,
  normalize(res, req) {
    const r = parse(TokenInfoSchema, res);
    if (r.data === null) return { availability: "empty", data: null, page: null, isLastPage: null, periodStartMs: null, periodEndMs: null };
    const d = r.data;
    if (d.contract_address && d.contract_address !== req.token_address) throw new SchemaMismatchError("Token information subject does not match request");
    const td = d.token_details ?? null;
    const sm = d.spot_metrics ?? null;
    const data: TokenInfoData = {
      name: d.name ?? null,
      symbol: d.symbol ?? null,
      logo: d.logo ?? null,
      deploymentDate: td?.token_deployment_date ?? null,
      website: td?.website ?? null,
      x: td?.x ?? null,
      telegram: td?.telegram ?? null,
      marketCapUsd: dec(td?.market_cap_usd, "market_cap_usd"),
      fdvUsd: dec(td?.fdv_usd, "fdv_usd"),
      circulatingSupply: dec(td?.circulating_supply, "circulating_supply"),
      totalSupply: dec(td?.total_supply, "total_supply"),
      timeframe: req.timeframe,
      spot: sm
        ? {
            volumeTotalUsd: dec(sm.volume_total_usd, "volume_total_usd"),
            buyVolumeUsd: dec(sm.buy_volume_usd, "buy_volume_usd"),
            sellVolumeUsd: dec(sm.sell_volume_usd, "sell_volume_usd"),
            totalBuys: int(sm.total_buys, "total_buys"),
            totalSells: int(sm.total_sells, "total_sells"),
            uniqueBuyers: int(sm.unique_buyers, "unique_buyers"),
            uniqueSellers: int(sm.unique_sellers, "unique_sellers"),
            liquidityUsd: dec(sm.liquidity_usd, "liquidity_usd"),
            totalHolders: int(sm.total_holders, "total_holders"),
          }
        : null,
    };
    return { availability: "available", data, page: null, isLastPage: null, periodStartMs: null, periodEndMs: null };
  },
};

/* ------------------------------------------------------------------ */
/* 3. Holders (premium labels disabled)                                */
/* ------------------------------------------------------------------ */

export type HoldersReq = {
  chain: "solana";
  token_address: string;
  premium_labels: false;
  aggregate_by_entity: false;
  label_type: "all_holders";
  /** Documented override of the default value_usd >= $1 dust filter, which hides every holder of unpriced new tokens. */
  filters: { value_usd: { min: 0 } };
  pagination: { page: number; per_page: number };
  order_by: [{ field: "token_amount"; direction: "DESC" }];
};

export type RawHolders = Omit<HoldersData, "observedTopShare" | "totalSupplyUsed" | "holders"> & {
  holders: Omit<HoldersData["holders"][number], "isPackMember">[];
};

const HoldersSchema = z.object({
  data: z.array(
    z.object({
      address: StrN,
      address_label: StrN,
      token_amount: NumN,
      total_outflow: NumN,
      total_inflow: NumN,
      balance_change_24h: NumN,
      ownership_percentage: NumN,
      value_usd: NumN,
    }),
  ),
  pagination: Pagination,
  warnings: z.array(z.string()).nullable().optional(),
});

export const HOLDERS: EndpointDef<HoldersReq, RawHolders> = {
  name: "tgm/holders",
  path: "/api/v1/tgm/holders",
  expectedCredits: 5,
  subjectType: "token",
  subjectId: (r) => r.token_address,
  ttlMs: 300_000,
  schema: HoldersSchema,
  normalize(res, req) {
    const r = parse(HoldersSchema, res);
    const p = page(r.pagination);
    const holders = r.data
      .filter((h) => typeof h.address === "string" && h.address.length > 0)
      .map((h) => ({
        address: h.address!,
        label: h.address_label ?? null,
        tokenAmount: dec(h.token_amount, "token_amount"),
        ownershipPercentage: dec(h.ownership_percentage, "ownership_percentage"),
        valueUsd: dec(h.value_usd, "value_usd"),
        balanceChange24h: dec(h.balance_change_24h, "balance_change_24h"),
      }));
    return {
      availability: holders.length > 0 ? "available" : "empty",
      data: {
        holders,
        page: p.page ?? req.pagination.page,
        perPage: req.pagination.per_page,
        isLastPage: p.isLastPage,
        warnings: r.warnings ?? [],
        observedHolderCount: holders.length,
      },
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: null,
      periodEndMs: null,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 4. Wallet PnL summary                                               */
/* ------------------------------------------------------------------ */

export type PnlReq = { chain: "solana"; wallet_address: string; date: { from: string; to: string } };

const PnlSchema = z.object({
  pagination: Pagination,
  top5_tokens: z
    .array(z.object({ realized_pnl: NumN, realized_roi: NumN, token_address: z.string(), token_symbol: StrN, chain: StrN }))
    .nullable()
    .optional(),
  traded_token_count: NumN,
  traded_times: NumN,
  realized_pnl_usd: NumN,
  realized_pnl_percent: NumN,
  win_rate: NumN,
});

export const PNL_SUMMARY: EndpointDef<PnlReq, PnlData> = {
  name: "profiler/address/pnl-summary",
  path: "/api/v1/profiler/address/pnl-summary",
  expectedCredits: 1,
  subjectType: "wallet",
  subjectId: (r) => r.wallet_address,
  ttlMs: 60 * 60_000,
  schema: PnlSchema,
  normalize(res, req) {
    const r = parse(PnlSchema, res);
    const data: PnlData = {
      periodStart: req.date.from,
      periodEnd: req.date.to,
      realizedPnlUsd: dec(r.realized_pnl_usd, "realized_pnl_usd"),
      realizedPnlPercent: dec(r.realized_pnl_percent, "realized_pnl_percent"),
      winRate: dec(r.win_rate, "win_rate"),
      tradedTimes: int(r.traded_times, "traded_times"),
      tradedTokenCount: int(r.traded_token_count, "traded_token_count"),
      top5Tokens: (r.top5_tokens ?? []).map((t) => ({
        tokenAddress: t.token_address,
        tokenSymbol: t.token_symbol ?? null,
        realizedPnl: dec(t.realized_pnl, "realized_pnl"),
        realizedRoi: dec(t.realized_roi, "realized_roi"),
      })),
    };
    return {
      availability: "available",
      data,
      page: null,
      isLastPage: null,
      periodStartMs: isoMs(req.date.from, "date.from"),
      periodEndMs: isoMs(req.date.to, "date.to"),
    };
  },
};

/* ------------------------------------------------------------------ */
/* 5. Wallet DEX history                                               */
/* ------------------------------------------------------------------ */

export type WalletDexReq = { chain: "solana"; address: string; date: { from: string; to: string }; pagination: { page: number; per_page: number } };

const TradeRow = z.object({
  chain: z.string(),
  block_timestamp: z.string(),
  transaction_hash: z.string(),
  trader_address: z.string(),
  trader_address_label: StrN,
  token_bought_address: z.string(),
  token_sold_address: z.string(),
  token_bought_amount: NumN,
  token_sold_amount: NumN,
  token_bought_symbol: StrN,
  token_sold_symbol: StrN,
  trade_value_usd: NumN,
});

const WalletDexSchema = z.object({ pagination: Pagination, data: z.array(TradeRow) });

export const WALLET_DEX_TRADES: EndpointDef<WalletDexReq, DexHistoryData> = {
  name: "profiler/dex-trades",
  path: "/api/v1/profiler/dex-trades",
  expectedCredits: 1,
  subjectType: "wallet",
  subjectId: (r) => r.address,
  ttlMs: 5 * 60_000,
  schema: WalletDexSchema,
  normalize(res, req) {
    const r = parse(WalletDexSchema, res);
    const p = page(r.pagination);
    const trades = r.data.map((t) => {
      if (t.chain !== "solana") throw new SchemaMismatchError("Wallet trade chain does not match request");
      return {
        transactionHash: t.transaction_hash,
        blockTimestamp: new Date(isoMs(t.block_timestamp, "block_timestamp")).toISOString(),
        tokenBoughtAddress: t.token_bought_address,
        tokenBoughtSymbol: t.token_bought_symbol ?? null,
        tokenSoldAddress: t.token_sold_address,
        tokenSoldSymbol: t.token_sold_symbol ?? null,
        tokenBoughtAmount: dec(t.token_bought_amount, "token_bought_amount"),
        tokenSoldAmount: dec(t.token_sold_amount, "token_sold_amount"),
        tradeValueUsd: dec(t.trade_value_usd, "trade_value_usd"),
      };
    });
    return {
      availability: trades.length > 0 ? "available" : "empty",
      data: { periodStart: req.date.from, periodEnd: req.date.to, trades, sampleSize: trades.length, page: p.page ?? req.pagination.page, isLastPage: p.isLastPage },
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: isoMs(req.date.from, "date.from"),
      periodEndMs: isoMs(req.date.to, "date.to"),
    };
  },
};

/* ------------------------------------------------------------------ */
/* 6. Related wallets                                                  */
/* ------------------------------------------------------------------ */

export type RelatedReq = { chain: "solana"; wallet_address: string; pagination: { page: number; per_page: number } };
export type RawRelated = Omit<RelatedData, "related"> & { related: Omit<RelatedData["related"][number], "isPackMember">[] };

const RelatedSchema = z.object({
  pagination: Pagination,
  data: z.array(
    z.object({
      address: z.string(),
      address_label: StrN,
      relation: z.string(),
      transaction_hash: z.string(),
      block_timestamp: z.string(),
      order: NumN,
      chain: z.string(),
    }),
  ),
});

export const RELATED_WALLETS: EndpointDef<RelatedReq, RawRelated> = {
  name: "profiler/address/related-wallets",
  path: "/api/v1/profiler/address/related-wallets",
  expectedCredits: 1,
  subjectType: "wallet",
  subjectId: (r) => r.wallet_address,
  ttlMs: 15 * 60_000,
  schema: RelatedSchema,
  normalize(res, req) {
    const r = parse(RelatedSchema, res);
    const p = page(r.pagination);
    const related = r.data.map((w) => {
      if (w.chain !== "solana") throw new SchemaMismatchError("Related wallet chain does not match request");
      return {
        address: w.address,
        label: w.address_label ?? null,
        relation: w.relation,
        transactionHash: w.transaction_hash,
        blockTimestamp: new Date(isoMs(w.block_timestamp, "block_timestamp")).toISOString(),
        order: int(w.order, "order"),
      };
    });
    return {
      availability: related.length > 0 ? "available" : "empty",
      data: { related, page: p.page ?? req.pagination.page, isLastPage: p.isLastPage },
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: null,
      periodEndMs: null,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 7. Current balance (selected follow-up)                             */
/* ------------------------------------------------------------------ */

export type BalanceReq = {
  chain: "solana";
  address: string;
  hide_spam_token: false;
  filters: { token_address: string };
  pagination: { page: number; per_page: number };
};
export type RawBalance = Omit<BalanceData, "scheduledAt">;

const BalanceSchema = z.object({
  pagination: Pagination,
  data: z.array(
    z.object({
      chain: z.string(),
      address: StrN,
      token_address: z.string(),
      token_symbol: StrN,
      token_name: StrN,
      token_amount: NumN,
      price_usd: NumN,
      value_usd: NumN,
    }),
  ),
});

export const CURRENT_BALANCE: EndpointDef<BalanceReq, RawBalance> = {
  name: "profiler/address/current-balance",
  path: "/api/v1/profiler/address/current-balance",
  expectedCredits: 1,
  subjectType: "wallet",
  subjectId: (r) => r.address,
  ttlMs: 60_000,
  schema: BalanceSchema,
  normalize(res, req) {
    const r = parse(BalanceSchema, res);
    const p = page(r.pagination);
    const balances = r.data.map((b) => {
      if (b.chain !== "solana") throw new SchemaMismatchError("Balance chain does not match request");
      return {
        tokenAddress: b.token_address,
        tokenSymbol: b.token_symbol ?? null,
        tokenAmount: dec(b.token_amount, "token_amount"),
        priceUsd: dec(b.price_usd, "price_usd"),
        valueUsd: dec(b.value_usd, "value_usd"),
      };
    });
    const match = balances.find((b) => b.tokenAddress === req.filters.token_address) ?? null;
    return {
      availability: balances.length > 0 ? "available" : "empty",
      data: {
        balances,
        packToken: {
          tokenAddress: req.filters.token_address,
          tokenAmount: match?.tokenAmount ?? null,
          valueUsd: match?.valueUsd ?? null,
          observedOnFetchedPages: match !== null,
        },
        page: p.page ?? req.pagination.page,
        isLastPage: p.isLastPage,
      },
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: null,
      periodEndMs: null,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 8. Smart Money DEX trades                                           */
/* ------------------------------------------------------------------ */

export type SmDexReq = {
  chains: ["solana"];
  filters?: { token_bought_address: string };
  pagination: { page: number; per_page: number };
  order_by: [{ field: "block_timestamp"; direction: "DESC" }];
};

export type SmTrade = {
  chain: "solana";
  transactionHash: string;
  blockTimeMs: number;
  traderAddress: string;
  traderLabel: string | null;
  tokenBoughtAddress: string;
  tokenSoldAddress: string;
  tokenBoughtSymbol: string | null;
  tokenSoldSymbol: string | null;
  tokenBoughtAmount: string | null;
  tokenSoldAmount: string | null;
  tradeValueUsd: string | null;
};

export type SmDexData = { trades: SmTrade[]; oldestMs: number | null; newestMs: number | null };

const SmDexSchema = z.object({ data: z.array(TradeRow), pagination: Pagination });

export const SMART_MONEY_DEX: EndpointDef<SmDexReq, SmDexData> = {
  name: "smart-money/dex-trades",
  path: "/api/v1/smart-money/dex-trades",
  expectedCredits: 5,
  subjectType: "token",
  subjectId: (r) => r.filters?.token_bought_address ?? "global",
  // At most one targeted lookup per mint per 120 seconds; packs sharing a mint share it.
  ttlMs: 120_000,
  schema: SmDexSchema,
  normalize(res, req) {
    const r = parse(SmDexSchema, res);
    const p = page(r.pagination);
    const trades: SmTrade[] = r.data.map((t) => {
      if (t.chain !== "solana") throw new SchemaMismatchError("Smart Money trade chain does not match Solana scope");
      if (req.filters && t.token_bought_address !== req.filters.token_bought_address) {
        throw new SchemaMismatchError("Smart Money trade does not match the requested bought token");
      }
      return {
        chain: "solana",
        transactionHash: t.transaction_hash,
        blockTimeMs: isoMs(t.block_timestamp, "block_timestamp"),
        traderAddress: t.trader_address,
        traderLabel: t.trader_address_label ?? null,
        tokenBoughtAddress: t.token_bought_address,
        tokenSoldAddress: t.token_sold_address,
        tokenBoughtSymbol: t.token_bought_symbol ?? null,
        tokenSoldSymbol: t.token_sold_symbol ?? null,
        tokenBoughtAmount: dec(t.token_bought_amount, "token_bought_amount"),
        tokenSoldAmount: dec(t.token_sold_amount, "token_sold_amount"),
        tradeValueUsd: dec(t.trade_value_usd, "trade_value_usd"),
      };
    });
    const times = trades.map((t) => t.blockTimeMs);
    return {
      availability: trades.length > 0 ? "available" : "empty",
      data: { trades, oldestMs: times.length ? Math.min(...times) : null, newestMs: times.length ? Math.max(...times) : null },
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: null,
      periodEndMs: null,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 9. Smart Money netflow                                              */
/* ------------------------------------------------------------------ */

export type NetflowReq = { chains: ["solana"]; filters: { token_address: string }; pagination: { page: number; per_page: number } };
export type NetflowData = Omit<Netflow, "fetchedAt" | "scopeHash"> & { tokenSymbol: string | null; rowFound: boolean };

const NetflowSchema = z.object({
  data: z.array(
    z.object({
      token_address: z.string(),
      token_symbol: StrN,
      net_flow_1h_usd: NumN,
      net_flow_24h_usd: NumN,
      net_flow_7d_usd: NumN,
      net_flow_30d_usd: NumN,
      chain: z.string(),
      trader_count: NumN,
    }),
  ),
  pagination: Pagination,
});

export const SMART_MONEY_NETFLOW: EndpointDef<NetflowReq, NetflowData> = {
  name: "smart-money/netflow",
  path: "/api/v1/smart-money/netflow",
  expectedCredits: 5,
  subjectType: "token",
  subjectId: (r) => r.filters.token_address,
  ttlMs: 5 * 60_000,
  schema: NetflowSchema,
  normalize(res, req) {
    const r = parse(NetflowSchema, res);
    const p = page(r.pagination);
    for (const row of r.data) if (row.chain !== "solana") throw new SchemaMismatchError("Netflow chain does not match Solana scope");
    const row = r.data.find((x) => x.token_address === req.filters.token_address) ?? null;
    if (r.data.length > 0 && row === null) throw new SchemaMismatchError("Netflow rows do not match the requested token");
    const data: NetflowData = {
      asOf: null, // the provider does not return an as-of timestamp; never fabricate one
      values: [
        { window: "1h", netFlowUsd: row ? dec(row.net_flow_1h_usd, "net_flow_1h_usd") : null },
        { window: "24h", netFlowUsd: row ? dec(row.net_flow_24h_usd, "net_flow_24h_usd") : null },
        { window: "7d", netFlowUsd: row ? dec(row.net_flow_7d_usd, "net_flow_7d_usd") : null },
        { window: "30d", netFlowUsd: row ? dec(row.net_flow_30d_usd, "net_flow_30d_usd") : null },
      ],
      traderCount30d: row ? int(row.trader_count, "trader_count") : null,
      tokenSymbol: row?.token_symbol ?? null,
      rowFound: row !== null,
    };
    return {
      availability: row ? "available" : "empty",
      data,
      page: p.page ?? req.pagination.page,
      isLastPage: p.isLastPage,
      periodStartMs: null,
      periodEndMs: null,
    };
  },
};

export const ALL_ENDPOINTS = [OHLCV, TOKEN_INFORMATION, HOLDERS, PNL_SUMMARY, WALLET_DEX_TRADES, RELATED_WALLETS, CURRENT_BALANCE, SMART_MONEY_DEX, SMART_MONEY_NETFLOW];
