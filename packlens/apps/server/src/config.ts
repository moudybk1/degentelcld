import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DetectorConfig, Mode } from "@packlens/contracts";

/** Repository root: apps/server/{src,dist}/config.* → three levels up. */
export const ROOT_DIR = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Pump.fun reports SOL-paired coins with Pubkey::default() as quote_mint. */
export const NATIVE_SOL_DEFAULT_PUBKEY = "11111111111111111111111111111111";
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const NANSEN_BASE_URL = "https://api.nansen.ai";
export const BASELINE_CONFIG_VERSION = "pack-baseline-v1";

export const BASELINE_DETECTOR_CONFIG: DetectorConfig = {
  version: BASELINE_CONFIG_VERSION,
  minTradeUsd: "20",
  minUniqueWallets: 3,
  triggerWindowMs: 20000,
  expansionFromStartMs: 40000,
  cooldownFromLastUpdateMs: 120000,
  reorderToleranceMs: 2000,
};

export type QuoteAsset = {
  symbol: "SOL";
  /** Mint used for Nansen price lookup (native SOL → WSOL). */
  priceMint: string;
  /** Mints that identify this quote in decoded events. */
  eventMints: string[];
  decimals: number;
};

export const NATIVE_SOL_QUOTE: QuoteAsset = {
  symbol: "SOL",
  priceMint: WSOL_MINT,
  eventMints: [NATIVE_SOL_DEFAULT_PUBKEY, WSOL_MINT],
  decimals: 9,
};

/**
 * Quote-price policy. The P0 baseline (INV-11) is Nansen OHLCV 1m closed
 * candles with a 120 s candle-start age limit. Because 1m WSOL queries time out
 * upstream (Nansen query_timeout, observed 2026-09-25), an operator may select
 * the documented fallback: 5m closed candles, candle start at most 15 minutes
 * before the event. Snapshot freshness stays 120 s. Detection rules are unchanged.
 */
export type PricePolicy = {
  timeframe: "1m" | "5m";
  version: "nansen-1m-closed-v1" | "nansen-5m-closed-v1";
  candleMs: number;
  /** Max E - intervalStart. */
  maxCandleAgeMs: number;
  /** Max R - availableAt. */
  maxFetchAgeMs: number;
  /** Requested range length ending at the last closed candle boundary. */
  rangeMs: number;
  isBaseline: boolean;
};

export function pricePolicy(timeframe: "1m" | "5m", maxAgeSeconds: number): PricePolicy {
  if (timeframe === "5m") {
    return { timeframe, version: "nansen-5m-closed-v1", candleMs: 300_000, maxCandleAgeMs: 900_000, maxFetchAgeMs: maxAgeSeconds * 1000, rangeMs: 30 * 60_000, isBaseline: false };
  }
  return { timeframe, version: "nansen-1m-closed-v1", candleMs: 60_000, maxCandleAgeMs: maxAgeSeconds * 1000, maxFetchAgeMs: maxAgeSeconds * 1000, rangeMs: 10 * 60_000, isBaseline: true };
}

export type AppConfig = {
  rootDir: string;
  mode: Mode;
  host: string;
  port: number;
  databasePath: string;
  detector: DetectorConfig;
  price: {
    provider: "nansen";
    timeframe: "1m" | "5m";
    candlePolicy: "closed_only";
    policy: PricePolicy;
    refreshSeconds: number;
    maxAgeSeconds: number;
    reservePolls: number;
    quotes: QuoteAsset[];
  };
  nansen: {
    apiKey: string | null;
    budgetCredits: number | null;
    maxConcurrency: number;
    maxRequestsPerMinute: number;
    minSuccessfulCalls: number;
    sessionEndAtMs: number | null;
    campaignId: string;
    timeoutMs: number;
    baseUrl: string;
  };
  smartMoney: {
    enabled: boolean;
    pollSeconds: number;
    sessionEndAtMs: number | null;
  };
  rpc: { httpUrl: string | null; wsUrl: string | null };
  adminToken: string | null;
  holderConcentrationThreshold: string | null;
  enrichment: { autoPacksPerCycle: number; cycleSeconds: number; maxQueuedPacks: number };
  rawCaptureMaxMb: number;
  llmEnabled: false;
  fixtureDatasetId: string;
  allowedOrigins: string[];
  secureCookies: boolean;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid PackLens configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const intString = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      if (!/^\d+$/.test(v.trim())) {
        ctx.addIssue({ code: "custom", message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      const n = Number(v.trim());
      if (n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const boolString = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const t = v.trim().toLowerCase();
      if (t === "true") return true;
      if (t === "false") return false;
      ctx.addIssue({ code: "custom", message: "must be true or false" });
      return z.NEVER;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? null : v.trim()));

const literalOr = <T extends string>(value: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return value;
      if (v.trim() !== value) {
        ctx.addIssue({ code: "custom", message: `only "${value}" is supported in P0` });
        return z.NEVER;
      }
      return value;
    });

const envSchema = z.object({
  APP_MODE: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const t = (v ?? "fixture").trim() || "fixture";
      if (t !== "fixture" && t !== "live" && t !== "replay") {
        ctx.addIssue({ code: "custom", message: "must be fixture, live, or replay" });
        return z.NEVER;
      }
      return t as Mode;
    }),
  LLM_ENABLED: boolString(false),
  PRICE_PROVIDER: literalOr("nansen"),
  PRICE_TIMEFRAME: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const t = (v ?? "").trim() || "1m";
      if (t !== "1m" && t !== "5m") {
        ctx.addIssue({ code: "custom", message: 'must be "1m" (P0 baseline) or "5m" (documented fallback)' });
        return z.NEVER;
      }
      return t as "1m" | "5m";
    }),
  PRICE_CANDLE_POLICY: literalOr("closed_only"),
  DATABASE_PATH: optionalString,
  PACK_MIN_TRADE_USD: literalOr("20"),
  PACK_MIN_WALLETS: literalOr("3"),
  PACK_WINDOW_SECONDS: literalOr("20"),
  PACK_EXTENSION_SECONDS: literalOr("40"),
  PACK_COOLDOWN_SECONDS: literalOr("120"),
  EVENT_REORDER_TOLERANCE_MS: literalOr("2000"),
  PRICE_REFRESH_SECONDS: intString(30, 5, 600),
  PRICE_MAX_AGE_SECONDS: intString(120, 60, 3600),
  PRICE_RESERVE_POLLS: intString(2, 0, 1000),
  NANSEN_MAX_CONCURRENCY: intString(2, 1, 16),
  NANSEN_MAX_REQUESTS_PER_MINUTE: intString(30, 1, 1500),
  NANSEN_MIN_SUCCESSFUL_CALLS: intString(100, 0, 1_000_000),
  NANSEN_BUDGET_CREDITS: optionalString,
  SMART_MONEY_ENABLED: boolString(false),
  SMART_MONEY_POLL_SECONDS: intString(120, 30, 3600),
  RAW_CAPTURE_MAX_MB: intString(200, 1, 100_000),
  NANSEN_API_KEY: optionalString,
  SOLANA_RPC_HTTP_URL: optionalString,
  SOLANA_RPC_WS_URL: optionalString,
  ADMIN_TOKEN: optionalString,
  QUOTE_ASSET_ALLOWLIST: optionalString,
  NANSEN_SESSION_END_AT: optionalString,
  SMART_MONEY_SESSION_END_AT: optionalString,
  NANSEN_CAMPAIGN_ID: optionalString,
  HOLDER_CONCENTRATION_THRESHOLD: optionalString,
  ENRICHMENT_AUTO_PACKS_PER_CYCLE: intString(3, 0, 50),
  ENRICHMENT_CYCLE_SECONDS: intString(300, 30, 3600),
  FIXTURE_DATASET: optionalString,
  HOST: optionalString,
  PORT: intString(8787, 1, 65535),
  ALLOWED_ORIGINS: optionalString,
  SECURE_COOKIES: boolString(false),
});

function parseIsoUtc(value: string | null, name: string, problems: string[]): number | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    problems.push(`${name} must be an ISO UTC timestamp such as 2026-09-25T18:00:00Z`);
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    problems.push(`${name} is not a valid timestamp`);
    return null;
  }
  return ms;
}

export function loadDotEnv(rootDir: string = ROOT_DIR): void {
  // Hermetic test servers opt out of the developer's .env.
  if (process.env.PACKLENS_SKIP_DOTENV === "1") return;
  const path = resolve(rootDir, ".env");
  if (existsSync(path)) {
    // Existing process environment values take precedence over the file.
    const before = { ...process.env };
    process.loadEnvFile(path);
    for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now(), rootDir: string = ROOT_DIR): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  if (e.LLM_ENABLED) problems.push("LLM_ENABLED must be false: P0 does not initialize a model or SDK");

  const quotes: QuoteAsset[] = [];
  const allow = (e.QUOTE_ASSET_ALLOWLIST ?? "SOL").split(",").map((s) => s.trim()).filter(Boolean);
  for (const q of allow) {
    if (q === "SOL" || q === WSOL_MINT) {
      if (!quotes.includes(NATIVE_SOL_QUOTE)) quotes.push(NATIVE_SOL_QUOTE);
    } else {
      problems.push(`QUOTE_ASSET_ALLOWLIST entry "${q}" is not validated in P0; only native SOL (WSOL price) is supported`);
    }
  }
  if (quotes.length === 0) problems.push("QUOTE_ASSET_ALLOWLIST must include SOL");

  let budget: number | null = null;
  if (e.NANSEN_BUDGET_CREDITS !== null) {
    if (!/^\d+$/.test(e.NANSEN_BUDGET_CREDITS) || Number(e.NANSEN_BUDGET_CREDITS) <= 0) {
      problems.push("NANSEN_BUDGET_CREDITS must be a positive integer");
    } else budget = Number(e.NANSEN_BUDGET_CREDITS);
  }

  const nansenEnd = parseIsoUtc(e.NANSEN_SESSION_END_AT, "NANSEN_SESSION_END_AT", problems);
  let smEnd = parseIsoUtc(e.SMART_MONEY_SESSION_END_AT, "SMART_MONEY_SESSION_END_AT", problems);
  if (smEnd === null) smEnd = nansenEnd;
  if (smEnd !== null && nansenEnd !== null && smEnd > nansenEnd) {
    problems.push("SMART_MONEY_SESSION_END_AT cannot be later than NANSEN_SESSION_END_AT");
  }

  let threshold: string | null = null;
  if (e.HOLDER_CONCENTRATION_THRESHOLD !== null) {
    const t = e.HOLDER_CONCENTRATION_THRESHOLD;
    if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(t)) problems.push("HOLDER_CONCENTRATION_THRESHOLD must be a ratio between 0 and 1");
    else threshold = t;
  }

  if (e.ADMIN_TOKEN !== null && e.ADMIN_TOKEN.length < 32) {
    problems.push("ADMIN_TOKEN must be a random secret of at least 32 characters");
  }

  const validateUrl = (value: string | null, name: string, protocols: string[]) => {
    if (value === null) return;
    try {
      const u = new URL(value);
      if (!protocols.includes(u.protocol)) problems.push(`${name} must use ${protocols.join(" or ")}`);
    } catch {
      problems.push(`${name} is not a valid URL`);
    }
  };
  validateUrl(e.SOLANA_RPC_HTTP_URL, "SOLANA_RPC_HTTP_URL", ["https:", "http:"]);
  validateUrl(e.SOLANA_RPC_WS_URL, "SOLANA_RPC_WS_URL", ["wss:", "ws:"]);

  if (e.APP_MODE === "live") {
    if (e.NANSEN_API_KEY === null) problems.push("NANSEN_API_KEY is required in live mode (backend secret)");
    if (budget === null) problems.push("NANSEN_BUDGET_CREDITS is required in live mode; no paid request is sent without a budget");
    if (e.NANSEN_SESSION_END_AT === null) problems.push("NANSEN_SESSION_END_AT is required in live mode (future ISO UTC); run `npm run session:set -- 2h` to set one");
    else if (nansenEnd !== null && nansenEnd <= nowMs) problems.push("NANSEN_SESSION_END_AT is in the past; run `npm run session:set -- 2h` to start a new session window");
    if (e.SOLANA_RPC_WS_URL === null) problems.push("SOLANA_RPC_WS_URL is required in live mode");
    if (e.SOLANA_RPC_HTTP_URL === null) problems.push("SOLANA_RPC_HTTP_URL is required in live mode");
    if (e.ADMIN_TOKEN === null) problems.push("ADMIN_TOKEN is required in live mode");
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const dbPath = e.DATABASE_PATH ?? "./data/packlens.sqlite";
  return {
    rootDir,
    mode: e.APP_MODE,
    host: e.HOST ?? "127.0.0.1",
    port: e.PORT,
    databasePath: dbPath === ":memory:" ? dbPath : isAbsolute(dbPath) ? dbPath : resolve(rootDir, dbPath),
    detector: BASELINE_DETECTOR_CONFIG,
    price: {
      provider: "nansen",
      timeframe: e.PRICE_TIMEFRAME,
      candlePolicy: "closed_only",
      policy: pricePolicy(e.PRICE_TIMEFRAME, e.PRICE_MAX_AGE_SECONDS),
      refreshSeconds: e.PRICE_REFRESH_SECONDS,
      maxAgeSeconds: e.PRICE_MAX_AGE_SECONDS,
      reservePolls: e.PRICE_RESERVE_POLLS,
      quotes,
    },
    nansen: {
      apiKey: e.NANSEN_API_KEY,
      budgetCredits: budget,
      maxConcurrency: e.NANSEN_MAX_CONCURRENCY,
      maxRequestsPerMinute: e.NANSEN_MAX_REQUESTS_PER_MINUTE,
      minSuccessfulCalls: e.NANSEN_MIN_SUCCESSFUL_CALLS,
      sessionEndAtMs: nansenEnd,
      campaignId: e.NANSEN_CAMPAIGN_ID ?? "packlens-live",
      timeoutMs: 15000,
      baseUrl: NANSEN_BASE_URL,
    },
    smartMoney: {
      enabled: e.SMART_MONEY_ENABLED,
      pollSeconds: e.SMART_MONEY_POLL_SECONDS,
      sessionEndAtMs: smEnd,
    },
    rpc: { httpUrl: e.SOLANA_RPC_HTTP_URL, wsUrl: e.SOLANA_RPC_WS_URL },
    adminToken: e.ADMIN_TOKEN,
    holderConcentrationThreshold: threshold,
    enrichment: { autoPacksPerCycle: e.ENRICHMENT_AUTO_PACKS_PER_CYCLE, cycleSeconds: e.ENRICHMENT_CYCLE_SECONDS, maxQueuedPacks: 50 },
    rawCaptureMaxMb: e.RAW_CAPTURE_MAX_MB,
    llmEnabled: false,
    fixtureDatasetId: e.FIXTURE_DATASET ?? "synthetic-demo-v1",
    allowedOrigins: (e.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    secureCookies: e.SECURE_COOKIES,
  };
}

/** Redact credentials embedded in RPC URLs (path segments, query strings, userinfo). */
export function redactUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    const hadSecret = u.username !== "" || u.password !== "" || u.search !== "" || u.pathname.length > 1;
    return hadSecret ? `${u.protocol}//${u.host}/[redacted]` : `${u.protocol}//${u.host}`;
  } catch {
    return "[invalid url]";
  }
}
