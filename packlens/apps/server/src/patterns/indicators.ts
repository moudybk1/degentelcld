/**
 * Factual pattern indicators, formula version patterns-v1 (blueprint §7.1).
 * Inputs are pack evidence and earlier packs in the same namespace only.
 * Smart Money is not an input. There is no combined P0 score.
 */
import type { PackMember, PatternMetrics } from "@packlens/contracts";
import { Decimal, parseDecimal, ratio18 } from "../lib/decimal.js";

export const PATTERN_FORMULA_VERSION = "patterns-v1" as const;
export const COOCCURRENCE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type EarlierPackMembership = {
  packId: string;
  mint: string;
  triggerEventTimeMs: number;
  wallets: string[];
};

export type PatternInputs = {
  mint: string;
  triggerEventTimeMs: number;
  members: PackMember[];
  /** Packs in the same namespace, other mints, strictly earlier triggers, not invalidated. */
  earlierPacks: EarlierPackMembership[];
  /** Earliest event time actually observed in this namespace (coverage start). */
  namespaceFirstObservedMs: number | null;
};

function span(times: number[]): number {
  if (times.length === 0) return 0;
  return Math.max(...times) - Math.min(...times);
}

/** Population standard deviation of per-member eligible value divided by its mean. */
export function buySizeCV(values: Decimal[]): string | null {
  const n = values.length;
  if (n < 2) return null;
  const total = values.reduce((a, v) => a.plus(v), new Decimal(0));
  const mean = total.div(n);
  if (mean.isZero()) return null;
  const variance = values.reduce((a, v) => a.plus(v.minus(mean).pow(2)), new Decimal(0)).div(n);
  return ratio18(variance.sqrt().div(mean));
}

export function largestBuyerShare(values: Decimal[]): string | null {
  if (values.length === 0) return null;
  const total = values.reduce((a, v) => a.plus(v), new Decimal(0));
  if (total.isZero()) return null;
  const max = values.reduce((a, v) => (v.greaterThan(a) ? v : a), values[0]!);
  return ratio18(max.div(total));
}

/** Distinct sorted member pairs that also appear together in an earlier other-token pack within 24 hours. */
export function cooccurrencePairs(inputs: PatternInputs): number {
  const memberSet = new Set(inputs.members.map((m) => m.walletAddress));
  const lookbackStart = inputs.triggerEventTimeMs - COOCCURRENCE_LOOKBACK_MS;
  const pairs = new Set<string>();
  for (const p of inputs.earlierPacks) {
    if (p.mint === inputs.mint) continue;
    if (!(p.triggerEventTimeMs < inputs.triggerEventTimeMs && p.triggerEventTimeMs >= lookbackStart)) continue;
    const shared = [...new Set(p.wallets.filter((w) => memberSet.has(w)))].sort();
    for (let i = 0; i < shared.length; i++) {
      for (let j = i + 1; j < shared.length; j++) pairs.add(`${shared[i]}|${shared[j]}`);
    }
  }
  return pairs.size;
}

export function computePatterns(inputs: PatternInputs): PatternMetrics {
  const initial = inputs.members.filter((m) => m.memberKind === "initial");
  const values = inputs.members.map((m) => parseDecimal(m.eligibleBuyUsd));
  const lookbackStart = inputs.triggerEventTimeMs - COOCCURRENCE_LOOKBACK_MS;
  const coverageStart =
    inputs.namespaceFirstObservedMs === null ? null : Math.max(lookbackStart, inputs.namespaceFirstObservedMs);
  return {
    formulaVersion: PATTERN_FORMULA_VERSION,
    initialEntrySpanMs: span(initial.map((m) => m.initialFirstEntryTimeMs ?? m.firstEntryTimeMs)),
    allMemberEntrySpanMs: span(inputs.members.map((m) => m.firstEntryTimeMs)),
    memberCount: inputs.members.length,
    buySizeCV: buySizeCV(values),
    largestBuyerShare: largestBuyerShare(values),
    cooccurrencePairCount: cooccurrencePairs(inputs),
    cooccurrenceCoverageStart: coverageStart === null ? null : new Date(coverageStart).toISOString(),
    patternScore: null,
  };
}
