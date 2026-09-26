import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { BudgetLedger } from "../../apps/server/src/scheduler/budget.js";
import { T0, testDb } from "../helpers.js";
import type { Db } from "../../apps/server/src/db/connection.js";

function ledger(budget: number, priceReserve = 2): { db: Db; l: BudgetLedger } {
  const db = testDb();
  const l = new BudgetLedger(db, "camp", new VirtualClock(T0), () => priceReserve);
  l.ensureCampaign(budget, null);
  return { db, l };
}

const req = (attemptId: string, lane: "PRICE" | "BASE_ENRICHMENT" | "SMART_MONEY", amount: number) => ({
  attemptId, lane, amount, endpoint: "e", parameterHash: "h", purpose: "p", subjectId: null, jobId: null, retryOfAttemptId: null,
});

describe("V11: credit ledger", () => {
  it("budget 10, settled 5, reserved 1, unresolved 1, price reserve 2", () => {
    const { l } = ledger(10);
    expect(l.reserve(req("s", "BASE_ENRICHMENT", 5)).ok).toBe(true);
    l.settle("s", 5);
    expect(l.reserve(req("r", "BASE_ENRICHMENT", 1)).ok).toBe(true); // active reservation
    expect(l.reserve(req("u", "BASE_ENRICHMENT", 1)).ok).toBe(true);
    l.markUnresolved("u");
    const t = l.totals();
    expect(t).toMatchObject({ settled: 5, reserved: 1, unresolved: 1, remaining: 3, priceReserve: 2 });
    // Enrichment may spend only 1; an estimate of 5 is rejected.
    expect(l.reserve(req("big", "BASE_ENRICHMENT", 5))).toEqual({ ok: false, reason: "insufficient_credits", available: 1 });
    expect(l.reserve(req("one", "BASE_ENRICHMENT", 1)).ok).toBe(true);
    expect(l.reserve(req("two", "SMART_MONEY", 1)).ok).toBe(false);
    // A price request may use the reserve.
    expect(l.reserve(req("price", "PRICE", 1)).ok).toBe(true);
  });

  it("settlement replaces the reservation instead of debiting twice", () => {
    const { l } = ledger(10);
    l.reserve(req("a", "BASE_ENRICHMENT", 5));
    l.settle("a", 5);
    expect(l.totals()).toMatchObject({ settled: 5, reserved: 0, remaining: 5 });
    l.settle("a", 5); // idempotent
    expect(l.totals().settled).toBe(5);
  });

  it("T33: a timeout without actual cost stays unresolved until reconciliation", () => {
    const { l, db } = ledger(10);
    l.reserve(req("t", "SMART_MONEY", 5));
    l.markUnresolved("t", 5);
    expect(l.totals()).toMatchObject({ unresolved: 5, remaining: 5 });
    expect((db.prepare("SELECT reservation_status FROM api_usage WHERE attempt_id = 't'").get() as { reservation_status: string }).reservation_status).toBe("unresolved");
  });

  it("actual cost above the estimate is recorded as-is (never trimmed)", () => {
    const { l } = ledger(10);
    l.reserve(req("x", "BASE_ENRICHMENT", 1));
    l.settle("x", 9);
    expect(l.totals()).toMatchObject({ settled: 9, remaining: 1 });
  });

  it("T32: competing reservations cannot oversubscribe the budget", () => {
    const { l } = ledger(12, 2);
    const results = Array.from({ length: 5 }, (_, i) => l.reserve(req(`c${i}`, "SMART_MONEY", 5)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(l.totals().reserved).toBe(10);
  });

  it("T41 / T46: call 101 and 301 proceed when funded; the count is never a cap", () => {
    const { l } = ledger(100_000, 2);
    for (let i = 0; i < 301; i++) {
      const r = l.reserve(req(`n${i}`, i % 3 === 0 ? "PRICE" : "BASE_ENRICHMENT", 1));
      expect(r.ok).toBe(true);
      l.settle(`n${i}`, 1);
    }
    expect(l.totals().settled).toBe(301);
  });

  it("the ledger survives a restart (new ledger object, same database)", () => {
    const { l, db } = ledger(50);
    l.reserve(req("p", "PRICE", 1));
    l.settle("p", 1);
    const again = new BudgetLedger(db, "camp", new VirtualClock(T0 + 1000), () => 2);
    again.ensureCampaign(50, null);
    expect(again.totals().settled).toBe(1);
  });
});

describe("daily credit cap (24/7 mode)", () => {
  const DAY = 24 * 60 * 60_000;

  it("stops at the cap for the UTC day, counts open and unresolved reservations, and resets at midnight", () => {
    const db = testDb();
    const clock = new VirtualClock(Math.floor(T0 / DAY) * DAY + 23 * 60 * 60_000); // 23:00 UTC
    const l = new BudgetLedger(db, "camp", clock, () => 0, 30);
    l.ensureCampaign(1000, null);
    expect(l.reserve(req("a", "BASE_ENRICHMENT", 10)).ok).toBe(true);
    l.settle("a", 8); // actual cost counts, not the estimate
    expect(l.reserve(req("b", "SMART_MONEY", 10)).ok).toBe(true); // still reserved
    expect(l.reserve(req("c", "BASE_ENRICHMENT", 5)).ok).toBe(true);
    l.markUnresolved("c");
    expect(l.totals()).toMatchObject({ dailyCap: 30, usedToday: 23 });
    expect(l.reserve(req("d", "BASE_ENRICHMENT", 8))).toEqual({ ok: false, reason: "daily_cap", available: 7 });
    l.release("b"); // never sent: frees today's allowance
    expect(l.reserve(req("e", "BASE_ENRICHMENT", 8)).ok).toBe(true);
    clock.advance(60 * 60_000); // 00:00 UTC next day
    expect(l.totals().usedToday).toBe(0);
    expect(l.reserve(req("f", "BASE_ENRICHMENT", 30)).ok).toBe(true);
    // The campaign budget still applies across days.
    expect(l.totals().remaining).toBe(1000 - 8 - 5 - 8 - 30);
  });

  it("without a cap only the campaign budget applies", () => {
    const { l } = ledger(10, 0);
    expect(l.totals()).toMatchObject({ dailyCap: null });
    expect(l.reserve(req("a", "BASE_ENRICHMENT", 10)).ok).toBe(true);
  });
});
