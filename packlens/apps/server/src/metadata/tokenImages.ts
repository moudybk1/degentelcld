import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db } from "../db/connection.js";
import { log } from "../lib/log.js";
import { FetchRefused, limitedFetch, type LimitedFetch } from "./safeFetch.js";

/**
 * Token logos (display only). For tokens that appear in packs, read the
 * pump.fun metadata JSON behind the create event's URI, fetch its `image`, and
 * store a small raster copy. IPFS content goes through pump.fun's gateway,
 * which also resizes it; content that gateway does not host (403/404, e.g.
 * tokens from other launchers) falls back to Pinata's slower public gateway,
 * which serves originals. The ipfs.io-style public gateways refuse plain HTTP.
 * Everything else goes through the guarded fetcher. SVG and other non-raster
 * types are rejected by magic bytes, whatever the server claims.
 */

export const IPFS_GATEWAY = "https://pump.mypinata.cloud/ipfs/";
export const PUBLIC_IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const PUBLIC_GATEWAY_TIMEOUT_MS = 20_000;
const RESIZE = "img-width=96&img-height=96&img-fit=cover&img-format=webp";
const META_MAX_BYTES = 64 * 1024;
const IMAGE_MAX_BYTES = 512 * 1024;
const BATCH = 3;
const INTERVAL_MS = 3000;
const RETRY_AFTER_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;
const RATE_LIMIT_PAUSE_MS = 60_000;
/** Reasons that will not change on retry; the token keeps its monogram. */
const PERMANENT = new Set<FetchRefused["reason"]>(["bad_url", "not_https", "port", "credentials", "private_address", "too_large", "encoding", "bad_json", "no_image", "not_image"]);

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;
const SAFE_PATH = /^[A-Za-z0-9._~\-/]*$/;

/** The IPFS content path (CID plus optional sub-path) in ipfs://, …/ipfs/<cid>, or <cid>.ipfs.<gateway> form; null otherwise. */
export function ipfsPath(raw: string): string | null {
  const s = raw.trim();
  const m =
    /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i.exec(s) ?? /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)([^?#]*)/i.exec(s) ?? /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+([^?#]*)/i.exec(s);
  if (!m) return null;
  const cid = m[1]!;
  const rest = m[2] ?? "";
  if (!CID.test(cid) || !SAFE_PATH.test(rest) || rest.includes("..")) return null;
  return `${cid}${rest === "/" ? "" : rest}`;
}

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

/** Raster type from magic bytes; null for anything else (SVG, HTML, JSON, …). */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "image/avif";
  return null;
}

type Candidate = { mint: string; uri: string; attempts: number };

export class TokenImageResolver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private pausedUntil = 0;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly namespace: string,
    private readonly fetcher: LimitedFetch = limitedFetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Resolve the next few tokens, newest pack first. Returns how many were attempted. */
  async runOnce(): Promise<number> {
    if (this.running || this.stopped || this.clock.now() < this.pausedUntil) return 0;
    this.running = true;
    try {
      const now = this.clock.now();
      const rows = this.db
        .prepare(
          `SELECT t.mint, t.uri, COALESCE(i.attempts, 0) AS attempts
             FROM tokens t
             JOIN (SELECT mint, MAX(trigger_event_time_ms) AS last FROM packs WHERE namespace = ? GROUP BY mint) p ON p.mint = t.mint
             LEFT JOIN token_images i ON i.namespace = t.namespace AND i.chain = t.chain AND i.mint = t.mint
            WHERE t.namespace = ? AND t.chain = 'solana' AND t.uri IS NOT NULL AND t.uri <> ''
              AND (i.mint IS NULL OR (i.state = 'failed' AND i.attempts < ? AND i.checked_at_ms <= ? - i.attempts * ?))
            ORDER BY p.last DESC LIMIT ?`,
        )
        .all(this.namespace, this.namespace, MAX_ATTEMPTS, now, RETRY_AFTER_MS, BATCH) as Candidate[];
      await Promise.all(rows.map((r) => this.resolveOne(r)));
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  private async resolveOne(c: Candidate): Promise<void> {
    try {
      const img = await this.fetchImage(c.uri);
      this.store(c.mint, { state: "ok", source: img.source, type: img.type, bytes: img.bytes, attempts: c.attempts + 1, error: null });
    } catch (err) {
      const reason = err instanceof FetchRefused ? err.reason : null;
      const permanent = reason !== null && PERMANENT.has(reason);
      const error = err instanceof FetchRefused ? (err.status ? `${err.reason} ${err.status}` : err.reason) : String(err);
      this.store(c.mint, { state: permanent ? "missing" : "failed", source: null, type: null, bytes: null, attempts: c.attempts + 1, error: error.slice(0, 200) });
    }
  }

  /** IPFS content from pump.fun's gateway (resized when `resize`), else from the public gateway when pump.fun does not host it. */
  private async fetchIpfs(path: string, opts: { maxBytes: number; accept: string }, resize: boolean): Promise<{ url: string; bytes: Buffer }> {
    const primary = `${IPFS_GATEWAY}${path}${resize ? `?${RESIZE}` : ""}`;
    try {
      return { url: primary, bytes: (await this.fetcher(primary, opts)).bytes };
    } catch (err) {
      if (!(err instanceof FetchRefused)) throw err;
      // Only pump.fun's gateway is shared by every lookup, so only its rate limit pauses them all.
      if (err.reason === "rate_limited" && this.clock.now() >= this.pausedUntil) {
        this.pausedUntil = this.clock.now() + RATE_LIMIT_PAUSE_MS;
        log("warn", "token-images", "pump.fun's IPFS gateway is rate limiting; pausing logo lookups", { pauseSeconds: RATE_LIMIT_PAUSE_MS / 1000 });
      }
      if (err.reason !== "http_status" || (err.status !== 403 && err.status !== 404)) throw err;
      const fallback = `${PUBLIC_IPFS_GATEWAY}${path}`;
      return { url: fallback, bytes: (await this.fetcher(fallback, { ...opts, timeoutMs: PUBLIC_GATEWAY_TIMEOUT_MS })).bytes };
    }
  }

  private async fetchImage(uri: string): Promise<{ source: string; type: ImageType; bytes: Buffer }> {
    const metaPath = ipfsPath(uri);
    const metaOpts = { maxBytes: META_MAX_BYTES, accept: "application/json" };
    const meta = metaPath ? await this.fetchIpfs(metaPath, metaOpts, false) : await this.fetcher(uri, metaOpts);
    let json: unknown;
    try {
      json = JSON.parse(meta.bytes.toString("utf8"));
    } catch {
      throw new FetchRefused("bad_json", "Metadata is not JSON");
    }
    const image = json && typeof json === "object" && typeof (json as { image?: unknown }).image === "string" ? (json as { image: string }).image.trim() : "";
    if (!image) throw new FetchRefused("no_image", "Metadata has no image");
    const imagePath = ipfsPath(image);
    const imageOpts = { maxBytes: IMAGE_MAX_BYTES, accept: "image/webp,image/avif,image/png,image/jpeg,image/gif" };
    const res = imagePath ? await this.fetchIpfs(imagePath, imageOpts, true) : { url: image, bytes: (await this.fetcher(image, imageOpts)).bytes };
    const type = sniffImage(res.bytes);
    if (!type) throw new FetchRefused("not_image", "Not a supported raster image");
    return { source: res.url, type, bytes: res.bytes };
  }

  private store(mint: string, r: { state: "ok" | "missing" | "failed"; source: string | null; type: ImageType | null; bytes: Buffer | null; attempts: number; error: string | null }): void {
    if (this.stopped) return;
    this.db
      .prepare(
        `INSERT INTO token_images (namespace, chain, mint, state, source_url, content_type, bytes, sha256, attempts, checked_at_ms, error)
         VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, chain, mint) DO UPDATE SET state = excluded.state, source_url = excluded.source_url, content_type = excluded.content_type,
           bytes = excluded.bytes, sha256 = excluded.sha256, attempts = excluded.attempts, checked_at_ms = excluded.checked_at_ms, error = excluded.error`,
      )
      .run(
        this.namespace, mint, r.state, r.source?.slice(0, 500) ?? null, r.type, r.bytes, r.bytes ? createHash("sha256").update(r.bytes).digest("hex") : null,
        r.attempts, this.clock.now(), r.error,
      );
  }
}
