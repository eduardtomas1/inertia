// @inertia-test-suite portable

import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  NATIVE_GROK_PROVIDER_SCHEMA_VERSION,
  nativeGrokProviderMigration,
} from "../../src/server/persistence/migrations/native-grok-provider";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const PREVIOUS_SCHEMA_VERSION = 111;
const REQUIRED_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
  "agent_turns",
  "subagent_traces",
] as const;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function tableSql(database: Database.Database, table: string): string {
  return (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function runMigrationAgain(database: Database.Database): void {
  if (typeof nativeGrokProviderMigration.up !== "function") throw new Error("Expected a code migration.");
  nativeGrokProviderMigration.up(database, {
    sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    sourceReleases: [],
    setLegacyBackfillDiagnostics: () => undefined,
  });
}

function rows(database: Database.Database, table: string): unknown[] {
  return database.prepare(`SELECT * FROM "${table.replaceAll("\"", "\"\"")}"`).all();
}

describe("native Grok provider migration", () => {
  it("is registered after the released subagent task shape migration", () => {
    expect(NATIVE_GROK_PROVIDER_SCHEMA_VERSION).toBe(112);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(112);
    expect(runtimeMigrationCatalog().at(-1)).toMatchObject({
      version: NATIVE_GROK_PROVIDER_SCHEMA_VERSION,
      name: nativeGrokProviderMigration.name,
      foreignKeys: "off",
    });
  });

  it("widens provider checks without rewriting earlier rows or released migration files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-grok-migration-"));
    directories.push(directory);
    const databasePath = join(directory, "published.sqlite");
    await copyFile(fixture, databasePath);
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const before = Object.fromEntries(REQUIRED_TABLES.map((table) => [table, rows(database, table)]));
      for (const table of REQUIRED_TABLES) {
        const sql = tableSql(database, table);
        expect(sql).toContain("antigravity");
        expect(sql).not.toContain("'grok'");
      }
      expect(() => database.prepare("INSERT INTO provider_metadata_cache (provider_id) VALUES ('grok')").run())
        .toThrow(/CHECK constraint failed/u);

      migrateRuntimeDatabase(database);

      for (const table of REQUIRED_TABLES) {
        expect(rows(database, table)).toEqual(before[table]);
        expect(tableSql(database, table)).toContain("'grok");
      }
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version").all(PREVIOUS_SCHEMA_VERSION))
        .toEqual(history);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get())
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(() => database.prepare("INSERT INTO provider_metadata_cache (provider_id) VALUES ('grok')").run())
        .not.toThrow();
      expect(database.prepare("SELECT provider_id FROM provider_metadata_cache WHERE provider_id = 'grok'").pluck().get())
        .toBe("grok");
      const imports = tableSql(database, "cli_conversation_imports");
      expect(imports).not.toContain("'grok'");
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      const schemaVersion = database.pragma("schema_version", { simple: true });
      migrateRuntimeDatabase(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
      runMigrationAgain(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }

    const released = await Promise.all([
      readFile(resolve("src/server/persistence/migrations/native-kimi-provider.ts"), "utf8"),
      readFile(resolve("src/server/persistence/migrations/native-antigravity-provider.ts"), "utf8"),
    ]);
    for (const source of released) expect(source).not.toContain("grok");
  });
});
