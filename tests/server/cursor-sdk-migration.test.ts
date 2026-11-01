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
describe("Cursor SDK append-only migration", () => {
  it("preserves all historical rows, indexes, triggers and foreign keys", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys=ON"); migrateRuntimeDatabase(db, 108);
      const beforeRows = rows(db); const beforeObjects = objects(db);
      const keys = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
        .map(({ name }) => [name, db.pragma(`foreign_key_list("${name}")`)] as const);
      migrateRuntimeDatabase(db, 109);
      expect(rows(db)).toEqual(beforeRows); expect(objects(db)).toEqual(beforeObjects);
      for (const [name, values] of keys) expect(db.pragma(`foreign_key_list("${name}")`)).toEqual(values);
      expect(db.pragma("foreign_key_check")).toEqual([]); expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const schemas = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql LIKE '%harness_id%IN%cursor-acp%'").all() as { sql: string }[];
      expect(schemas.length).toBeGreaterThan(0);
      for (const { sql } of schemas) expect(sql).toContain("'cursor-sdk'");
    } finally { db.close(); }
  });
});
