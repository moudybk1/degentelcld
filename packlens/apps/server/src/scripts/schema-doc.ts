/** npm run db:schema-doc: generate docs/db-schema.md from the actual migrations. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../config.js";
import { migrate, openDatabase } from "../db/connection.js";

const db = openDatabase(":memory:");
const result = migrate(db, join(ROOT_DIR, "migrations"), Date.now());
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
let md = `# PackLens database schema\n\nGenerated from \`migrations/\` (${result.applied.join(", ")}) by \`npm run db:schema-doc\`. Do not edit by hand.\n\n`;
md += "SQLite runs in WAL mode with foreign keys enabled on every connection. Namespaces (`live:`, `fixture:`, `replay:`) isolate data; composite foreign keys keep references inside one namespace.\n\n";
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as { name: string; type: string; notnull: number; pk: number; dflt_value: string | null }[];
  const fks = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t.name)})`).all() as { table: string; from: string; to: string; id: number }[];
  const idx = db.prepare(`PRAGMA index_list(${JSON.stringify(t.name)})`).all() as { name: string; unique: number }[];
  md += `## \`${t.name}\`\n\n| Column | Type | Null | Key | Default |\n|---|---|---|---|---|\n`;
  for (const c of cols) md += `| \`${c.name}\` | ${c.type || "—"} | ${c.notnull ? "no" : "yes"} | ${c.pk ? "PK" : ""} | ${c.dflt_value ?? ""} |\n`;
  if (fks.length) {
    const grouped = new Map<number, { table: string; from: string[]; to: string[] }>();
    for (const f of fks) {
      const g = grouped.get(f.id) ?? { table: f.table, from: [], to: [] };
      g.from.push(f.from);
      g.to.push(f.to);
      grouped.set(f.id, g);
    }
    md += `\nForeign keys: ${[...grouped.values()].map((g) => `(${g.from.join(", ")}) → \`${g.table}\`(${g.to.join(", ")})`).join("; ")}\n`;
  }
  const named = idx.filter((i) => !i.name.startsWith("sqlite_autoindex"));
  if (named.length) md += `\nIndexes: ${named.map((i) => `\`${i.name}\`${i.unique ? " (unique)" : ""}`).join(", ")}\n`;
  md += "\n";
}
const triggers = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; tbl_name: string }[];
if (triggers.length) md += `## Immutability triggers\n\n${triggers.map((t) => `- \`${t.name}\` on \`${t.tbl_name}\`: updates are rejected; new responses create new rows.`).join("\n")}\n`;
writeFileSync(join(ROOT_DIR, "docs", "db-schema.md"), md);
process.stdout.write(`Wrote docs/db-schema.md (${tables.length} tables)\n`);
