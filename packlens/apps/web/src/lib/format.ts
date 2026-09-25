/** Display-only formatting. APIs keep ISO UTC and exact decimal strings. */

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdCompactFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat("en-US");

export function usd(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return usdFmt.format(n);
}

/** Per-token prices: significant digits for tiny values (e.g. $0.00000390). */
export function usdPrice(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1) return usd(value);
  return `$${Number(n.toPrecision(3)).toString().includes("e") ? n.toFixed(12).replace(/0+$/, "") : Number(n.toPrecision(3)).toString()}`;
}

export function usdCompact(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 10_000) return usd(value);
  return usdCompactFmt.format(n);
}

export function signedUsd(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const s = usdCompact(String(Math.abs(n)));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function int(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : intFmt.format(n);
}

export function decimal(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
}

export function pct(ratio: string | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined) return "—";
  const n = Number(ratio);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—";
}

export function shortAddr(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

function toMs(t: number | string): number {
  return typeof t === "number" ? t : Date.parse(t);
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function timeUtc(t: number | string | null | undefined): string {
  if (t === null || t === undefined) return "—";
  const d = new Date(toMs(t));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function dateTimeUtc(t: number | string | null | undefined): string {
  if (t === null || t === undefined) return "—";
  const d = new Date(toMs(t));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function relative(t: number | string | null | undefined, now = Date.now()): string {
  if (t === null || t === undefined) return "—";
  const diff = now - toMs(t);
  const abs = Math.abs(diff);
  const future = diff < 0;
  let s: string;
  if (abs < 5_000) return "just now";
  if (abs < 60_000) s = `${Math.round(abs / 1000)} s`;
  else if (abs < 3_600_000) s = `${Math.round(abs / 60_000)} min`;
  else if (abs < 86_400_000) s = `${(abs / 3_600_000).toFixed(abs < 36_000_000 ? 1 : 0)} h`;
  else s = `${Math.round(abs / 86_400_000)} d`;
  return future ? `in ${s}` : `${s} ago`;
}

export function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

export function rawAmount(raw: string, decimals: number, maxFractionDigits = 4): string {
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).slice(0, maxFractionDigits).replace(/0+$/, "");
  return `${Number(whole).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
