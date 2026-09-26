/** Explorer links built only from validated Base58 identifiers. */
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function valid(s: string, min: number, max: number): boolean {
  return s.length >= min && s.length <= max && B58.test(s);
}

export function txUrl(signature: string): string | null {
  return valid(signature, 64, 90) ? `https://solscan.io/tx/${signature}` : null;
}

export function accountUrl(address: string): string | null {
  return valid(address, 32, 44) ? `https://solscan.io/account/${address}` : null;
}

export function tokenUrl(mint: string): string | null {
  return valid(mint, 32, 44) ? `https://solscan.io/token/${mint}` : null;
}

/** Where traders look at a pump.fun token next. */
export function pumpFunUrl(mint: string): string | null {
  return valid(mint, 32, 44) ? `https://pump.fun/coin/${mint}` : null;
}

export function dexScreenerUrl(mint: string): string | null {
  return valid(mint, 32, 44) ? `https://dexscreener.com/solana/${mint}` : null;
}

export function nansenWalletUrl(address: string): string | null {
  return valid(address, 32, 44) ? `https://app.nansen.ai/profiler?address=${address}&chain=solana` : null;
}

/** Stable monogram tile for a token, derived from the mint: graphite, ink, and red only. */
export function avatarTone(mint: string): { bg: string; fg: string } {
  const tones = [
    { bg: "#2A1113", fg: "#FF4D4D" },
    { bg: "#1C1C1F", fg: "#EAEAEA" },
    { bg: "#27272B", fg: "#B9B9BE" },
    { bg: "#141416", fg: "#FF2A2A" },
    { bg: "#EAEAEA", fg: "#0A0A0A" },
    { bg: "#3A0E10", fg: "#F2F2F2" },
  ];
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return tones[h % tones.length]!;
}
