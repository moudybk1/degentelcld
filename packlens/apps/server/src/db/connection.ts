import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "../lib/ids.js";

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("SQLite foreign keys could not be enabled");
  return db;
}

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

/** First-line marker for a migration that rebuilds a referenced table. */
const FOREIGN_KEYS_OFF = /^-- packlens: foreign-keys-off\n/;

/**
 * Versioned, checksummed migrations. An already-applied migration whose file
 * content changed is a hard error: applied migrations are never edited.
 */
export function migrate(db: Db, migrationsDir: string, nowMs: number): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  )`);
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied = new Map(
    (db.prepare("SELECT version, checksum FROM schema_migrations").all() as { version: string; checksum: string }[]).map((r) => [r.version, r.checksum]),
  );
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const version = file.slice(0, 4);
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const checksum = sha256Hex(sql);
    const existing = applied.get(version);
    if (existing !== undefined) {
      if (existing !== checksum) throw new Error(`Migration ${file} was edited after it was applied (checksum mismatch)`);
      result.alreadyApplied.push(file);
      continue;
    }
    const record = () =>
      db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)").run(version, file, checksum, nowMs);
    if (FOREIGN_KEYS_OFF.test(sql)) {
      // Table rebuilds (sqlite.org/lang_altertable.html#otheralter): foreign keys can only be
      // switched outside a transaction, and every reference is re-checked before the commit.
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(sql);
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) throw new Error(`Migration ${file} would leave ${violations.length} foreign key violations`);
          record();
        })();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      db.transaction(() => {
        db.exec(sql);
        record();
      })();
    }
    result.applied.push(file);
  }
  return result;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
