import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactUrl, ROOT_DIR } from "../../apps/server/src/config.js";

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

  it("rejects a past session end, a non-integer budget, and baseline changes", () => {
    const live = { APP_MODE: "live", NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "100", SOLANA_RPC_HTTP_URL: "https://x.test", SOLANA_RPC_WS_URL: "wss://x.test", ADMIN_TOKEN: "a".repeat(40) };
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T11:00:00Z" }, NOW)).toThrow(/in the past/);
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z", NANSEN_BUDGET_CREDITS: "12.5" }, NOW)).toThrow(/positive integer/);
    expect(() => loadConfig({ PACK_MIN_TRADE_USD: "10" }, NOW)).toThrow(/only "20"/);
    expect(() => loadConfig({ PRICE_PROVIDER: "jupiter" }, NOW)).toThrow(/only "nansen"/);
    expect(() => loadConfig({ QUOTE_ASSET_ALLOWLIST: "SOL,USDC" }, NOW)).toThrow(/not validated in P0/);
    expect(() => loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z", SMART_MONEY_SESSION_END_AT: "2026-09-25T14:00:00Z" }, NOW)).toThrow(/cannot be later/);
    const ok = loadConfig({ ...live, NANSEN_SESSION_END_AT: "2026-09-25T13:00:00Z" }, NOW);
    expect(ok.smartMoney.sessionEndAtMs).toBe(ok.nansen.sessionEndAtMs);
    expect(ok.nansen.budgetCredits).toBe(100);
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
