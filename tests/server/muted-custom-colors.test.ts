import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { defaultSettings } from "../../src/shared/contracts/app";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { restoredDefaultSettings } from "../../src/shared/restore-defaults";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-muted-custom-colors-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

const columns = (database: Database.Database) =>
  (database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>).map(({ name }) => name);

describe("muted custom colours", () => {
  it("defaults to the vivid treatment", () => {
    expect(defaultSettings.mutedCustomColors).toBe(false);
  });

  it("persists across restart", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    expect(store.snapshot().settings.mutedCustomColors).toBe(false);
    store.updateSettings({ lightCustomColor: "#0d9488", mutedCustomColors: true });
    store.close();
    const reopened = new RuntimeStore(databasePath, workspacePath);
    try {
      expect(reopened.snapshot().settings.mutedCustomColors).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("returns to vivid when both appearances go back to a preset or restore defaults", async () => {
    const { store } = await openStore();
    try {
      store.updateSettings({ lightCustomColor: "#0d9488", darkCustomColor: "#f97316", mutedCustomColors: true });
      store.updateSettings({ lightCustomColor: null });
      expect(store.snapshot().settings.mutedCustomColors).toBe(true);
      store.updateSettings({ darkColorTheme: "ember" });
      expect(store.snapshot().settings).toMatchObject({ lightCustomColor: null, darkCustomColor: null, mutedCustomColors: false });
      store.updateSettings({ darkCustomColor: "#f97316", mutedCustomColors: true });
      store.updateSettings(restoredDefaultSettings(store.snapshot().settings));
      expect(store.snapshot().settings).toMatchObject({ darkCustomColor: null, mutedCustomColors: false });
      store.updateSettings({ mutedCustomColors: true });
      expect(store.snapshot().settings.mutedCustomColors).toBe(false);
    } finally {
      store.close();
    }
  });

  it("validates the switch at the command and event boundaries", () => {
    const command = (mutedCustomColors: unknown) => clientCommandSchema.safeParse({
      type: "settings.update", requestId: crypto.randomUUID(), payload: { mutedCustomColors },
    }).success;
    expect(command(true)).toBe(true);
    expect(command("yes")).toBe(false);
    expect(command(null)).toBe(false);
    const snapshotEvent = (mutedCustomColors: unknown): unknown => ({
      type: "snapshot.updated",
      snapshot: {
        projects: [], conversations: [], runs: [], providers: [],
        settings: { ...defaultSettings, mutedCustomColors },
        activeProjectId: null, activeConversationId: null,
      },
    });
    const decoded = parseServerEvent(snapshotEvent(true));
    expect(decoded.type === "snapshot.updated" && decoded.snapshot.settings.mutedCustomColors).toBe(true);
    expect(() => parseServerEvent(snapshotEvent(1))).toThrow("Malformed server event");
  });

  it("adds one boolean column to schema-90 databases and tolerates it already existing", () => {
    for (const existing of [false, true]) {
      const database = new Database(":memory:");
      try {
        migrateRuntimeDatabase(database, 90);
        if (existing) database.exec("ALTER TABLE app_state ADD COLUMN muted_custom_colors INTEGER NOT NULL DEFAULT 0");
        migrateRuntimeDatabase(database);
        expect(columns(database).filter((name) => name === "muted_custom_colors")).toHaveLength(1);
        expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
          .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
        if (!existing) {
          expect((database.prepare("SELECT sql FROM sqlite_master WHERE name = 'app_state'").get() as { sql: string }).sql)
            .toContain("muted_custom_colors INTEGER NOT NULL DEFAULT 0");
          expect((database.prepare("SELECT sql FROM sqlite_master WHERE name = 'app_state'").get() as { sql: string }).sql)
            .toContain("CHECK (muted_custom_colors IN (0, 1))");
        }
      } finally {
        database.close();
      }
    }
  });
});
