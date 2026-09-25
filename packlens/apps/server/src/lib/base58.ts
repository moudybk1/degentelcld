const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = ALPHABET[r] + out;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 128) return null;
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** Solana account/mint address: Base58 decoding to exactly 32 bytes (blueprint §17.8). */
export function isSolanaAddress(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const bytes = base58Decode(text);
  return bytes !== null && bytes.length === 32;
}

/** Solana transaction signature: Base58 decoding to exactly 64 bytes. */
export function isSolanaSignature(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const bytes = base58Decode(text);
  return bytes !== null && bytes.length === 64;
}
