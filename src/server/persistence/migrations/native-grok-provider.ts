import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

export const NATIVE_GROK_PROVIDER_SCHEMA_VERSION = 108;

const REQUIRED_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
  "agent_turns",
  "subagent_traces",
] as const;

const CONSTRAINT_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/'kimi',\s*'opencode',\s*'antigravity'\)/gu, "'kimi', 'opencode', 'antigravity', 'grok')"],
  [/'kimi-acp',\s*'antigravity-cli',/gu, "'kimi-acp', 'antigravity-cli', 'grok-acp',"],
  [/'kimi-managed',\s*'antigravity-managed',/gu, "'kimi-managed', 'antigravity-managed', 'grok-managed',"],
];

function quoted(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function tableSql(database: Database.Database, table: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row?.sql) throw new Error(`The ${table} table is missing.`);
  return row.sql;
}

function widenedSql(table: string, sql: string): string {
  const header = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`, "u");
  if (!header.test(sql)) throw new Error(`The ${table} schema has an unexpected shape.`);
  let next = sql.replace(header, `CREATE TABLE ${quoted(`${table}_v108`)} (`);
  let rewrote = false;
  for (const [pattern, replacement] of CONSTRAINT_REWRITES) {
    pattern.lastIndex = 0;
    if (!pattern.test(next)) continue;
    pattern.lastIndex = 0;
    next = next.replace(pattern, replacement);
    rewrote = true;
  }
  if (!rewrote || !next.includes("'grok")) {
    throw new Error(`The ${table} provider constraints were not found.`);
  }
  return next;
}

function rebuildTable(database: Database.Database, table: string): void {
  const createSql = widenedSql(table, tableSql(database, table));
  const indexes = (database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
    .all(table) as { sql: string }[])
    .map(({ sql }) => sql);
  const columns = (database
    .prepare(`PRAGMA table_info(${quoted(table)})`)
    .all() as { name: string }[])
    .map(({ name }) => quoted(name));
  const countRows = (): number => database
    .prepare(`SELECT COUNT(*) FROM ${quoted(table)}`)
    .pluck()
    .get() as number;
  const before = countRows();
  database.exec(createSql);
  database.exec(
    `INSERT INTO ${quoted(`${table}_v108`)} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${quoted(table)}`,
  );
  database.exec(`DROP TABLE ${quoted(table)}`);
  database.exec(`ALTER TABLE ${quoted(`${table}_v108`)} RENAME TO ${quoted(table)}`);
  for (const sql of indexes) database.exec(sql);
  if (countRows() !== before) {
    throw new Error(`${table} changed while adding Grok provider constraints.`);
  }
}

export const nativeGrokProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportNativeGrokProvider",
  foreignKeys: "off",
  up: (database) => {
    const tables = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ name, sql }) => !name.startsWith("sqlite_") && sql.includes("'antigravity"));
    const names = new Set(tables.map(({ name }) => name));
    for (const table of REQUIRED_TABLES) {
      if (!names.has(table)) {
        throw new Error(`The ${table} provider constraints were not found.`);
      }
    }
    for (const { name, sql } of tables) {
      const matches = CONSTRAINT_REWRITES.some(([pattern]) => {
        pattern.lastIndex = 0;
        return pattern.test(sql);
      });
      if (!matches) throw new Error(`The ${name} schema has an unexpected shape.`);
    }
    const dependentTriggers = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ sql }) => tables.some(({ name }) => new RegExp(`\\b${name}\\b`, "u").test(sql)));
    for (const { name } of dependentTriggers) database.exec(`DROP TRIGGER ${quoted(name)}`);
    for (const { name } of tables) rebuildTable(database, name);
    for (const { sql } of dependentTriggers) database.exec(sql);
  },
};
