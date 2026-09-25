/**
 * Test helpers. All data here is synthetic: addresses and signatures are
 * derived from hashes of labels (valid 32/64-byte Base58), never real.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TradeEvent } from "@packlens/contracts";
import { VirtualClock } from "../apps/server/src/clock.js";
import { BASELINE_DETECTOR_CONFIG, loadConfig, ROOT_DIR, WSOL_MINT, type AppConfig } from "../apps/server/src/config.js";
import { migrate, openDatabase, type Db } from "../apps/server/src/db/connection.js";
import { base58Encode } from "../apps/server/src/lib/base58.js";
import { eventIdFor } from "../apps/server/src/lib/ids.js";
import { OutboxBus } from "../apps/server/src/ingest/outbox.js";
import { DetectorEngine } from "../apps/server/src/ingest/engine.js";
import { IngestPipeline } from "../apps/server/src/ingest/pipeline.js";
import { ensureNamespace } from "../apps/server/src/replay/runner.js";
import { setLogSink } from "../apps/server/src/lib/log.js";
import type { DetectorInput } from "../apps/server/src/detector/core.js";

setLogSink(() => undefined, "error");

export const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

export function addr(label: string): string {
  return base58Encode(createHash("sha256").update(`test-addr:${label}`).digest());
}

export function sig(label: string): string {
  return base58Encode(createHash("sha512").update(`test-sig:${label}`).digest());
}

export const MINT = addr("mint-M");
export const MINT2 = addr("mint-N");

export function testDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db, join(ROOT_DIR, "migrations"), T0);
  return db;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ APP_MODE: "fixture", DATABASE_PATH: ":memory:", ...env }, T0);
}

/** Detector input in seconds relative to T0 (ms precision preserved via ms param). */
export function input(id: string, wallet: string, tMs: number, usd: string | null, opts: Partial<DetectorInput> = {}): DetectorInput {
  return {
    eventId: `solana:${sig(id)}:0`,
    walletAddress: addr(wallet),
    tokenAddress: opts.tokenAddress ?? MINT,
    timeMs: T0 + tMs,
    slot: 1000 + Math.floor(tMs / 400),
    signature: sig(id),
    ordinal: 0,
    side: "buy",
    valuationStatus: usd === null ? "missing_price" : "valued",
    tradeValueUsd: usd,
    admission: "admitted",
    ...opts,
  };
}

export function tradeEvent(namespace: string, id: string, wallet: string, tMs: number, usd: string | null, opts: Partial<TradeEvent> = {}): TradeEvent {
  const signature = opts.signature ?? sig(id);
  const ordinal = opts.eventOrdinal ?? 0;
  return {
    eventId: eventIdFor(signature, ordinal),
    namespace,
    chain: "solana",
    source: "pumpfun",
    sourceMode: "fixture",
    signature,
    eventOrdinal: ordinal,
    slot: 1000 + Math.floor(tMs / 400),
    blockTimeMs: T0 + tMs,
    receivedAtMs: T0 + tMs + 500,
    walletAddress: addr(wallet),
    tokenAddress: MINT,
    side: "buy",
    tokenAmountRaw: "1000000",
    tokenDecimals: 6,
    quoteAmountRaw: "100000000",
    quoteDecimals: 9,
    quoteAssetAddress: WSOL_MINT,
    quoteUsdPrice: usd === null ? null : "200",
    quotePriceAtMs: usd === null ? null : T0 - 60_000,
    priceSnapshotId: null,
    priceCandleEndMs: null,
    valuationStatus: usd === null ? "missing_price" : "valued",
    tradeValueUsd: usd,
    priceSource: usd === null ? null : "test",
    decoderVersion: "test",
    normalizedAtMs: T0 + tMs + 600,
    coreEligibility: "pending",
    ...opts,
  };
}

export type Harness = {
  db: Db;
  clock: VirtualClock;
  outbox: OutboxBus;
  engine: DetectorEngine;
  pipeline: IngestPipeline;
  namespace: string;
  /** Ingest then advance the watermark past the event (tolerance-free for boundary tests). */
  feed: (events: TradeEvent[]) => void;
  flushTo: (tMs: number) => void;
  packs: () => Record<string, unknown>[];
};

export function harness(namespace = "fixture:test", db: Db = testDb()): Harness {
  const clock = new VirtualClock(T0 - 60_000);
  const outbox = new OutboxBus();
  ensureNamespace(db, namespace, namespace.startsWith("replay:") ? "replay" : namespace.startsWith("live:") ? "live" : "fixture", "test", null, T0);
  const engine = new DetectorEngine(db, namespace, BASELINE_DETECTOR_CONFIG, clock, outbox);
  const pipeline = new IngestPipeline(db, namespace, clock, engine, 2000);
  const h: Harness = {
    db,
    clock,
    outbox,
    engine,
    pipeline,
    namespace,
    feed(events) {
      for (const e of events) pipeline.ingest(e);
    },
    flushTo(tMs) {
      pipeline.advanceTo(T0 + tMs);
    },
    packs() {
      return db.prepare("SELECT * FROM packs WHERE namespace = ? ORDER BY trigger_event_time_ms").all(namespace) as Record<string, unknown>[];
    },
  };
  return h;
}

export function members(db: Db, packId: string): { wallet: string; member_kind: string; eligible_buy_usd: string; first_entry_time_ms: number; joined_at_event_time_ms: number }[] {
  return db.prepare("SELECT wallet, member_kind, eligible_buy_usd, first_entry_time_ms, joined_at_event_time_ms FROM pack_members WHERE pack_id = ? ORDER BY first_entry_time_ms, wallet").all(packId) as never;
}

/** Minimal fake Nansen provider for client tests; never touches the network. */
export type FakeReply = { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number; throws?: "timeout" | "network" };

export function fakeFetch(handler: (path: string, body: Record<string, unknown>, call: number) => FakeReply) {
  let calls = 0;
  const log: { path: string; body: Record<string, unknown> }[] = [];
  const fn = async (url: string, init: { body: string; headers: Record<string, string>; signal: AbortSignal }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls++;
    log.push({ path, body });
    const r = handler(path, body, calls);
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.throws === "timeout") {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    if (r.throws === "network") throw new TypeError("fetch failed");
    const headers = new Map(Object.entries({ "x-nansen-credits-used": "1", "x-nansen-credits-cost": "1", "x-request-id": `req-${calls}`, ...(r.headers ?? {}) }).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { fn, log, get calls() { return calls; } };
}
