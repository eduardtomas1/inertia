// @inertia-test-suite portable

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  EXTEND_COLOR_THEMES_SCHEMA_VERSION,
  extendColorThemesMigration,
} from "../../src/server/persistence/migrations/extend-color-themes";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import { COLOR_THEME_IDS } from "../../src/shared/contracts";

const NEW_THEMES = ["graphite", "blossom", "lagoon", "saffron"] as const;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function schemaWithoutAppState(database: Database.Database): unknown[] {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name <> 'app_state' ORDER BY type, name").all();
}

function appStateSql(database: Database.Database): string {
  return database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_state'").pluck().get() as string;
}

function expectColorThemeChecks(database: Database.Database): void {
  for (const column of ["color_theme", "light_color_theme", "dark_color_theme"]) {
    for (const theme of COLOR_THEME_IDS) {
      database.prepare(`UPDATE app_state SET ${column} = ? WHERE id = 1`).run(theme);
      expect(database.prepare(`SELECT ${column} FROM app_state WHERE id = 1`).pluck().get()).toBe(theme);
    }
    for (const invalid of ["ultraviolet", "Graphite", "", "custom"]) {
      expect(() => database.prepare(`UPDATE app_state SET ${column} = ? WHERE id = 1`).run(invalid), `${column} ${invalid}`)
        .toThrow(/CHECK constraint failed/u);
    }
  }
  expect(() => database.prepare("UPDATE app_state SET color_theme = NULL WHERE id = 1").run()).toThrow(/NOT NULL/u);
  database.prepare("UPDATE app_state SET light_color_theme = NULL, dark_color_theme = NULL WHERE id = 1").run();
}

describe("color theme library migration", () => {
  it("appends the extended theme library as schema 117", () => {
    expect(EXTEND_COLOR_THEMES_SCHEMA_VERSION).toBe(117);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(EXTEND_COLOR_THEMES_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === 117)).toMatchObject({
      name: extendColorThemesMigration.name,
      foreignKeys: "off",
    });
  });

  it("rebuilds app_state with every row, column, default and constraint intact", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, EXTEND_COLOR_THEMES_SCHEMA_VERSION - 1);
      database.prepare(`INSERT INTO app_state (
        id, theme, compact_sidebar, show_timestamps, terminal_font_size, color_theme, light_color_theme, dark_color_theme,
        light_custom_color, dark_custom_color, muted_custom_colors, default_provider, keybindings_json, claude_auto_compact_window
      ) VALUES (1, 'dark', 1, 0, 15, 'ember', 'grove', 'iris', '#0d9488', NULL, 1, 'claude', '{"search":"p"}', NULL)`).run();
      for (const theme of NEW_THEMES) {
        expect(() => database.prepare("UPDATE app_state SET light_color_theme = ?").run(theme)).toThrow(/CHECK constraint failed/u);
      }
      const before = {
        row: database.prepare("SELECT * FROM app_state").get(),
        columns: database.pragma("table_info(app_state)"),
        foreignKeys: database.pragma("foreign_key_list(app_state)"),
        sql: appStateSql(database),
        schema: schemaWithoutAppState(database),
      };

      // Only this migration, so later ones that change other tables leave the comparison alone.
      migrateRuntimeDatabase(database, EXTEND_COLOR_THEMES_SCHEMA_VERSION);

      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(EXTEND_COLOR_THEMES_SCHEMA_VERSION);
      expect(database.prepare("SELECT * FROM app_state").get()).toEqual(before.row);
      expect(database.pragma("table_info(app_state)")).toEqual(before.columns);
      expect(database.pragma("foreign_key_list(app_state)")).toEqual(before.foreignKeys);
      expect(schemaWithoutAppState(database)).toEqual(before.schema);
      const after = appStateSql(database);
      expect(after.replace(/^CREATE TABLE "app_state"/u, "CREATE TABLE app_state").replaceAll(", 'graphite', 'blossom', 'lagoon', 'saffron')", ")"))
        .toBe(before.sql);
      expect(after.split("'saffron')")).toHaveLength(4);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expectColorThemeChecks(database);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects an app_state schema whose color theme constraints are unrecognised", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, EXTEND_COLOR_THEMES_SCHEMA_VERSION - 1);
      database.pragma("foreign_keys = OFF");
      database.exec(`
        CREATE TABLE app_state_drift (id INTEGER PRIMARY KEY, color_theme TEXT NOT NULL DEFAULT 'inertia');
        DROP TABLE app_state;
        ALTER TABLE app_state_drift RENAME TO app_state;
      `);
      database.pragma("foreign_keys = ON");
      expect(() => migrateRuntimeDatabase(database)).toThrow(/Database migration 117 \(ExtendColorThemeLibrary\)/u);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(EXTEND_COLOR_THEMES_SCHEMA_VERSION - 1);
    } finally {
      database.close();
    }
  });

  it("upgrades a released v0.0.6 database and lets the store persist every new family", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-color-theme-library-migration-"));
    directories.push(directory);
    const path = join(directory, "inertia.sqlite");
    await copyFile(resolve("tests/fixtures/database/v0.0.6.sqlite"), path);
    const released = new Database(path);
    const releasedState = released.prepare("SELECT id, theme, compact_sidebar, show_timestamps, terminal_font_size, active_project_id, active_conversation_id FROM app_state").all();
    const releasedProjects = released.prepare("SELECT id, name FROM projects ORDER BY id").all();
    released.close();

    const store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    store.updateSettings({ lightColorTheme: "saffron", darkColorTheme: "blossom" });
    expect(store.shellSnapshot().settings).toMatchObject({ lightColorTheme: "saffron", darkColorTheme: "blossom" });
    store.close();

    const database = new Database(path);
    try {
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(database.prepare("SELECT id, theme, compact_sidebar, show_timestamps, terminal_font_size, active_project_id, active_conversation_id FROM app_state").all())
        .toEqual(releasedState);
      expect(database.prepare("SELECT id, name FROM projects ORDER BY id").all()).toEqual(releasedProjects);
      expect(database.prepare("SELECT light_color_theme, dark_color_theme FROM app_state").get())
        .toEqual({ light_color_theme: "saffron", dark_color_theme: "blossom" });
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expectColorThemeChecks(database);
    } finally {
      database.close();
    }

    const reopened = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    try {
      reopened.updateSettings({ colorTheme: "graphite" });
      expect(reopened.shellSnapshot().settings).toMatchObject({ colorTheme: "graphite", lightColorTheme: "graphite", darkColorTheme: "graphite" });
      reopened.updateSettings({ darkColorTheme: "lagoon" });
      expect(reopened.shellSnapshot().settings).toMatchObject({ lightColorTheme: "graphite", darkColorTheme: "lagoon" });
    } finally {
      reopened.close();
    }
  });
});
