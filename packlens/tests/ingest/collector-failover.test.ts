import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { PumpCollector, RETRY_PRIMARY_AFTER_MS, type RawTransaction } from "../../apps/server/src/collector/collector.js";
import { ensureNamespace } from "../../apps/server/src/replay/runner.js";
import { T0, testDb } from "../helpers.js";

const NS = "live:failover";

/**
 * A logsSubscribe server that refuses the upgrade, confirms the subscription and then
 * closes without data (a plan out of credits may do either), or confirms and sends a notification.
 */
async function rpcServer(opts: { refuse: () => boolean; silent?: () => boolean }) {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (_info, done) => {
      server.attempts++;
      if (opts.refuse()) done(false, 429, "Too Many Requests");
      else done(true);
    },
  }) as WebSocketServer & { attempts: number };
  server.attempts = 0;
  server.on("connection", (ws) => {
    ws.on("message", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }));
      if (opts.silent?.()) {
        setTimeout(() => ws.close(), 50);
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: { context: { slot: 9 }, value: { signature: `sig-${server.attempts}`, err: null, logs: ["Program log: x"] } } } }));
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("collector endpoint failover", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("moves to the fallback after three refused connects, then tries the primary again after 30 minutes", async () => {
    let primaryUp = false;
    const primary = await rpcServer({ refuse: () => !primaryUp });
    const fallback = await rpcServer({ refuse: () => false });
    const db = testDb();
    ensureNamespace(db, NS, "live", "test", null, T0);
    const clock = new VirtualClock(Date.now());
    const txs: RawTransaction[] = [];
    const c = new PumpCollector([primary.url(), fallback.url()], clock, db, NS, (tx) => txs.push(tx));
    cleanups.push(() => c.stop(), () => primary.server.close(), () => fallback.server.close());
    c.start();

    await until(() => c.health === "connected");
    expect(primary.server.attempts).toBe(3);
    expect(c.endpoint).toBe("fallback");
    await until(() => txs.length > 0);

    // Half an hour later the fallback drops; the reconnect tries the primary first.
    primaryUp = true;
    clock.advance(RETRY_PRIMARY_AFTER_MS);
    for (const ws of fallback.server.clients) ws.terminate();
    await until(() => c.endpoint === "primary" && c.health === "connected");
    expect(primary.server.attempts).toBe(4);
    // Every disconnect was recorded as a gap and closed once the stream was back.
    expect(db.prepare("SELECT COUNT(*) FROM collector_gaps WHERE namespace = ? AND recovery_state = 'open'").pluck().get(NS)).toBe(0);
  }, 30_000);

  it("also leaves an endpoint that confirms the subscription but then closes without sending data", async () => {
    const primary = await rpcServer({ refuse: () => false, silent: () => true });
    const fallback = await rpcServer({ refuse: () => false });
    const db = testDb();
    ensureNamespace(db, NS, "live", "test", null, T0);
    const txs: RawTransaction[] = [];
    const c = new PumpCollector([primary.url(), fallback.url()], new VirtualClock(Date.now()), db, NS, (tx) => txs.push(tx));
    cleanups.push(() => c.stop(), () => primary.server.close(), () => fallback.server.close());
    c.start();
    await until(() => txs.length > 0);
    expect(primary.server.attempts).toBe(3);
    expect(c.endpoint).toBe("fallback");
  }, 30_000);
});
