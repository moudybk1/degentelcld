/**
 * Totals of an archived live namespace (an earlier rule) are counted on a
 * worker thread, never on the main thread that runs the collector, and are
 * persisted so a restart does not count again. Uses a real database file,
 * because a worker cannot open an in-memory database. No network access.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig, PUMP_PROGRAM_ID, ROOT_DIR } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { TRADE_EVENT_DISCRIMINATOR } from "../../apps/server/src/collector/decoder.js";
import { base58Decode } from "../../apps/server/src/lib/base58.js";
import type { FetchLike } from "../../apps/server/src/adapters/nansen/client.js";
import { addr, MINT, sig } from "../helpers.js";

const START = Date.UTC(2026, 8, 26, 4, 42, 13);

function tradeLog(user: string, lamports: bigint, tsSec: number): string {
  const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8);
  let o = 0;
  Buffer.from(TRADE_EVENT_DISCRIMINATOR).copy(b, o); o += 8;
  Buffer.from(base58Decode(MINT)!).copy(b, o); o += 32;
  b.writeBigUInt64LE(lamports, o); o += 8;
  b.writeBigUInt64LE(1_000_000_000n, o); o += 8;
  b.writeUInt8(1, o); o += 1;
  Buffer.from(base58Decode(user)!).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(tsSec), o);
  return `Program data: ${b.toString("base64")}`;
}
const txLogs = (line: string) => [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Buy", line, `Program ${PUMP_PROGRAM_ID} success`];
const account = (JSON.parse(readFileSync(join(ROOT_DIR, "fixtures/recorded/pyth-sol-usd-account.json"), "utf8")) as { value: unknown }).value;
const rpc: FetchLike = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: account } }) });
const nansen: FetchLike = async () => {
  throw new Error("Nansen must not be called");
};

const dir = mkdtempSync(join(tmpdir(), "packlens-archived-"));
const DB = join(dir, "packlens.sqlite");
const env = (extra: Record<string, string>) => ({
  APP_MODE: "live", PRICE_PROVIDER: "pyth", DATABASE_PATH: DB, ADMIN_TOKEN: "t".repeat(40), NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "500",
  SOLANA_RPC_HTTP_URL: "https://rpc.invalid", SOLANA_RPC_WS_URL: "wss://rpc.invalid", ...extra,
});

async function until<T>(read: () => T, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("archived live namespace totals", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("are counted off the main thread, reported as pending meanwhile, and persisted", async () => {
    // 1. A baseline-rule run records four buys in live:packlens-live.
    const clock = new VirtualClock(START + 1500);
    const first = Runtime.create(loadConfig(env({}), clock.now()), { clock, fetchImpl: nansen, rpcFetchImpl: rpc, startCollector: false });
    first.start();
    first.live!.pricePoller.stop();
    await first.live!.pricePoller.pollQuote(first.config.price.quotes[0]!);
    for (let i = 0; i < 4; i++) {
      clock.set(START + (2 + i) * 1000 + 800);
      first.handleTransaction({ signature: sig(`arch-${i}`), slot: 10 + i, err: null, logs: txLogs(tradeLog(addr(`arch-${i}`), 250_000_000n, Math.floor(START / 1000) + 2 + i)), receivedAtMs: clock.now() });
    }
    clock.set(START + 9_000);
    first.live!.pipeline.tick();
    expect(first.primaryNamespace).toBe("live:packlens-live");
    await first.stop();

    // 2. The rule changes: the baseline namespace is now archived.
    const second = Runtime.create(loadConfig(env({ PACK_MIN_WALLETS: "5", PACK_MIN_TRADE_USD: "25" }), clock.now()), { clock, fetchImpl: nansen, rpcFetchImpl: rpc, startCollector: false });
    second.start();
    second.live!.pricePoller.stop();
    expect(second.primaryNamespace).toBe("live:packlens-live:5w-25usd");
    const pending = second.status("live:packlens-live");
    expect(pending.countersPending).toBe(true);
    expect(pending.counters.buys).toBe(0);
    const counted = await until(() => second.status("live:packlens-live"), (s) => s.countersPending !== true);
    expect(counted.countersPending).toBeUndefined();
    expect(counted.counters).toMatchObject({ decodedEvents: 4, buys: 4, sells: 0, eligible: 4 });
    // The live namespace keeps its in-memory counters and is never pending.
    expect(second.status(second.primaryNamespace).countersPending).toBeUndefined();
    await second.stop();

    // 3. After a restart the stored totals answer at once.
    const third = Runtime.create(loadConfig(env({ PACK_MIN_WALLETS: "5", PACK_MIN_TRADE_USD: "25" }), clock.now()), { clock, fetchImpl: nansen, rpcFetchImpl: rpc, startCollector: false });
    third.start();
    third.live!.pricePoller.stop();
    expect(third.status("live:packlens-live").counters.buys).toBe(4);
    await third.stop();
  });
});
