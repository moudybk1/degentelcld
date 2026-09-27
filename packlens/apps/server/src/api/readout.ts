/**
 * Plain-language reading of a pack, generated from stored facts with fixed
 * templates (no model). Three groups: what happened, what is worth checking,
 * and what is not known. It never recommends buying or selling and never
 * predicts prices; it points the reader at evidence.
 */
import type { AfterPackData, Assessment, EarlierPack, Pack, PackCoverage, PackSmartMoneyContext, PatternMetrics, ReadoutItem, SmartMoneyWindowMetric, TokenIdentity } from "@packlens/contracts";
import { formatUsd } from "./templates.js";

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

export function signedPct(p: number): string {
  const r = Math.abs(p) >= 100 ? Math.round(p) : Math.round(p * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
}

export type ReadoutInput = {
  core: Pack;
  token: TokenIdentity;
  patterns: PatternMetrics;
  after: AfterPackData;
  earlier: EarlierPack[];
  oneHour: SmartMoneyWindowMetric | undefined;
  confirmation: PackSmartMoneyContext;
  assessment: Assessment;
  coverage: PackCoverage;
};

export function buildReadout(i: ReadoutInput): ReadoutItem[] {
  const out: ReadoutItem[] = [];
  const add = (group: ReadoutItem["group"], text: string) => out.push({ group, text });
  const tokenName = i.token.symbol ? i.token.symbol : "this token";
  const expanded = i.core.totalWalletCount - i.core.initialWalletCount;

  // What happened
  const first =
    i.patterns.initialEntrySpanMs === 0
      ? `${i.core.initialWalletCount} wallets bought ${tokenName} in the same second`
      : `${i.core.initialWalletCount} wallets bought ${tokenName} within ${duration(i.patterns.initialEntrySpanMs)}`;
  add(
    "happened",
    expanded > 0
      ? `${first}, and ${expanded} more joined within 40 seconds of the first buy: ${i.core.totalWalletCount} wallets and ${formatUsd(i.core.eligibleBuyUsd)} of pack buys.`
      : `${first}, together ${formatUsd(i.core.eligibleBuyUsd)} of pack buys.`,
  );
  if (i.after.tokenCreatedAt) {
    const age = i.core.firstEventTimeMs - Date.parse(i.after.tokenCreatedAt);
    if (age >= 0) {
      add(
        "happened",
        age < 1000
          ? "The first pack buy came in the same second the token was created."
          : age <= 120_000
            ? `The first pack buy came ${duration(age)} after the token was created.`
            : `The token was created ${duration(age)} before the first pack buy.`,
      );
    }
  }
  const tradesAfter = i.after.activity.buys + i.after.activity.sells;
  if (tradesAfter === 0) {
    add("happened", "No trades have been observed since the pack formed.");
  } else if (i.after.lastChangePct !== null) {
    const pk = i.after.peak;
    const atPeak = pk !== null && Math.abs(pk.changePct - i.after.lastChangePct) < 0.05;
    const peak = !pk
      ? ""
      : atPeak
        ? " That is also the highest since the pack formed."
        : ` It peaked at ${signedPct(pk.changePct)}, ${duration(Date.parse(pk.at) - i.core.triggerEventTimeMs)} after the pack formed.`;
    add("happened", `The latest observed trade is ${signedPct(i.after.lastChangePct)} against the pack's average entry price (in SOL).${peak}`);
  }
  const m = i.after.members;
  if (m.sold === 0) {
    add("happened", `None of the ${m.count} pack wallets have sold in the observed trades.`);
  } else {
    const firstSell = m.firstSellAt ? ` The first sale came ${duration(Date.parse(m.firstSellAt) - i.core.firstEventTimeMs)} after the first pack buy.` : "";
    add("happened", `${m.sold} of ${m.count} pack wallets ${m.sold === 1 ? "has" : "have"} sold some; together ${Math.round((m.soldShare ?? 0) * 100)}% of the tokens they bought is sold.${firstSell}`);
  }
  if (tradesAfter > 0) {
    const net = Number(i.after.activity.netSol);
    add(
      "happened",
      `Since the pack formed: ${i.after.activity.buys} buys from ${i.after.activity.uniqueBuyers} wallets and ${i.after.activity.sells} sells from ${i.after.activity.uniqueSellers} wallets, net ${Math.abs(net).toFixed(2)} SOL ${net >= 0 ? "more bought than sold" : "more sold than bought"}.`,
    );
  }
  if (i.confirmation.confirmedMemberCount !== null && i.confirmation.confirmedMemberCount > 0) {
    add("happened", `${i.confirmation.confirmedMemberCount} of ${i.confirmation.totalMemberCount} pack wallets are confirmed Smart Money buyers of this token (their pack transaction appears in Nansen's Smart Money data).`);
  }
  if (i.oneHour && i.oneHour.observedUniqueBuyers !== null && i.oneHour.observedUniqueBuyers > 0) {
    add("happened", `${i.oneHour.countQualifier === "observed" ? i.oneHour.observedUniqueBuyers : `At least ${i.oneHour.observedUniqueBuyers}`} Smart Money ${i.oneHour.observedUniqueBuyers === 1 ? "wallet" : "wallets"} bought this token in the hour before the last check. They may or may not be pack members.`);
  }

  // Worth checking
  if (i.patterns.initialEntrySpanMs === 0) add("check", "The first wallets bought in the same second. Open the evidence to see whether they look like independent traders or one coordinated action.");
  if (i.patterns.buySizeCV !== null && Number(i.patterns.buySizeCV) < 0.15 && i.patterns.memberCount >= 3) {
    add("check", `Buy sizes are very similar (size variation ${Number(i.patterns.buySizeCV).toFixed(2)}). Uniform sizing is worth a closer look.`);
  }
  if (i.patterns.largestBuyerShare !== null && Number(i.patterns.largestBuyerShare) >= 0.5) {
    add("check", `One wallet supplied ${Math.round(Number(i.patterns.largestBuyerShare) * 100)}% of the pack's buying, so the "group" is mostly one buyer.`);
  }
  if (i.earlier.length > 0) {
    const n = i.earlier.length >= 10 ? "10 or more" : String(i.earlier.length);
    add("check", `${n} earlier ${i.earlier.length === 1 ? "pack includes" : "packs include"} at least two of these wallets. See how those tokens moved in "Earlier packs with these wallets".`);
  }
  if (m.soldShare !== null && m.soldShare >= 0.5) add("check", `Pack wallets have already sold ${Math.round(m.soldShare * 100)}% of what they bought.`);
  const quickest = m.rows.map((r) => r.secondsToFirstSell).filter((x): x is number => x !== null).sort((a, b) => a - b)[0];
  if (quickest !== undefined && quickest <= 60) {
    add("check", quickest === 0 ? "A pack wallet sold in the same second as its first buy." : `A pack wallet started selling ${duration(quickest * 1000)} after its first buy.`);
  }
  if (i.after.lastChangePct !== null && i.after.lastChangePct >= 100) add("check", `The latest observed price is already ${signedPct(i.after.lastChangePct)} above the pack's entry.`);
  if (i.assessment.reviewFlags.includes("CHECK_RELATIONSHIP")) add("check", "Nansen returned a direct relationship between pack wallets. A relationship is a lead, not proof of common ownership.");
  if (i.after.graduatedAt) add("check", `The token left the pump.fun bonding curve at ${new Date(i.after.graduatedAt).toISOString().slice(11, 19)} UTC; later trades are not observed here.`);

  // Not known
  if (i.assessment.analysisState === "not_requested") add("unknown", "Wallet histories and relationships have not been analyzed for this pack yet.");
  if (!i.oneHour || i.oneHour.countQualifier === "unknown") add("unknown", "Smart Money activity on this token has not been checked.");
  else if (i.oneHour.countQualifier === "at_least") add("unknown", "Smart Money counts are partial; there may be more buyers than shown.");
  if (i.coverage.gapIds.length > 0) add("unknown", "The collector was disconnected near this pack, so some buys may be missing.");
  add("unknown", "Who controls these wallets, and what the price does next. PackLens shows what happened, not a forecast.");
  return out;
}
