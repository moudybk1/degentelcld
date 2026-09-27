import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverviewData, PackListItem } from "@packlens/contracts";
import { loadConfig } from "../../apps/server/src/config.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { buildServer } from "../../apps/server/src/api/server.js";
import { renderIndex } from "../../apps/server/src/api/pageMeta.js";
import * as serverText from "../../apps/server/src/lib/tokenText.js";
import * as webText from "../../apps/web/src/lib/tokenText.js";

const TEMPLATE = `<!doctype html><html><head>
    <meta name="description" content="Site description" />
    <meta property="og:title" content="Degentellegence · Pack Radar" />
    <meta property="og:description" content="Site description" />
    <meta property="og:url" content="https://degentel.xyz/" />
    <meta name="twitter:title" content="Degentellegence · Pack Radar" />
    <meta name="twitter:description" content="Site description" />
    <title>Degentellegence · Pack Radar</title>
  </head><body><div id="root"></div></body></html>`;

describe("served page head", () => {
  const dist = mkdtempSync(join(tmpdir(), "packlens-web-"));
  writeFileSync(join(dist, "index.html"), TEMPLATE);
  const rt = Runtime.create(loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:" }));
  rt.start();
  const app = buildServer(rt, { webDist: dist });
  afterAll(() => app.close());

  it("carries the detection rule on every page, so the first paint never shows a default rule", async () => {
    const html = (await app.inject({ url: "/" })).body;
    const rule = JSON.parse(/<meta name="degentel-rule" content="([^"]*)"/.exec(html)![1]!.replace(/&quot;/g, '"')) as { minUniqueWallets: number; minTradeUsd: string };
    expect(rule).toMatchObject({ minUniqueWallets: 3, minTradeUsd: "20" });
    expect(html).toContain("<title>Degentellegence · Pack Radar</title>");
  });

  it("gives a pack link its own title and preview, naming when it formed and no outcome", async () => {
    const items = (await app.inject({ url: "/api/packs?limit=50" })).json().data.items as PackListItem[];
    const p = items.find((i) => i.token.symbol === "LMOTH")!;
    const html = (await app.inject({ url: `/packs/${p.core.id}` })).body;
    const title = /<title>([^<]*)<\/title>/.exec(html)![1]!;
    expect(title).toMatch(/^Lantern Moth \(LMOTH\) pack · \d+ wallets · \d\d:\d\d UTC, \d+ \w{3} · Degentellegence$/);
    expect(html).toContain(`<meta property="og:title" content="${title}"`);
    expect(html).toContain(`<meta property="og:url" content="https://degentel.xyz/packs/${p.core.id}"`);
    const description = /<meta property="og:description" content="([^"]*)"/.exec(html)![1]!;
    expect(description).toMatch(/wallets each bought \$20\+ of Lantern Moth \(LMOTH\) on pump\.fun within 20 s/);
    expect(description).not.toMatch(/%|up |down |peak/i);
    // Unknown packs and other pages keep the site defaults.
    expect((await app.inject({ url: `/packs/${"0".repeat(64)}` })).body).toContain("<title>Degentellegence · Pack Radar</title>");
  });

  it("escapes and masks untrusted token text in the head", () => {
    const html = renderIndex(TEMPLATE, { version: "v", minUniqueWallets: 5, minTradeUsd: "25", triggerWindowSeconds: 20, expansionSeconds: 40, isBaseline: false }, {
      title: `"><script>x</script> pack`,
      description: "d",
      path: "/packs/x",
    });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(serverText.maskOffensive("RETARD COIN")).toBe("R***** COIN");
  });

  it("keeps the server's slur lists identical to the web app's", () => {
    expect(serverText.STEMS).toEqual(webText.STEMS);
    expect(serverText.WORDS).toEqual(webText.WORDS);
  });

  it("offers an analyzed pack as the example to open first", async () => {
    const o = (await app.inject({ url: "/api/overview" })).json().data as OverviewData;
    expect(o.example).not.toBeNull();
    const detail = (await app.inject({ url: `/api/packs/${o.example!.id}` })).json().data as { assessment: { analysisState: string } };
    expect(detail.assessment.analysisState).toBe("complete");
  });
});
