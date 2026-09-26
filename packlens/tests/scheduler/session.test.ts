import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../apps/server/src/clock.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { SessionManager } from "../../apps/server/src/scheduler/session.js";
import { T0, testDb } from "../helpers.js";

const DAY = 24 * 60 * 60_000;
const live = { APP_MODE: "live", PRICE_PROVIDER: "pyth", NANSEN_API_KEY: "k", NANSEN_BUDGET_CREDITS: "100", SOLANA_RPC_HTTP_URL: "https://x.test", SOLANA_RPC_WS_URL: "wss://x.test", ADMIN_TOKEN: "a".repeat(40) };

function manager(env: Record<string, string>, startMs: number) {
  const clock = new VirtualClock(startMs);
  const db = testDb();
  db.prepare("INSERT INTO api_campaigns (id, configured_budget, started_at_ms, ends_at_ms) VALUES ('c', 100, ?, NULL)").run(startMs);
  return { clock, db, s: new SessionManager(db, clock, loadConfig({ ...live, ...env }, startMs), "c") };
}

describe("Nansen sessions for 24/7 operation", () => {
  const noon = Math.floor(T0 / DAY) * DAY + 12 * 60 * 60_000;

  it("continuous mode opens a session for the rest of the UTC day and renews it after midnight", () => {
    const { clock, db, s } = manager({ NANSEN_DAILY_CREDIT_CAP: "500" }, noon);
    const first = s.current()!;
    expect(first).toMatchObject({ started_by: "continuous", started_at_ms: noon, ends_at_ms: noon + 12 * 60 * 60_000, smart_money_ends_at_ms: noon + 12 * 60 * 60_000 });
    expect(s.current()!.id).toBe(first.id);
    expect(s.blockReason("BASE_ENRICHMENT")).toBeNull();
    clock.advance(12 * 60 * 60_000); // exactly midnight
    const second = s.current()!;
    expect(second.id).not.toBe(first.id);
    expect(second.ends_at_ms).toBe(noon + 36 * 60 * 60_000);
    expect(db.prepare("SELECT ended_reason FROM nansen_sessions WHERE id = ?").get(first.id)).toEqual({ ended_reason: "expired" });
  });

  it("without a session end or a cap, Nansen is off: no session, and none can be started", () => {
    const { s } = manager({}, noon);
    expect(s.current()).toBeNull();
    expect(s.blockReason("BASE_ENRICHMENT")).toBe("no_session");
    expect(() => s.start({ startedBy: "operator" })).toThrow(/Nansen is off/);
  });

  it("a bounded session still ends at NANSEN_SESSION_END_AT and does not renew", () => {
    const { clock, s } = manager({ NANSEN_SESSION_END_AT: new Date(noon + 60 * 60_000).toISOString() }, noon);
    expect(s.current()).toBeNull();
    s.start({ startedBy: "startup" });
    expect(s.current()!.ends_at_ms).toBe(noon + 60 * 60_000);
    clock.advance(60 * 60_000);
    expect(s.current()).toBeNull();
  });
});
