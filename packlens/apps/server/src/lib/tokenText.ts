/**
 * Slur masking for token text the server puts into page titles and link previews.
 * Keep the lists identical to apps/web/src/lib/tokenText.ts (a test compares them).
 */
export const STEMS = ["nigg", "faggot", "retard", "pedophil", "wetback", "tranny", "rapist"];
export const WORDS = ["fag", "fags", "dyke", "dykes", "kike", "kikes", "chink", "chinks", "spic", "spics", "gook", "gooks", "coon", "coons", "paki", "pakis", "tard", "tards", "rape", "raped", "pedo", "pedos", "beaner", "beaners"];

const PATTERN = new RegExp(`[a-z]*(?:${STEMS.join("|")})[a-z]*|(?<![a-z])(?:${WORDS.join("|")})(?![a-z])`, "gi");

export function maskOffensive(text: string): string {
  return text.replace(PATTERN, (m) => m[0] + "*".repeat(m.length - 1));
}
