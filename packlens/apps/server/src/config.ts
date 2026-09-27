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
/** Pyth Solana Receiver: owner of every verified Pyth price update account. */
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** Pyth SOL/USD feed ID (Crypto.SOL/USD). */
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** Pyth's sponsored push-oracle account for SOL/USD (shard 0), kept current by Pyth on Solana mainnet. */
export const PYTH_SOL_USD_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
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

/**
 * A member's first entry into a pack lies inside that pack's evidence window: at most
 * the trigger window before its trigger and at most the expansion window after it.
 * Bounding member entry times by this margin lets the (namespace, wallet, time) index
 * serve earlier-pack lookups; packs are still filtered by trigger time exactly.
 */
export const MEMBER_ENTRY_MARGIN_MS = BASELINE_DETECTOR_CONFIG.triggerWindowMs + BASELINE_DETECTOR_CONFIG.expansionFromStartMs;

/**
 * The detection rule. The spec baseline (3 wallets, $20 per buy) is `pack-baseline-v1`. The owner
 * may run another wallet count or per-buy minimum (approved 2026-09-26); it keeps the baseline
 * windows and gets its own version, so its packs are never presented as, or mixed with, baseline
 * results (blueprint: "experiments use another configuration version").
 */
export function detectorConfig(minUniqueWallets: number, minTradeUsd: string): DetectorConfig {
  if (minUniqueWallets === BASELINE_DETECTOR_CONFIG.minUniqueWallets && minTradeUsd === BASELINE_DETECTOR_CONFIG.minTradeUsd) return BASELINE_DETECTOR_CONFIG;
  return { ...BASELINE_DETECTOR_CONFIG, version: `pack-custom-${minUniqueWallets}w-${minTradeUsd}usd-v1`, minUniqueWallets, minTradeUsd };
}

const CUSTOM_RULE_VERSION = /^pack-custom-(\d+)w-(\d+(?:\.\d+)?)usd-v1$/;

/** The rule a pack, dataset, or namespace was recorded under; null for an unknown version. */
export function detectorConfigForVersion(version: string): DetectorConfig | null {
  if (version === BASELINE_CONFIG_VERSION) return BASELINE_DETECTOR_CONFIG;
  const m = CUSTOM_RULE_VERSION.exec(version);
  return m ? detectorConfig(Number(m[1]), m[2]!) : null;
}

/** Live packs under a custom rule get their own namespace, e.g. `live:packlens-live:5w-25usd`. */
export function liveNamespace(config: Pick<AppConfig, "nansen" | "detector">): string {
  const d = config.detector;
  const base = `live:${config.nansen.campaignId}`;
  return d.version === BASELINE_CONFIG_VERSION ? base : `${base}:${d.minUniqueWallets}w-${d.minTradeUsd}usd`;
}

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
 * before the event. Snapshot freshness stays 120 s.
 *
 * For 24/7 operation the owner approved (2026-09-26) a keyless alternative,
 * `PRICE_PROVIDER=pyth`: Pyth's on-chain SOL/USD price, read from the chain
 * like the trades themselves, costs no Nansen credits. A price qualifies when
 * it was published at or before the event and at most PRICE_MAX_AGE_SECONDS
 * earlier ("tick": candle length 0). Detection rules are unchanged in all cases.
 */
export type PriceTimeframe = "1m" | "5m" | "tick";
export type PricePolicy = {
  provider: "nansen" | "pyth";
  timeframe: PriceTimeframe;
  version: "nansen-1m-closed-v1" | "nansen-5m-closed-v1" | "pyth-onchain-v1";
  /** Candle length; 0 for a published price (the price time must not be after the event). */
  candleMs: number;
  /** Max E - intervalStart. */
  maxCandleAgeMs: number;
  /** Max R - availableAt. */
  maxFetchAgeMs: number;
  /** Requested range length ending at the last closed candle boundary. */
  rangeMs: number;
  isBaseline: boolean;
};

export function pricePolicy(timeframe: PriceTimeframe, maxAgeSeconds: number): PricePolicy {
  if (timeframe === "tick") {
    return { provider: "pyth", timeframe, version: "pyth-onchain-v1", candleMs: 0, maxCandleAgeMs: maxAgeSeconds * 1000, maxFetchAgeMs: maxAgeSeconds * 1000, rangeMs: 0, isBaseline: false };
  }
  if (timeframe === "5m") {
    return { provider: "nansen", timeframe, version: "nansen-5m-closed-v1", candleMs: 300_000, maxCandleAgeMs: 900_000, maxFetchAgeMs: maxAgeSeconds * 1000, rangeMs: 30 * 60_000, isBaseline: false };
  }
  return { provider: "nansen", timeframe, version: "nansen-1m-closed-v1", candleMs: 60_000, maxCandleAgeMs: maxAgeSeconds * 1000, maxFetchAgeMs: maxAgeSeconds * 1000, rangeMs: 10 * 60_000, isBaseline: true };
}

/** The policy a stored snapshot or dataset was recorded under. */
export function policyForVersion(version: string | undefined | null, maxAgeSeconds: number): PricePolicy {
  if (version === "pyth-onchain-v1") return pricePolicy("tick", maxAgeSeconds);
  return pricePolicy(version === "nansen-5m-closed-v1" ? "5m" : "1m", maxAgeSeconds);
}

export type AppConfig = {
  rootDir: string;
  mode: Mode;
  host: string;
  port: number;
  databasePath: string;
  detector: DetectorConfig;
  price: {
    provider: "nansen" | "pyth";
    timeframe: PriceTimeframe;
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
    /**
     * Continuous sessions (Pyth price only): with no NANSEN_SESSION_END_AT and a
     * daily cap, sessions renew each UTC day and paid calls stay within the cap.
     */
    continuous: boolean;
    /** Credits allowed per UTC day across all lanes; null means only the campaign budget applies. */
    dailyCreditCap: number | null;
    campaignId: string;
    timeoutMs: number;
    baseUrl: string;
  };
  smartMoney: {
    enabled: boolean;
    /** The shared global Smart Money feed poll; per-pack token lookups follow `enabled` only. */
    feedEnabled: boolean;
    /** Limit the feed to tokens at most this many days old (Nansen `token_bought_age_days`); null = every token. */
    feedMaxTokenAgeDays: number | null;
    pollSeconds: number;
    sessionEndAtMs: number | null;
  };
  /** Fallbacks (optional) take over when the primary RPC keeps failing, for example when a keyed plan runs out of credits. */
  rpc: { httpUrl: string | null; wsUrl: string | null; httpFallbackUrl: string | null; wsFallbackUrl: string | null };
  adminToken: string | null;
  holderConcentrationThreshold: string | null;
  enrichment: { autoPacksPerCycle: number; cycleSeconds: number; maxQueuedPacks: number };
  rawCaptureMaxMb: number;
  llmEnabled: false;
  fixtureDatasetId: string;
  allowedOrigins: string[];
  secureCookies: boolean;
  /**
   * Public hosting protections: per-client rate limits, a 5 s read cache,
   * live-stream connection caps, and an analytics cap. Requires secure cookies.
   */
  publicHosting: boolean;
  /** Reverse proxies whose X-Forwarded-For is trusted (Fastify trustProxy); false when direct. */
  trustProxy: string | false;
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
  PRICE_PROVIDER: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const t = (v ?? "").trim() || "nansen";
      if (t !== "nansen" && t !== "pyth") {
        ctx.addIssue({ code: "custom", message: 'must be "nansen" (P0 baseline) or "pyth" (on-chain price, no credits)' });
        return z.NEVER;
      }
      return t as "nansen" | "pyth";
    }),
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
  // The windows stay locked; the wallet count and per-buy minimum may differ from the baseline.
  PACK_MIN_TRADE_USD: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const t = (v ?? "").trim() || "20";
      if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) < 1) {
        ctx.addIssue({ code: "custom", message: "must be a USD amount of at least 1 with up to two decimals, e.g. 25" });
        return z.NEVER;
      }
      return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : String(Number(t));
    }),
  PACK_MIN_WALLETS: intString(3, 3, 100),
  PACK_WINDOW_SECONDS: literalOr("20"),
  PACK_EXTENSION_SECONDS: literalOr("40"),
  PACK_COOLDOWN_SECONDS: literalOr("120"),
  EVENT_REORDER_TOLERANCE_MS: literalOr("2000"),
  // Default depends on the provider: 30 s for Nansen candles, 5 s for Pyth (a free on-chain read).
  PRICE_REFRESH_SECONDS: intString(0, 1, 600),
  PRICE_MAX_AGE_SECONDS: intString(120, 60, 3600),
  PRICE_RESERVE_POLLS: intString(2, 0, 1000),
  NANSEN_MAX_CONCURRENCY: intString(2, 1, 16),
  NANSEN_MAX_REQUESTS_PER_MINUTE: intString(30, 1, 1500),
  NANSEN_MIN_SUCCESSFUL_CALLS: intString(100, 0, 1_000_000),
  NANSEN_BUDGET_CREDITS: optionalString,
  NANSEN_DAILY_CREDIT_CAP: optionalString,
  SMART_MONEY_ENABLED: boolString(false),
  SMART_MONEY_FEED_ENABLED: boolString(true),
  SMART_MONEY_POLL_SECONDS: intString(120, 30, 3600),
  SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS: intString(-1, 0, 365),
  RAW_CAPTURE_MAX_MB: intString(200, 1, 100_000),
  NANSEN_API_KEY: optionalString,
  SOLANA_RPC_HTTP_URL: optionalString,
  SOLANA_RPC_WS_URL: optionalString,
  SOLANA_RPC_HTTP_FALLBACK_URL: optionalString,
  SOLANA_RPC_WS_FALLBACK_URL: optionalString,
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
  PUBLIC_HOSTING: boolString(false),
  TRUST_PROXY: optionalString,
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

  let dailyCap: number | null = null;
  if (e.NANSEN_DAILY_CREDIT_CAP !== null) {
    if (!/^\d+$/.test(e.NANSEN_DAILY_CREDIT_CAP)) problems.push("NANSEN_DAILY_CREDIT_CAP must be a whole number of credits (0 or more)");
    else dailyCap = Number(e.NANSEN_DAILY_CREDIT_CAP);
  }
  const pyth = e.PRICE_PROVIDER === "pyth";
  const refreshSeconds = e.PRICE_REFRESH_SECONDS === 0 ? (pyth ? 5 : 30) : e.PRICE_REFRESH_SECONDS;
  if (!pyth && refreshSeconds < 5) problems.push("PRICE_REFRESH_SECONDS must be at least 5 for Nansen price polling");

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
  validateUrl(e.SOLANA_RPC_HTTP_FALLBACK_URL, "SOLANA_RPC_HTTP_FALLBACK_URL", ["https:", "http:"]);
  validateUrl(e.SOLANA_RPC_WS_FALLBACK_URL, "SOLANA_RPC_WS_FALLBACK_URL", ["wss:", "ws:"]);

  if (e.APP_MODE === "live") {
    if (e.NANSEN_API_KEY === null) problems.push("NANSEN_API_KEY is required in live mode (backend secret)");
    if (budget === null) problems.push("NANSEN_BUDGET_CREDITS is required in live mode; no paid request is sent without a budget");
    // With Pyth prices, detection needs no Nansen session: without one, Nansen is either
    // continuous under NANSEN_DAILY_CREDIT_CAP or off entirely.
    if (e.NANSEN_SESSION_END_AT === null && !pyth) problems.push("NANSEN_SESSION_END_AT is required in live mode (future ISO UTC); run `npm run session:set -- 2h` to set one");
    else if (nansenEnd !== null && nansenEnd <= nowMs) problems.push("NANSEN_SESSION_END_AT is in the past; run `npm run session:set -- 2h` to start a new session window");
    if (e.SOLANA_RPC_WS_URL === null) problems.push("SOLANA_RPC_WS_URL is required in live mode");
    if (e.SOLANA_RPC_HTTP_URL === null) problems.push("SOLANA_RPC_HTTP_URL is required in live mode");
    if (e.ADMIN_TOKEN === null) problems.push("ADMIN_TOKEN is required in live mode");
  }

  let trustProxy: string | false = false;
  if (e.TRUST_PROXY !== null) {
    const t = e.TRUST_PROXY === "loopback" ? "127.0.0.1,::1" : e.TRUST_PROXY;
    if (!/^[0-9a-fA-F:.,/ ]+$/.test(t)) problems.push('TRUST_PROXY must be "loopback" or a comma-separated list of proxy IP addresses or CIDR ranges');
    else trustProxy = t.replace(/\s+/g, "");
  }
  if (e.PUBLIC_HOSTING && !e.SECURE_COOKIES) problems.push("PUBLIC_HOSTING requires SECURE_COOKIES=true (serve the site over HTTPS)");

  if (problems.length > 0) throw new ConfigError(problems);

  const policy = pyth ? pricePolicy("tick", e.PRICE_MAX_AGE_SECONDS) : pricePolicy(e.PRICE_TIMEFRAME, e.PRICE_MAX_AGE_SECONDS);
  const dbPath = e.DATABASE_PATH ?? "./data/packlens.sqlite";
  return {
    rootDir,
    mode: e.APP_MODE,
    host: e.HOST ?? "127.0.0.1",
    port: e.PORT,
    databasePath: dbPath === ":memory:" ? dbPath : isAbsolute(dbPath) ? dbPath : resolve(rootDir, dbPath),
    detector: detectorConfig(e.PACK_MIN_WALLETS, e.PACK_MIN_TRADE_USD),
    price: {
      provider: policy.provider,
      timeframe: policy.timeframe,
      candlePolicy: "closed_only",
      policy,
      refreshSeconds,
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
      continuous: pyth && nansenEnd === null && dailyCap !== null && dailyCap > 0,
      dailyCreditCap: dailyCap,
      campaignId: e.NANSEN_CAMPAIGN_ID ?? "packlens-live",
      timeoutMs: 15000,
      baseUrl: NANSEN_BASE_URL,
    },
    smartMoney: {
      enabled: e.SMART_MONEY_ENABLED,
      feedEnabled: e.SMART_MONEY_ENABLED && e.SMART_MONEY_FEED_ENABLED,
      feedMaxTokenAgeDays: e.SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS < 0 ? null : e.SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS,
      pollSeconds: e.SMART_MONEY_POLL_SECONDS,
      sessionEndAtMs: smEnd,
    },
    rpc: { httpUrl: e.SOLANA_RPC_HTTP_URL, wsUrl: e.SOLANA_RPC_WS_URL, httpFallbackUrl: e.SOLANA_RPC_HTTP_FALLBACK_URL, wsFallbackUrl: e.SOLANA_RPC_WS_FALLBACK_URL },
    adminToken: e.ADMIN_TOKEN,
    holderConcentrationThreshold: threshold,
    enrichment: { autoPacksPerCycle: e.ENRICHMENT_AUTO_PACKS_PER_CYCLE, cycleSeconds: e.ENRICHMENT_CYCLE_SECONDS, maxQueuedPacks: 50 },
    rawCaptureMaxMb: e.RAW_CAPTURE_MAX_MB,
    llmEnabled: false,
    fixtureDatasetId: e.FIXTURE_DATASET ?? "synthetic-demo-v1",
    allowedOrigins: (e.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    secureCookies: e.SECURE_COOKIES,
    publicHosting: e.PUBLIC_HOSTING,
    trustProxy,
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
