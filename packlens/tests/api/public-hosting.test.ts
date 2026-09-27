import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { BusyError, RateLimiter, ReadGate, TtlCache } from "../../apps/server/src/api/protect.js";

const busyWait = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

describe("ReadGate", () => {
  it("runs heavy reads one at a time and lets due timers run between them", async () => {
    const gate = new ReadGate(10);
    const log: string[] = [];
    let ticks = 0;
    const tick = setInterval(() => ticks++, 5);
    const jobs = [1, 2, 3, 4].map((n) =>
      gate.run(() => {
        log.push(`start ${n} after ${ticks} ticks`);
        busyWait(30); // a synchronous read that blocks the loop
        return n;
      }),
    );
    expect(await Promise.all(jobs)).toEqual([1, 2, 3, 4]);
    clearInterval(tick);
    // Every job after the first starts only after the interval got a turn.
    const counts = log.map((l) => Number(/after (\d+)/.exec(l)![1]));
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  });

  it("sheds load past its queue limit and keeps working after a failed job", async () => {
    const gate = new ReadGate(2);
    const a = gate.run(() => 1);
    const b = gate.run(() => {
      throw new Error("boom");
    });
    await expect(gate.run(() => 3)).rejects.toBeInstanceOf(BusyError);
    await expect(a).resolves.toBe(1);
    await expect(b).rejects.toThrow("boom");
    await expect(gate.run(() => 4)).resolves.toBe(4);
  });
});

describe("TtlCache and RateLimiter", () => {
  it("expires entries and evicts the oldest past its size", () => {
    let now = 0;
    const c = new TtlCache<number>(2, () => now);
    c.set("a", 1, 100);
    c.set("b", 2, 100);
    c.set("c", 3, 100);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual([undefined, 2, 3]);
    now = 100;
    expect(c.get("b")).toBeUndefined();
  });

  it("allows `limit` hits per window per key, then reports seconds until reset", () => {
    let now = 0;
    const r = new RateLimiter(3, 60_000, () => now);
    expect([r.hit("x"), r.hit("x"), r.hit("x")]).toEqual([null, null, null]);
    expect(r.hit("x")).toBe(60);
    expect(r.hit("y")).toBeNull();
    now = 45_000;
    expect(r.hit("x")).toBe(15);
    now = 60_000;
    expect(r.hit("x")).toBeNull();
  });

  it("meters weighted work and reports a block without counting", () => {
    let now = 0;
    const r = new RateLimiter(1000, 60_000, () => now);
    expect(r.blockedFor("x")).toBeNull();
    expect(r.hit("x", 600)).toBeNull();
    expect(r.blockedFor("x")).toBeNull();
    r.hit("x", 400); // exactly at the limit: further work waits for the window
    expect(r.blockedFor("x")).toBe(60);
    expect(r.blockedFor("y")).toBeNull();
    now = 60_000;
    expect(r.blockedFor("x")).toBeNull();
  });
});

describe("public hosting configuration", () => {
  it("requires secure cookies and validates trusted proxies", () => {
    expect(() => loadConfig({ PUBLIC_HOSTING: "true" })).toThrow(/SECURE_COOKIES=true/);
    expect(loadConfig({ PUBLIC_HOSTING: "true", SECURE_COOKIES: "true", TRUST_PROXY: "loopback" })).toMatchObject({ publicHosting: true, trustProxy: "127.0.0.1,::1" });
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(() => loadConfig({ TRUST_PROXY: "everyone" })).toThrow(ConfigError);
  });
});

describe("public hosting limits", () => {
  const config = loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:", PUBLIC_HOSTING: "true", SECURE_COOKIES: "true", TRUST_PROXY: "loopback" });
  const rt = Runtime.create(config);
  rt.start();
  const app = buildServer(rt);
  let base = "";
  beforeAll(async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());

  it("limits API requests per client, using the address the trusted proxy reports", async () => {
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    for (let i = 0; i < 600; i++) expect((await app.inject({ url: "/api/admin/me", headers: from("203.0.113.7") })).statusCode).toBe(200);
    const limited = await app.inject({ url: "/api/admin/me", headers: from("203.0.113.7") });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    // Another client is unaffected, and health checks are never limited.
    expect((await app.inject({ url: "/api/admin/me", headers: from("198.51.100.9") })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/health", headers: from("203.0.113.7") })).statusCode).toBe(200);
  });

  it("shares a heavy read between viewers for a few seconds", async () => {
    const first = (await app.inject({ url: "/api/packs?limit=5", headers: { "x-forwarded-for": "192.0.2.1" } })).json();
    const again = (await app.inject({ url: "/api/packs?limit=5", headers: { "x-forwarded-for": "192.0.2.2" } })).json();
    expect(again.data).toEqual(first.data);
    expect(again.requestId).not.toBe(first.requestId);
  });

  it("keys the shared cache on validated parameters, so extra query text cannot bypass it", async () => {
    const first = (await app.inject({ url: "/api/packs?limit=7", headers: { "x-forwarded-for": "192.0.2.3" } })).json();
    const top = first.data.items[0].core.id as string;
    rt.db.prepare("UPDATE packs SET total_wallet_count = total_wallet_count + 1000 WHERE id = ?").run(top);
    try {
      const busted = (await app.inject({ url: "/api/packs?limit=7&x=1&namespace=" + encodeURIComponent(first.namespace), headers: { "x-forwarded-for": "192.0.2.4" } })).json();
      expect(busted.data).toEqual(first.data); // served from the cache, not recomputed
    } finally {
      rt.db.prepare("UPDATE packs SET total_wallet_count = total_wallet_count - 1000 WHERE id = ?").run(top);
    }
  });

  it("drops anonymous analytics writes past the per-client limit", async () => {
    const count = () => (rt.db.prepare("SELECT COUNT(*) AS n FROM analytics_events").get() as { n: number }).n;
    const before = count();
    for (let i = 0; i < 40; i++) {
      const r = await app.inject({ method: "POST", url: "/api/analytics", headers: { "x-forwarded-for": "192.0.2.50" }, payload: { name: "radar_viewed", screen: "radar" } });
      expect(r.statusCode).toBe(204);
    }
    expect(count() - before).toBe(30);
  });

  it("caps live-update streams per client and frees a slot when one closes", async () => {
    const open = () =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const req = get(`${base}/api/events`, { headers: { "x-forwarded-for": "192.0.2.77" } }, resolve);
        req.on("error", reject);
      });
    const streams = await Promise.all(Array.from({ length: 6 }, open));
    expect(streams.map((s) => s.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const seventh = await open();
    expect(seventh.statusCode).toBe(429);
    seventh.resume();
    streams[0]!.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const again = await open();
    expect(again.statusCode).toBe(200);
    for (const s of [...streams, again]) s.destroy();
  });
});
