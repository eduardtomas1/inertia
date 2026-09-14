import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

const WIDENED_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
  "agent_turns",
  "subagent_traces",
] as const;

const WIDENINGS: readonly (readonly [RegExp, string])[] = [
  [/'gemini', 'kimi', 'opencode'\)/gu, "'gemini', 'kimi', 'opencode', 'antigravity')"],
  [/'gemini-acp', 'kimi-acp',/gu, "'gemini-acp', 'kimi-acp', 'antigravity-cli',"],
  [/'gemini-managed', 'kimi-managed',/gu, "'gemini-managed', 'kimi-managed', 'antigravity-managed',"],
];

interface SchemaRow {
  name: string;
  sql: string;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function widenedTableSql(table: string, sql: string): string {
  const header = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`, "u");
  if (!header.test(sql) || sql.includes("'antigravity")) {
    throw new Error(`The ${table} schema has an unexpected shape.`);
  }
  let next = sql.replace(header, `CREATE TABLE ${quoted(`${table}_v76`)} (`);
  let widened = false;
  for (const [pattern, replacement] of WIDENINGS) {
    const candidate = next.replace(pattern, replacement);
    widened ||= candidate !== next;
    next = candidate;
  }
  if (!widened) {
    throw new Error(`The ${table} provider constraints were not found.`);
  }
  return next;
}

function tableSql(database: Database.Database, table: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`The ${table} table is missing.`);
  return row.sql;
}

export const nativeAntigravityProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportNativeAntigravityProvider",
  foreignKeys: "off",
  up: (database) => {
    const dependentTriggers = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as SchemaRow[])
      .filter(({ sql }) => WIDENED_TABLES.some((table) =>
        new RegExp(`\\b${table}\\b`, "u").test(sql)));
    for (const { name } of dependentTriggers) {
      database.exec(`DROP TRIGGER ${quoted(name)}`);
    }
    for (const table of WIDENED_TABLES) {
      const createSql = widenedTableSql(table, tableSql(database, table));
      const indexes = (database
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
        .all(table) as SchemaRow[])
        .map(({ sql }) => sql);
      const columns = (database
        .prepare(`PRAGMA table_info(${quoted(table)})`)
        .all() as { name: string }[])
        .map(({ name }) => quoted(name))
        .join(", ");
      database.exec(createSql);
      database.exec(
        `INSERT INTO ${quoted(`${table}_v76`)} (${columns}) SELECT ${columns} FROM ${quoted(table)}`,
      );
      database.exec(`DROP TABLE ${quoted(table)}`);
      database.exec(`ALTER TABLE ${quoted(`${table}_v76`)} RENAME TO ${quoted(table)}`);
      for (const sql of indexes) database.exec(sql);
    }
    for (const { sql } of dependentTriggers) database.exec(sql);
  },
};
