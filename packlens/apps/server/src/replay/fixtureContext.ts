/**
 * Fixture context seeding. Synthetic, provider-shaped snapshots are stored
 * with source "fixture" in a fixture or replay namespace only, so the offline
 * UI can show every panel state without keys. They are never live evidence.
 */
import { z } from "zod";
import { VirtualClock } from "../clock.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { newId, sha256Hex } from "../lib/ids.js";
import { canonicalJson } from "../lib/json.js";
import type { OutboxBus } from "../ingest/outbox.js";
import { AssessmentService } from "../assessment/assessment.js";
import { SmartMoneyService, scopeHashFor } from "../smart-money/service.js";
import type { Dataset } from "./dataset.js";

const Coverage = z.enum(["window_scanned", "partial", "unknown"]);

export const FixtureContextSchema = z.object({
  snapshots: z.array(
    z.object({
      key: z.string(),
      endpoint: z.string(),
      subjectType: z.enum(["token", "wallet", "global"]),
      subjectId: z.string(),
      params: z.record(z.string(), z.unknown()),
      fetchedAtMs: z.number().int(),
      availability: z.enum(["available", "empty", "unavailable", "error", "budget_paused"]),
      coverage: Coverage,
      reasonCode: z.string().nullable().optional(),
      page: z.number().int().nullable().optional(),
      isLastPage: z.boolean().nullable().optional(),
      periodStartMs: z.number().int().nullable().optional(),
      periodEndMs: z.number().int().nullable().optional(),
      result: z.unknown().nullable(),
    }),
  ),
  smartMoney: z.object({
    trades: z.array(
      z.object({
        chain: z.literal("solana"),
        transactionHash: z.string(),
        blockTimeMs: z.number().int(),
        traderAddress: z.string(),
        traderLabel: z.string().nullable(),
        tokenBoughtAddress: z.string(),
        tokenSoldAddress: z.string(),
        tokenBoughtSymbol: z.string().nullable(),
        tokenSoldSymbol: z.string().nullable(),
        tokenBoughtAmount: z.string().nullable(),
        tokenSoldAmount: z.string().nullable(),
        tradeValueUsd: z.string().nullable(),
        scope: z.enum(["global", "token"]),
      }),
    ),
    scans: z.array(z.object({ mint: z.string(), asOfMs: z.number().int(), coverage: z.object({ "5m": Coverage, "1h": Coverage, "24h": Coverage }) })),
  }),
  /** Packs that receive fixture analysis, by mint and trigger order (0 = earliest pack of that mint). */
  enrichedPacks: z.array(z.object({ mint: z.string(), packIndex: z.number().int().min(0) })),
  demoPins: z.array(z.string()),
  jobs: z.array(
    z.object({
      mint: z.string(),
      packIndex: z.number().int().min(0),
      type: z.string(),
      subject: z.string(),
      status: z.enum(["succeeded", "failed", "cancelled", "budget_paused"]),
      snapshotKey: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export type FixtureContext = z.infer<typeof FixtureContextSchema>;

export function seedFixtureContext(db: Db, outbox: OutboxBus, config: AppConfig, namespace: string, dataset: Dataset): void {
  if (dataset.context === undefined) return;
  const ctx = FixtureContextSchema.parse(dataset.context);
  const keyToId = new Map<string, string>();
  const insert = db.prepare(
    `INSERT INTO enrichment_snapshots (id, namespace, endpoint, subject_type, subject_id, parameter_hash, params_json, scope_hash, fetched_at_ms, period_start_ms, period_end_ms,
       availability, coverage, reason_code, page, is_last_page, result_json, attempt_id, schema_version, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'fixture')`,
  );
  db.transaction(() => {
    for (const s of ctx.snapshots) {
      const id = `${namespace}/${s.key}`;
      keyToId.set(s.key, id);
      insert.run(id, namespace, s.endpoint, s.subjectType, s.subjectId, sha256Hex(`${s.endpoint}|${canonicalJson(s.params)}`), canonicalJson(s.params),
        s.endpoint === "smart-money/dex-trades" ? scopeHashFor((s.params as { filters?: { token_bought_address: string } }).filters, 100) : null,
        s.fetchedAtMs, s.periodStartMs ?? null, s.periodEndMs ?? null, s.availability, s.coverage, s.reasonCode ?? null, s.page ?? null,
        s.isLastPage === undefined || s.isLastPage === null ? null : s.isLastPage ? 1 : 0, s.result === null ? null : JSON.stringify(s.result), `${s.endpoint}.v1`);
    }
  })();

  // Smart Money: observations with provenance, then windows and confirmations at each scan's asOf.
  const scans = [...ctx.smartMoney.scans].sort((a, b) => a.asOfMs - b.asOfMs);
  const clock = new VirtualClock(Math.min(...scans.map((s) => s.asOfMs), ...ctx.snapshots.map((s) => s.fetchedAtMs)));
  const sm = new SmartMoneyService(db, namespace, clock, outbox, null);
  const globalSnap = ctx.snapshots.find((s) => s.endpoint === "smart-money/dex-trades" && s.subjectId === "global");
  const globalTrades = ctx.smartMoney.trades.filter((t) => t.scope === "global");
  if (globalSnap && globalTrades.length > 0) sm.ingestTrades(globalTrades, keyToId.get(globalSnap.key)!, scopeHashFor(undefined, 100));
  for (const scan of scans) {
    const snap = ctx.snapshots.find((s) => s.endpoint === "smart-money/dex-trades" && s.subjectId === scan.mint);
    const trades = ctx.smartMoney.trades.filter((t) => t.scope === "token" && t.tokenBoughtAddress === scan.mint);
    const snapId = snap ? keyToId.get(snap.key)! : null;
    if (snapId) sm.ingestTrades(trades, snapId, scopeHashFor({ token_bought_address: scan.mint }, 100));
    clock.set(Math.max(clock.now(), scan.asOfMs));
    sm.recompute(scan.mint, scan.asOfMs, scan.coverage, snapId ? [snapId] : []);
  }

  // Base analysis: fixture job rows mirror what the worker records in live mode.
  const assessment = new AssessmentService(db, clock, outbox, config.holderConcentrationThreshold);
  const packs = db
    .prepare("SELECT id, mint, triggered_at_ms FROM packs WHERE namespace = ? ORDER BY trigger_event_time_ms, id")
    .all(namespace) as { id: string; mint: string; triggered_at_ms: number }[];
  const indexByPack = new Map<string, number>();
  const seenPerMint = new Map<string, number>();
  for (const p of packs) {
    const i = seenPerMint.get(p.mint) ?? 0;
    indexByPack.set(p.id, i);
    seenPerMint.set(p.mint, i + 1);
  }
  const insertJob = db.prepare(
    `INSERT INTO jobs (id, namespace, campaign_id, lane, type, subject, pack_id, payload_json, status, status_reason, active_dedupe_key, attempts, next_attempt_at_ms,
       enqueued_at_ms, started_at_ms, finished_at_ms, requested_by, result_json)
     VALUES (?, ?, NULL, 'BASE_ENRICHMENT', ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, 'fixture', ?)`,
  );
  for (const p of packs) {
    const packIndex = indexByPack.get(p.id)!;
    if (!ctx.enrichedPacks.some((e) => e.mint === p.mint && e.packIndex === packIndex)) continue;
    const jobs = ctx.jobs.filter((j) => j.mint === p.mint && j.packIndex === packIndex);
    db.transaction(() => {
      db.prepare("UPDATE pack_enrichment SET status = 'scheduled', requested_by = 'fixture', scheduled_at_ms = ? WHERE pack_id = ?").run(p.triggered_at_ms + 2000, p.id);
      for (const j of jobs) {
        const payload = j.type === "token_info" || j.type === "holders" ? { mint: p.mint } : { wallet: j.subject, mint: p.mint };
        const at = p.triggered_at_ms + 3000;
        insertJob.run(newId("job"), namespace, j.type, j.subject, p.id, JSON.stringify(payload), j.status, j.reason, at, at, at, at + 1500,
          JSON.stringify({ snapshotId: j.snapshotKey ? keyToId.get(j.snapshotKey) ?? null : null }));
      }
    })();
    assessment.refresh(p.id);
  }
  for (const mint of ctx.demoPins) {
    db.prepare("INSERT INTO demo_pins (namespace, chain, mint, enabled, updated_at_ms) VALUES (?, 'solana', ?, 1, ?) ON CONFLICT DO NOTHING").run(namespace, mint, clock.now());
  }
}
