import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

const PI_TABLES = ["provider_metadata_cache", "diff_review_summaries", "provider_metadata_scoped_cache",
  "model_backend_profiles", "agent_turns", "subagent_traces"] as const;

function quotePiIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

/** Append provider choices without changing existing rows, foreign keys, indexes or triggers. */
function piTableDefinition(table: string, sql: string): string {
  const header = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`, "u");
  if (!header.test(sql)) throw new Error(`Unexpected ${table} table definition.`);
  let changed = false;
  let next = sql.replace(header, `CREATE TABLE ${quotePiIdentifier(`${table}_v108`)} (`);
  for (const [column, anchor, addition] of [
    ["provider_id", "antigravity", "pi"], ["harness_id", "antigravity-cli", "pi-rpc"],
    ["protocol", "antigravity-managed", "pi-native"],
  ] as const) {
    const pattern = new RegExp(`(\\b${column}\\s+IN\\s*\\()([^)]*)(\\))`, "giu");
    next = next.replace(pattern, (_match, prefix: string, values: string, suffix: string) => {
      if (!values.includes(`'${anchor}'`)) throw new Error(`Unexpected ${table}.${column} constraint.`);
      // Backdated test/recovery fixtures can already contain the widened schema.
      changed = true;
      return `${prefix}${values.includes(`'${addition}'`) ? values : `${values}, '${addition}'`}${suffix}`;
    });
  }
  if (!changed) throw new Error(`No provider constraints found in ${table}.`);
  return next;
}

function rebuildPiTable(database: Database.Database, table: string): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`Missing ${table} table.`);
  const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
    .all(table) as { sql: string }[];
  const columns = (database.prepare(`PRAGMA table_info(${quotePiIdentifier(table)})`).all() as { name: string }[])
    .map(({ name }) => quotePiIdentifier(name)).join(", ");
  database.exec(piTableDefinition(table, row.sql));
  database.exec(`INSERT INTO ${quotePiIdentifier(`${table}_v108`)} (${columns}) SELECT ${columns} FROM ${quotePiIdentifier(table)}`);
  database.exec(`DROP TABLE ${quotePiIdentifier(table)}`);
  database.exec(`ALTER TABLE ${quotePiIdentifier(`${table}_v108`)} RENAME TO ${quotePiIdentifier(table)}`);
  for (const index of indexes) database.exec(index.sql);
}

export const nativePiProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportNativePiProvider",
  foreignKeys: "off",
  up: (database) => {
    const triggers = (database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ sql }) => PI_TABLES.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql)));
    for (const { name } of triggers) database.exec(`DROP TRIGGER ${quotePiIdentifier(name)}`);
    for (const table of PI_TABLES) rebuildPiTable(database, table);
    for (const { sql } of triggers) database.exec(sql);
  },
};
