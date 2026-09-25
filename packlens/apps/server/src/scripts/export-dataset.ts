/**
 * npm run dataset:export -- --id <dataset-id> --from <ISO> --to <ISO> [--mint <mint>]
 * Exports real recorded events from the live namespace, with their pinned
 * valuations and admission watermarks, into fixtures/recorded/<id>.json and
 * registers a manifest. The export is labeled recorded-live; replaying it keeps
 * the original times and prices (MVP §7.1 D5).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { TradeEvent } from "@packlens/contracts";
import { BASELINE_CONFIG_VERSION, loadConfig, loadDotEnv } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { DECODER_VERSION } from "../collector/decoder.js";
import { sha256Hex } from "../lib/ids.js";

loadDotEnv();
const { values } = parseArgs({ options: { id: { type: "string" }, from: { type: "string" }, to: { type: "string" }, mint: { type: "string" }, namespace: { type: "string" } } });
if (!values.id || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(values.id) || !values.from || !values.to) {
  process.stderr.write("Usage: npm run dataset:export -- --id recorded-demo-1 --from 2026-09-25T12:00:00Z --to 2026-09-25T12:30:00Z [--mint <mint>]\n");
  process.exit(1);
}
const from = Date.parse(values.from);
const to = Date.parse(values.to);
if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
  process.stderr.write("--from and --to must be ISO UTC times with --to after --from\n");
  process.exit(1);
}
const config = loadConfig({ ...process.env, APP_MODE: "fixture" });
const db = openDatabase(config.databasePath);
const ns = values.namespace ?? `live:${config.nansen.campaignId}`;
const where = ["namespace = ?", "event_time_ms >= ?", "event_time_ms <= ?"];
const args: unknown[] = [ns, from, to];
if (values.mint) {
  where.push("mint = ?");
  args.push(values.mint);
}
const rows = db.prepare(`SELECT payload_json, admission_watermark_ms, admission FROM trade_events WHERE ${where.join(" AND ")} ORDER BY received_at_ms`).all(...args) as {
  payload_json: string; admission_watermark_ms: number | null; admission: string;
}[];
if (rows.length === 0) {
  process.stderr.write(`No events in ${ns} between ${values.from} and ${values.to}\n`);
  process.exit(1);
}
const events = rows.map((r) => {
  const e = JSON.parse(r.payload_json) as TradeEvent;
  return {
    signature: e.signature, ordinal: e.eventOrdinal, slot: e.slot, blockTimeMs: e.blockTimeMs, receivedAtMs: e.receivedAtMs, wallet: e.walletAddress, mint: e.tokenAddress,
    side: e.side, tokenAmountRaw: e.tokenAmountRaw, quoteAmountRaw: e.quoteAmountRaw, quoteMint: e.quoteAssetAddress, quoteDecimals: e.quoteDecimals,
    sourceMode: r.admission === "backfill" ? "backfill" : "live",
    admissionWatermarkMs: r.admission_watermark_ms,
    pinned: { valuationStatus: e.valuationStatus, tradeValueUsd: e.tradeValueUsd, quoteUsdPrice: e.quoteUsdPrice, quotePriceAtMs: e.quotePriceAtMs, priceSnapshotId: e.priceSnapshotId, priceCandleEndMs: e.priceCandleEndMs, priceSource: e.priceSource },
  };
});
const snapIds = [...new Set(events.map((e) => e.pinned.priceSnapshotId).filter((x): x is string => x !== null))];
const priceSnapshots = snapIds.map((id) => {
  const s = db.prepare("SELECT id, quote_mint, available_at_ms, requested_from_ms, requested_to_ms, candles_json, timeframe FROM price_snapshots WHERE id = ?").get(id) as {
    id: string; quote_mint: string; available_at_ms: number; requested_from_ms: number; requested_to_ms: number; candles_json: string; timeframe: "1m" | "5m";
  };
  return { id: s.id, quoteMint: s.quote_mint, availableAtMs: s.available_at_ms, requestedFromMs: s.requested_from_ms, requestedToMs: s.requested_to_ms, timeframe: s.timeframe, candles: JSON.parse(s.candles_json) };
});
const mints = [...new Set(events.map((e) => e.mint))];
const tokens = mints.map((m) => {
  const t = db.prepare("SELECT name, symbol FROM tokens WHERE namespace = ? AND mint = ?").get(ns, m) as { name: string | null; symbol: string | null } | undefined;
  return { mint: m, name: t?.name ?? null, symbol: t?.symbol ?? null };
});
const dataset = {
  datasetId: values.id,
  label: `Recorded pump.fun window ${values.from} to ${values.to}${values.mint ? ` (${values.mint.slice(0, 6)}…)` : ""}`,
  mode: "recorded",
  origin: "recorded-live",
  chain: "solana",
  source: "pumpfun",
  decoderVersion: DECODER_VERSION,
  configVersion: BASELINE_CONFIG_VERSION,
  createdAt: new Date().toISOString(),
  description: `Real Solana mainnet pump.fun events recorded by PackLens in ${ns}, with pinned Nansen OHLCV valuations and original admission watermarks. Times are original chain and arrival times.`,
  pricePolicy: config.price.policy.version,
  events,
  priceSnapshots,
  tokens,
};
const text = JSON.stringify(dataset) + "\n";
const file = `fixtures/recorded/${values.id}.json`;
writeFileSync(join(config.rootDir, file), text);
const manifest = {
  datasetId: values.id, label: dataset.label, mode: "recorded", origin: "recorded-live", chain: "solana", source: "pumpfun", decoderVersion: DECODER_VERSION,
  configVersion: BASELINE_CONFIG_VERSION, createdAt: dataset.createdAt, file, sha256: sha256Hex(text), eventCount: events.length,
};
writeFileSync(join(config.rootDir, "fixtures", "manifests", `${values.id}.json`), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Exported ${events.length} events, ${priceSnapshots.length} price snapshots to ${file}\nReplay it with: npm run replay -- --dataset ${values.id} --mode recorded-arrival\n`);
db.close();
