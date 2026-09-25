/**
 * Structured JSON logs (blueprint §15.1). Credentials are never logged:
 * known secret keys are redacted and URLs are reduced to protocol and host.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = /(apikey|api_key|token|secret|authorization|cookie|password)/i;
let minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

export function setLogSink(fn: (line: string) => void, level: Level = "info"): void {
  sink = fn;
  minLevel = level;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof value === "string") {
    return value.replace(/(https?|wss?):\/\/[^\s"']+/g, (m) => {
      try {
        const u = new URL(m);
        return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? "/[redacted]" : ""}`;
      } catch {
        return "[url]";
      }
    }).slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = REDACT_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
    return out;
  }
  return value;
}

export function log(level: Level, component: string, message: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, component, msg: message, ...(scrub(fields) as Record<string, unknown>) }));
}
