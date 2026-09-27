import type { DetectionRule } from "@packlens/contracts";
import type { Db } from "../db/connection.js";
import { isSolanaAddress } from "../lib/base58.js";
import { maskOffensive } from "../lib/tokenText.js";

/**
 * The SPA's index.html, filled per request: the detection rule (so the first paint
 * never shows a default rule) and, for pack, token, and wallet pages, a title and
 * link-preview text. Previews describe the pack and when it formed, never a current
 * outcome, because a crawler's copy is kept long after the moment it was fetched.
 */
export type PageMeta = { title: string; description: string; path: string };

const SITE = "Degentellegence";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Untrusted token text for a title: masked, single-line, bounded. */
function tokenLabel(name: string | null, symbol: string | null, mint: string): string {
  const clean = (s: string | null) => (s ? maskOffensive(s.replace(/\s+/g, " ").trim()).slice(0, 40) : "");
  const n = clean(name);
  const sym = clean(symbol);
  if (n && sym && n.toLowerCase() !== sym.toLowerCase()) return `${n} (${sym})`;
  return n || sym || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function usdWhole(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : `$${v}`;
}

function whenUtc(ms: number): string {
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC, ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** Title and preview text for a deep link, or null for other pages (the static defaults stay). */
export function pageMeta(db: Db, path: string, namespace: string, rule: (namespace: string) => DetectionRule): PageMeta | null {
  let m = /^\/packs\/([0-9a-f]{64})$/.exec(path);
  if (m) {
    const p = db
      .prepare(
        `SELECT p.id, p.namespace, p.mint, p.trigger_event_time_ms AS t, p.initial_wallet_count AS iw, p.total_wallet_count AS tw, p.eligible_buy_usd AS usd, tk.name, tk.symbol
         FROM packs p LEFT JOIN tokens tk ON tk.namespace = p.namespace AND tk.chain = 'solana' AND tk.mint = p.mint WHERE p.id = ?`,
      )
      .get(m[1]) as { id: string; namespace: string; mint: string; t: number; iw: number; tw: number; usd: string; name: string | null; symbol: string | null } | undefined;
    if (!p) return null;
    const r = rule(p.namespace);
    const token = tokenLabel(p.name, p.symbol, p.mint);
    return {
      title: `${token} pack · ${p.tw} wallets · ${whenUtc(p.t)} · ${SITE}`,
      description: `${p.iw} wallets each bought $${r.minTradeUsd}+ of ${token} on pump.fun within ${r.triggerWindowSeconds} s at ${whenUtc(p.t)}; ${p.tw} wallets in total, ${usdWhole(p.usd)} of pack buys. The transactions, the wallets, and what happened next.`,
      path,
    };
  }
  m = /^\/tokens\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (m && isSolanaAddress(m[1]!)) {
    const mint = m[1]!;
    // Primary-key lookup in the viewed namespace (without it, every token row was read: 0.4 s on the live database).
    const t = db.prepare("SELECT name, symbol FROM tokens WHERE namespace = ? AND chain = 'solana' AND mint = ?").get(namespace, mint) as { name: string | null; symbol: string | null } | undefined;
    const token = tokenLabel(t?.name ?? null, t?.symbol ?? null, mint);
    return { title: `${token} on pump.fun · ${SITE}`, description: `Grouped buys of ${token} on pump.fun, with the transactions behind them, Smart Money activity, and token facts from Nansen.`, path };
  }
  m = /^\/wallets\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (m && isSolanaAddress(m[1]!)) {
    const w = m[1]!;
    const short = `${w.slice(0, 4)}…${w.slice(-4)}`;
    return { title: `Wallet ${short} · ${SITE}`, description: `The pump.fun packs wallet ${short} joined: when it bought, whether it sold, and its Nansen profile.`, path };
  }
  return null;
}

/** Replace the content of one meta tag, matched by its name or property attribute. */
function setMeta(html: string, attr: "name" | "property", key: string, value: string): string {
  const re = new RegExp(`(<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content=")[^"]*(")`);
  // A replacer function: "$20" in the text must not be read as a replacement pattern.
  return html.replace(re, (_m, open: string, close: string) => `${open}${esc(value)}${close}`);
}

export function renderIndex(template: string, rule: DetectionRule, meta: PageMeta | null): string {
  let html = template.replace("</head>", () => `  <meta name="degentel-rule" content="${esc(JSON.stringify(rule))}" />\n  </head>`);
  if (!meta) return html;
  const base = /<meta property="og:url" content="([^"]*)"/.exec(template)?.[1]?.replace(/\/$/, "") ?? "";
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(meta.title)}</title>`);
  html = setMeta(html, "name", "description", meta.description);
  for (const [attr, key] of [["property", "og:title"], ["name", "twitter:title"]] as const) html = setMeta(html, attr, key, meta.title);
  for (const [attr, key] of [["property", "og:description"], ["name", "twitter:description"]] as const) html = setMeta(html, attr, key, meta.description);
  if (base) html = setMeta(html, "property", "og:url", `${base}${meta.path}`);
  return html;
}
