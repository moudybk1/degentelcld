/**
 * Lossless JSON parsing for provider responses (blueprint §17.1). Every JSON
 * number becomes a ProviderNumber carrying its exact source text, so financial
 * values are never rounded through IEEE-754 doubles. Adapters decide which
 * numbers become decimal strings and which verified-safe counters become numbers.
 */
export class ProviderNumber {
  constructor(readonly raw: string) {}
  toJSON(): string {
    return this.raw;
  }
}

type ReviverContext = { source?: string };

export function parseLossless(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: ReviverContext) {
    if (typeof value === "number") {
      if (!context || typeof context.source !== "string") throw new Error("Lossless JSON parsing is not supported by this runtime");
      return new ProviderNumber(context.source);
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

/** Canonical JSON with sorted object keys, used for hashes and identities. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof ProviderNumber) return value.raw;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
