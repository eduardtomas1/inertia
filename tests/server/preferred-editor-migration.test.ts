import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  PREFERRED_EDITOR_SCHEMA_VERSION,
  preferredEditorMigration,
} from "../../src/server/persistence/migrations/preferred-editor";
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
  const directory = await mkdtemp(join(tmpdir(), "inertia-preferred-editor-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  await copyFile(fixture, databasePath);
  return new Database(databasePath);
}

function state(database: Database.Database): StateRow {
  return database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow;
}

describe("Preferred editor migration", () => {
  it("is registered at the end of the runtime catalog", () => {
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(PREFERRED_EDITOR_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === PREFERRED_EDITOR_SCHEMA_VERSION)).toMatchObject({
      version: PREFERRED_EDITOR_SCHEMA_VERSION,
      name: preferredEditorMigration.name,
    });
  });

  it("adds preferred_editor defaulting to system while preserving earlier settings", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database, PREFERRED_EDITOR_SCHEMA_VERSION - 1);
      const before = state(database);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      const after = state(database);
      expect(after).toEqual({ ...before, preferred_editor: "system" });
      expect(settingsFromState(after).preferredEditor).toBe("system");
      expect(
        database.prepare("SELECT * FROM schema_migrations WHERE version < ? ORDER BY version")
          .all(PREFERRED_EDITOR_SCHEMA_VERSION),
      ).toEqual(history);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("accepts supported editors and reads unknown values as the system default", async () => {
    const database = await publishedDatabase();
    try {
      migrateRuntimeDatabase(database);
      const update = database.prepare("UPDATE app_state SET preferred_editor = ? WHERE id = 1");
      for (const value of ["system", "ask", "vscode", "cursor", "zed", "idea"]) {
        expect(() => update.run(value)).not.toThrow();
        expect(settingsFromState(state(database)).preferredEditor).toBe(value);
      }
      update.run("notepad");
      expect(settingsFromState(state(database)).preferredEditor).toBe("system");
      for (const value of ["", null, "x".repeat(65)]) {
        expect(() => update.run(value)).toThrow(/CHECK constraint failed|NOT NULL constraint failed/u);
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
      if (typeof preferredEditorMigration.up !== "function") throw new Error("Expected a code migration.");
      preferredEditorMigration.up(database, {
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
