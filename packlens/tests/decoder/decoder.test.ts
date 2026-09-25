import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeLogs, decodeTradeEvent, PUMP_IDL_SHA256, TRADE_EVENT_DISCRIMINATOR } from "../../apps/server/src/collector/decoder.js";
import { ROOT_DIR } from "../../apps/server/src/config.js";
import { sha256Hex } from "../../apps/server/src/lib/ids.js";

type Tx = { signature: string; slot: number; blockTime: number; err: unknown; logs: string[] };
const recorded = JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pumpfun-sample-transactions.json"), "utf8")) as { transactions: Tx[] };
const bySig = (prefix: string) => recorded.transactions.find((t) => t.signature.startsWith(prefix))!;

describe("pinned IDL", () => {
  it("matches the recorded hash and TradeEvent field order", () => {
    const text = readFileSync(join(ROOT_DIR, "apps/server/src/collector/pump-idl.json"), "utf8");
    expect(sha256Hex(text)).toBe(PUMP_IDL_SHA256);
    const idl = JSON.parse(text) as { address: string; events: { name: string; discriminator: number[] }[]; types: { name: string; type: { fields: { name: string }[] } }[] };
    expect(idl.address).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(idl.events.find((e) => e.name === "TradeEvent")!.discriminator).toEqual([...TRADE_EVENT_DISCRIMINATOR]);
    const fields = idl.types.find((t) => t.name === "TradeEvent")!.type.fields.map((f) => f.name);
    expect(fields.slice(0, 6)).toEqual(["mint", "sol_amount", "token_amount", "is_buy", "user", "timestamp"]);
    expect(fields.slice(-6)).toEqual(["quote_mint", "quote_amount", "virtual_quote_reserves", "real_quote_reserves", "holder_rewards_bps", "holder_rewards"]);
  });
});

describe("real mainnet transactions (recorded 2026-09-25)", () => {
  it("decodes a buy with the trading wallet, mint, amounts, and chain timestamp", () => {
    const tx = bySig("4xKwhKHW");
    const d = decodeLogs(tx.logs);
    expect(d.errors).toBe(0);
    expect(d.trades).toHaveLength(1);
    const t = d.trades[0]!;
    expect(t).toMatchObject({
      ordinal: 0,
      mint: "iukEZsyfa3r9x2yZ2WcB4ne8AJCfcywUTaLpjMCpump",
      solAmountRaw: "16830001",
      tokenAmountRaw: "69510430509",
      isBuy: true,
      user: "FcXwvUZT7KcRoY86jQdYrt952pvEpYfo3qVywXuLCViN",
      feeRaw: "159886",
      creatorFeeRaw: "50491",
      ixName: "buy",
      quoteMint: "11111111111111111111111111111111",
      quoteAmountRaw: "16830001",
    });
    expect(t.timestampSec).toBe(tx.blockTime);
  });

  it("decodes a sell executed through a router (pump program at invoke depth 2)", () => {
    const d = decodeLogs(bySig("5uNM1nzF").logs);
    expect(d.trades).toHaveLength(1);
    expect(d.trades[0]).toMatchObject({ isBuy: false, user: "BRC94JagEKBQgWTtWQAxwKz54vaEooLBdRhg4LZ2hqfR", solAmountRaw: "689133184", ixName: "sell" });
  });

  it("a failed transaction yields no trade events", () => {
    const tx = bySig("33o1G7Bf");
    expect(tx.err).not.toBeNull();
    expect(decodeLogs(tx.logs).trades).toHaveLength(0);
  });
});

describe("decoder robustness", () => {
  const buyLine = bySig("4xKwhKHW").logs.find((l) => l.startsWith("Program data: "))!;
  const full = Buffer.from(buyLine.slice(14), "base64");

  it("reads a legacy (shorter) layout, ending at a field boundary", () => {
    const legacy = full.subarray(0, 8 + 32 + 8 + 8 + 1 + 32 + 8);
    const t = decodeTradeEvent(Buffer.from(legacy), 0);
    expect(t.quoteMint).toBeNull();
    expect(t.feeRaw).toBeNull();
  });

  it("rejects data that ends inside a field", () => {
    expect(() => decodeTradeEvent(Buffer.from(full.subarray(0, 60)), 0)).toThrow();
  });

  it("ignores Program data emitted by other programs and assigns deterministic ordinals", () => {
    const logs = [
      "Program Other1111111111111111111111111111111111111 invoke [1]",
      buyLine,
      "Program Other1111111111111111111111111111111111111 success",
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
      buyLine,
      buyLine,
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
      "Log truncated",
    ];
    const d = decodeLogs(logs);
    expect(d.trades.map((t) => t.ordinal)).toEqual([0, 1]);
    expect(d.truncated).toBe(true);
  });
});

describe("token lifecycle events (recorded 2026-09-25)", () => {
  const lifecycle = JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pumpfun-lifecycle-transactions.json"), "utf8")) as { transactions: (Tx & { kind: string })[] };
  const byKind = (k: string) => lifecycle.transactions.find((t) => t.kind === k)!;

  it("reads the total supply from a create event", () => {
    const d = decodeLogs(byKind("create").logs);
    expect(d.errors).toBe(0);
    expect(d.creates).toHaveLength(1);
    expect(d.creates[0]).toMatchObject({ mint: "BiV37NuYD9HAepqi74Nfdt2pJ5V4M4RXuBBeBJ6pump", symbol: "THAT", timestampSec: 1790337358, totalSupplyRaw: "1000000000000000" });
    expect(d.completes).toHaveLength(0);
  });

  it("decodes a bonding-curve completion with its mint and time", () => {
    const d = decodeLogs(byKind("complete").logs);
    expect(d.errors).toBe(0);
    expect(d.completes).toEqual([{ user: "2Lj3tW4vh5iYSvV2MxjonVHiHuNibh1YpbufjiycjJZw", mint: "6YPBSCw75eyNg2aBzbULro2hULX5iLaeJSSZuPQTpump", timestampSec: 1790337367 }]);
    expect(d.trades).toHaveLength(1);
  });
});
