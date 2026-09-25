/**
 * PackLens shared contracts.
 *
 * Domain types follow blueprint §4, §9, and §11 exactly. Additive fields are
 * documented where they extend a canonical shape; canonical names are never
 * renamed. Decimals are strings; unknown values are null.
 */

export type Mode = "fixture" | "live" | "replay";
export type Chain = "solana";

/* ------------------------------------------------------------------ */
/* §4.1 Transaction event                                              */
/* ------------------------------------------------------------------ */

export type ValuationStatus = "valued" | "missing_price" | "stale_price" | "unsupported_quote";
export type CoreEligibility = "pending" | "eligible" | "ineligible" | "late";

export type TradeEvent = {
  eventId: string; // chain + signature + decoder ordinal
  namespace: string; // live:<campaignId>, fixture:<datasetId>, replay:<runId>
  chain: "solana";
  source: "pumpfun";
  sourceMode: "live" | "backfill" | "replay" | "fixture";
  signature: string;
  eventOrdinal: number;
  slot: number;
  blockTimeMs: number;
  receivedAtMs: number;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  tokenAmountRaw: string;
  tokenDecimals: number;
  quoteAmountRaw: string; // traded quote amount, excluding separately identified fees
  quoteDecimals: number;
  quoteAssetAddress: string; // native SOL uses the WSOL mint for price lookup
  quoteUsdPrice: string | null;
  quotePriceAtMs: number | null; // selected candle intervalStart
  priceSnapshotId: string | null;
  priceCandleEndMs: number | null;
  valuationStatus: ValuationStatus;
  tradeValueUsd: string | null;
  priceSource: string | null;
  decoderVersion: string;
  normalizedAtMs: number;
  coreEligibility: CoreEligibility;
};

/** Additive: why an event is or is not eligible for detection. */
export type EligibilityReason =
  | "eligible"
  | "sell"
  | "below_threshold"
  | "missing_price"
  | "stale_price"
  | "unsupported_quote"
  | "late"
  | "backfill"
  | "invalid";

/* ------------------------------------------------------------------ */
/* §4.2 Detector configuration                                         */
/* ------------------------------------------------------------------ */

export type DetectorConfig = {
  version: string;
  minTradeUsd: "20";
  minUniqueWallets: 3;
  triggerWindowMs: 20000;
  expansionFromStartMs: 40000;
  cooldownFromLastUpdateMs: 120000;
  reorderToleranceMs: 2000;
};

/* ------------------------------------------------------------------ */
/* §4.3 Pack and evidence                                              */
/* ------------------------------------------------------------------ */

export type Pack = {
  id: string;
  namespace: string;
  chain: "solana";
  tokenAddress: string;
  state: "collecting" | "frozen";
  configVersion: string;
  firstEventTimeMs: number;
  triggerEventTimeMs: number;
  triggeredAtMs: number;
  lastAcceptedEventTimeMs: number;
  initialWalletCount: number;
  totalWalletCount: number;
  eligibleBuyUsd: string;
  expansionEndMs: number;
  suppressUntilMs: number;
  coreVersion: number; // all core changes, including freeze
  evidenceVersion: number; // newly accepted evidence only
};

export type PackMember = {
  packId: string;
  walletAddress: string;
  memberKind: "initial" | "expanded";
  firstEntryTimeMs: number; // first evidence time; displayed as entry
  initialFirstEntryTimeMs: number | null; // initial members only; immutable
  joinedAtEventTimeMs: number; // trigger or expansion-window time that admitted the member
  eligibleBuyUsd: string;
  eventIds: string[];
};

/** Additive: evidence role for each pack event. */
export type EvidenceMeta = {
  eventId: string;
  role: "initial" | "expansion";
  acceptedAtEventTimeMs: number;
  acceptedAtExpansion: boolean;
};

/* ------------------------------------------------------------------ */
/* §4.4 Panel state                                                    */
/* ------------------------------------------------------------------ */

export type PanelAvailability =
  | "not_requested"
  | "queued"
  | "available"
  | "empty"
  | "unavailable"
  | "error"
  | "budget_paused";

export type PanelState = {
  availability: PanelAvailability;
  coverage: "unknown" | "partial" | "window_scanned";
  freshness: "unknown" | "fresh" | "stale";
  fetchedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reasonCode: string | null;
  snapshotIds: string[];
};

export type Panel<T> = { data: T | null; state: PanelState };

/* ------------------------------------------------------------------ */
/* §9 Smart Money                                                      */
/* ------------------------------------------------------------------ */

export type SmartMoneyObservation = {
  id: string;
  chain: "solana";
  transactionHash: string;
  traderAddress: string;
  tokenBoughtAddress: string;
  tokenSoldAddress: string;
  blockTimeMs: number;
  tradeValueUsd: string | null;
  fingerprint: string;
  ambiguousSwapIdentity: boolean;
  scopeHash: string;
  snapshotId: string;
};

export type SmartMoneyWindow = "5m" | "1h" | "24h";

export type SmartMoneyWindowMetric = {
  window: SmartMoneyWindow;
  windowStart: string;
  windowEnd: string;
  observedUniqueBuyers: number | null;
  countQualifier: "observed" | "at_least" | "unknown";
  knownBuyUsd: string | null;
  missingValuationCount: number;
  ambiguousTradeCount: number;
  state: PanelState;
  scopeHash: string;
};

export type MemberMatchState =
  | "not_checked"
  | "checked_no_match"
  | "wallet_seen"
  | "pack_buy_confirmed"
  | "ambiguous";

export type PackSmartMoneyContext = {
  packId: string;
  evidenceVersion: number | null; // null if never checked
  contextVersion: number;
  confirmedMemberCount: number | null;
  checkedMemberCount: number;
  totalMemberCount: number;
  matchedObservationIds: string[];
  memberMatches: {
    walletAddress: string;
    matchState: MemberMatchState;
    matchedObservationIds: string[];
    checkedAt: string | null;
  }[];
  state: PanelState;
  updatedAt: string | null;
};

/* ------------------------------------------------------------------ */
/* §11.2 Canonical detail DTO                                          */
/* ------------------------------------------------------------------ */

export type Envelope<T> = {
  schemaVersion: string;
  namespace: string;
  mode: Mode;
  data: T;
  requestId: string;
};

export type PatternMetrics = {
  formulaVersion: "patterns-v1";
  initialEntrySpanMs: number;
  allMemberEntrySpanMs: number;
  memberCount: number;
  buySizeCV: string | null;
  largestBuyerShare: string | null;
  cooccurrencePairCount: number;
  cooccurrenceCoverageStart: string | null;
  patternScore: null;
};

export type AnalysisState =
  | "not_requested"
  | "queued"
  | "running"
  | "partial"
  | "complete"
  | "error"
  | "budget_paused";

export type ReviewFlag = "CHECK_RELATIONSHIP" | "CHECK_CONCENTRATION";

export type Assessment = {
  version: number;
  analysisState: AnalysisState;
  reviewFlags: ReviewFlag[];
  scheduledMemberCount: number;
  totalMemberCount: number;
  snapshotIds: string[];
};

export type NetflowWindow = "1h" | "24h" | "7d" | "30d";

export type Netflow = {
  asOf: string | null; // provider timestamp if available; never fabricate
  fetchedAt: string;
  values: {
    window: NetflowWindow;
    netFlowUsd: string | null;
  }[];
  scopeHash: string;
  /** Additive: provider metadata, not a substitute for observed buyers. */
  traderCount30d?: number | null;
};

export type PackCoverage = {
  source: "pumpfun";
  commitment: "confirmed";
  quoteMints: string[];
  gapIds: string[];
  lateEventCount: number;
  unvaluedEventCount: number;
  auditedInvalidated: boolean;
};

/* Additive: base Nansen context panels shown on detail, wallet and token pages. */

export type TokenIdentity = {
  chain: "solana";
  mint: string;
  name: string | null;
  symbol: string | null;
  /** Where the name/symbol came from; token text is untrusted display data. */
  identitySource: "pumpfun_create_event" | "nansen_token_information" | null;
};

export type TokenInfoData = {
  name: string | null;
  symbol: string | null;
  logo: string | null;
  deploymentDate: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  circulatingSupply: string | null;
  totalSupply: string | null;
  timeframe: string;
  spot: {
    volumeTotalUsd: string | null;
    buyVolumeUsd: string | null;
    sellVolumeUsd: string | null;
    totalBuys: number | null;
    totalSells: number | null;
    uniqueBuyers: number | null;
    uniqueSellers: number | null;
    liquidityUsd: string | null;
    totalHolders: number | null;
  } | null;
};

export type HolderRow = {
  address: string;
  label: string | null;
  tokenAmount: string | null;
  ownershipPercentage: string | null;
  valueUsd: string | null;
  balanceChange24h: string | null;
  isPackMember: boolean;
};

export type HoldersData = {
  holders: HolderRow[];
  page: number;
  perPage: number;
  isLastPage: boolean | null;
  warnings: string[];
  /** Sum of returned holders' token amounts divided by verified total supply (0-1), or null. */
  observedTopShare: string | null;
  observedHolderCount: number;
  totalSupplyUsed: string | null;
};

export type PnlData = {
  periodStart: string;
  periodEnd: string;
  realizedPnlUsd: string | null;
  realizedPnlPercent: string | null;
  winRate: string | null;
  tradedTimes: number | null;
  tradedTokenCount: number | null;
  top5Tokens: { tokenAddress: string; tokenSymbol: string | null; realizedPnl: string | null; realizedRoi: string | null }[];
};

export type WalletTradeRow = {
  transactionHash: string;
  blockTimestamp: string;
  tokenBoughtAddress: string;
  tokenBoughtSymbol: string | null;
  tokenSoldAddress: string;
  tokenSoldSymbol: string | null;
  tokenBoughtAmount: string | null;
  tokenSoldAmount: string | null;
  tradeValueUsd: string | null;
};

export type DexHistoryData = {
  periodStart: string;
  periodEnd: string;
  trades: WalletTradeRow[];
  sampleSize: number;
  page: number;
  isLastPage: boolean | null;
};

export type RelatedWalletRow = {
  address: string;
  label: string | null;
  relation: string;
  transactionHash: string;
  blockTimestamp: string;
  order: number | null;
  isPackMember: boolean;
};

export type RelatedData = {
  related: RelatedWalletRow[];
  page: number;
  isLastPage: boolean | null;
};

export type BalanceData = {
  scheduledAt: string | null;
  balances: {
    tokenAddress: string;
    tokenSymbol: string | null;
    tokenAmount: string | null;
    priceUsd: string | null;
    valueUsd: string | null;
  }[];
  packToken: { tokenAddress: string; tokenAmount: string | null; valueUsd: string | null; observedOnFetchedPages: boolean } | null;
  page: number;
  isLastPage: boolean | null;
};

export type WalletContext = {
  walletAddress: string;
  pnl: Panel<PnlData>;
  dexHistory: Panel<DexHistoryData>;
  related: Panel<RelatedData>;
  balance: Panel<BalanceData>;
};

export type PackDetail = {
  core: Pack;
  members: PackMember[];
  evidence: TradeEvent[];
  patterns: PatternMetrics;
  assessment: Assessment;
  smartMoney: {
    contextVersion: number;
    asOf: string | null;
    windows: SmartMoneyWindowMetric[]; // exactly 5m, 1h, 24h, in this order
    packConfirmation: PackSmartMoneyContext;
    netflow: Panel<Netflow>;
  };
  coverage: PackCoverage;
  /** Additive fields below. */
  evidenceMeta: EvidenceMeta[];
  token: TokenIdentity;
  context: {
    tokenInfo: Panel<TokenInfoData>;
    holders: Panel<HoldersData>;
    wallets: WalletContext[];
    selectedProfileWallets: string[];
    selectedRelationshipWallets: string[];
  };
  summary: string;
  history: { at: string; kind: string; detail: string }[];
  isDemoPinned: boolean;
  /** Additive: decision-support facts and a plain-language reading (no predictions). */
  after: AfterPackData;
  earlierPacks: EarlierPack[];
  readout: ReadoutItem[];
};

/* ------------------------------------------------------------------ */
/* After the pack: facts from the monitored pump.fun stream (no Nansen) */
/* ------------------------------------------------------------------ */

/** Percent values are ratios in percent (e.g. 42.5 = +42.5%), computed in SOL per token. */
export type AfterPackSummary = {
  lastChangePct: number | null;
  peakChangePct: number | null;
  lastTradeAt: string | null;
  tradesAfter: number;
  membersSold: number;
  memberCount: number;
  graduatedAt: string | null;
};

export type AfterPackPoint = { t: number; changePct: number };
export type AfterPackMarker = { t: number; changePct: number; kind: "pack_buy" | "member_sell"; wallet: string; solAmount: string };

export type MemberExit = {
  walletAddress: string;
  memberKind: "initial" | "expanded";
  tokensBought: string;
  tokensSold: string;
  soldShare: number;
  firstSellAt: string | null;
  secondsToFirstSell: number | null;
  lastActionAt: string | null;
};

export type AfterPackData = {
  asOf: string;
  entryPriceSol: string | null;
  lastPriceSol: string | null;
  lastPriceUsd: string | null;
  lastTradeAt: string | null;
  lastChangePct: number | null;
  peak: { changePct: number; at: string } | null;
  trough: { changePct: number; at: string } | null;
  marketCapUsd: string | null;
  activity: { buys: number; sells: number; uniqueBuyers: number; uniqueSellers: number; buySol: string; sellSol: string; netSol: string };
  members: {
    count: number;
    sold: number;
    exited: number;
    soldShare: number | null;
    firstSellAt: string | null;
    rows: MemberExit[];
  };
  series: AfterPackPoint[];
  markers: AfterPackMarker[];
  tokenCreatedAt: string | null;
  graduatedAt: string | null;
  observedSince: string | null;
  notes: string[];
};

export type EarlierPack = {
  packId: string;
  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  triggerEventTimeMs: number;
  sharedWallets: number;
  totalWalletCount: number;
  eligibleBuyUsd: string;
  /** Outcome in the 15 minutes after that pack formed, from observed trades (null if not observed). */
  peakChangePct15m: number | null;
  changePct15m: number | null;
};

export type ReadoutItem = {
  group: "happened" | "check" | "unknown";
  text: string;
};

export type PackDetailResponse = Envelope<PackDetail>;

/* ------------------------------------------------------------------ */
/* Radar list                                                          */
/* ------------------------------------------------------------------ */

export type PackListItem = {
  core: Pack;
  token: TokenIdentity;
  patterns: PatternMetrics;
  analysisState: AnalysisState;
  smartMoney1h: SmartMoneyWindowMetric;
  confirmedMemberCount: number | null;
  totalMemberCount: number;
  invalidated: boolean;
  after: AfterPackSummary;
};

export type PackListData = {
  items: PackListItem[];
  nextCursor: string | null;
  asOf: string;
  filters: RadarFilters;
};

export type RadarFilters = {
  minWallets: number;
  minUsd: string;
  mint: string | null;
  from: string | null;
  to: string | null;
  confirmedSmartMoneyOnly: boolean;
  includeInvalidated: boolean;
};

/* ------------------------------------------------------------------ */
/* Status and health                                                   */
/* ------------------------------------------------------------------ */

export type CollectorHealth = "connected" | "connecting" | "disconnected" | "not_configured" | "replay" | "fixture";

export type SourceStatus = {
  namespace: string;
  mode: Mode;
  source: "pumpfun";
  chain: "solana";
  commitment: "confirmed";
  decoderVersion: string;
  collector: {
    health: CollectorHealth;
    lastMessageAt: string | null;
    lastEventTimeMs: number | null;
    connectedSince: string | null;
    reconnects: number;
  };
  price: {
    state: "valid" | "waiting_for_price" | "stale" | "not_applicable";
    latestCandleStart: string | null;
    latestSnapshotAvailableAt: string | null;
    quoteMints: string[];
    /** Active quote-price policy: 1m baseline or the documented 5m fallback. */
    timeframe: "1m" | "5m";
    policyVersion: string;
    isBaseline: boolean;
  };
  counters: {
    notifications: number;
    failedTransactions: number;
    decodedEvents: number;
    buys: number;
    sells: number;
    eligible: number;
    late: number;
    duplicates: number;
    unvalued: number;
    undecodable: number;
    truncatedLogs: number;
  };
  openGaps: number;
  totalGaps: number;
  latestPackTriggerMs: number | null;
  packCount: number;
  session: { active: boolean; endsAt: string | null; smartMoneyEndsAt: string | null };
  smartMoneyEnabled: boolean;
  analysisPaused: { paused: boolean; reason: string | null };
  namespaces: { id: string; mode: Mode; createdAt: string }[];
};

/* ------------------------------------------------------------------ */
/* Token and Smart Money activity                                      */
/* ------------------------------------------------------------------ */

export type TokenPageData = {
  token: TokenIdentity;
  tokenInfo: Panel<TokenInfoData>;
  holders: Panel<HoldersData>;
  smartMoney: {
    asOf: string | null;
    windows: SmartMoneyWindowMetric[];
    netflow: Panel<Netflow>;
  };
  packs: PackListItem[];
  isDemoPinned: boolean;
  firstSeenInSource: string | null;
};

export type SmartMoneyActivityRow = {
  observationId: string;
  transactionHash: string;
  traderAddress: string;
  traderLabel: string | null;
  direction: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string | null;
  counterTokenAddress: string;
  counterTokenSymbol: string | null;
  tokenAmount: string | null;
  tradeValueUsd: string | null;
  blockTime: string;
  snapshotId: string;
  scope: string;
  hasPack: boolean;
};

export type SmartMoneyActivityData = {
  rows: SmartMoneyActivityRow[];
  nextCursor: string | null;
  asOf: string | null;
  state: PanelState;
  scopeDescription: string;
};

export type WalletPageData = {
  walletAddress: string;
  context: WalletContext;
  packs: { packId: string; tokenAddress: string; tokenSymbol: string | null; memberKind: "initial" | "expanded"; firstEntryTimeMs: number; eligibleBuyUsd: string; triggerEventTimeMs: number }[];
};

/* ------------------------------------------------------------------ */
/* Operator                                                            */
/* ------------------------------------------------------------------ */

export type UsageSummary = {
  campaignId: string | null;
  configuredBudget: number | null;
  credits: {
    settled: number;
    reserved: number;
    unresolved: number;
    available: number | null;
    priceReserve: number;
    lastReportedRemaining: number | null;
  };
  attempts: {
    total: number;
    httpSuccess: number;
    httpFailed: number;
    schemaValid: number;
    schemaInvalid: number;
    unresolved: number;
    cacheHits: number;
  };
  minimumTarget: number;
  relevantSuccessful: number;
  byEndpoint: { endpoint: string; attempts: number; httpSuccess: number; schemaValid: number; actualCredits: number }[];
  recent: {
    attemptId: string;
    startedAt: string;
    endpoint: string;
    purpose: string;
    subjectId: string | null;
    httpStatus: number | null;
    normalizationStatus: string;
    actualCredits: number | null;
    quotedCredits: number | null;
    reservationStatus: string;
    retryOfAttemptId: string | null;
  }[];
};

export type JobSummary = {
  id: string;
  lane: "PRICE" | "BASE_ENRICHMENT" | "SMART_MONEY";
  type: string;
  subject: string;
  status: string;
  statusReason: string | null;
  attempts: number;
  enqueuedAt: string;
  finishedAt: string | null;
};

export type OperatorOverview = {
  status: SourceStatus;
  usage: UsageSummary;
  jobs: { counts: Record<string, number>; recent: JobSummary[] };
  session: {
    active: boolean;
    id: string | null;
    startedAt: string | null;
    endsAt: string | null;
    smartMoneyEndsAt: string | null;
    configuredMaxEnd: string | null;
  };
  datasets: { id: string; label: string; origin: string; mode: string; eventCount: number; hash: string }[];
  replayRuns: { id: string; datasetId: string; mode: string; namespace: string; startedAt: string; finishedAt: string | null; resultHash: string | null }[];
  demoPins: { chain: "solana"; mint: string; enabled: boolean; updatedAt: string }[];
  errors: { at: string; component: string; code: string; message: string }[];
  analytics: { name: string; count: number }[];
  config: {
    configVersion: string;
    decoderVersion: string;
    smartMoneyEnabled: boolean;
    smartMoneyPollSeconds: number;
    priceRefreshSeconds: number;
    enrichmentAutoPacksPerCycle: number;
  };
};

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

export type SseEventType =
  | "pack.created"
  | "pack.updated"
  | "analysis.updated"
  | "smart_money.updated"
  | "source.status"
  | "resync_required";

export type SseMessage = {
  sequence: number;
  type: SseEventType;
  namespace: string;
  aggregateId: string;
  version: number;
  payload: Record<string, unknown>;
};

export type ApiError = {
  error: {
    code: "INVALID_INPUT" | "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN" | "BUDGET_PAUSED" | "SOURCE_UNAVAILABLE" | "SNAPSHOT_NOT_READY" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL";
    message: string;
    retryable: boolean;
    requestId: string;
  };
};
