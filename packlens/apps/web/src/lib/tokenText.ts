/**
 * Token names and symbols are text anyone can type into a pump.fun launch.
 * Slurs among them are masked for display (first letter kept, the rest as *);
 * the API still returns the stored text unchanged. The server keeps the same lists for
 * page titles and link previews (apps/server/src/lib/tokenText.ts; a test compares them).
 */

/** Distinctive stems, masked wherever they appear ("RetardCoin", "BIGRETARD"). */
export const STEMS = ["nigg", "faggot", "retard", "pedophil", "wetback", "tranny", "rapist"];
/** Short words that also occur inside innocent ones ("grape", "raccoon", "custard"): masked only as whole words. */
export const WORDS = ["fag", "fags", "dyke", "dykes", "kike", "kikes", "chink", "chinks", "spic", "spics", "gook", "gooks", "coon", "coons", "paki", "pakis", "tard", "tards", "rape", "raped", "pedo", "pedos", "beaner", "beaners"];

const PATTERN = new RegExp(`[a-z]*(?:${STEMS.join("|")})[a-z]*|(?<![a-z])(?:${WORDS.join("|")})(?![a-z])`, "gi");

/** JSON keys that carry token text in API responses. */
export const TOKEN_TEXT_KEYS = new Set(["name", "symbol", "tokenName", "tokenSymbol", "tokenBoughtSymbol", "tokenSoldSymbol", "counterTokenSymbol"]);

export function maskOffensive(text: string): string {
  return text.replace(PATTERN, (m) => m[0] + "*".repeat(m.length - 1));
}

/** JSON.parse reviver: masks token text fields, leaves every other value as it is. */
export function tokenTextReviver(key: string, value: unknown): unknown {
  return typeof value === "string" && TOKEN_TEXT_KEYS.has(key) ? maskOffensive(value) : value;
}
