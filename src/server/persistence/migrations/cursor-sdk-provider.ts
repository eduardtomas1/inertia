import type Database from "better-sqlite3";
import type { DatabaseMigrationDefinition } from "./catalog";

function cursorSdkIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function rebuildCursorSdkTable(database: Database.Database, table: string, sql: string): void {
  const header = new RegExp(`^CREATE TABLE (?:"${table}"|${table})\\s*\\(`, "u");
  if (!/^[a-z_]+$/u.test(table) || !header.test(sql)) throw new Error("Unexpected Cursor SDK migration table.");
  const replacement = `${table}_cursor_sdk_109`;
  const next = sql.replace(header, `CREATE TABLE ${cursorSdkIdentifier(replacement)} (`)
    .replace(/(\bharness_id\s+IN\s*\()([^)]*)(\))/giu, (_match, prefix: string, values: string, suffix: string) => {
      if (!values.includes("'cursor-acp'")) throw new Error("Unexpected Cursor SDK harness constraint.");
      return `${prefix}${values.includes("'cursor-sdk'") ? values : `${values}, 'cursor-sdk'`}${suffix}`;
    });
  const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as { sql: string }[];
  const columns = (database.prepare(`PRAGMA table_info(${cursorSdkIdentifier(table)})`).all() as { name: string }[])
    .map(({ name }) => cursorSdkIdentifier(name)).join(", ");
  database.exec(next);
  database.exec(`INSERT INTO ${cursorSdkIdentifier(replacement)} (${columns}) SELECT ${columns} FROM ${cursorSdkIdentifier(table)}`);
  database.exec(`DROP TABLE ${cursorSdkIdentifier(table)}`);
  database.exec(`ALTER TABLE ${cursorSdkIdentifier(replacement)} RENAME TO ${cursorSdkIdentifier(table)}`);
  for (const index of indexes) database.exec(index.sql);
}

export const cursorSdkProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportCursorSdkHarness", foreignKeys: "off",
  up: (database) => {
    const tables = (database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[])
      .filter(({ sql }) => /\bharness_id\s+IN\s*\([^)]*'cursor-acp'/iu.test(sql));
    if (!tables.length) throw new Error("Cursor SDK migration found no harness constraints.");
    const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[];
    for (const { name } of triggers) database.exec(`DROP TRIGGER ${cursorSdkIdentifier(name)}`);
    for (const { name, sql } of tables) rebuildCursorSdkTable(database, name, sql);
    for (const { sql } of triggers) database.exec(sql);
  },
};
