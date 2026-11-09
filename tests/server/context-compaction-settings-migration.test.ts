// @inertia-test-suite portable

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  CONTEXT_COMPACTION_SETTINGS_SCHEMA_VERSION,
  contextCompactionSettingsMigration,
} from "../../src/server/persistence/migrations/context-compaction-settings";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import { settingsFromState } from "../../src/server/persistence/codecs";
import type { StateRow } from "../../src/server/persistence/rows";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const PREVIOUS_SCHEMA_VERSION = CONTEXT_COMPACTION_SETTINGS_SCHEMA_VERSION - 1;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function publishedDatabase(): Promise<Database.Database> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-compaction-settings-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  await copyFile(fixture, databasePath);
  return new Database(databasePath);
}

function state(database: Database.Database): StateRow {
  return database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow;
}

describe("context compaction settings migration", () => {
  it("is the newest registered migration", () => {
    expect(CONTEXT_COMPACTION_SETTINGS_SCHEMA_VERSION).toBe(113);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(113);
    expect(runtimeMigrationCatalog().at(-1)).toMatchObject({
      version: CONTEXT_COMPACTION_SETTINGS_SCHEMA_VERSION,
      name: contextCompactionSettingsMigration.name,
    });
  });

  it("adds idle compaction off and a 400K Claude compaction window while keeping every earlier setting", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
      database.prepare("UPDATE app_state SET compact_on_return = 'never', show_timestamps = 1 WHERE id = 1").run();
      const before = state(database);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      const after = state(database);
      expect(after).toEqual({ ...before, compact_before_cache_expires: 0, claude_auto_compact_window: 400_000 });
      expect(settingsFromState(after)).toMatchObject({
        compactOnReturn: "never",
        compactBeforeCacheExpires: false,
        claudeAutoCompactWindow: 400_000,
      });
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version").all(PREVIOUS_SCHEMA_VERSION))
        .toEqual(history);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("accepts Claude Code's own default and rejects values outside Claude Code's range", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database);
      const update = database.prepare("UPDATE app_state SET claude_auto_compact_window = ? WHERE id = 1");
      expect(() => update.run(null)).not.toThrow();
      expect(settingsFromState(state(database)).claudeAutoCompactWindow).toBeNull();
      for (const value of [100_000, 1_000_000]) expect(() => update.run(value)).not.toThrow();
      for (const value of [99_999, 1_000_001, 250_000.5, "four hundred thousand"]) {
        expect(() => update.run(value)).toThrow(/CHECK constraint failed/u);
      }
      const toggle = database.prepare("UPDATE app_state SET compact_before_cache_expires = ? WHERE id = 1");
      expect(() => toggle.run(1)).not.toThrow();
      expect(settingsFromState(state(database)).compactBeforeCacheExpires).toBe(true);
      expect(() => toggle.run(2)).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });

  it("does nothing when run again on a migrated database", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database);
      const schemaVersion = database.pragma("schema_version", { simple: true });
      if (typeof contextCompactionSettingsMigration.up !== "function") throw new Error("Expected a code migration.");
      contextCompactionSettingsMigration.up(database, {
        sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        sourceReleases: [],
        setLegacyBackfillDiagnostics: () => undefined,
      });
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }
  });
});
