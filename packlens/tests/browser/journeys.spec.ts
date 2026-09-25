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
  await expect(page.getByText("Fixture", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Synthetic fixture data")).toBeVisible();
  const card = page.locator("article", { hasText: "Lantern Moth" });
  await expect(card).toContainText("12 observed buyers");
  await expect(card).toContainText("2 of 6");
  await expect(card).toContainText("Analysis complete");
  const finch = page.locator("article", { hasText: "Copper Finch" });
  await expect(finch).toContainText("Not checked");
  await expect(finch).toContainText("Not analyzed yet");
  const harbor = page.locator("article", { hasText: "Quiet Harbor" });
  await expect(harbor).toContainText("0 observed buyers");
  await expect(harbor).toContainText("Analysis paused");
  expect(errors).toEqual([]);
});

test("radar filters are labeled and never enabled automatically", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Filter active")).toHaveCount(0);
  await page.getByLabel("Only packs with confirmed Smart Money members").check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Filter active")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.locator("article")).toContainText("Lantern Moth");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("article")).toHaveCount(5);
  await page.getByRole("textbox", { name: "Token address" }).fill("not-a-mint");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Token address must be a Solana mint address.")).toBeVisible();
});

test("radar → pack → wallet → back, then refresh keeps the stored pack", async ({ page }) => {
  await openPack(page, "Lantern Moth");
  await expect(page.getByText("3 wallets made eligible buys within 6 seconds.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Formation" })).toBeVisible();
  // Initial versus expanded members, with evidence rows.
  await expect(page.locator("table").first().getByText("Initial", { exact: true })).toHaveCount(3);
  await expect(page.locator("table").first().getByText("Expanded", { exact: true })).toHaveCount(3);
  await expect(page.getByText("synthetic").first()).toBeVisible();
  // Smart Money panel: token-wide buyers differ from confirmed members.
  await expect(page.getByText("at least").first()).toBeVisible();
  await expect(page.getByText("of 6 members", { exact: true })).toBeVisible();
  await expect(page.getByText("Smart Money does not change pack detection, indicators, or ordering.")).toBeVisible();
  const url = page.url();
  // Wallet page from the member table.
  await page.locator("table").first().locator("tbody tr").first().locator(".addr a").click();
  await expect(page.getByRole("heading", { name: "Packs with this wallet" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lantern Moth");
});

test("data states are explicit: unavailable, update delayed, budget paused, observed zero", async ({ page }) => {
  await openPack(page, "Quiet Harbor");
  await expect(page.getByText("0 buyers observed in the checked data over 1 hour.")).toBeVisible();
  await expect(page.getByText("No holders were returned in the checked data.")).toBeVisible();
  await expect(page.getByText("Analysis paused before the follow-up ran.").first()).toBeVisible();
  await expect(page.getByText(/Update delayed/).first()).toBeVisible();
  await page.goto("/");
  await page.locator("article", { hasText: "Salt Meridian" }).filter({ hasText: "Analysis complete" }).getByRole("link").first().click();
  await expect(page.getByText("Token data is unavailable from this source. The pack is retained.")).toBeVisible();
  await expect(page.getByText(/At least 2 unique buyers observed over 1 hour; coverage is partial./)).toBeVisible();
});

test("token page without a pack says so, and Smart Money activity cannot create packs", async ({ page }) => {
  await page.goto("/smart-money");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Smart Money");
  await expect(page.getByText("they never create or change packs")).toBeVisible();
  await page.getByRole("row", { name: /GRVL/ }).first().getByRole("link", { name: "GRVL" }).click();
  await expect(page.getByText("No pack detected in the monitored source")).toBeVisible();
});

test("keyboard: open a pack from the radar without a mouse", async ({ page }) => {
  await page.goto("/");
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

test("radar cards show what happened after each pack", async ({ page }) => {
  await page.goto("/");
  const card = page.locator("article", { hasText: "Lantern Moth" });
  await expect(card).toContainText("After the pack");
  await expect(card).toContainText("4 of 6 sold");
  await expect(card.locator(".delta.down").first()).toBeVisible();
  await expect(page.locator("article", { hasText: "Quiet Harbor" })).toContainText("1 of 3 sold");
});

test("pack page: plain-language reading, after-the-pack facts, chart, and earlier packs", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openPack(page, "Lantern Moth");
  const reading = page.getByRole("region", { name: "Reading this pack" });
  await expect(reading.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(reading.getByRole("heading", { name: "Worth checking" })).toBeVisible();
  await expect(reading).toContainText("4 of 6 pack wallets have sold");
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
  await expect(after.getByText("All sold", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("region", { name: "Earlier packs with these wallets" })).toContainText("No earlier packs with two or more of these wallets");
  // Salt Meridian's first pack shares two wallets with Lantern Moth.
  await page.goto("/");
  await page.locator("article", { hasText: "Salt Meridian" }).filter({ hasText: "Analysis complete" }).getByRole("link").first().click();
  const earlier = page.getByRole("region", { name: "Earlier packs with these wallets" });
  await expect(earlier.getByRole("link", { name: "LMOTH" })).toBeVisible();
  await expect(earlier).toContainText("2 of 6");
  expect(errors).toEqual([]);
});

test("graduated token is labeled and the note explains the missing trades", async ({ page }) => {
  await openPack(page, "Quiet Harbor");
  await expect(page.getByRole("region", { name: "Reading this pack" })).toContainText("left the pump.fun bonding curve");
  await expect(page.getByRole("region", { name: "After the pack" })).toContainText("completed its pump.fun bonding curve");
});

test("info tips explain terms on hover, focus, and click, and close with Escape", async ({ page }) => {
  await openPack(page, "Lantern Moth");
  const tip = page.getByRole("button", { name: "What is Entry spread?" }).first();
  await tip.click();
  await expect(page.getByRole("tooltip")).toContainText("Time between the first and the last buy");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("guide: reachable from the top bar and the radar, and the radar hint can be dismissed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Read the 3-minute guide" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read PackLens");
  await expect(page.getByRole("heading", { name: "Seven questions before you act" })).toBeVisible();
  await expect(page.getByText("Research tool. Not trading advice.").first()).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Entry spread" })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Hide this guide suggestion" }).click();
  await expect(page.getByRole("link", { name: "Read the 3-minute guide" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pack Radar");
  await expect(page.getByRole("link", { name: "Read the 3-minute guide" })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: "Guide", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read PackLens");
});

test("360 px: guide and after-the-pack section fit without horizontal scroll", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("How to read PackLens");
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
