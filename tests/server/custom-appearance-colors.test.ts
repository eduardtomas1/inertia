import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const columns = (database: Database.Database, table: string) =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
const schemaVersion = (database: Database.Database) =>
  (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;

describe("custom appearance colors migration", () => {
  it.each([83, 84])("upgrades a schema-%i database with both colour columns", (version) => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, version);
      expect(columns(database, "app_state")).not.toContain("light_custom_color");
      migrateRuntimeDatabase(database);
      expect(columns(database, "agent_turns")).toContain("session_recovery_json");
      expect(columns(database, "app_state").filter((name) => name === "light_custom_color")).toHaveLength(1);
      expect(columns(database, "app_state").filter((name) => name === "dark_custom_color")).toHaveLength(1);
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it.each([
    ["both colour columns", "ALTER TABLE app_state ADD COLUMN light_custom_color TEXT; ALTER TABLE app_state ADD COLUMN dark_custom_color TEXT;"],
    ["only the light colour column", "ALTER TABLE app_state ADD COLUMN light_custom_color TEXT;"],
    ["only the dark colour column", "ALTER TABLE app_state ADD COLUMN dark_custom_color TEXT;"],
  ])("tolerates %s already existing", (_label, sql) => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 84);
      database.exec(sql);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
      expect(columns(database, "app_state").filter((name) => name === "light_custom_color")).toHaveLength(1);
      expect(columns(database, "app_state").filter((name) => name === "dark_custom_color")).toHaveLength(1);
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });
});
