import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Random identifier with a readable prefix. Not used for domain identities. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

/** eventId = "solana:" + signature + ":" + eventOrdinal (blueprint §17.5). */
export function eventIdFor(signature: string, ordinal: number): string {
  return `solana:${signature}:${ordinal}`;
}

/**
 * packId = sha256(canonicalJSON([namespace, configVersion, mint, triggerEventId]))
 * in lowercase hex, preserving array order and address capitalization (§17.5).
 */
export function packIdFor(namespace: string, configVersion: string, mint: string, triggerEventId: string): string {
  return sha256Hex(Buffer.from(JSON.stringify([namespace, configVersion, mint, triggerEventId]), "utf8"));
}

export function iso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function isoRequired(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseIsoMs(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
