import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("RuntimeStore prompt preset snapshots", () => {
  it("publishes mutations through full and shell snapshots after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-preset-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_presets'",
      ).get()).toEqual({ name: "prompt_presets" });
      expect((database.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version).toBe(
        CURRENT_DATABASE_SCHEMA_VERSION,
      );
    } finally {
      database.close();
    }

    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    const created = store.promptPresets.create({
      name: "Review lifecycle",
      body: "Review this change for lifecycle races.",
      route: null,
    });
    expect(store.snapshot().promptPresets).toEqual([created]);

    const updated = store.promptPresets.update(created.id, created.revision, {
      name: "Review lifecycle carefully",
    });
    expect(store.shellSnapshot().promptPresets).toEqual([updated]);
    store.close();

    const reopened = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.snapshot().promptPresets).toEqual([updated]);
    expect(reopened.shellSnapshot().promptPresets).toEqual([updated]);
    reopened.close();
  });
});
