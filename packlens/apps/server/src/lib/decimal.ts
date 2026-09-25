import { Decimal as DecimalBase } from "decimal.js";

/**
 * Financial decimal arithmetic (blueprint §17.13): precision 128, at most 60
 * significant digits per financial input, no rounding before threshold
 * evaluation, canonical serialization without exponent.
 */
export const Decimal = DecimalBase.clone({ precision: 128, rounding: DecimalBase.ROUND_HALF_UP, toExpNeg: -9e15, toExpPos: 9e15 });
export type Decimal = InstanceType<typeof Decimal>;

export const MAX_SIGNIFICANT_DIGITS = 60;

const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class DecimalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalFormatError";
  }
}

/** Parse a decimal string strictly. Rejects NaN/Infinity and excess precision instead of truncating. */
export function parseDecimal(input: string): Decimal {
  const text = input.trim();
  if (!DECIMAL_PATTERN.test(text)) throw new DecimalFormatError(`Not a decimal: ${text.slice(0, 40)}`);
  const d = new Decimal(text);
  if (!d.isFinite()) throw new DecimalFormatError("Non-finite decimal");
  if (d.precision(true) > MAX_SIGNIFICANT_DIGITS) throw new DecimalFormatError("Excess precision");
  return d;
}

/** Canonical decimal string: no exponent, no trailing fractional zeros, "0" for zero. */
export function canonical(d: Decimal): string {
  if (d.isZero()) return "0";
  const fixed = d.toFixed();
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

export function canonicalString(s: string): string {
  return canonical(parseDecimal(s));
}

/** Ratios and CV under patterns-v1: at most 18 decimals, ROUND_HALF_UP. */
export function ratio18(d: Decimal): string {
  return canonical(new Decimal(d.toFixed(18, DecimalBase.ROUND_HALF_UP)));
}

/** Raw on-chain integer (u64) scaled by decimals, exact. */
export function fromRaw(raw: string, decimals: number): Decimal {
  if (!/^\d+$/.test(raw)) throw new DecimalFormatError("Raw amount must be an unsigned integer string");
  if (BigInt(raw) > 18446744073709551615n) throw new DecimalFormatError("Raw amount exceeds u64");
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}

export function sumDecimals(values: string[]): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(parseDecimal(v));
  return acc;
}
