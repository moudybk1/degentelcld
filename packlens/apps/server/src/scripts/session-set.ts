/**
 * npm run session:set -- 2h   (or 90m)
 * Writes NANSEN_SESSION_END_AT (ISO UTC) into .env. The running server reads
 * it at startup; restart the server to apply a new session window.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../config.js";

const arg = process.argv[2] ?? "";
const m = /^(\d+)(h|m)$/.exec(arg.trim());
if (!m) {
  process.stderr.write("Usage: npm run session:set -- <duration>, for example 2h or 90m\n");
  process.exit(1);
}
const minutes = Number(m[1]) * (m[2] === "h" ? 60 : 1);
if (minutes < 5 || minutes > 24 * 60) {
  process.stderr.write("Duration must be between 5 minutes and 24 hours.\n");
  process.exit(1);
}
const end = new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const path = join(ROOT_DIR, ".env");
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
const line = `NANSEN_SESSION_END_AT=${end}`;
const next = /^NANSEN_SESSION_END_AT=.*$/m.test(text) ? text.replace(/^NANSEN_SESSION_END_AT=.*$/m, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
writeFileSync(path, next, { mode: 0o600 });
process.stdout.write(`NANSEN_SESSION_END_AT set to ${end} (${minutes} minutes from now). Restart the server to apply it.\n`);
