import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";

/**
 * Bounded HTTPS GET for creator-chosen URLs (token metadata and logos). Those
 * URLs are untrusted input, so every hop is checked: https on the default
 * port only, no credentials, no local names, and every resolved address must
 * be public (checked in the socket's own DNS lookup, so a second resolution
 * cannot swap in a private address). Bodies are capped before and after
 * decompression, redirects are limited, and the whole fetch has a deadline.
 */

export class FetchRefused extends Error {
  constructor(
    readonly reason:
      | "bad_url"
      | "not_https"
      | "port"
      | "credentials"
      | "private_address"
      | "redirects"
      | "timeout"
      | "http_status"
      | "rate_limited"
      | "too_large"
      | "encoding"
      | "bad_json"
      | "no_image"
      | "not_image",
    message: string,
    /** The HTTP status, when the refusal came from a response. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "FetchRefused";
  }
}

export type Fetched = { url: string; contentType: string | null; bytes: Buffer };
export type LimitedFetch = (url: string, opts: { maxBytes: number; accept: string; timeoutMs?: number }) => Promise<Fetched>;

const USER_AGENT = "Degentellegence/0.1 (token logo fetcher)";
const MAX_REDIRECTS = 3;

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
// No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped IPv6 against the IPv4 rules, and such a rule would also match every IPv4 address.
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** True only for a literal IP address outside private, loopback, link-local, shared, documentation, and multicast ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Parse and vet one URL before any connection is made. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused("bad_url", "Not a valid URL");
  }
  if (u.protocol !== "https:") throw new FetchRefused("not_https", "Only https URLs are fetched");
  if (u.username || u.password) throw new FetchRefused("credentials", "URLs with credentials are not fetched");
  if (u.port !== "" && u.port !== "443") throw new FetchRefused("port", "Only the default https port is allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) ? !isPublicAddress(host) : host === "localhost" || /\.(localhost|local|internal|home|lan|intranet|corp)$/.test(host) || !host.includes(".")) {
    throw new FetchRefused("private_address", "The host is not a public address");
  }
  return u;
}

/** Socket DNS lookup that fails unless every resolved address is public. */
const guardedLookup = ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new FetchRefused("private_address", "The host resolves to a non-public address"));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as unknown as LookupFunction;

type Hop = { kind: "body"; contentType: string | null; bytes: Buffer } | { kind: "redirect"; location: string };

function hop(url: URL, accept: string, maxBytes: number, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchRefused("timeout", "Timed out"));
    const req = request(
      url,
      { method: "GET", agent: false, lookup: guardedLookup, headers: { Accept: accept, "Accept-Encoding": "gzip, deflate", "User-Agent": USER_AGENT } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ kind: "redirect", location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new FetchRefused(status === 429 ? "rate_limited" : "http_status", `HTTP ${status}`, status));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new FetchRefused("too_large", `Larger than ${maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new FetchRefused("too_large", `Larger than ${maxBytes} bytes`));
          } else chunks.push(c);
        });
        res.on("end", () => {
          let bytes = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "identity").toLowerCase();
          try {
            if (enc === "gzip" || enc === "x-gzip") bytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
            else if (enc === "deflate") bytes = inflateSync(bytes, { maxOutputLength: maxBytes });
            else if (enc !== "identity") throw new Error(enc);
          } catch {
            reject(new FetchRefused("encoding", "Unsupported or oversized content encoding"));
            return;
          }
          resolve({ kind: "body", contentType: res.headers["content-type"] ?? null, bytes });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new FetchRefused("timeout", "Timed out")), remaining);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

export const limitedFetch: LimitedFetch = async (raw, { maxBytes, accept, timeoutMs = 8000 }) => {
  const deadline = Date.now() + timeoutMs;
  let url = checkUrl(raw);
  for (let redirects = 0; ; redirects++) {
    const r = await hop(url, accept, maxBytes, deadline);
    if (r.kind === "body") return { url: url.toString(), contentType: r.contentType, bytes: r.bytes };
    if (redirects >= MAX_REDIRECTS) throw new FetchRefused("redirects", "Too many redirects");
    url = checkUrl(new URL(r.location, url).toString());
  }
};
