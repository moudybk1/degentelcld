import { base58Encode } from "../lib/base58.js";
import { PUMP_PROGRAM_ID } from "../config.js";

/**
 * pump.fun bonding-curve event decoder.
 *
 * Pinned to the official IDL at github.com/pump-fun/pump-public-docs,
 * commit 81091419e4457566469d4e2a27f64ed84d42419c, idl/pump.json
 * sha256 ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b.
 * A copy lives next to this file (pump-idl.json) and a test verifies the hash
 * and field order. Events are read from "Program data:" log lines emitted
 * while the pump program is the executing program on the invoke stack.
 *
 * Older logs are shorter: fields added later are read as absent (the pump.fun
 * docs specify "read the missing fields as 0 / false").
 */
export const DECODER_VERSION = "pumpfun-idl-81091419-v1";
export const PUMP_IDL_COMMIT = "81091419e4457566469d4e2a27f64ed84d42419c";
export const PUMP_IDL_SHA256 = "ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b";

export const TRADE_EVENT_DISCRIMINATOR = Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]);
export const CREATE_EVENT_DISCRIMINATOR = Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]);
export const COMPLETE_EVENT_DISCRIMINATOR = Uint8Array.from([95, 114, 97, 156, 212, 46, 152, 8]);

/** Pump.fun mints use 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;

export type DecodedTrade = {
  ordinal: number;
  mint: string;
  solAmountRaw: string;
  tokenAmountRaw: string;
  isBuy: boolean;
  user: string;
  timestampSec: number;
  feeRaw: string | null;
  creatorFeeRaw: string | null;
  ixName: string | null;
  /** null when the log predates the quote fields (legacy SOL-only layout). */
  quoteMint: string | null;
  quoteAmountRaw: string | null;
};

export type DecodedCreate = {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  user: string | null;
  creator: string | null;
  timestampSec: number | null;
  totalSupplyRaw: string | null;
};

/** The token completed its bonding curve; later trades happen on other venues. */
export type DecodedComplete = {
  user: string;
  mint: string;
  timestampSec: number;
};

export type DecodeResult = {
  trades: DecodedTrade[];
  creates: DecodedCreate[];
  completes: DecodedComplete[];
  truncated: boolean;
  errors: number;
};

class Cursor {
  offset = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.offset;
  }
  private need(n: number): void {
    if (this.remaining < n) throw new RangeError("Event data ended inside a field");
  }
  pubkey(): string {
    this.need(32);
    const v = base58Encode(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  bool(): boolean {
    this.need(1);
    const v = this.buf[this.offset]!;
    this.offset += 1;
    if (v !== 0 && v !== 1) throw new RangeError("Invalid bool");
    return v === 1;
  }
  string(maxLen = 1024): string {
    const len = this.u32();
    if (len > maxLen) throw new RangeError("String too long");
    this.need(len);
    const v = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }
}

function hasPrefix(buf: Buffer, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

/** Decode a TradeEvent payload (including the 8-byte discriminator). Throws on malformed data. */
export function decodeTradeEvent(buf: Buffer, ordinal: number): DecodedTrade {
  const c = new Cursor(buf);
  c.skip(8);
  const mint = c.pubkey();
  const solAmount = c.u64();
  const tokenAmount = c.u64();
  const isBuy = c.bool();
  const user = c.pubkey();
  const timestamp = c.i64();
  const out: DecodedTrade = {
    ordinal,
    mint,
    solAmountRaw: solAmount.toString(),
    tokenAmountRaw: tokenAmount.toString(),
    isBuy,
    user,
    timestampSec: Number(timestamp),
    feeRaw: null,
    creatorFeeRaw: null,
    ixName: null,
    quoteMint: null,
    quoteAmountRaw: null,
  };
  if (timestamp <= 0n || timestamp > 4102444800n) throw new RangeError("Implausible event timestamp");
  // Optional tail, read field by field; a log may end at any field boundary.
  if (c.remaining === 0) return out;
  c.u64(); c.u64(); c.u64(); c.u64(); // virtual/real reserves
  if (c.remaining === 0) return out;
  c.pubkey(); // fee_recipient
  c.u64(); // fee_basis_points
  out.feeRaw = c.u64().toString();
  if (c.remaining === 0) return out;
  c.pubkey(); // creator
  c.u64(); // creator_fee_basis_points
  out.creatorFeeRaw = c.u64().toString();
  if (c.remaining === 0) return out;
  c.bool(); // track_volume
  c.u64(); c.u64(); c.u64(); // total_unclaimed_tokens, total_claimed_tokens, current_sol_volume
  c.i64(); // last_update_timestamp
  if (c.remaining === 0) return out;
  out.ixName = c.string(64);
  if (c.remaining === 0) return out;
  c.bool(); // mayhem_mode
  if (c.remaining === 0) return out;
  c.u64(); c.u64(); // cashback bps, cashback
  if (c.remaining === 0) return out;
  c.u64(); c.u64(); // buyback bps, buyback fee
  if (c.remaining === 0) return out;
  const shareholders = c.u32();
  if (shareholders > 64) throw new RangeError("Too many shareholders");
  for (let i = 0; i < shareholders; i++) {
    c.pubkey();
    c.u16();
  }
  if (c.remaining === 0) return out;
  out.quoteMint = c.pubkey();
  out.quoteAmountRaw = c.u64().toString();
  return out;
}

export function decodeCreateEvent(buf: Buffer): DecodedCreate {
  const c = new Cursor(buf);
  c.skip(8);
  const name = c.string(256);
  const symbol = c.string(64);
  const uri = c.string(512);
  const mint = c.pubkey();
  const out: DecodedCreate = { name, symbol, uri, mint, user: null, creator: null, timestampSec: null, totalSupplyRaw: null };
  if (c.remaining === 0) return out;
  c.pubkey(); // bonding_curve
  out.user = c.pubkey();
  if (c.remaining === 0) return out;
  out.creator = c.pubkey();
  if (c.remaining === 0) return out;
  out.timestampSec = Number(c.i64());
  if (c.remaining === 0) return out;
  c.u64(); c.u64(); c.u64(); // virtual token, virtual sol, real token reserves
  if (c.remaining === 0) return out;
  out.totalSupplyRaw = c.u64().toString();
  return out;
}

export function decodeCompleteEvent(buf: Buffer): DecodedComplete {
  const c = new Cursor(buf);
  c.skip(8);
  const user = c.pubkey();
  const mint = c.pubkey();
  c.pubkey(); // bonding_curve
  const ts = c.i64();
  if (ts <= 0n) throw new RangeError("Implausible event timestamp");
  return { user, mint, timestampSec: Number(ts) };
}

const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (success|failed.*)$/;

/**
 * Decode pump.fun events from a transaction's log messages. The ordinal is the
 * position of the TradeEvent among decoded pump TradeEvents in log order,
 * deterministic for this decoder version.
 */
export function decodeLogs(logs: readonly string[]): DecodeResult {
  const result: DecodeResult = { trades: [], creates: [], completes: [], truncated: false, errors: 0 };
  const stack: string[] = [];
  let tradeOrdinal = 0;
  for (const line of logs) {
    if (line === "Log truncated") {
      result.truncated = true;
      continue;
    }
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit) {
      if (stack.length > 0 && stack[stack.length - 1] === exit[1]) stack.pop();
      continue;
    }
    if (!line.startsWith("Program data: ")) continue;
    if (stack[stack.length - 1] !== PUMP_PROGRAM_ID) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice("Program data: ".length), "base64");
    } catch {
      result.errors++;
      continue;
    }
    if (hasPrefix(buf, TRADE_EVENT_DISCRIMINATOR)) {
      const ordinal = tradeOrdinal++;
      try {
        result.trades.push(decodeTradeEvent(buf, ordinal));
      } catch {
        result.errors++;
      }
    } else if (hasPrefix(buf, CREATE_EVENT_DISCRIMINATOR)) {
      try {
        result.creates.push(decodeCreateEvent(buf));
      } catch {
        result.errors++;
      }
    } else if (hasPrefix(buf, COMPLETE_EVENT_DISCRIMINATOR)) {
      try {
        result.completes.push(decodeCompleteEvent(buf));
      } catch {
        result.errors++;
      }
    }
  }
  return result;
}
