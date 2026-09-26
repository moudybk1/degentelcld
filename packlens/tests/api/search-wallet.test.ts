import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackDetail, PackListItem, SearchData, TokenPageData, WalletPageData } from "@packlens/contracts";
import { loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";

/** Search, the wallet page's per-pack facts, and token lifecycle times (fixture). */
describe("search and wallet facts (fixture)", () => {
  const rt = Runtime.create(loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" }));
  rt.start();
  const app = buildServer(rt);
  let items: PackListItem[] = [];
  let moth: PackDetail;
  const get = async <T,>(url: string) => {
    const r = await app.inject({ url });
    expect(r.statusCode, url).toBe(200);
    return r.json().data as T;
  };
  beforeAll(async () => {
    items = await get<{ items: PackListItem[] }>("/api/packs?limit=50").then((d) => d.items);
    moth = await get<PackDetail>(`/api/packs/${items.find((i) => i.token.symbol === "LMOTH")!.core.id}`);
  });
  afterAll(() => app.close());

  it("finds tokens with packs by name, symbol, or mint, and wallets by exact address", async () => {
    const byName = await get<SearchData>("/api/search?q=moth");
    expect(byName.tokens.map((t) => t.token.symbol)).toContain("LMOTH");
    expect(byName.tokens[0]!.packs).toBeGreaterThan(0);
    expect(byName.wallet).toBeNull();

    const bySymbol = await get<SearchData>("/api/search?q=saltm");
    const salt = bySymbol.tokens.find((t) => t.token.symbol === "SALTM")!;
    expect(salt.packs).toBe(items.filter((i) => i.token.symbol === "SALTM").length);
    expect(salt.latestPackId).toBe(items.filter((i) => i.token.symbol === "SALTM").sort((a, b) => b.core.triggerEventTimeMs - a.core.triggerEventTimeMs)[0]!.core.id);

    const byMint = await get<SearchData>(`/api/search?q=${moth.core.tokenAddress}`);
    expect(byMint.tokens).toHaveLength(1);
    expect(byMint.tokens[0]!.token.mint).toBe(moth.core.tokenAddress);

    const member = moth.members[0]!.walletAddress;
    const byWallet = await get<SearchData>(`/api/search?q=${member}`);
    expect(byWallet.wallet).toMatchObject({ address: member });
    expect(byWallet.wallet!.packs).toBeGreaterThan(0);
  });

  it("treats search text literally and rejects oversized input", async () => {
    expect((await get<SearchData>("/api/search?q=%25")).tokens).toHaveLength(0);
    expect((await get<SearchData>("/api/search?q=_")).tokens).toHaveLength(0);
    expect((await get<SearchData>("/api/search?q=%27%3B%20DROP%20TABLE%20packs%3B--")).tokens).toHaveLength(0);
    expect((await app.inject({ url: `/api/search?q=${"x".repeat(201)}` })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/search" })).statusCode).toBe(400);
  });

  it("reports each wallet's first sell and launch timing per pack, matching the pack's own facts", async () => {
    for (const exit of moth.after.members.rows) {
      const w = await get<WalletPageData>(`/api/wallets/solana/${exit.walletAddress}`);
      expect(w.packCount).toBeGreaterThanOrEqual(w.packs.length);
      const row = w.packs.find((p) => p.packId === moth.core.id)!;
      expect(row.token.symbol).toBe("LMOTH");
      if (exit.soldShare && exit.soldShare > 0) {
        expect(row.firstSellTimeMs).not.toBeNull();
        expect(row.firstSellTimeMs!).toBeGreaterThanOrEqual(row.firstEntryTimeMs);
      } else {
        expect(row.firstSellTimeMs).toBeNull();
      }
      if (moth.after.tokenCreatedAt) expect(row.tokenCreatedAtMs).toBe(Date.parse(moth.after.tokenCreatedAt));
    }
  });

  it("adds creation and graduation times to the token page", async () => {
    const harbor = items.find((i) => i.token.symbol === "HARBR")!;
    const t = await get<TokenPageData>(`/api/tokens/solana/${harbor.core.tokenAddress}`);
    expect(t.graduatedAt).not.toBeNull();
    expect(t.graduatedAt).toBe(harbor.after.graduatedAt);
    expect(t.createdAt === null || Number.isFinite(Date.parse(t.createdAt))).toBe(true);
  });
});
