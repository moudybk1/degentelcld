import { createContext, useContext } from "react";
import type { DetectionRule } from "@packlens/contracts";

/** The spec baseline, used until the server reports the namespace's rule (and by older servers). */
export const BASELINE_RULE: DetectionRule = {
  version: "pack-baseline-v1",
  minUniqueWallets: 3,
  minTradeUsd: "20",
  triggerWindowSeconds: 20,
  expansionSeconds: 40,
  isBaseline: true,
};

const RuleContext = createContext<DetectionRule>(BASELINE_RULE);

export const RuleProvider = RuleContext.Provider;

/** The pack rule of the namespace being viewed. */
export function useRule(): DetectionRule {
  return useContext(RuleContext);
}

/** "$25" or "$25.50". */
export function ruleUsd(rule: DetectionRule): string {
  return rule.minTradeUsd.includes(".") ? `$${Number(rule.minTradeUsd).toFixed(2)}` : `$${rule.minTradeUsd}`;
}

/** Fills {wallets}, {usd}, {window} and {expansion} in shared explanations with the active rule. */
export function ruleText(text: string, rule: DetectionRule): string {
  return text
    .replaceAll("{wallets}", String(rule.minUniqueWallets))
    .replaceAll("{usd}", ruleUsd(rule))
    .replaceAll("{window}", String(rule.triggerWindowSeconds))
    .replaceAll("{expansion}", String(rule.expansionSeconds));
}

/** One sentence naming the rule, marking a non-baseline rule as custom. */
export function ruleSentence(rule: DetectionRule): string {
  const base = `at least ${rule.minUniqueWallets} unique wallets, ${ruleUsd(rule)} per eligible buy, within ${rule.triggerWindowSeconds} seconds`;
  return rule.isBaseline ? base : `${base} (custom rule ${rule.version}; the spec baseline is 3 wallets and $20)`;
}
