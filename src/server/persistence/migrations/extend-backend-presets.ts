import type { DatabaseMigrationDefinition } from "./catalog";

export const extendBackendPresetsMigration: DatabaseMigrationDefinition = {
  name: "ExtendBackendPresets",
  foreignKeys: "off",
  up: (database) => {
    const table = "model_backend_profiles";
    const rebuilt = "model_backend_profiles_extended_presets";
    const quoted = (identifier: string): string => `"${identifier.replaceAll("\"", "\"\"")}"`;
    const current = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    if (!current) throw new Error("The model_backend_profiles table is missing.");
    if (current.sql.includes("'anthropic-api-key'") && current.sql.includes("'openai-api-key'")) return;
    const header = /^CREATE TABLE "?model_backend_profiles"?\s*\(/u;
    const presetConstraint = /preset\s+IN\s*\(\s*'native'\s*,\s*'kimi-code'\s*,\s*'custom'\s*\)/u;
    if (!header.test(current.sql) || !presetConstraint.test(current.sql)) {
      throw new Error("The model_backend_profiles schema has an unexpected shape.");
    }
    const createSql = current.sql
      .replace(header, `CREATE TABLE ${quoted(rebuilt)} (`)
      .replace(
        presetConstraint,
        "preset IN ('native', 'kimi-code', 'custom', 'anthropic-api-key', 'openai-api-key')",
      );
    const indexes = (database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
      .all(table) as { sql: string }[])
      .map(({ sql }) => sql);
    const triggers = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[])
      .filter(({ sql }) => /\bmodel_backend_profiles\b/u.test(sql));
    const columns = (database
      .prepare(`PRAGMA table_info(${quoted(table)})`)
      .all() as { name: string }[])
      .map(({ name }) => quoted(name))
      .join(", ");
    const countRows = (name: string): number => database
      .prepare(`SELECT COUNT(*) FROM ${quoted(name)}`)
      .pluck()
      .get() as number;
    const before = countRows(table);
    for (const { name } of triggers) database.exec(`DROP TRIGGER ${quoted(name)}`);
    database.exec(createSql);
    database.exec(`INSERT INTO ${quoted(rebuilt)} (${columns}) SELECT ${columns} FROM ${quoted(table)}`);
    database.exec(`DROP TABLE ${quoted(table)}`);
    database.exec(`ALTER TABLE ${quoted(rebuilt)} RENAME TO ${quoted(table)}`);
    for (const sql of indexes) database.exec(sql);
    for (const { sql } of triggers) database.exec(sql);
    if (countRows(table) !== before) {
      throw new Error("Model backend profiles changed while extending their presets.");
    }
  },
};
