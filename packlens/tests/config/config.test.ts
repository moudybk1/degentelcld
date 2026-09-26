import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, detectorConfigForVersion, liveNamespace, loadConfig, redactUrl, ROOT_DIR } from "../../apps/server/src/config.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");

describe("configuration", () => {
  it("fixture mode starts without any keys", () => {
    const c = loadConfig({ APP_MODE: "fixture" }, NOW);
    expect(c.mode).toBe("fixture");
    expect(c.nansen.apiKey).toBeNull();
    expect(c.detector).toMatchObject({ minTradeUsd: "20", minUniqueWallets: 3, triggerWindowMs: 20000, expansionFromStartMs: 40000, cooldownFromLastUpdateMs: 120000, reorderToleranceMs: 2000, version: "pack-baseline-v1" });
  });

  it("T54: LLM stays disabled and P0 needs no model key", () => {
    expect(loadConfig({}, NOW).llmEnabled).toBe(false);
    expect(() => loadConfig({ LLM_ENABLED: "true" }, NOW)).toThrow(ConfigError);
    const pkg = readFileSync(join(ROOT_DIR, "apps/server/package.json"), "utf8");
    expect(pkg).not.toMatch(/anthropic|openai|langchain/i);
  });

  it("live mode fails clearly when required values are missing", () => {
    try {
      loadConfig({ APP_MODE: "live" }, NOW);
      expect.unreachable();
    } catch (e) {
      const msg = (e as ConfigError).message;
      for (const k of ["NANSEN_API_KEY", "NANSEN_BUDGET_CREDITS", "NANSEN_SESSION_END_AT", "SOLANA_RPC_WS_URL", "ADMIN_TOKEN"]) expect(msg).toContain(k);
    }
  });

  it("rejects a past session end, a non-integer budget, and changes to the locked windows", () => {
    const live = { APP_MODE: "live", NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "100", SOLANA_RPC_HTTP_URL: "https://x.test", SOLANA_RPC_WS_URL: "wss://x.test", ADMIN_TOKEN: "a".repeat(40) };
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T11:00:00Z" }, NOW)).toThrow(/in the past/);
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z", NANSEN_BUDGET_CREDITS: "12.5" }, NOW)).toThrow(/positive integer/);
    expect(() => loadConfig({ PACK_WINDOW_SECONDS: "30" }, NOW)).toThrow(/only "20"/);
    expect(() => loadConfig({ PACK_EXTENSION_SECONDS: "60" }, NOW)).toThrow(/only "40"/);
    expect(() => loadConfig({ PRICE_PROVIDER: "jupiter" }, NOW)).toThrow(/must be "nansen" \(P0 baseline\) or "pyth"/);
    expect(() => loadConfig({ QUOTE_ASSET_ALLOWLIST: "SOL,USDC" }, NOW)).toThrow(/not validated in P0/);
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z", SMART_MONEY_SESSION_END_AT: "2026-09-25T14:00:00Z" }, NOW)).toThrow(/cannot be later/);
    const ok = loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z" }, NOW);
    expect(ok.smartMoney.sessionEndAtMs).toBe(ok.nansen.sessionEndAtMs);
    expect(ok.nansen.budgetCredits).toBe(100);
  });

  it("a custom wallet count and per-buy minimum get their own rule version and live namespace", () => {
    const base = loadConfig({}, NOW);
    expect(base.detector.version).toBe("pack-baseline-v1");
    expect(liveNamespace(base)).toBe("live:packlens-live");

    const c = loadConfig({ PACK_MIN_WALLETS: "5", PACK_MIN_TRADE_USD: "25" }, NOW);
    expect(c.detector).toEqual({ version: "pack-custom-5w-25usd-v1", minUniqueWallets: 5, minTradeUsd: "25", triggerWindowMs: 20000, expansionFromStartMs: 40000, cooldownFromLastUpdateMs: 120000, reorderToleranceMs: 2000 });
    expect(liveNamespace(c)).toBe("live:packlens-live:5w-25usd");
    expect(detectorConfigForVersion(c.detector.version)).toEqual(c.detector);
    expect(detectorConfigForVersion("pack-baseline-v1")).toEqual(base.detector);
    expect(detectorConfigForVersion("pack-other-v9")).toBeNull();

    // Setting the baseline values explicitly is the baseline, and USD amounts are normalized.
    expect(loadConfig({ PACK_MIN_WALLETS: "3", PACK_MIN_TRADE_USD: "20.00" }, NOW).detector.version).toBe("pack-baseline-v1");
    expect(loadConfig({ PACK_MIN_TRADE_USD: "25.50" }, NOW).detector.version).toBe("pack-custom-3w-25.5usd-v1");
    for (const bad of ["abc", "0.5", "25.123", "-5"]) expect(() => loadConfig({ PACK_MIN_TRADE_USD: bad }, NOW)).toThrow(/PACK_MIN_TRADE_USD/);
    for (const bad of ["2", "101", "4.5"]) expect(() => loadConfig({ PACK_MIN_WALLETS: bad }, NOW)).toThrow(/PACK_MIN_WALLETS/);
  });

  it("redacts credential-bearing RPC URLs", () => {
    expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=secret123")).toBe("https://mainnet.helius-rpc.com/[redacted]");
    expect(redactUrl("wss://user:pass@rpc.example/abc")).not.toContain("pass");
    expect(redactUrl("wss://api.mainnet-beta.solana.com")).toBe("wss://api.mainnet-beta.solana.com");
  });
});

describe("price policy", () => {
  it("defaults to the 1m baseline and accepts only the documented 5m fallback", () => {
    expect(loadConfig({}, NOW).price.policy).toMatchObject({ timeframe: "1m", version: "nansen-1m-closed-v1", maxCandleAgeMs: 120_000, isBaseline: true });
    expect(loadConfig({ PRICE_TIMEFRAME: "5m" }, NOW).price.policy).toMatchObject({ timeframe: "5m", version: "nansen-5m-closed-v1", candleMs: 300_000, maxCandleAgeMs: 900_000, maxFetchAgeMs: 120_000, isBaseline: false });
    expect(() => loadConfig({ PRICE_TIMEFRAME: "15m" }, NOW)).toThrow(ConfigError);
    // Detector baseline is unchanged by the price policy.
    expect(loadConfig({ PRICE_TIMEFRAME: "5m" }, NOW).detector.version).toBe("pack-baseline-v1");
  });
});

describe("Pyth price and 24/7 Nansen modes", () => {
  const live = { APP_MODE: "live", NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "100", SOLANA_RPC_HTTP_URL: "https://x.test", SOLANA_RPC_WS_URL: "wss://x.test", ADMIN_TOKEN: "a".repeat(40) };

  it("PRICE_PROVIDER=pyth selects pyth-onchain-v1 and polls every 5 s by default; detection is unchanged", () => {
    const c = loadConfig({ PRICE_PROVIDER: "pyth", PRICE_TIMEFRAME: "5m" }, NOW);
    expect(c.price.provider).toBe("pyth");
    expect(c.price.policy).toMatchObject({ provider: "pyth", timeframe: "tick", version: "pyth-onchain-v1", candleMs: 0, maxCandleAgeMs: 120_000, maxFetchAgeMs: 120_000, isBaseline: false });
    expect(c.price.refreshSeconds).toBe(5);
    expect(loadConfig({}, NOW).price.refreshSeconds).toBe(30);
    expect(loadConfig({ PRICE_PROVIDER: "pyth", PRICE_REFRESH_SECONDS: "10" }, NOW).price.refreshSeconds).toBe(10);
    expect(() => loadConfig({ PRICE_REFRESH_SECONDS: "2" }, NOW)).toThrow(/at least 5 for Nansen/);
    expect(c.detector.version).toBe("pack-baseline-v1");
  });

  it("with Pyth, live mode needs no Nansen session: off without a cap, continuous with one", () => {
    const off = loadConfig({ ...live, PRICE_PROVIDER: "pyth" }, NOW);
    expect(off.nansen).toMatchObject({ sessionEndAtMs: null, continuous: false, dailyCreditCap: null });
    const zero = loadConfig({ ...live, PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "0" }, NOW);
    expect(zero.nansen).toMatchObject({ continuous: false, dailyCreditCap: 0 });
    const on = loadConfig({ ...live, PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "500" }, NOW);
    expect(on.nansen).toMatchObject({ continuous: true, dailyCreditCap: 500 });
    // A bounded session still works and takes precedence over continuous mode.
    const bounded = loadConfig({ ...live, PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "500", NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z" }, NOW);
    expect(bounded.nansen).toMatchObject({ continuous: false, dailyCreditCap: 500 });
    expect(() => loadConfig({ ...live, PRICE_PROVIDER: "pyth", NANSEN_SESSION_END_AT: "2026-09-25T11:00:00Z" }, NOW)).toThrow(/in the past/);
    expect(() => loadConfig({ ...live, PRICE_PROVIDER: "pyth", NANSEN_DAILY_CREDIT_CAP: "5.5" }, NOW)).toThrow(/NANSEN_DAILY_CREDIT_CAP/);
    // Nansen prices still need a session: a cap alone never starts 24/7 paid polling.
    expect(() => loadConfig({ ...live, NANSEN_DAILY_CREDIT_CAP: "500" }, NOW)).toThrow(/NANSEN_SESSION_END_AT is required/);
    expect(loadConfig({ ...live, NANSEN_DAILY_CREDIT_CAP: "500", NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z" }, NOW).nansen.continuous).toBe(false);
  });

  it("the global Smart Money feed can be turned off while per-pack Smart Money stays on", () => {
    expect(loadConfig({ SMART_MONEY_ENABLED: "true" }, NOW).smartMoney).toMatchObject({ enabled: true, feedEnabled: true });
    expect(loadConfig({ SMART_MONEY_ENABLED: "true", SMART_MONEY_FEED_ENABLED: "false" }, NOW).smartMoney).toMatchObject({ enabled: true, feedEnabled: false });
    expect(loadConfig({ SMART_MONEY_ENABLED: "false", SMART_MONEY_FEED_ENABLED: "true" }, NOW).smartMoney).toMatchObject({ enabled: false, feedEnabled: false });
    // The feed covers every token unless limited to new ones.
    expect(loadConfig({}, NOW).smartMoney.feedMaxTokenAgeDays).toBeNull();
    expect(loadConfig({ SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS: "1" }, NOW).smartMoney.feedMaxTokenAgeDays).toBe(1);
    expect(loadConfig({ SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS: "0" }, NOW).smartMoney.feedMaxTokenAgeDays).toBe(0);
    for (const bad of ["-1", "1.5", "400"]) expect(() => loadConfig({ SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS: bad }, NOW)).toThrow(/SMART_MONEY_FEED_MAX_TOKEN_AGE_DAYS/);
  });
});
