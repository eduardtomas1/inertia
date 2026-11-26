import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

function objects(db: Database.Database) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
}
function rows(db: Database.Database) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}
/** Main's schemas 117 to 119, which every branch rebuild runs after and must keep. */
function expectMainSchemas117To119(database: Database.Database) {
  const sql = (name: string) => (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql;
  for (const column of ["color_theme", "light_color_theme", "dark_color_theme"]) {
    expect(sql("app_state")).toMatch(new RegExp(`\\b${column}\\b[^,]*IN \\('inertia', 'grove', 'ocean', 'ember', 'iris', 'graphite', 'blossom', 'lagoon', 'saffron'\\)`, "u"));
  }
  expect(database.prepare("SELECT type, \"notnull\", dflt_value FROM pragma_table_info('messages') WHERE name = 'sent_to_user'").get())
    .toEqual({ type: "INTEGER", notnull: 1, dflt_value: "0" });
  expect(sql("messages")).toContain("sent_to_user IN (0, 1) AND (sent_to_user = 0 OR role = 'system')");
  expect(sql("agent_thread_operations")).toContain("'inertia_answer_question'");
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_thread_operations' ORDER BY name")
    .all()).toEqual(expect.arrayContaining([{ name: "agent_thread_operations_child_idx" }, { name: "agent_thread_operations_source_turn_idx" }]));
}
describe("Cursor SDK append-only migration", () => {
  it("preserves all historical rows, indexes, triggers and foreign keys", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys=ON"); migrateRuntimeDatabase(db, 124);
      const beforeRows = rows(db); const beforeObjects = objects(db);
      const keys = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
        .map(({ name }) => [name, db.pragma(`foreign_key_list("${name}")`)] as const);
      migrateRuntimeDatabase(db, 125);
      expect(rows(db)).toEqual(beforeRows); expect(objects(db)).toEqual(beforeObjects);
      for (const [name, values] of keys) expect(db.pragma(`foreign_key_list("${name}")`)).toEqual(values);
      expect(db.pragma("foreign_key_check")).toEqual([]); expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const schemas = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql LIKE '%harness_id%IN%cursor-acp%'").all() as { sql: string }[];
      expect(schemas.length).toBeGreaterThan(0);
      for (const { sql } of schemas) {
        expect(sql).toContain("'cursor-sdk'");
        expect(sql).toContain("'grok-acp'");
        expect(sql).toContain("'pi-rpc'");
      }
      expectMainSchemas117To119(db);
      migrateRuntimeDatabase(db);
      expectMainSchemas117To119(db);
    } finally { db.close(); }
  });
});
