import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../lib/ids.js";

/**
 * Registered datasets (MVP §7.1). Each manifest names mode, origin, time,
 * chain, decoder/config version, and the file hash. Replay accepts only a
 * registered dataset ID, never an arbitrary path.
 */
const ValuationStatus = z.enum(["valued", "missing_price", "stale_price", "unsupported_quote"]);

export const DatasetEventSchema = z.object({
  signature: z.string().min(32).max(128),
  ordinal: z.number().int().min(0),
  slot: z.number().int().min(0),
  blockTimeMs: z.number().int(),
  receivedAtMs: z.number().int(),
  wallet: z.string().min(32).max(64),
  mint: z.string().min(32).max(64),
  side: z.enum(["buy", "sell"]),
  tokenAmountRaw: z.string().regex(/^\d+$/),
  quoteAmountRaw: z.string().regex(/^\d+$/),
  quoteMint: z.string(),
  quoteDecimals: z.number().int().min(0).max(18),
  sourceMode: z.enum(["live", "backfill", "fixture", "replay"]).optional(),
  admissionWatermarkMs: z.number().int().nullable().optional(),
  pinned: z
    .object({
      valuationStatus: ValuationStatus,
      tradeValueUsd: z.string().nullable(),
      quoteUsdPrice: z.string().nullable(),
      quotePriceAtMs: z.number().int().nullable(),
      priceSnapshotId: z.string().nullable(),
      priceCandleEndMs: z.number().int().nullable(),
      priceSource: z.string().nullable(),
    })
    .optional(),
});

export const DatasetSchema = z.object({
  datasetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  label: z.string(),
  mode: z.enum(["fixture", "recorded"]),
  origin: z.enum(["synthetic", "recorded-live"]),
  chain: z.literal("solana"),
  source: z.literal("pumpfun"),
  decoderVersion: z.string(),
  configVersion: z.string(),
  createdAt: z.string(),
  description: z.string(),
  /** Price policy the dataset was recorded or designed under; replays value with it. */
  pricePolicy: z.enum(["nansen-1m-closed-v1", "nansen-5m-closed-v1", "pyth-onchain-v1"]).optional(),
  events: z.array(DatasetEventSchema),
  priceSnapshots: z.array(
    z.object({
      id: z.string(),
      quoteMint: z.string(),
      availableAtMs: z.number().int(),
      requestedFromMs: z.number().int().optional(),
      requestedToMs: z.number().int().optional(),
      timeframe: z.enum(["1m", "5m", "tick"]).optional(),
      candles: z.array(z.object({ intervalStartMs: z.number().int(), close: z.string() })),
    }),
  ),
  tokens: z.array(
    z.object({
      mint: z.string(),
      name: z.string().nullable(),
      symbol: z.string().nullable(),
      totalSupplyRaw: z.string().regex(/^\d+$/).nullable().optional(),
      createdAtMs: z.number().int().nullable().optional(),
      completedAtMs: z.number().int().nullable().optional(),
    }),
  ),
  context: z.unknown().optional(),
});

export type Dataset = z.infer<typeof DatasetSchema>;
export type DatasetEvent = z.infer<typeof DatasetEventSchema>;

export const ManifestSchema = z.object({
  datasetId: z.string(),
  label: z.string(),
  mode: z.enum(["fixture", "recorded"]),
  origin: z.enum(["synthetic", "recorded-live"]),
  chain: z.literal("solana"),
  source: z.literal("pumpfun"),
  decoderVersion: z.string(),
  configVersion: z.string(),
  createdAt: z.string(),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  eventCount: z.number().int(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function listManifests(rootDir: string): Manifest[] {
  const dir = join(rootDir, "fixtures", "manifests");
  if (!existsSync(dir)) return [];
  const out: Manifest[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export class DatasetError extends Error {}

export function loadDataset(rootDir: string, datasetId: string): { dataset: Dataset; manifest: Manifest } {
  const manifest = listManifests(rootDir).find((m) => m.datasetId === datasetId);
  if (!manifest) throw new DatasetError(`Dataset "${datasetId}" is not registered`);
  const root = resolve(rootDir);
  const path = resolve(root, manifest.file);
  if (!path.startsWith(join(root, "fixtures"))) throw new DatasetError("Dataset file must live under fixtures/");
  const text = readFileSync(path, "utf8");
  const hash = sha256Hex(text);
  if (hash !== manifest.sha256) throw new DatasetError(`Dataset "${datasetId}" hash does not match its manifest`);
  const parsed = DatasetSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new DatasetError(`Dataset "${datasetId}" is invalid: ${parsed.error.issues[0]?.message ?? "schema"}`);
  if (parsed.data.datasetId !== datasetId) throw new DatasetError("Dataset id does not match manifest");
  return { dataset: parsed.data, manifest };
}
