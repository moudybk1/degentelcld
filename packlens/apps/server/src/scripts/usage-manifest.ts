/**
 * npm run usage:manifest: aggregate Nansen usage evidence (MVP §6.4).
 * Writes docs/usage-manifest.json (aggregate, no secrets or raw responses)
 * and prints a summary. Account usage remains the reconciliation source.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDatabase } from "../db/connection.js";

loadDotEnv();
const config = loadConfig({ ...process.env, APP_MODE: "fixture" });
const db = openDatabase(config.databasePath);
const campaignId = config.nansen.campaignId;
const campaign = db.prepare("SELECT * FROM api_campaigns WHERE id = ?").get(campaignId) as Record<string, unknown> | undefined;
const byEndpoint = db
  .prepare(
    `SELECT endpoint, COUNT(*) AS attempts, SUM(http_outcome = 'success') AS http_success, SUM(normalization_status = 'ok') AS schema_valid,
       SUM(http_outcome IN ('http_error','network_error','timeout')) AS failed, SUM(reservation_status = 'unresolved') AS unresolved,
       COALESCE(SUM(actual_credits), 0) AS actual_credits, COALESCE(SUM(quoted_credits), 0) AS quoted_credits
     FROM api_usage WHERE campaign_id = ? GROUP BY endpoint ORDER BY endpoint`,
  )
  .all(campaignId);
const byPurpose = db.prepare("SELECT purpose, COUNT(*) AS attempts, SUM(normalization_status = 'ok') AS schema_valid FROM api_usage WHERE campaign_id = ? GROUP BY purpose ORDER BY purpose").all(campaignId);
const totals = db
  .prepare(
    `SELECT COUNT(*) AS attempts, SUM(http_outcome = 'success') AS http_success, SUM(normalization_status = 'ok') AS schema_valid,
       SUM(reservation_status = 'unresolved') AS unresolved_attempts, MIN(started_at_ms) AS first_ms, MAX(started_at_ms) AS last_ms,
       COALESCE(SUM(actual_credits), 0) AS actual_credits, MIN(remaining_credits) AS min_reported_remaining
     FROM api_usage WHERE campaign_id = ?`,
  )
  .get(campaignId) as Record<string, number | null>;
const reservations = db
  .prepare(
    `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN settled_amount END),0) AS settled, COALESCE(SUM(CASE WHEN status='unresolved' THEN amount END),0) AS unresolved,
       COALESCE(SUM(CASE WHEN status='reserved' THEN amount END),0) AS reserved FROM budget_reservations WHERE campaign_id = ?`,
  )
  .get(campaignId);
const cacheHits = (db.prepare("SELECT value FROM meta WHERE key = 'nansen_cache_hits'").get() as { value: string } | undefined)?.value ?? "0";
const manifest = {
  generatedAt: new Date().toISOString(),
  campaignId,
  configuredBudget: campaign?.configured_budget ?? null,
  window: { first: totals.first_ms ? new Date(totals.first_ms).toISOString() : null, last: totals.last_ms ? new Date(totals.last_ms).toISOString() : null },
  totals: { ...totals, first_ms: undefined, last_ms: undefined, cache_hits_not_calls: Number(cacheHits) },
  credits: reservations,
  minimumTarget: config.nansen.minSuccessfulCalls,
  minimumMet: Number(totals.schema_valid ?? 0) >= config.nansen.minSuccessfulCalls,
  byEndpoint,
  byPurpose,
  note: "Aggregate ledger evidence from local attempts. Reconcile against Nansen account usage; cache hits are not provider calls.",
};
const out = join(config.rootDir, "docs", "usage-manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`${JSON.stringify({ attempts: totals.attempts, schemaValid: totals.schema_valid, credits: reservations, minimumMet: manifest.minimumMet }, null, 2)}\nWrote ${out}\n`);
db.close();
