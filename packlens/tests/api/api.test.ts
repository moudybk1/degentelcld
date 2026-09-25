import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { fakeFetch } from "../helpers.js";

const TOKEN = "operator-token-for-api-tests-0123456789";

describe("fixture API", () => {
  const config = loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:", ADMIN_TOKEN: TOKEN });
  const rt = Runtime.create(config);
  rt.start();
  const app = buildServer(rt);
  afterAll(() => app.close());

  it("serves envelopes with mode, namespace, and schema version", async () => {
    const r = await app.inject({ url: "/api/packs" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ schemaVersion: "pack-list.v1", mode: "fixture", namespace: "fixture:synthetic-demo-v1" });
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(r.headers["x-outbox-sequence"]).toBeDefined();
  });

  it("rejects invalid input with English errors", async () => {
    expect((await app.inject({ url: "/api/packs?minWallets=2" })).json().error.code).toBe("INVALID_INPUT");
    expect((await app.inject({ url: "/api/packs?mint=https://example.com" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/packs?namespace=live:nope" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/wallets/solana/notanaddress" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/tokens/ethereum/So11111111111111111111111111111111111111112" })).statusCode).toBe(400);
  });

  it("cursors are signed and bound to namespace and filters", async () => {
    const first = (await app.inject({ url: "/api/packs?limit=1" })).json();
    const cursor = first.data.nextCursor as string;
    expect(cursor).toBeTruthy();
    expect((await app.inject({ url: `/api/packs?limit=1&cursor=${encodeURIComponent(cursor)}` })).statusCode).toBe(200);
    const tampered = cursor.slice(0, -2) + (cursor.endsWith("AA") ? "BB" : "AA");
    expect((await app.inject({ url: `/api/packs?limit=1&cursor=${encodeURIComponent(tampered)}` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/packs?limit=1&minWallets=4&cursor=${encodeURIComponent(cursor)}` })).statusCode).toBe(400);
  });

  it("T38: operator routes reject unauthenticated access", async () => {
    for (const [method, url] of [["GET", "/api/admin/usage"], ["GET", "/api/admin/overview"], ["POST", "/api/admin/replay"], ["POST", "/api/admin/demo-pins"], ["POST", "/api/admin/enrich/" + "a".repeat(64)]] as const) {
      const r = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("T53: login, idempotent mutation, conflict on a reused key with a different body, and logout", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: "wrong" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: TOKEN } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "packlens_operator")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(login.body).not.toContain(TOKEN);
    const headers = { cookie: `packlens_operator=${cookie.value}`, "idempotency-key": "key-00000001" };
    const mint = "So11111111111111111111111111111111111111112";
    const a = await app.inject({ method: "POST", url: "/api/admin/demo-pins", headers, payload: { chain: "solana", mint, enabled: true } });
    expect(a.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/admin/demo-pins", headers, payload: { chain: "solana", mint, enabled: true } });
    expect(again.json()).toEqual(a.json());
    const conflict = await app.inject({ method: "POST", url: "/api/admin/demo-pins", headers, payload: { chain: "solana", mint, enabled: false } });
    expect(conflict.statusCode).toBe(409);
    // Cross-origin cookie mutation is rejected.
    const csrf = await app.inject({ method: "POST", url: "/api/admin/demo-pins", headers: { ...headers, "idempotency-key": "key-00000002", origin: "https://evil.example" }, payload: { chain: "solana", mint, enabled: true } });
    expect(csrf.statusCode).toBe(403);
    // Enrichment is refused outside live mode (fixtures never call providers).
    const pack = (await app.inject({ url: "/api/packs?limit=1" })).json().data.items[0].core.id as string;
    const enrich = await app.inject({ method: "POST", url: `/api/admin/enrich/${pack}`, headers: { ...headers, "idempotency-key": "key-00000003" } });
    expect(enrich.statusCode).toBe(409);
    await app.inject({ method: "POST", url: "/api/admin/logout", headers });
    expect((await app.inject({ url: "/api/admin/usage", headers })).statusCode).toBe(401);
  });

  it("login is rate-limited to five attempts per minute", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: "nope" }, remoteAddress: "10.0.0.9" })).statusCode);
    expect(codes.slice(-2)).toEqual([429, 429]);
  });

  it("operators can replay a registered dataset into a new namespace with an identical digest", async () => {
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: TOKEN }, remoteAddress: "10.0.0.2" });
    const cookie = login.cookies.find((c) => c.name === "packlens_operator")!.value;
    const r1 = await app.inject({ method: "POST", url: "/api/admin/replay", headers: { cookie: `packlens_operator=${cookie}`, "idempotency-key": "replay-000001" }, payload: { datasetId: "synthetic-demo-v1", mode: "recorded-arrival" } });
    const r2 = await app.inject({ method: "POST", url: "/api/admin/replay", headers: { cookie: `packlens_operator=${cookie}`, "idempotency-key": "replay-000002" }, payload: { datasetId: "synthetic-demo-v1", mode: "recorded-arrival" } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().namespace).toMatch(/^replay:/);
    expect(r1.json().namespace).not.toBe(r2.json().namespace);
    expect(r1.json().digest).toBe(r2.json().digest);
    const bad = await app.inject({ method: "POST", url: "/api/admin/replay", headers: { cookie: `packlens_operator=${cookie}`, "idempotency-key": "replay-000003" }, payload: { datasetId: "../../etc/passwd" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("live mode: public GET never spends credits (T38)", () => {
  const fake = fakeFetch(() => ({ status: 200, body: { chain: "solana", token_address: "So11111111111111111111111111111111111111112", timeframe: "1m", data: [] } }));
  const config = loadConfig(
    {
      APP_MODE: "live",
      DATABASE_PATH: ":memory:",
      ADMIN_TOKEN: TOKEN,
      NANSEN_API_KEY: "test-key",
      NANSEN_BUDGET_CREDITS: "100",
      NANSEN_SESSION_END_AT: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      SOLANA_RPC_HTTP_URL: "https://rpc.invalid",
      SOLANA_RPC_WS_URL: "wss://rpc.invalid",
      SMART_MONEY_ENABLED: "true",
    },
    Date.now(),
  );
  const rt = Runtime.create(config, { fetchImpl: fake.fn as never, startCollector: false });
  rt.start();
  const app = buildServer(rt);
  beforeAll(async () => {
    // Stop background work so only request-driven calls could reach the provider.
    rt.live!.pricePoller.stop();
    rt.live!.scheduler.stop();
    await rt.live!.worker.stop(1000);
  });
  afterAll(async () => {
    await app.close();
  });

  it("a battery of public GETs makes zero provider calls", async () => {
    const before = fake.calls;
    const mint = "So11111111111111111111111111111111111111112";
    for (const url of ["/api/health", "/api/status", "/api/packs", `/api/tokens/solana/${mint}`, `/api/wallets/solana/${mint}`, "/api/smart-money/activity", "/api/admin/me"]) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBeLessThan(500);
    }
    expect(fake.calls).toBe(before);
    const status = (await app.inject({ url: "/api/status" })).json().data;
    expect(status.mode).toBe("live");
    expect(status.session.active).toBe(true);
    expect(status.collector.health).toBe("not_configured");
  });

  it("the usage summary never exposes the key", async () => {
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { token: TOKEN } });
    const cookie = login.cookies.find((c) => c.name === "packlens_operator")!.value;
    const r = await app.inject({ url: "/api/admin/overview", headers: { cookie: `packlens_operator=${cookie}` } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("test-key");
  });
});

describe("T36: SSE replay and resync", () => {
  const config = loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" });
  const rt = Runtime.create(config);
  rt.start();
  const app = buildServer(rt);
  let port = 0;
  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  function readSse(query: string, ms = 400): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: `/api/events${query}`, headers: { Accept: "text/event-stream" } }, (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        setTimeout(() => {
          req.destroy();
          resolve(buf);
        }, ms);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("replays retained outbox rows after Last-Event-ID", async () => {
    const text = await readSse("?lastEventId=0");
    expect(text).toContain("event: pack.created");
    expect(text).toMatch(/id: \d+/);
  });

  it("asks for a resync when the cursor is ahead of the outbox", async () => {
    const text = await readSse("?lastEventId=999999999");
    expect(text).toContain("event: resync_required");
  });

  it("a fresh subscription starts from the latest sequence without replaying history", async () => {
    const text = await readSse("");
    expect(text).not.toContain("pack.created");
    expect(text).toContain("retry: 3000");
  });
});
