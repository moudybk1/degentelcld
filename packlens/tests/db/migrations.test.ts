import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_DIR } from "../../apps/server/src/config.js";
import { migrate, openDatabase } from "../../apps/server/src/db/connection.js";
import { T0 } from "../helpers.js";

const SNAP = `INSERT INTO price_snapshots (id, namespace, chain, quote_mint, requested_from_ms, requested_to_ms, request_started_at_ms, response_received_at_ms, available_at_ms, candles_json, source, timeframe, policy_version)
  VALUES (?, 'live:t', 'solana', 'So11111111111111111111111111111111111111112', 1, 2, 3, 4, 5, '[{"intervalStartMs":0,"close":"120"}]', 'nansen', ?, ?)`;

function migrationsUpTo(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "packlens-mig-"));
  for (const f of readdirSync(join(ROOT_DIR, "migrations"))) if (f.slice(0, 4) <= version) copyFileSync(join(ROOT_DIR, "migrations", f), join(dir, f));
  return dir;
}

describe("0006: price snapshots accept Pyth prices", () => {
  it("rebuilds the table without losing rows, keeps it immutable, and restores foreign keys", () => {
    const db = openDatabase(":memory:");
    const dir = migrationsUpTo("0005");
    migrate(db, dir, T0);
    db.prepare("INSERT INTO namespaces (id, mode, created_at_ms, label) VALUES ('live:t', 'live', 1, 't')").run();
    db.prepare(SNAP).run("old", "5m", "nansen-5m-closed-v1");
    expect(() => db.prepare(SNAP).run("tick-before", "tick", "pyth-onchain-v1")).toThrow(/CHECK constraint/);

    copyFileSync(join(ROOT_DIR, "migrations", "0006_pyth_price.sql"), join(dir, "0006_pyth_price.sql"));
    expect(migrate(db, dir, T0).applied).toEqual(["0006_pyth_price.sql"]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT id, timeframe, policy_version FROM price_snapshots").all()).toEqual([{ id: "old", timeframe: "5m", policy_version: "nansen-5m-closed-v1" }]);
    db.prepare(SNAP).run("tick", "tick", "pyth-onchain-v1");
    expect(() => db.prepare(SNAP).run("bad", "15m", "x")).toThrow(/CHECK constraint/);
    expect(() => db.prepare("UPDATE price_snapshots SET source = 'x' WHERE id = 'tick'").run()).toThrow(/immutable/);
    expect(() => db.prepare(SNAP.replace("'live:t'", "'live:missing'")).run("orphan", "tick", "pyth-onchain-v1")).toThrow(/FOREIGN KEY/);
  });

  it("a table rebuild that would break a reference is rolled back and foreign keys stay on", () => {
    const db = openDatabase(":memory:");
    const dir = migrationsUpTo("0001");
    migrate(db, dir, T0);
    db.prepare("INSERT INTO namespaces (id, mode, created_at_ms, label) VALUES ('live:t', 'live', 1, 't')").run();
    db.exec("INSERT INTO price_snapshots (id, namespace, chain, quote_mint, requested_from_ms, requested_to_ms, request_started_at_ms, response_received_at_ms, available_at_ms, candles_json, source) VALUES ('p', 'live:t', 'solana', 'q', 1, 2, 3, 4, 5, '[]', 's')");
    writeFileSync(join(dir, "0002_broken.sql"), "-- packlens: foreign-keys-off\nDELETE FROM namespaces;\n");
    expect(() => migrate(db, dir, T0)).toThrow(/foreign key violations/);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM namespaces").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: "0001" }]);
  });
});
