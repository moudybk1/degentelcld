import { afterAll, describe, expect, it } from "vitest";
import type { PackListItem } from "@packlens/contracts";
import { loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { FetchRefused, isPublicAddress, limitedFetch, type LimitedFetch } from "../../apps/server/src/metadata/safeFetch.js";
import { IPFS_GATEWAY, ipfsPath, PUBLIC_IPFS_GATEWAY, sniffImage, TokenImageResolver } from "../../apps/server/src/metadata/tokenImages.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const CID = "QmUA4EvNCdZbnUKc8QYieYEaW2f3yzM5V81rVCMPaWEVjG";
const CID2 = "bafkreibpw5rnftefxjxtbay7lcudgldi5f2ujp64a33e7wekpjoowj5su4";
const json = (v: unknown) => ({ url: "", contentType: "application/json", bytes: Buffer.from(JSON.stringify(v)) });

describe("logo URL handling", () => {
  it("recognizes IPFS content in its common forms and nothing else", () => {
    expect(ipfsPath(`ipfs://${CID}`)).toBe(CID);
    expect(ipfsPath(`https://ipfs.io/ipfs/${CID}`)).toBe(CID);
    expect(ipfsPath(`https://gateway.pinata.cloud/ipfs/${CID2}/logo.png?x=1`)).toBe(`${CID2}/logo.png`);
    expect(ipfsPath(`https://${CID2}.ipfs.w3s.link/`)).toBe(CID2);
    expect(ipfsPath("https://metadata.j7tracker.io/m/xQ7k1qit0m")).toBeNull();
    expect(ipfsPath(`https://ipfs.io/ipfs/${CID}/../../secret`)).toBeNull();
    expect(ipfsPath("https://ipfs.io/ipfs/not-a-cid")).toBeNull();
  });

  it("accepts raster images by their bytes, never SVG or text", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from("<html></html>"))).toBeNull();
  });

  it("refuses non-public, non-https, and credentialed URLs before connecting", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.5", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.5"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("104.16.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("::ffff:104.16.1.1")).toBe(true);
    const refused = (u: string, reason: FetchRefused["reason"]) => expect(limitedFetch(u, { maxBytes: 10, accept: "*/*" })).rejects.toMatchObject({ reason });
    await refused("http://example.com/a.json", "not_https");
    await refused("javascript:alert(1)", "not_https");
    await refused("https://127.0.0.1/a.json", "private_address");
    await refused("https://[::1]/a.json", "private_address");
    await refused("https://169.254.169.254/latest/meta-data", "private_address");
    await refused("https://localhost/a.json", "private_address");
    await refused("https://metadata.internal/a", "private_address");
    await refused("https://intranet/a", "private_address");
    await refused("https://user:pw@example.com/a", "credentials");
    await refused("https://example.com:8443/a", "port");
  });
});

describe("token logo resolver", () => {
  const rt = Runtime.create(loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" }));
  rt.start();
  const app = buildServer(rt);
  const ns = rt.primaryNamespace;
  afterAll(() => app.close());
  const mintOf = (symbol: string) => (rt.db.prepare("SELECT mint FROM tokens WHERE namespace = ? AND symbol = ?").get(ns, symbol) as { mint: string }).mint;
  const setUri = (symbol: string, uri: string) => rt.db.prepare("UPDATE tokens SET uri = ? WHERE namespace = ? AND symbol = ?").run(uri, ns, symbol);
  const state = (symbol: string) =>
    rt.db.prepare("SELECT state, attempts, error, content_type FROM token_images WHERE namespace = ? AND mint = ?").get(ns, mintOf(symbol)) as
      | { state: string; attempts: number; error: string | null; content_type: string | null }
      | undefined;

  it("stores logos, rejects unsafe or missing images, and retries only transient failures", async () => {
    setUri("LMOTH", `ipfs://${CID}`);
    setUri("FINCH", "https://meta.example.com/finch.json");
    setUri("HARBR", "https://meta.example.com/harbor.json");
    setUri("SALTM", "https://meta.example.com/salt.json");
    const requested: string[] = [];
    let harborCalls = 0;
    const fetcher: LimitedFetch = async (url) => {
      requested.push(url);
      if (url === `${IPFS_GATEWAY}${CID}`) return json({ name: "Lantern Moth", image: `https://ipfs.io/ipfs/${CID2}` });
      if (url.startsWith(`${IPFS_GATEWAY}${CID2}?`)) return { url, contentType: "image/webp", bytes: WEBP };
      if (url === "https://meta.example.com/finch.json") return json({ image: "https://img.example.com/finch.svg" });
      if (url === "https://img.example.com/finch.svg") return { url, contentType: "image/png", bytes: SVG }; // lies about its type
      if (url === "https://meta.example.com/harbor.json") {
        harborCalls++;
        throw new FetchRefused("http_status", "HTTP 503");
      }
      if (url === "https://meta.example.com/salt.json") return json({ name: "Salt Meridian" });
      throw new Error(`unexpected ${url}`);
    };
    const clock = new VirtualClock(Date.now());
    const resolver = new TokenImageResolver(rt.db, clock, ns, fetcher);
    let attempted = 0;
    for (let i = 0; i < 5; i++) attempted += await resolver.runOnce();
    expect(attempted).toBe(4);

    expect(state("LMOTH")).toMatchObject({ state: "ok", content_type: "image/webp" });
    // IPFS goes through the resizing gateway, never the public gateway named in the metadata.
    expect(requested.some((u) => u.includes("ipfs.io"))).toBe(false);
    expect(requested.find((u) => u.startsWith(`${IPFS_GATEWAY}${CID2}`))).toContain("img-width=96");
    expect(state("FINCH")).toMatchObject({ state: "missing", error: "not_image" });
    expect(state("SALTM")).toMatchObject({ state: "missing", error: "no_image" });
    expect(state("HARBR")).toMatchObject({ state: "failed", attempts: 1 });

    // Transient failures wait for a backoff; permanent ones are never retried.
    expect(await resolver.runOnce()).toBe(0);
    clock.advance(5 * 60_000);
    expect(await resolver.runOnce()).toBe(1);
    expect(harborCalls).toBe(2);
    expect(state("HARBR")).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("serves a stored logo inertly and links it from token identity", async () => {
    const items = (await app.inject({ url: "/api/packs?limit=50" })).json().data.items as PackListItem[];
    const moth = items.find((i) => i.token.symbol === "LMOTH")!;
    expect(moth.token.imageUrl).toMatch(new RegExp(`^/api/tokens/solana/${moth.core.tokenAddress}/image\\?namespace=.+&v=[0-9a-f]{16}$`));
    expect(items.filter((i) => i.token.symbol !== "LMOTH").every((i) => i.token.imageUrl === null)).toBe(true);

    const r = await app.inject({ url: moth.token.imageUrl! });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/webp");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect(r.headers["cache-control"]).toContain("immutable");
    expect(r.rawPayload.equals(WEBP)).toBe(true);

    expect((await app.inject({ url: `/api/tokens/solana/${mintOf("FINCH")}/image` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/tokens/solana/not-a-mint/image" })).statusCode).toBe(400);
  });

  it("falls back to the public gateway for IPFS content pump.fun does not host", async () => {
    rt.db.prepare("DELETE FROM token_images").run();
    for (const sym of ["FINCH", "HARBR", "SALTM"]) setUri(sym, "");
    const CID3 = "bafkreiebravfrqv44qb4x4i6xqzwcdyykz2mfmhxhm3wbv5ckdtl3uxmxa";
    setUri("LMOTH", `https://ipfs.io/ipfs/${CID3}`);
    const requested: { url: string; timeoutMs: number | undefined }[] = [];
    const resolver = new TokenImageResolver(rt.db, new VirtualClock(Date.now()), ns, async (url, opts) => {
      requested.push({ url, timeoutMs: opts.timeoutMs });
      if (url.startsWith(IPFS_GATEWAY)) throw new FetchRefused("http_status", "HTTP 403", 403);
      if (url === `${PUBLIC_IPFS_GATEWAY}${CID3}`) return json({ image: `ipfs://${CID2}` });
      if (url === `${PUBLIC_IPFS_GATEWAY}${CID2}`) return { url, contentType: "image/png", bytes: PNG };
      throw new Error(`unexpected ${url}`);
    });
    expect(await resolver.runOnce()).toBe(1);
    expect(state("LMOTH")).toMatchObject({ state: "ok", content_type: "image/png" });
    // pump.fun's gateway is tried first for both files; the public one gets a longer deadline and no resize parameters.
    expect(requested.map((r) => r.url)).toEqual([`${IPFS_GATEWAY}${CID3}`, `${PUBLIC_IPFS_GATEWAY}${CID3}`, `${IPFS_GATEWAY}${CID2}?img-width=96&img-height=96&img-fit=cover&img-format=webp`, `${PUBLIC_IPFS_GATEWAY}${CID2}`]);
    expect(requested.filter((r) => r.url.startsWith(PUBLIC_IPFS_GATEWAY)).every((r) => (r.timeoutMs ?? 0) > 8000)).toBe(true);
  });

  it("pauses only when pump.fun's shared gateway rate limits", async () => {
    rt.db.prepare("DELETE FROM token_images").run();
    // A rate limit from one creator-chosen host does not stop other lookups.
    setUri("LMOTH", "https://meta.example.com/moth.json");
    setUri("FINCH", "https://meta.example.com/finch.json");
    setUri("HARBR", "https://meta.example.com/harbor.json");
    setUri("SALTM", "https://meta.example.com/salt.json");
    const clock = new VirtualClock(Date.now());
    const busyHost = new TokenImageResolver(rt.db, clock, ns, async () => {
      throw new FetchRefused("rate_limited", "HTTP 429", 429);
    });
    expect(await busyHost.runOnce()).toBe(3);
    expect(await busyHost.runOnce()).toBe(1);

    rt.db.prepare("DELETE FROM token_images").run();
    for (const [sym, i] of [["LMOTH", 0], ["FINCH", 1], ["HARBR", 2], ["SALTM", 3]] as const) setUri(sym, `ipfs://${CID.slice(0, -1)}${"ABCD"[i]}`);
    let calls = 0;
    const busyGateway = new TokenImageResolver(rt.db, clock, ns, async () => {
      calls++;
      throw new FetchRefused("rate_limited", "HTTP 429", 429);
    });
    expect(await busyGateway.runOnce()).toBe(3);
    expect(await busyGateway.runOnce()).toBe(0);
    expect(calls).toBe(3);
    clock.advance(61_000);
    expect(await busyGateway.runOnce()).toBe(1);
  });
});
