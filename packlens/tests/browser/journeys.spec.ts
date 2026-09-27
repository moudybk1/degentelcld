import { expect, test, type Page } from "@playwright/test";

const TOKEN = "e2e-operator-token-0123456789abcdef";

async function openPack(page: Page, name: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pack Radar");
  await page.getByRole("link", { name: new RegExp(name) }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
}

test("radar shows mode, source, and separate Smart Money metrics", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  // One source badge in the top bar.
  await expect(page.getByRole("banner").getByRole("status")).toHaveText("Example data");
  await expect(page.getByText(/Detecting · last event/)).toHaveCount(0);
  const row = page.getByRole("row", { name: /Lantern Moth/ });
  await expect(row).toContainText("12 observed buyers");
  await expect(row).toContainText("2 of 6 confirmed");
  await expect(row).toContainText("Nansen checks done");
  const finch = page.getByRole("row", { name: /Copper Finch/ });
  await expect(finch).toContainText("Not checked yet");
  await expect(finch).not.toContainText("0 observed");
  const harbor = page.getByRole("row", { name: /Quiet Harbor/ });
  await expect(harbor).toContainText("0 observed buyers");
  await expect(harbor).toContainText("Nansen checks paused");
  expect(errors).toEqual([]);
});

test("radar filters are labeled, apply immediately, and are never enabled automatically", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("table.feed tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(page.getByText("Filter active")).toHaveCount(0);
  await page.getByLabel("Only packs with confirmed Smart Money members").check();
  await expect(page.getByText("Filter active")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Lantern Moth");
  // The overview summarizes the same filtered packs.
  await expect(page.locator(".kpi.hero .kpi-value")).toHaveText("1");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.locator(".kpi.hero .kpi-value")).toHaveText("5");
  await page.getByLabel("Min. wallets").selectOption("4");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("textbox", { name: "Token address" }).fill("not-a-mint");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Token address must be a Solana mint address.")).toBeVisible();
  await expect(rows).toHaveCount(5);
});

test("radar overview summarizes the range, ranks packs, and drills into an interval", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const overview = page.getByRole("region", { name: "Last 24 hours" });
  await expect(overview.locator(".kpi.hero")).toContainText("5");
  await expect(overview.getByRole("region", { name: "Largest packs" })).toContainText("Lantern Moth");
  await expect(overview.getByRole("region", { name: "Packed repeatedly" })).toContainText("Salt Meridian");
  await expect(overview.getByRole("region", { name: "Packed repeatedly" })).toContainText("2");
  // Keyboard reading of the activity chart, then Enter lists the packs of one interval.
  const chart = overview.getByRole("img", { name: /Packs per/ });
  await chart.focus();
  const tip = overview.locator(".chart-tip");
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("ArrowRight");
    const text = (await tip.textContent()) ?? "";
    if (!text.startsWith("0 packs")) break;
  }
  await expect(tip).toContainText("Click to list these packs");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Clear the selected interval" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected interval" })).toBeVisible();
  const rows = page.locator("table.feed tbody tr");
  // The previous rows stay on screen (dimmed) until the filtered list arrives.
  await expect.poll(() => rows.count()).toBeLessThan(5);
  await expect(rows.first()).toBeVisible();
  await page.getByRole("button", { name: "Clear the selected interval" }).click();
  await expect(rows).toHaveCount(5);
  // A preset range ends at the latest fixture pack, so historical data still shows.
  await page.getByRole("group", { name: "Time range" }).getByRole("button", { name: "1 h" }).click();
  await expect(page.getByRole("region", { name: "Last hour" })).toBeVisible();
  await expect(rows).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("radar → pack → wallet → back, then refresh keeps the stored pack", async ({ page }) => {
  await openPack(page, "Lantern Moth");
  await expect(page.getByRole("region", { name: "Pack at a glance" })).toContainText("3 wallets each bought $20 or more within 6 seconds. 3 more joined later (6 in total).");
  await expect(page.getByRole("heading", { name: "How the pack formed" })).toBeVisible();
  // Wallets that started the pack versus those that joined later, with every buy.
  const wallets = page.getByRole("table", { name: "Pack wallets" });
  await expect(wallets.getByText("Started it", { exact: true })).toHaveCount(3);
  await expect(wallets.getByText("Joined later", { exact: true })).toHaveCount(3);
  await expect(page.getByText("synthetic").first()).toBeVisible();
  // Smart Money panel: token-wide buyers differ from confirmed members.
  await expect(page.getByText("at least").first()).toBeVisible();
  await expect(page.getByText("of 6 members", { exact: true })).toBeVisible();
  await expect(page.getByText("Smart Money does not change pack detection, indicators, or ordering.")).toBeVisible();
  const url = page.url();
  // Wallet page from the member table.
  await wallets.locator("tbody tr").first().locator(".addr a").click();
  await expect(page.getByRole("heading", { name: "Packs with this wallet" })).toBeVisible();
  // The wallet page leads with plain answers and remembers which pack it came from.
  await expect(page.getByRole("heading", { name: "This wallet at a glance" })).toBeVisible();
  await expect(page.getByText("Does it sell quickly?")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Lantern Moth");
  await page.goBack();
  await expect(page).toHaveURL(url);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lantern Moth");
});

test("data states are explicit: unavailable, update delayed, budget paused, observed zero", async ({ page }) => {
  await openPack(page, "Quiet Harbor");
  await expect(page.getByText("0 buyers observed in the checked data over 1 hour.")).toBeVisible();
  await expect(page.getByText("No holders were returned in the checked data.")).toBeVisible();
  await expect(page.getByText("Checks paused before the later balance check ran.").first()).toBeVisible();
  await expect(page.getByText(/Update delayed/).first()).toBeVisible();
  await page.goto("/");
  await page.getByRole("row", { name: /Salt Meridian/ }).filter({ hasText: "Nansen checks done" }).getByRole("link").first().click();
  await expect(page.getByText("Token data is unavailable from this source. The pack is retained.")).toBeVisible();
  await expect(page.getByText(/At least 2 unique buyers observed over 1 hour; coverage is partial./)).toBeVisible();
});

test("token page without a pack says so, and Smart Money activity cannot create packs", async ({ page }) => {
  await page.goto("/smart-money");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Smart Money");
  await expect(page.getByText("they never create or change packs")).toBeVisible();
  // One list, pump.fun tokens only, with how soon after launch.
  await expect(page.getByRole("group", { name: "Tokens shown" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "After launch" })).toBeVisible();
  await expect(page.getByText("Smart Money trades in other tokens are left out")).toBeVisible();
  await expect(page.getByRole("row", { name: /GRVL/ }).first()).toBeVisible();
  await page.getByRole("row", { name: /GRVL/ }).first().getByRole("link", { name: "GRVL" }).click();
  await expect(page.getByText("No pack detected in the monitored source")).toBeVisible();
});

test("keyboard: open a pack from the radar without a mouse", async ({ page }) => {
  await page.goto("/");
  // Wait for the overview: its highlight links render above the feed, so "first" must not change after focusing.
  await expect(page.locator(".highlights .rank-row").first()).toBeVisible();
  const link = page.getByRole("link", { name: /Lantern Moth/ }).first();
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lantern Moth");
});

test("360 px: core flow works without horizontal page scroll", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: /Lantern Moth/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lantern Moth");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.close();
});

test("operator: login required, session cookie, overview, logout", async ({ page }) => {
  // The console is for the site owner: reachable by its address, not linked for visitors.
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Operator" })).toHaveCount(0);
  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "Operator login" })).toBeVisible();
  await page.getByLabel("Operator token").fill("wrong-token");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("That operator token is not valid.")).toBeVisible();
  await page.getByLabel("Operator token").fill(TOKEN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Session and credits" })).toBeVisible();
  await expect(page.getByText("Fixture and replay modes never call providers.")).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage) + document.cookie)).not.toContain(TOKEN);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Operator login" })).toBeVisible();
});

test("radar rows and cards show what happened after each pack", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("row", { name: /Lantern Moth/ });
  await expect(row).toContainText("4/6 sold some");
  await expect(row.locator(".delta.down").first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Quiet Harbor/ })).toContainText("1/3 sold some");
  // The card layout carries the same facts, and the choice is remembered.
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Cards" }).click();
  const card = page.locator("article", { hasText: "Lantern Moth" });
  await expect(card).toContainText("After the pack");
  await expect(card).toContainText("4/6 sold some");
  await expect(card.locator(".delta.down").first()).toBeVisible();
  await expect(page.locator("article", { hasText: "Quiet Harbor" })).toContainText("1/3 sold some");
  await page.reload();
  await expect(page.locator("article")).toHaveCount(5);
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Table" }).click();
  await expect(page.locator("table.feed tbody tr")).toHaveCount(5);
});

test("pack page: plain-language reading, after-the-pack facts, chart, and earlier packs", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openPack(page, "Lantern Moth");
  const reading = page.getByRole("region", { name: "Reading this pack" });
  // The full written summary is folded under the glance.
  await expect(reading.getByRole("heading", { name: "What happened" })).toBeHidden();
  await reading.getByText("Read the full written summary").click();
  await expect(reading.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(reading.getByRole("heading", { name: "Worth checking" })).toBeVisible();
  await expect(reading).toContainText("4 of 6 pack wallets have sold some");
  await expect(reading).toContainText("not a forecast");
  await page.getByRole("navigation", { name: "Sections on this page" }).getByRole("link", { name: "After the pack" }).click();
  const after = page.getByRole("region", { name: "After the pack" });
  await expect(after.getByText("Now vs pack entry")).toBeVisible();
  await expect(after.getByRole("img", { name: /Price after the pack/ })).toBeVisible();
  // Keyboard reading of the chart.
  await after.getByRole("img", { name: /Price after the pack/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(after.locator(".chart-tip")).toContainText("vs pack entry");
  await page.keyboard.press("Escape");
  await after.getByText("Show the chart data as a table").click();
  await expect(after.locator(".chart-table tbody tr").first()).toBeVisible();
  await expect(after).toContainText("they do not predict what happens next");
  await expect(after.getByText("Sold all bought", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("region", { name: "Earlier packs with these wallets" })).toContainText("No earlier packs with two or more of these wallets");
  // Salt Meridian's first pack shares two wallets with Lantern Moth.
  await page.goto("/");
  await page.getByRole("row", { name: /Salt Meridian/ }).filter({ hasText: "Nansen checks done" }).getByRole("link").first().click();
  const earlier = page.getByRole("region", { name: "Earlier packs with these wallets" });
  await expect(earlier.getByRole("link", { name: "LMOTH" })).toBeVisible();
  await expect(earlier).toContainText("2 of 6");
  expect(errors).toEqual([]);
});

test("pack page answers the key questions at a glance, each linked to its evidence", async ({ page }) => {
  await openPack(page, "Lantern Moth");
  const glance = page.getByRole("region", { name: "Pack at a glance" });
  await expect(glance.getByRole("link")).toHaveCount(6);
  await expect(glance).toContainText("4 of 6 sold some");
  await expect(glance).toContainText("2 of 6 pack wallets");
  await expect(glance).toContainText("Not in the observed data");
  await expect(glance).toContainText("not what the price will do next");
  await glance.getByRole("link", { name: /Are the pack wallets still holding/ }).click();
  await expect(page).toHaveURL(/#sec-after$/);
});

test("radar explains what a pack is, rows say whether the group sold, and the explainer can be reopened", async ({ page }) => {
  await page.goto("/");
  const how = page.getByRole("region", { name: "How Pack Radar works" });
  await expect(how).toContainText("3 or more different wallets");
  await expect(how).toContainText("not a buy signal");
  await expect(page.getByRole("row", { name: /Lantern Moth/ })).toContainText("4/6 sold some");
  await how.getByRole("button", { name: "Hide this guide suggestion" }).click();
  await expect(how).toHaveCount(0);
  await page.getByRole("button", { name: "How it works" }).click();
  await expect(page.getByRole("region", { name: "How Pack Radar works" })).toBeVisible();
});

test("top bar search finds a token by name and opens it", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search tokens and wallets" });
  await search.fill("moth");
  await expect(page.getByRole("option", { name: /Lantern Moth/ })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lantern Moth");
  await expect(page.getByRole("heading", { name: "Packs on this token" })).toBeVisible();
  await search.fill("zzzz-no-such-token");
  await expect(page.getByText(/No token with a pack matches/)).toBeVisible();
});

test("a link to a pack section lands on that section", async ({ page }) => {
  const list = await (await page.request.get("/api/packs?limit=50")).json();
  const moth = list.data.items.find((i: { token: { symbol: string } }) => i.token.symbol === "LMOTH");
  await page.goto(`/packs/${moth.core.id}#sec-earlier`);
  await expect(page.getByRole("heading", { name: /Earlier packs with these wallets/ })).toBeInViewport();
});

test("graduated token is labeled and the note explains the missing trades", async ({ page }) => {
  await openPack(page, "Quiet Harbor");
  await expect(page.getByRole("region", { name: "Reading this pack" })).toContainText("left the pump.fun bonding curve");
  await expect(page.getByRole("region", { name: "After the pack" })).toContainText("completed its pump.fun bonding curve");
});

test("info tips explain terms on hover, focus, and click, and close with Escape", async ({ page }) => {
  await openPack(page, "Lantern Moth");
  const tip = page.getByRole("button", { name: "What is Entry window?" }).first();
  await tip.click();
  await expect(page.getByRole("tooltip")).toContainText("Time between the first and the last buy");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("guide: reachable from the top bar and the radar, and the radar hint can be dismissed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Read the short guide" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read Degentellegence");
  await expect(page.getByRole("heading", { name: "Seven questions before you act" })).toBeVisible();
  await expect(page.getByText("Research tool. Not trading advice.").first()).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Entry window" })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Hide this guide suggestion" }).click();
  await expect(page.getByRole("link", { name: "Read the short guide" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pack Radar");
  await expect(page.getByRole("link", { name: "Read the short guide" })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: "Guide", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read Degentellegence");
});

test("360 px: guide and after-the-pack section fit without horizontal scroll", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read Degentellegence");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/");
  await page.getByRole("link", { name: /Lantern Moth/ }).first().click();
  await page.getByRole("region", { name: "After the pack" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: "After the pack" }).getByRole("img", { name: /Price after the pack/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.close();
});

test("unknown pack and route show clear messages", async ({ page }) => {
  await page.goto(`/packs/${"0".repeat(64)}`);
  await expect(page.getByText("Pack not found")).toBeVisible();
  await page.goto("/nowhere");
  await expect(page.getByText("This page does not exist.")).toBeVisible();
});

test("repeat wallets: reachable from the top bar, explains its sources, and fits 360 px", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Wallets" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Repeat wallets");
  await expect(page.getByText("Pack counts come from the chain; profiles, labels, and relationships come from Nansen.")).toBeVisible();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.getByRole("button", { name: "All time" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("table.table, .empty").first()).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("radar overview stays visible after it refreshes (scroll reveal never hides a block again)", async ({ page }) => {
  await page.goto("/");
  const overview = page.locator("section.overview");
  await overview.scrollIntoViewIfNeeded();
  await expect(overview).toHaveAttribute("data-reveal", "in");
  // A filter change reloads the overview, which toggles its "refreshing" class.
  await page.getByLabel("Only packs with confirmed Smart Money members").check();
  await expect(page.locator(".kpi.hero .kpi-value")).toHaveText("1");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(".kpi.hero .kpi-value")).toHaveText("5");
  await expect(overview).toHaveCSS("opacity", "1");
  // Anything above the reader counts as seen, even after a jump to the bottom.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator("[data-reveal='pending']")).toHaveCount(0);
});

test("a newcomer reaches the feed or an analyzed example from the first phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toFeed = page.getByRole("link", { name: /View packs/ });
  const example = page.getByRole("link", { name: /Explore an example/ });
  await expect(example).toBeVisible();
  for (const l of [toFeed, example]) expect((await l.boundingBox())!.y + 40).toBeLessThan(844);
  await toFeed.click();
  await expect.poll(async () => (await page.locator("#radar-list").boundingBox())!.y).toBeLessThan(300);
  // Quick views are plain filters that say what they keep.
  const quick = page.getByRole("group", { name: "Quick views" });
  await quick.getByRole("button", { name: "Larger buys · $1,000+" }).click();
  await expect(quick.getByRole("button", { name: "Larger buys · $1,000+" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Min. total pack USD")).toHaveValue("1000");
  await quick.getByRole("button", { name: "All packs" }).click();
  await expect(page.getByLabel("Min. total pack USD")).toHaveValue("");
  // The example is a pack with complete Nansen analysis, and its page can be shared.
  await page.goto("/");
  await page.getByRole("link", { name: /Explore an example/ }).click();
  await expect(page.getByRole("button", { name: "Copy pack link" })).toBeVisible();
  await expect(page).toHaveTitle(/pack · \d+ wallets · .* · Degentellegence$/);
});
