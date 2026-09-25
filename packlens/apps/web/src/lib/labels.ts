import type { AnalysisState, MemberMatchState, SmartMoneyWindowMetric } from "@packlens/contracts";

/** Token-wide Smart Money buyer wording (PRD §10, blueprint §17.7). */
export function buyerCountText(m: SmartMoneyWindowMetric | undefined, period: string): { headline: string; detail: string } {
  if (!m || m.countQualifier === "unknown" || m.observedUniqueBuyers === null) {
    return { headline: "Not checked", detail: `Smart Money buyers over ${period} have not been analyzed yet.` };
  }
  const n = m.observedUniqueBuyers;
  if (m.countQualifier === "observed") {
    return n === 0
      ? { headline: "0 observed", detail: `0 buyers observed in the checked data over ${period}.` }
      : { headline: `${n} observed`, detail: `${n} unique ${n === 1 ? "buyer" : "buyers"} observed in the checked data over ${period}.` };
  }
  return n === 0
    ? { headline: "None observed", detail: `No buyers observed over ${period}; data is incomplete.` }
    : { headline: `At least ${n}`, detail: `At least ${n} unique ${n === 1 ? "buyer" : "buyers"} observed over ${period}; coverage is partial.` };
}

export function confirmedText(confirmed: number | null, total: number): string {
  if (confirmed === null) return "Not checked";
  return `${confirmed} of ${total}`;
}

export function analysisLabel(s: AnalysisState): { text: string; tone: "gray" | "green" | "yellow" | "red" | "blue" | "outline" } {
  switch (s) {
    case "not_requested":
      return { text: "Not analyzed yet", tone: "outline" };
    case "queued":
      return { text: "Queued", tone: "blue" };
    case "running":
      return { text: "Analysis running", tone: "blue" };
    case "partial":
      return { text: "Partial analysis", tone: "yellow" };
    case "complete":
      return { text: "Analysis complete", tone: "green" };
    case "error":
      return { text: "Analysis error", tone: "red" };
    case "budget_paused":
      return { text: "Analysis paused", tone: "yellow" };
  }
}

export function matchLabel(s: MemberMatchState): { text: string; tone: "gray" | "green" | "yellow" | "red" | "blue" | "outline"; help: string } {
  switch (s) {
    case "pack_buy_confirmed":
      return { text: "Confirmed", tone: "green", help: "A Smart Money observation matches this member's pack transaction, wallet, and bought token." };
    case "wallet_seen":
      return { text: "Wallet seen", tone: "blue", help: "The wallet appears in Smart Money data, but not with this pack's transaction. This is not a pack confirmation." };
    case "ambiguous":
      return { text: "Ambiguous", tone: "yellow", help: "A matching transaction was found but the purchase match itself is uncertain." };
    case "checked_no_match":
      return { text: "Not confirmed", tone: "outline", help: "Not confirmed in the checked data. This does not prove the wallet is not Smart Money." };
    case "not_checked":
      return { text: "Not checked", tone: "outline", help: "Smart Money data has not been checked for this member." };
  }
}

export const REVIEW_FLAG_TEXT: Record<string, string> = {
  CHECK_RELATIONSHIP: "Check relationship: the provider returned a direct relationship between pack members. A relationship does not prove common ownership.",
  CHECK_CONCENTRATION: "Check concentration: the observed top holders exceed the configured threshold of verified supply.",
};
