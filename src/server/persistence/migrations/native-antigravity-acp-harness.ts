import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

export const NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION = 123;

const REQUIRED_TABLES = [
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
] as const;

const CONSTRAINT_REWRITE: readonly [RegExp, string] = [
  /'antigravity-cli',\s*'grok-acp',(?!\s*'antigravity-acp')/gu,
  "'antigravity-cli', 'grok-acp', 'antigravity-acp',",
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
  let next = sql.replace(header, `CREATE TABLE ${quoted(`${table}_v123`)} (`);
  const [pattern, replacement] = CONSTRAINT_REWRITE;
  pattern.lastIndex = 0;
  if (!pattern.test(next)) {
    throw new Error(`The ${table} Antigravity harness constraint was not found.`);
  }
  pattern.lastIndex = 0;
  next = next.replace(pattern, replacement);
  if (!next.includes("'antigravity-cli'") || !next.includes("'antigravity-acp'")) {
    throw new Error(`The ${table} Antigravity harness constraint was not widened.`);
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
    `INSERT INTO ${quoted(`${table}_v123`)} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${quoted(table)}`,
  );
  database.exec(`DROP TABLE ${quoted(table)}`);
  database.exec(`ALTER TABLE ${quoted(`${table}_v123`)} RENAME TO ${quoted(table)}`);
  for (const sql of indexes) database.exec(sql);
  if (countRows() !== before) {
    throw new Error(`${table} changed while adding Antigravity ACP harness constraints.`);
  }
}

function rewriteHarnessIdJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.harnessId !== "antigravity-cli") return null;
  return JSON.stringify({ ...record, harnessId: "antigravity-acp" });
}

export const nativeAntigravityAcpHarnessMigration: DatabaseMigrationDefinition = {
  name: "SupportNativeAntigravityAcpHarness",
  foreignKeys: "off",
  up: (database) => {
    const tables = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ name, sql }) => !name.startsWith("sqlite_") && sql.includes("'antigravity-cli'"));
    const names = new Set(tables.map(({ name }) => name));
    for (const table of REQUIRED_TABLES) {
      if (!names.has(table)) {
        throw new Error(`The ${table} Antigravity harness constraint was not found.`);
      }
    }
    const [pattern] = CONSTRAINT_REWRITE;
    const pending = tables.filter(({ name, sql }) => {
      pattern.lastIndex = 0;
      const matches = pattern.test(sql);
      if (!matches && !sql.includes("'antigravity-acp'")) {
        throw new Error(`The ${name} schema has an unexpected shape.`);
      }
      return matches;
    });
    const dependentTriggers = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ sql }) => pending.some(({ name }) => new RegExp(`\\b${name}\\b`, "u").test(sql)));
    for (const { name } of dependentTriggers) database.exec(`DROP TRIGGER ${quoted(name)}`);
    for (const { name } of pending) rebuildTable(database, name);
    for (const { sql } of dependentTriggers) database.exec(sql);

    const builtinProfiles = database.prepare(`
      SELECT profile_id, configuration_json
      FROM model_backend_profiles
      WHERE profile_id = 'builtin:antigravity' AND harness_id = 'antigravity-cli'
    `).all() as { profile_id: string; configuration_json: string }[];
    const updateBuiltinProfile = database.prepare(`
      UPDATE model_backend_profiles
      SET harness_id = 'antigravity-acp', configuration_json = ?
      WHERE profile_id = ? AND harness_id = 'antigravity-cli'
    `);
    for (const row of builtinProfiles) {
      const updatedConfiguration = rewriteHarnessIdJson(row.configuration_json) ?? row.configuration_json;
      updateBuiltinProfile.run(updatedConfiguration, row.profile_id);
    }

    const conversations = database.prepare(`
      SELECT id, model_selection_json
      FROM conversations
      WHERE model_selection_json IS NOT NULL
        AND instr(model_selection_json, 'antigravity-cli') > 0
    `).all() as { id: string; model_selection_json: string }[];
    const updateConversation = database.prepare(`
      UPDATE conversations
      SET model_selection_json = ?
      WHERE id = ?
    `);
    for (const row of conversations) {
      const updated = rewriteHarnessIdJson(row.model_selection_json);
      if (updated !== null) updateConversation.run(updated, row.id);
    }

    const defaults = database.prepare(`
      SELECT rowid, selection_json
      FROM model_backend_defaults
      WHERE instr(selection_json, 'antigravity-cli') > 0
    `).all() as { rowid: number; selection_json: string }[];
    const updateDefault = database.prepare(`
      UPDATE model_backend_defaults
      SET selection_json = ?
      WHERE rowid = ?
    `);
    for (const row of defaults) {
      const updated = rewriteHarnessIdJson(row.selection_json);
      if (updated !== null) updateDefault.run(updated, row.rowid);
    }
  },
};
