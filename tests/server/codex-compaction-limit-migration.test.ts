// @inertia-test-suite portable

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  CODEX_COMPACTION_LIMIT_SCHEMA_VERSION,
  codexCompactionLimitMigration,
} from "../../src/server/persistence/migrations/codex-compaction-limit";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import { settingsFromState } from "../../src/server/persistence/codecs";
import type { StateRow } from "../../src/server/persistence/rows";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function publishedDatabase(): Promise<Database.Database> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-codex-compaction-limit-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  await copyFile(fixture, databasePath);
  return new Database(databasePath);
}

function state(database: Database.Database): StateRow {
  return database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow;
}

describe("Codex compaction limit migration", () => {
  it("is registered after the context compaction settings migration", () => {
    expect(CODEX_COMPACTION_LIMIT_SCHEMA_VERSION).toBe(114);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(CODEX_COMPACTION_LIMIT_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === CODEX_COMPACTION_LIMIT_SCHEMA_VERSION)).toMatchObject({
      version: CODEX_COMPACTION_LIMIT_SCHEMA_VERSION,
      name: codexCompactionLimitMigration.name,
    });
  });

  it("adds a 300K Codex limit while keeping every earlier setting and the migration history", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database, CODEX_COMPACTION_LIMIT_SCHEMA_VERSION - 1);
      database.prepare("UPDATE app_state SET claude_auto_compact_window = NULL, compact_before_cache_expires = 1 WHERE id = 1").run();
      const before = state(database);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      const after = state(database);
      expect(after).toEqual({ ...before, codex_auto_compact_token_limit: 300_000 });
      expect(settingsFromState(after)).toMatchObject({
        claudeAutoCompactWindow: null,
        compactBeforeCacheExpires: true,
        codexAutoCompactTokenLimit: 300_000,
      });
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version < ? ORDER BY version").all(CODEX_COMPACTION_LIMIT_SCHEMA_VERSION))
        .toEqual(history);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("accepts Codex's own default and rejects values outside the supported range", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database);
      const update = database.prepare("UPDATE app_state SET codex_auto_compact_token_limit = ? WHERE id = 1");
      expect(() => update.run(null)).not.toThrow();
      expect(settingsFromState(state(database)).codexAutoCompactTokenLimit).toBeNull();
      for (const value of [100_000, 1_000_000]) expect(() => update.run(value)).not.toThrow();
      for (const value of [99_999, 1_000_001, 250_000.5, "three hundred thousand"]) {
        expect(() => update.run(value)).toThrow(/CHECK constraint failed/u);
      }
    } finally {
      database.close();
    }
  });

  it("does nothing when run again on a migrated database", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database);
      const schemaVersion = database.pragma("schema_version", { simple: true });
      if (typeof codexCompactionLimitMigration.up !== "function") throw new Error("Expected a code migration.");
      codexCompactionLimitMigration.up(database, {
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
