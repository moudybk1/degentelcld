import { describe, expect, it } from "vitest";
import { BASELINE_DETECTOR_CONFIG as CFG } from "../../apps/server/src/config.js";
import {
  advanceWatermark,
  consumeOrdered,
  deriveMembers,
  newTokenState,
  packTotalUsd,
  type CoreEffect,
  type DetectorInput,
  type TokenState,
} from "../../apps/server/src/detector/core.js";
import { addr, input, MINT, T0 } from "../helpers.js";

/** Run inputs in order, applying the watermark timer after each event (W = event time). */
function run(events: DetectorInput[], state: TokenState = newTokenState("fixture:test", MINT, CFG.version)) {
  const effects: CoreEffect[] = [];
  for (const e of events) {
    effects.push(...consumeOrdered(state, e, CFG, e.timeMs).effects);
    effects.push(...advanceWatermark(state, e.timeMs));
  }
  return { state, effects, created: effects.filter((x) => x.kind === "pack.created") };
}

const s = (sec: number) => Math.round(sec * 1000);

describe("V01 / T01: exact trigger boundary", () => {
  it("A/B/C at 0, 7, 20 seconds with $20 each trigger one pack", () => {
    const { created, state } = run([input("e1", "A", s(0), "20"), input("e2", "B", s(7), "20"), input("e3", "C", s(20), "20")]);
    expect(created).toHaveLength(1);
    const pack = created[0]!.pack;
    expect(pack.triggerEventTimeMs).toBe(T0 + s(20));
    expect(pack.firstEventTimeMs).toBe(T0);
    expect(pack.initialWallets.sort()).toEqual([addr("A"), addr("B"), addr("C")].sort());
    expect(packTotalUsd(pack)).toBe("60");
    expect(pack.expansionEndMs).toBe(T0 + s(40));
    expect(pack.suppressUntilMs).toBe(T0 + s(140));
    expect(state.suppressUntilMs).toBe(T0 + s(140));
  });
});

describe("V02 / T02: 20.001 seconds does not trigger", () => {
  it("A/B/C at 0, 7, 20.001 seconds", () => {
    const { created } = run([input("e1", "A", 0, "20"), input("e2", "B", 7000, "20"), input("e3", "C", 20001, "20")]);
    expect(created).toHaveLength(0);
  });
});

describe("V03 / T03: repeated wallets do not inflate uniqueness", () => {
  it("all A except e3=B is not a pack", () => {
    const { created } = run([input("e1", "A", 0, "20"), input("e2", "A", 7000, "20"), input("e3", "B", 20000, "20")]);
    expect(created).toHaveLength(0);
  });
  it("five A transactions and one B are two unique wallets", () => {
    const evs = [0, 1, 2, 3, 4].map((i) => input(`a${i}`, "A", i * 1000, "25"));
    const { created, state } = run([...evs, input("b", "B", 5000, "25")]);
    expect(created).toHaveLength(0);
    expect(new Set(state.buffer.map((b) => b.wallet)).size).toBe(2);
  });
});

describe("V04 / T04 / T05: per-transaction $20 threshold", () => {
  it("$19.99 is ineligible, $20 passes", () => {
    const { created } = run([input("e1", "A", 0, "20"), input("e2", "B", 7000, "19.99"), input("e3", "C", 20000, "20")]);
    expect(created).toHaveLength(0);
    const st = newTokenState("fixture:test", MINT, CFG.version);
    expect(consumeOrdered(st, input("x", "A", 0, "19.99"), CFG, T0).eligibility).toEqual({ eligible: false, reason: "below_threshold" });
    expect(consumeOrdered(st, input("y", "A", 0, "20"), CFG, T0).eligibility.eligible).toBe(true);
    expect(consumeOrdered(st, input("z", "A", 0, "20.00"), CFG, T0).eligibility.eligible).toBe(true);
  });
  it("two $10 purchases by one wallet do not combine into eligibility", () => {
    const { created } = run([input("a1", "A", 0, "10"), input("a2", "A", 1000, "10"), input("b", "B", 2000, "20"), input("c", "C", 3000, "20")]);
    expect(created).toHaveLength(0);
  });
  it("no rounding before evaluation: 19.999999999 fails", () => {
    const st = newTokenState("fixture:test", MINT, CFG.version);
    expect(consumeOrdered(st, input("x", "A", 0, "19.999999999999999999"), CFG, T0).eligibility.eligible).toBe(false);
  });
});

describe("V05 / T06: duplicate after trigger", () => {
  it("re-consuming e3 adds no value and does not extend cooldown", () => {
    const e3 = input("e3", "C", 20000, "20");
    const { state } = run([input("e1", "A", 0, "20"), input("e2", "B", 7000, "20"), e3]);
    const before = packTotalUsd(state.active!);
    const r = consumeOrdered(state, e3, CFG, T0 + 21000);
    expect(r.effects).toHaveLength(0);
    expect(packTotalUsd(state.active!)).toBe(before);
    expect(state.active!.suppressUntilMs).toBe(T0 + 140_000);
  });
});

describe("V06 / T09 / T10: qualifying expansion window", () => {
  const base = [input("e1", "A", 0, "20"), input("e2", "B", 7000, "20"), input("e3", "C", 20000, "20")];
  it("A at 25 and D at exactly 40 expand the pack", () => {
    const { state, effects } = run([...base, input("e4", "A", 25000, "20"), input("e5", "D", 40000, "20")]);
    const pack = state.active!;
    const m = deriveMembers(pack);
    expect(m.filter((x) => x.memberKind === "initial").map((x) => x.walletAddress).sort()).toEqual([addr("A"), addr("B"), addr("C")].sort());
    expect(m.filter((x) => x.memberKind === "expanded").map((x) => x.walletAddress)).toEqual([addr("D")]);
    expect(m).toHaveLength(4);
    expect(packTotalUsd(pack)).toBe("100");
    expect(pack.lastAcceptedEventTimeMs).toBe(T0 + 40000);
    expect(pack.expansionEndMs).toBe(T0 + 40000);
    expect(pack.suppressUntilMs).toBe(T0 + 160000);
    // A timer at W=40 does not freeze.
    expect(effects.some((e) => e.kind === "pack.frozen")).toBe(false);
    // W=40.001 freezes after the t=40 event.
    const frozen = advanceWatermark(state, T0 + 40001);
    expect(frozen.map((f) => f.kind)).toEqual(["pack.frozen"]);
  });
  it("E at 40.001 is not a formation member", () => {
    const { state, effects } = run([...base, input("e4", "A", 25000, "20"), input("e5", "D", 40000, "20"), input("e6", "E", 40001, "20")]);
    const frozen = effects.find((e) => e.kind === "pack.frozen");
    expect(frozen).toBeDefined();
    const m = deriveMembers(frozen!.pack);
    expect(m.map((x) => x.walletAddress)).not.toContain(addr("E"));
    expect(state.active).toBeNull();
  });
  it("without e4, D at 40 has only C/D in the window and cannot expand", () => {
    const { state } = run([...base, input("e5", "D", 40000, "20")]);
    expect(deriveMembers(state.active!).map((x) => x.walletAddress)).not.toContain(addr("D"));
    expect(state.active!.suppressUntilMs).toBe(T0 + 140000);
  });
});

describe("V07 / T11: cooldown and freezing old state", () => {
  const v06 = [
    input("e1", "A", 0, "20"),
    input("e2", "B", 7000, "20"),
    input("e3", "C", 20000, "20"),
    input("e4", "A", 25000, "20"),
    input("e5", "D", 40000, "20"),
  ];
  it("F/G buffer during cooldown; H at exactly suppressUntil triggers pack two", () => {
    const { created } = run([...v06, input("f", "F", 150000, "20"), input("g", "G", 155000, "20"), input("h", "H", 160000, "20")]);
    expect(created).toHaveLength(2);
    const p2 = created[1]!.pack;
    expect(p2.firstEventTimeMs).toBe(T0 + 150000);
    expect(p2.triggerEventTimeMs).toBe(T0 + 160000);
    expect(p2.expansionEndMs).toBe(T0 + 190000);
    expect(p2.suppressUntilMs).toBe(T0 + 280000);
  });
  it("just before suppressUntil a qualifying window is suppressed", () => {
    const { created } = run([...v06, input("f", "F", 150000, "20"), input("g", "G", 155000, "20"), input("h", "H", 159999, "20")]);
    expect(created).toHaveLength(1);
  });
  it("T48: a stale checkpoint with activePackId still considers H after freezing", () => {
    // Consume V06 without timers so the old pack is still active when H arrives.
    const state = newTokenState("fixture:test", MINT, CFG.version);
    for (const e of v06) consumeOrdered(state, e, CFG, e.timeMs);
    for (const e of [input("f", "F", 150000, "20"), input("g", "G", 155000, "20")]) consumeOrdered(state, e, CFG, e.timeMs);
    // F already froze the old pack; simulate a stale checkpoint by restoring it.
    const fresh = newTokenState("fixture:test", MINT, CFG.version);
    for (const e of v06) consumeOrdered(fresh, e, CFG, e.timeMs);
    fresh.buffer = [...state.buffer];
    const r = consumeOrdered(fresh, input("h", "H", 160000, "20"), CFG, T0 + 160000);
    expect(r.effects.map((e) => e.kind)).toEqual(["pack.frozen", "pack.created"]);
    const p2 = (r.effects[1] as { pack: { firstEventTimeMs: number; suppressUntilMs: number } }).pack;
    expect(p2.firstEventTimeMs).toBe(T0 + 150000);
    expect(p2.suppressUntilMs).toBe(T0 + 280000);
  });
});

describe("T07 / T08: event identity", () => {
  it("two ordinals in one signature stay distinct events", () => {
    const a = input("same", "A", 0, "20", { eventId: "solana:X:0", ordinal: 0 });
    const b = input("same", "B", 1000, "20", { eventId: "solana:X:1", ordinal: 1 });
    const c = input("c", "C", 2000, "20");
    const { created } = run([a, b, c]);
    expect(created).toHaveLength(1);
    expect(created[0]!.pack.evidence).toHaveLength(3);
  });
  it("two mints with identical symbols stay separate", () => {
    const other = addr("mint-other");
    const sa = newTokenState("fixture:test", MINT, CFG.version);
    const sb = newTokenState("fixture:test", other, CFG.version);
    consumeOrdered(sa, input("a", "A", 0, "20"), CFG, T0);
    consumeOrdered(sa, input("b", "B", 1000, "20"), CFG, T0);
    const r = consumeOrdered(sb, input("c", "C", 2000, "20", { tokenAddress: other }), CFG, T0);
    expect(r.effects).toHaveLength(0);
    expect(() => consumeOrdered(sa, input("d", "D", 3000, "20", { tokenAddress: other }), CFG, T0)).toThrow();
  });
});

describe("ineligible inputs", () => {
  it("sells, unvalued, late, and backfill never enter the buffer", () => {
    const st = newTokenState("fixture:test", MINT, CFG.version);
    expect(consumeOrdered(st, input("s", "A", 0, "50", { side: "sell" }), CFG, T0).eligibility.reason).toBe("sell");
    expect(consumeOrdered(st, input("u", "A", 0, null), CFG, T0).eligibility.reason).toBe("missing_price");
    expect(consumeOrdered(st, input("st", "A", 0, null, { valuationStatus: "stale_price" }), CFG, T0).eligibility.reason).toBe("stale_price");
    expect(consumeOrdered(st, input("q", "A", 0, null, { valuationStatus: "unsupported_quote" }), CFG, T0).eligibility.reason).toBe("unsupported_quote");
    expect(consumeOrdered(st, input("l", "A", 0, "50", { admission: "late" }), CFG, T0).eligibility.reason).toBe("late");
    expect(consumeOrdered(st, input("bf", "A", 0, "50", { admission: "backfill" }), CFG, T0).eligibility.reason).toBe("backfill");
    expect(st.buffer).toHaveLength(0);
  });
});

describe("expansion accepts an earlier observation (acceptedAtExpansion)", () => {
  it("E at 35 joins when F at 38 makes the window qualify", () => {
    const { state } = run([
      input("a", "A", 0, "20"),
      input("b", "B", 7000, "20"),
      input("c", "C", 20000, "20"),
      input("e", "E", 35000, "20"),
      input("f", "F", 38000, "20"),
    ]);
    const ev = state.active!.evidence.find((x) => x.wallet === addr("E"))!;
    expect(ev.acceptedAtExpansion).toBe(true);
    expect(ev.acceptedAtEventTimeMs).toBe(T0 + 38000);
    const m = deriveMembers(state.active!).find((x) => x.walletAddress === addr("E"))!;
    expect(m.firstEntryTimeMs).toBe(T0 + 35000);
    expect(m.joinedAtEventTimeMs).toBe(T0 + 38000);
    expect(m.memberKind).toBe("expanded");
  });
});
