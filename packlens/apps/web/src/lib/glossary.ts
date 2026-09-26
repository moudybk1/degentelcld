/**
 * One vocabulary for tooltips and the Guide page, so every explanation of a
 * number reads the same wherever it appears.
 */
export const GLOSSARY = {
  uniqueWallets: {
    term: "Unique wallets",
    text: "Distinct addresses that made qualifying buys in this pack. One person can control several wallets, so this is not a head count.",
  },
  packBuys: {
    term: "Pack buys",
    text: "The total of the pack's own buys, each at least $20. It is not the token's total trading volume.",
  },
  pack: {
    term: "Pack",
    text: "A group of 3 or more different wallets that each bought at least $20 of the same pump.fun token within 20 seconds. It shows buying happened together, not who is behind it or what the price will do.",
  },
  entrySpread: {
    term: "Entry window",
    text: "Time between the first and the last buy of the wallets that started the pack. 0 s means they all landed in the same second.",
  },
  initialExpanded: {
    term: "Started it or joined later",
    text: "The wallets that started the pack bought within 20 seconds of each other (3 or more). Wallets that joined later bought within 40 seconds of the first buy while the group was still active.",
  },
  packState: {
    term: "Forming or final",
    text: "Forming: the pack can still gain wallets, up to 40 seconds after its first buy. Final: that window has closed and the list of wallets is fixed.",
  },
  sizeCV: {
    term: "Buy size variation",
    text: "How much the wallets' buy sizes differ. 0 means every wallet spent the same; above 1 means very uneven sizes. Very uniform sizing is worth a closer look.",
  },
  largestBuyer: {
    term: "Largest buyer",
    text: "The biggest wallet's share of the pack's buying. A high share means the group is mostly one buyer. It is not a share of the token's supply.",
  },
  cooccurrence: {
    term: "Repeat pairs",
    text: "Pairs of these wallets that also bought together in earlier packs on other tokens in the last 24 hours. Repeat pairs suggest a recurring group.",
  },
  sinceEntry: {
    term: "Now vs entry",
    text: "The latest observed trade price compared with the pack's average entry price, in SOL. +50% means the token last traded 50% above where the pack bought.",
  },
  peak: {
    term: "Peak after the pack",
    text: "The highest trade price observed after the pack formed, compared with the pack's average entry price.",
  },
  membersSold: {
    term: "Pack wallets sold",
    text: "How many pack wallets have sold some of this token since their first buy, and what share of the tokens they bought has been sold.",
  },
  activity: {
    term: "Activity since the pack",
    text: "All buys and sells of this token observed on pump.fun after the pack formed. Net SOL above zero means more SOL was spent buying than received selling.",
  },
  earlierPacks: {
    term: "Earlier packs with these wallets",
    text: "Earlier packs that include at least two of these wallets, with how that token moved in the 15 minutes after that pack formed. Past moves do not predict the next one.",
  },
  smTokenBuyers: {
    term: "Smart Money on the token",
    text: "Wallets that Nansen labels Smart Money and that bought this token in the window, whether or not they are in the pack.",
  },
  smConfirmed: {
    term: "Confirmed pack wallets",
    text: "Pack wallets whose own pack purchase appears in Nansen's Smart Money data. 'Not confirmed' does not mean the wallet is not Smart Money.",
  },
  qualifiers: {
    term: "Observed or at least",
    text: "'Observed' means Nansen's full results for the window were checked. 'At least' means only part was checked, so there may be more. 'Not checked' means unknown, not zero.",
  },
  netflow: {
    term: "Smart Money netflow",
    text: "Nansen's net Smart Money flow for the token, including exchange transfers. A separate metric; it never confirms a pack wallet's buy.",
  },
  analysis: {
    term: "Nansen checks",
    text: "Nansen wallet histories, relationships, and holders. The largest packs are checked automatically while credits allow; others show 'Not checked yet' until an operator runs the checks.",
  },
  priceEstimate: {
    term: "USD values",
    text: "USD values use a Nansen SOL price from a recent closed candle, pinned when the buy arrived. They are estimates, especially near $20.",
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
