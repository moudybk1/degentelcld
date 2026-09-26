/**
 * Deterministic English summaries (INV-12, blueprint §17.10, §17.14). P0 uses
 * templates only: no model, no advice. The pack sentence and the Smart Money
 * sentence are separate so context never reads as part of the detection.
 */
import type { Pack, PackSmartMoneyContext, PatternMetrics, SmartMoneyWindowMetric } from "@packlens/contracts";
import { BASELINE_DETECTOR_CONFIG, detectorConfigForVersion } from "../config.js";
import { parseDecimal } from "../lib/decimal.js";

export function formatUsd(value: string): string {
  const d = parseDecimal(value);
  const fixed = d.toDecimalPlaces(2).toFixed(2);
  const [int, frac] = fixed.split(".");
  const withCommas = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}${frac === "00" ? "" : `.${frac}`}`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

export function packSentence(core: Pack, patterns: PatternMetrics): string {
  const min = formatUsd((detectorConfigForVersion(core.configVersion) ?? BASELINE_DETECTOR_CONFIG).minTradeUsd);
  const parts = [
    patterns.initialEntrySpanMs === 0
      ? `${core.initialWalletCount} wallets each bought ${min} or more in the same second.`
      : `${core.initialWalletCount} wallets each bought ${min} or more within ${seconds(patterns.initialEntrySpanMs)} seconds.`,
  ];
  if (core.totalWalletCount > core.initialWalletCount) {
    parts.push(`${core.totalWalletCount - core.initialWalletCount} more joined later (${core.totalWalletCount} in total).`);
  }
  parts.push(`Together they bought ${formatUsd(core.eligibleBuyUsd)}.`);
  return parts.join(" ");
}

export function smartMoneySentence(oneHour: SmartMoneyWindowMetric | undefined, confirmation: PackSmartMoneyContext): string {
  if (!oneHour || oneHour.countQualifier === "unknown" || oneHour.observedUniqueBuyers === null) {
    return "Smart Money data has not been checked.";
  }
  const n = oneHour.observedUniqueBuyers;
  const buyers =
    oneHour.countQualifier === "observed"
      ? `${n} Smart Money ${n === 1 ? "buyer" : "buyers"} observed over 1 hour in the checked data`
      : n === 0
        ? "No Smart Money buyers observed over 1 hour; data is incomplete"
        : `At least ${n} Smart Money ${n === 1 ? "buyer" : "buyers"} observed over 1 hour`;
  const members =
    confirmation.confirmedMemberCount === null
      ? "pack wallets have not been checked"
      : `${confirmation.confirmedMemberCount} of ${confirmation.totalMemberCount} pack wallets confirmed`;
  return `${buyers}; ${members}.`;
}
