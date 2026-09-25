/**
 * Pack member confirmation (blueprint §9.6). Strong matching requires chain,
 * wallet, bought mint, and a transaction hash that belongs to the member's
 * pack evidence. A wallet seen elsewhere is only `wallet_seen`. Missing from
 * the checked sample means unconfirmed, never proven absent.
 */
import type { MemberMatchState } from "@packlens/contracts";
import type { ObservationForCount } from "./aggregate.js";

export type MemberEvidence = {
  walletAddress: string;
  /** Signatures of this member's pack evidence events. */
  signatures: string[];
};

export type MemberMatch = {
  walletAddress: string;
  matchState: MemberMatchState;
  matchedObservationIds: string[];
  checkedAt: string | null;
};

export type MatchInput = {
  mint: string;
  members: MemberEvidence[];
  /** Observations in the checked scope (token lookup plus any global rows for this namespace). */
  observations: readonly ObservationForCount[];
  /** Whether a scan for this mint has actually been completed in some scope. */
  checked: boolean;
  checkedAtMs: number | null;
};

export function matchMembers(input: MatchInput): { matches: MemberMatch[]; confirmedMemberCount: number | null; checkedMemberCount: number } {
  if (!input.checked) {
    return {
      matches: input.members.map((m) => ({ walletAddress: m.walletAddress, matchState: "not_checked", matchedObservationIds: [], checkedAt: null })),
      confirmedMemberCount: null,
      checkedMemberCount: 0,
    };
  }
  const checkedAt = input.checkedAtMs === null ? null : new Date(input.checkedAtMs).toISOString();
  const matches: MemberMatch[] = input.members.map((m) => {
    const sigs = new Set(m.signatures);
    const confirmed = input.observations.filter(
      (o) => o.chain === "solana" && o.traderAddress === m.walletAddress && o.tokenBoughtAddress === input.mint && sigs.has(o.transactionHash),
    );
    if (confirmed.length > 0) {
      return { walletAddress: m.walletAddress, matchState: "pack_buy_confirmed", matchedObservationIds: confirmed.map((o) => o.id), checkedAt };
    }
    // Same transaction hash attributed to a different trader: the purchase match itself is uncertain.
    const sameTxOtherTrader = input.observations.filter(
      (o) => o.chain === "solana" && sigs.has(o.transactionHash) && o.tokenBoughtAddress === input.mint && o.traderAddress !== m.walletAddress,
    );
    if (sameTxOtherTrader.length > 0) {
      return { walletAddress: m.walletAddress, matchState: "ambiguous", matchedObservationIds: sameTxOtherTrader.map((o) => o.id), checkedAt };
    }
    const seen = input.observations.filter((o) => o.chain === "solana" && o.traderAddress === m.walletAddress);
    if (seen.length > 0) {
      return { walletAddress: m.walletAddress, matchState: "wallet_seen", matchedObservationIds: seen.map((o) => o.id), checkedAt };
    }
    return { walletAddress: m.walletAddress, matchState: "checked_no_match", matchedObservationIds: [], checkedAt };
  });
  const confirmed = new Set(matches.filter((m) => m.matchState === "pack_buy_confirmed").map((m) => m.walletAddress));
  return { matches, confirmedMemberCount: confirmed.size, checkedMemberCount: input.members.length };
}
