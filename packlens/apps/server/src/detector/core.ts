/**
 * Pure pack detector (blueprint §6). Accepts only trade events, configuration,
 * an injected processing time, and per-token state. It performs no I/O and
 * has no access to Smart Money, Nansen, or any enrichment context.
 */
import type { DetectorConfig, EligibilityReason, PackMember, ValuationStatus } from "@packlens/contracts";
import { canonical, Decimal, parseDecimal } from "../lib/decimal.js";
import { packIdFor } from "../lib/ids.js";

export type DetectorInput = {
  eventId: string;
  walletAddress: string;
  tokenAddress: string;
  timeMs: number;
  slot: number;
  signature: string;
  ordinal: number;
  side: "buy" | "sell";
  valuationStatus: ValuationStatus;
  tradeValueUsd: string | null;
  admission: "admitted" | "late" | "backfill";
};

export type BufferedEvent = {
  eventId: string;
  wallet: string;
  timeMs: number;
  usd: string;
  slot: number;
  signature: string;
  ordinal: number;
};

export type EvidenceEntry = BufferedEvent & {
  role: "initial" | "expansion";
  acceptedAtEventTimeMs: number;
  acceptedAtExpansion: boolean;
  evidenceVersion: number;
};

export type ActivePack = {
  id: string;
  mint: string;
  firstEventTimeMs: number;
  triggerEventTimeMs: number;
  triggerEventId: string;
  triggeredAtMs: number;
  expansionEndMs: number;
  lastAcceptedEventTimeMs: number;
  suppressUntilMs: number;
  initialWallets: string[];
  initialFirstEntry: Record<string, number>;
  memberKinds: Record<string, "initial" | "expanded">;
  joinedAt: Record<string, number>;
  evidence: EvidenceEntry[];
  coreVersion: number;
  evidenceVersion: number;
};

export type TokenState = {
  namespace: string;
  chain: "solana";
  mint: string;
  buffer: BufferedEvent[];
  active: ActivePack | null;
  suppressUntilMs: number | null;
  configVersion: string;
};

export type CoreEffect =
  | { kind: "pack.created"; pack: ActivePack }
  | { kind: "pack.expanded"; pack: ActivePack; added: EvidenceEntry[]; newWallets: string[] }
  | { kind: "pack.frozen"; pack: ActivePack; frozenAtWatermarkMs: number | null; frozenByEventTimeMs: number | null };

export type ConsumeResult = {
  eligibility: { eligible: boolean; reason: EligibilityReason };
  effects: CoreEffect[];
};

export function newTokenState(namespace: string, mint: string, configVersion: string): TokenState {
  return { namespace, chain: "solana", mint, buffer: [], active: null, suppressUntilMs: null, configVersion };
}

/** Deterministic processing order: (E, slot, signature, ordinal). */
export function compareOrder(a: { timeMs: number; slot: number; signature: string; ordinal: number }, b: { timeMs: number; slot: number; signature: string; ordinal: number }): number {
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.signature !== b.signature) return a.signature < b.signature ? -1 : 1;
  return a.ordinal - b.ordinal;
}

export function classifyEligibility(event: DetectorInput, config: DetectorConfig): { eligible: boolean; reason: EligibilityReason } {
  if (event.admission === "late") return { eligible: false, reason: "late" };
  if (event.admission === "backfill") return { eligible: false, reason: "backfill" };
  if (event.side !== "buy") return { eligible: false, reason: "sell" };
  if (event.valuationStatus !== "valued" || event.tradeValueUsd === null) {
    const reason: EligibilityReason =
      event.valuationStatus === "valued" ? "missing_price" : (event.valuationStatus as EligibilityReason);
    return { eligible: false, reason };
  }
  let usd: Decimal;
  try {
    usd = parseDecimal(event.tradeValueUsd);
  } catch {
    return { eligible: false, reason: "invalid" };
  }
  if (usd.isNegative()) return { eligible: false, reason: "invalid" };
  // Evaluated before any rounding (NFR-01): $19.99 fails, $20 passes.
  if (usd.lessThan(parseDecimal(config.minTradeUsd))) return { eligible: false, reason: "below_threshold" };
  return { eligible: true, reason: "eligible" };
}

function freeze(state: TokenState, byEventTimeMs: number | null, atWatermarkMs: number | null): CoreEffect | null {
  const pack = state.active;
  if (!pack) return null;
  pack.coreVersion += 1;
  state.active = null;
  // suppressUntil is retained even though activePackId becomes null.
  state.suppressUntilMs = pack.suppressUntilMs;
  return { kind: "pack.frozen", pack, frozenAtWatermarkMs: atWatermarkMs, frozenByEventTimeMs: byEventTimeMs };
}

function distinctWallets(events: BufferedEvent[]): Set<string> {
  return new Set(events.map((e) => e.wallet));
}

/**
 * consumeOrdered (blueprint §6.4). Mutates `state`; callers clone before
 * calling if they need rollback. `processingTimeMs` becomes triggeredAtMs.
 */
export function consumeOrdered(state: TokenState, event: DetectorInput, config: DetectorConfig, processingTimeMs: number): ConsumeResult {
  if (event.tokenAddress !== state.mint) throw new Error("Event routed to the wrong token state");
  const eligibility = classifyEligibility(event, config);
  const effects: CoreEffect[] = [];
  if (!eligibility.eligible) return { eligibility, effects };

  const t = event.timeMs;
  // Finalize old state first so the same event can trigger a new pack.
  if (state.active && t > state.active.expansionEndMs) {
    const e = freeze(state, t, null);
    if (e) effects.push(e);
  }

  const entry: BufferedEvent = {
    eventId: event.eventId,
    wallet: event.walletAddress,
    timeMs: t,
    usd: canonical(parseDecimal(event.tradeValueUsd!)),
    slot: event.slot,
    signature: event.signature,
    ordinal: event.ordinal,
  };
  if (!state.buffer.some((b) => b.eventId === entry.eventId)) {
    state.buffer.push(entry);
    state.buffer.sort(compareOrder);
  }
  const lower = t - config.triggerWindowMs;
  state.buffer = state.buffer.filter((b) => b.timeMs >= lower);
  const window = state.buffer.filter((b) => b.timeMs >= lower && b.timeMs <= t);
  const walletSet = distinctWallets(window);

  const active = state.active;
  if (active) {
    if (t <= active.expansionEndMs && walletSet.size >= config.minUniqueWallets) {
      const existing = new Set(active.evidence.map((e) => e.eventId));
      const addedRaw = window.filter((w) => w.timeMs >= active.firstEventTimeMs && w.timeMs <= active.expansionEndMs && !existing.has(w.eventId));
      if (addedRaw.length > 0) {
        active.evidenceVersion += 1;
        active.coreVersion += 1;
        const newWallets: string[] = [];
        const added: EvidenceEntry[] = addedRaw.map((w) => ({
          ...w,
          role: "expansion",
          acceptedAtEventTimeMs: t,
          acceptedAtExpansion: w.timeMs < t,
          evidenceVersion: active.evidenceVersion,
        }));
        for (const a of added) {
          if (active.memberKinds[a.wallet] === undefined) {
            active.memberKinds[a.wallet] = "expanded";
            active.joinedAt[a.wallet] = t;
            newWallets.push(a.wallet);
          }
        }
        active.evidence.push(...added);
        active.evidence.sort(compareOrder);
        active.lastAcceptedEventTimeMs = Math.max(...active.evidence.map((e) => e.timeMs));
        active.suppressUntilMs = active.lastAcceptedEventTimeMs + config.cooldownFromLastUpdateMs;
        state.suppressUntilMs = active.suppressUntilMs;
        effects.push({ kind: "pack.expanded", pack: active, added, newWallets });
      }
    }
  } else if ((state.suppressUntilMs === null || t >= state.suppressUntilMs) && walletSet.size >= config.minUniqueWallets) {
    const firstTime = Math.min(...window.map((w) => w.timeMs));
    const lastTime = Math.max(...window.map((w) => w.timeMs));
    const initialFirstEntry: Record<string, number> = {};
    for (const w of window) {
      const prev = initialFirstEntry[w.wallet];
      if (prev === undefined || w.timeMs < prev) initialFirstEntry[w.wallet] = w.timeMs;
    }
    const initialWallets = [...walletSet].sort((a, b) => {
      const d = initialFirstEntry[a]! - initialFirstEntry[b]!;
      return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
    });
    const memberKinds: Record<string, "initial" | "expanded"> = {};
    const joinedAt: Record<string, number> = {};
    for (const w of initialWallets) {
      memberKinds[w] = "initial";
      joinedAt[w] = t;
    }
    const pack: ActivePack = {
      id: packIdFor(state.namespace, config.version, state.mint, event.eventId),
      mint: state.mint,
      firstEventTimeMs: firstTime,
      triggerEventTimeMs: t,
      triggerEventId: event.eventId,
      triggeredAtMs: processingTimeMs,
      expansionEndMs: firstTime + config.expansionFromStartMs,
      lastAcceptedEventTimeMs: lastTime,
      suppressUntilMs: lastTime + config.cooldownFromLastUpdateMs,
      initialWallets,
      initialFirstEntry,
      memberKinds,
      joinedAt,
      evidence: window.map((w) => ({ ...w, role: "initial", acceptedAtEventTimeMs: t, acceptedAtExpansion: false, evidenceVersion: 1 })),
      coreVersion: 1,
      evidenceVersion: 1,
    };
    state.active = pack;
    state.suppressUntilMs = pack.suppressUntilMs;
    effects.push({ kind: "pack.created", pack });
  }
  return { eligibility, effects };
}

/**
 * Timer processing after draining events with E <= W. A pack freezes only when
 * the watermark is strictly greater than expansionEnd (§5.4).
 */
export function advanceWatermark(state: TokenState, watermarkMs: number): CoreEffect[] {
  if (state.active && watermarkMs > state.active.expansionEndMs) {
    const e = freeze(state, null, watermarkMs);
    return e ? [e] : [];
  }
  return [];
}

/** A checkpoint may be dropped once it holds no active pack, no live buffer, and no cooldown. */
export function isDisposable(state: TokenState, watermarkMs: number, config: DetectorConfig): boolean {
  if (state.active) return false;
  if (state.suppressUntilMs !== null && state.suppressUntilMs > watermarkMs) return false;
  return state.buffer.every((b) => b.timeMs < watermarkMs - config.triggerWindowMs);
}

/** Members derived from evidence; each evidence event's value is counted once. */
export function deriveMembers(pack: ActivePack): PackMember[] {
  const byWallet = new Map<string, EvidenceEntry[]>();
  for (const e of pack.evidence) {
    const list = byWallet.get(e.wallet) ?? [];
    list.push(e);
    byWallet.set(e.wallet, list);
  }
  const members: PackMember[] = [];
  for (const [wallet, events] of byWallet) {
    const kind = pack.memberKinds[wallet] ?? "expanded";
    const sorted = [...events].sort(compareOrder);
    members.push({
      packId: pack.id,
      walletAddress: wallet,
      memberKind: kind,
      firstEntryTimeMs: sorted[0]!.timeMs,
      initialFirstEntryTimeMs: kind === "initial" ? pack.initialFirstEntry[wallet] ?? sorted[0]!.timeMs : null,
      joinedAtEventTimeMs: pack.joinedAt[wallet] ?? pack.triggerEventTimeMs,
      eligibleBuyUsd: canonical(sorted.reduce((acc, e) => acc.plus(parseDecimal(e.usd)), new Decimal(0))),
      eventIds: sorted.map((e) => e.eventId),
    });
  }
  members.sort((a, b) => {
    if (a.memberKind !== b.memberKind) return a.memberKind === "initial" ? -1 : 1;
    const d = a.firstEntryTimeMs - b.firstEntryTimeMs;
    return d !== 0 ? d : a.walletAddress < b.walletAddress ? -1 : a.walletAddress > b.walletAddress ? 1 : 0;
  });
  return members;
}

export function packTotalUsd(pack: ActivePack): string {
  return canonical(pack.evidence.reduce((acc, e) => acc.plus(parseDecimal(e.usd)), new Decimal(0)));
}

/**
 * Select the first three initial members by (initialFirstEntryTimeMs, walletAddress)
 * ascending for automatic profiling (§7.2, §17.11).
 */
export function selectProfileWallets(pack: ActivePack, count = 3): string[] {
  return [...pack.initialWallets]
    .sort((a, b) => {
      const d = pack.initialFirstEntry[a]! - pack.initialFirstEntry[b]!;
      return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, count);
}
