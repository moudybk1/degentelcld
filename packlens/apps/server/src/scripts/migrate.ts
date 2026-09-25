/** npm run db:migrate: apply versioned migrations to the configured database. */
import { join } from "node:path";
import { ConfigError, loadConfig, loadDotEnv } from "../config.js";
import { migrate, openDatabase } from "../db/connection.js";

loadDotEnv();
try {
  const config = loadConfig({ ...process.env, APP_MODE: process.env.APP_MODE === "live" ? "fixture" : process.env.APP_MODE });
  const db = openDatabase(config.databasePath);
  const result = migrate(db, join(config.rootDir, "migrations"), Date.now());
  db.close();
  process.stdout.write(`Database: ${config.databasePath}\nApplied: ${result.applied.join(", ") || "none"}\nAlready applied: ${result.alreadyApplied.join(", ") || "none"}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
