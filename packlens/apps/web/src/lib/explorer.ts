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

/** Stable pastel for a token monogram, derived from the mint. */
export function avatarTone(mint: string): { bg: string; fg: string } {
  const tones = [
    { bg: "#FDEBEC", fg: "#9F2F2D" },
    { bg: "#E1F3FE", fg: "#1F6C9F" },
    { bg: "#EDF3EC", fg: "#346538" },
    { bg: "#FBF3DB", fg: "#956400" },
    { bg: "#F1EEF8", fg: "#5B4A8B" },
    { bg: "#F1F1EF", fg: "#5F5E5B" },
  ];
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return tones[h % tones.length]!;
}
