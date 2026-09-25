import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/connection.js";
import { getMeta, setMeta } from "../db/connection.js";

/**
 * Stable, signed cursors bound to namespace, filter hash, sort tuple, and the
 * snapshot as-of time (blueprint §11.1, §17.8). No OFFSET pagination.
 */
export type CursorPayload = { ns: string; fh: string; t: number; id: string; asOf: number };

export function cursorSecret(db: Db): Buffer {
  let s = getMeta(db, "cursor_secret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setMeta(db, "cursor_secret", s);
  }
  return Buffer.from(s, "hex");
}

export function encodeCursor(secret: Buffer, p: CursorPayload): string {
  const body = Buffer.from(JSON.stringify([p.ns, p.fh, p.t, p.id, p.asOf]), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
  return `${body}.${mac}`;
}

export function decodeCursor(secret: Buffer, cursor: string): CursorPayload | null {
  if (cursor.length > 1024) return null;
  const [body, mac] = cursor.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const arr = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(arr) || arr.length !== 5) return null;
    const [ns, fh, t, id, asOf] = arr as unknown[];
    if (typeof ns !== "string" || typeof fh !== "string" || typeof id !== "string" || !Number.isSafeInteger(t) || !Number.isSafeInteger(asOf)) return null;
    return { ns, fh, t: t as number, id, asOf: asOf as number };
  } catch {
    return null;
  }
}
