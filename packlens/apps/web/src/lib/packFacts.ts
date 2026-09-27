import type { Pack, PackListItem, PatternMetrics } from "@packlens/contracts";
import { usd } from "./format";

/**
 * Plain-language labels for pack facts, shared by the radar and the pack
 * page. Every label restates an observed fact; none predicts a price or
 * recommends an action.
 */

export type FactTone = "attention" | "neutral" | "unknown";

/** Whether the pack's own wallets have sold, as a short status. */
export function groupSold(sold: number, count: number): { label: string; tone: "outline" | "yellow" | "red"; title: string } {
  if (count <= 0) return { label: "n/a", tone: "outline", title: "No pack wallets" };
  if (sold === 0) return { label: "None sold", tone: "outline", title: `None of the ${count} pack wallets has sold in the observed trades.` };
  // "Sold some": any sell counts; how much of their tokens they sold is on the pack page.
  if (sold >= count) return { label: `${count}/${count} sold some`, tone: "red", title: `Every pack wallet has sold at least some of this token since its first buy. The pack page shows how much of the bought tokens was sold.` };
  return { label: `${sold}/${count} sold some`, tone: "yellow", title: `${sold} of ${count} pack wallets have sold at least some of this token since their first buy. The pack page shows how much of the bought tokens was sold.` };
}

/** The first wallets' entry window in words. */
export function entryWindow(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms === 0) return "Same second";
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** Uncommon facts worth a flag on a radar row (common ones would only add noise). */
export function rowFlags(item: PackListItem): { label: string; title: string }[] {
  const flags: { label: string; title: string }[] = [];
  const largest = item.patterns.largestBuyerShare === null ? null : Number(item.patterns.largestBuyerShare);
  if (largest !== null && largest >= 0.5) flags.push({ label: `1 wallet ${Math.round(largest * 100)}%`, title: "One wallet made at least half of the pack's buying, so the group is mostly one buyer." });
  const cv = item.patterns.buySizeCV === null ? null : Number(item.patterns.buySizeCV);
  if (cv !== null && cv < 0.15 && item.patterns.memberCount >= 3) flags.push({ label: "Equal buy sizes", title: "The wallets bought almost identical amounts. Uniform sizing can mean one operator or a script." });
  if (item.after?.graduatedAt) flags.push({ label: "Left curve", title: "The token completed its pump.fun bonding curve; later trades happen elsewhere and are not observed." });
  return flags;
}

/** One plain sentence about how the pack formed; `minUsd` is the rule's per-buy minimum, e.g. "3 wallets each bought $20 or more within 6 seconds. 3 more joined later (6 in total). Together they bought $554.22." */
export function packLead(core: Pack, patterns: PatternMetrics, minUsd: string): string {
  const span = patterns.initialEntrySpanMs;
  const s = span / 1000;
  const when = span === 0 ? "in the same second" : `within ${Number.isInteger(s) ? s : s.toFixed(1)} ${s === 1 ? "second" : "seconds"}`;
  const joined = core.totalWalletCount - core.initialWalletCount;
  return `${core.initialWalletCount} wallets each bought ${minUsd} or more ${when}.${joined > 0 ? ` ${joined} more joined later (${core.totalWalletCount} in total).` : ""} Together they bought ${usd(core.eligibleBuyUsd)}.`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h} h`;
}
