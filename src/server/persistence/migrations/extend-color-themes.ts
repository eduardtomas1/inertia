import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

export const EXTEND_COLOR_THEMES_SCHEMA_VERSION = 117;

const COLOR_THEME_TABLE = "app_state";
const REBUILT_COLOR_THEME_TABLE = "app_state_v117";
const COLOR_THEME_COLUMNS = ["color_theme", "light_color_theme", "dark_color_theme"] as const;
const PREVIOUS_COLOR_THEMES = /IN\s*\(\s*'inertia',\s*'grove',\s*'ocean',\s*'ember',\s*'iris'\s*\)/gu;
const EXTENDED_COLOR_THEMES = "IN ('inertia', 'grove', 'ocean', 'ember', 'iris', 'graphite', 'blossom', 'lagoon', 'saffron')";

interface ColorThemeSchemaRow {
  name: string;
  sql: string;
}

function quotedColorThemeIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function colorThemeTableSql(database: Database.Database): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(COLOR_THEME_TABLE) as { sql: string } | undefined;
  if (!row?.sql) throw new Error(`The ${COLOR_THEME_TABLE} table is missing.`);
  return row.sql;
}

function extendedColorThemeSql(sql: string): string {
  const header = new RegExp(`^CREATE TABLE "?${COLOR_THEME_TABLE}"?\\s*\\(`, "u");
  if (!header.test(sql)) throw new Error(`The ${COLOR_THEME_TABLE} schema has an unexpected shape.`);
  const previous = sql.match(PREVIOUS_COLOR_THEMES)?.length ?? 0;
  const extended = sql.split(EXTENDED_COLOR_THEMES).length - 1;
  if (previous === 0 || previous + extended !== COLOR_THEME_COLUMNS.length) {
    throw new Error(`The ${COLOR_THEME_TABLE} color theme constraints were not found.`);
  }
  const next = sql
    .replace(header, `CREATE TABLE ${quotedColorThemeIdentifier(REBUILT_COLOR_THEME_TABLE)} (`)
    .replace(PREVIOUS_COLOR_THEMES, EXTENDED_COLOR_THEMES);
  if (next.split(EXTENDED_COLOR_THEMES).length - 1 !== COLOR_THEME_COLUMNS.length) {
    throw new Error(`The ${COLOR_THEME_TABLE} color theme constraints were not rewritten.`);
  }
  return next;
}

function colorThemeTableShape(database: Database.Database): string {
  return JSON.stringify(database.prepare(`PRAGMA table_info(${quotedColorThemeIdentifier(COLOR_THEME_TABLE)})`).all());
}

function colorThemeTableRows(database: Database.Database): string {
  return JSON.stringify(database.prepare(`SELECT * FROM ${quotedColorThemeIdentifier(COLOR_THEME_TABLE)} ORDER BY rowid`).all());
}

function rebuildColorThemeTable(database: Database.Database): void {
  const createSql = extendedColorThemeSql(colorThemeTableSql(database));
  const indexes = (database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
    .all(COLOR_THEME_TABLE) as { sql: string }[])
    .map(({ sql }) => sql);
  const triggers = (database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
    .all() as ColorThemeSchemaRow[])
    .filter(({ sql }) => new RegExp(`\\b${COLOR_THEME_TABLE}\\b`, "u").test(sql));
  const columns = (database
    .prepare(`PRAGMA table_info(${quotedColorThemeIdentifier(COLOR_THEME_TABLE)})`)
    .all() as { name: string }[])
    .map(({ name }) => quotedColorThemeIdentifier(name));
  const shape = colorThemeTableShape(database);
  const rows = colorThemeTableRows(database);
  for (const { name } of triggers) database.exec(`DROP TRIGGER ${quotedColorThemeIdentifier(name)}`);
  database.exec(createSql);
  database.exec(
    `INSERT INTO ${quotedColorThemeIdentifier(REBUILT_COLOR_THEME_TABLE)} (${columns.join(", ")}) `
    + `SELECT ${columns.join(", ")} FROM ${quotedColorThemeIdentifier(COLOR_THEME_TABLE)}`,
  );
  database.exec(`DROP TABLE ${quotedColorThemeIdentifier(COLOR_THEME_TABLE)}`);
  database.exec(
    `ALTER TABLE ${quotedColorThemeIdentifier(REBUILT_COLOR_THEME_TABLE)} RENAME TO ${quotedColorThemeIdentifier(COLOR_THEME_TABLE)}`,
  );
  for (const sql of indexes) database.exec(sql);
  for (const { sql } of triggers) database.exec(sql);
  if (colorThemeTableShape(database) !== shape || colorThemeTableRows(database) !== rows) {
    throw new Error(`${COLOR_THEME_TABLE} changed while extending its color theme constraints.`);
  }
}

export const extendColorThemesMigration: DatabaseMigrationDefinition = {
  name: "ExtendColorThemeLibrary",
  foreignKeys: "off",
  up: (database) => {
    const sql = colorThemeTableSql(database);
    if (!sql.match(PREVIOUS_COLOR_THEMES)) {
      if (sql.includes(EXTENDED_COLOR_THEMES)) return;
      throw new Error(`The ${COLOR_THEME_TABLE} color theme constraints were not found.`);
    }
    rebuildColorThemeTable(database);
  },
};
