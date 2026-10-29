// @inertia-test-suite portable
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function schemaObjects(database: Database.Database) {
  return database.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
}

function tableData(database: Database.Database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

describe("native Pi provider append-only upgrade", () => {
  it("upgrades populated released data without changing rows, indexes, triggers or foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-pi-migration-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    await copyFile(resolve("tests/fixtures/database/v0.0.6.sqlite"), path);
    const database = new Database(path);
    try {
      database.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(database, 107);
      database.prepare("INSERT OR REPLACE INTO provider_metadata_cache (provider_id, executable, version, auth_state) VALUES ('codex', 'codex-test', '1', 'authenticated')").run();
      expect(() => database.prepare("INSERT INTO provider_metadata_cache (provider_id) VALUES ('pi')").run()).toThrow();
      const rows = tableData(database);
      const objects = schemaObjects(database);
      const foreignKeys = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => { const { name } = row as { name: string }; return [name, database.pragma(`foreign_key_list("${name.replaceAll('"', '""')}")`)]; });
      migrateRuntimeDatabase(database, 108);
      expect(tableData(database)).toEqual(rows);
      expect(schemaObjects(database)).toEqual(objects);
      for (const [name, keys] of foreignKeys) expect(database.pragma(`foreign_key_list("${String(name).replaceAll('"', '""')}")`)).toEqual(keys);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      database.prepare("INSERT INTO provider_metadata_cache (provider_id) VALUES ('pi')").run();
    } finally { database.close(); }
    const store = new RuntimeStore(path, directory);
    try {
      const project = store.createProject("Pi upgrade", directory);
      const selection = providerNativeModelSelection({ providerId: "pi", modelId: "anthropic/claude-test" });
      const conversation = store.createConversation(project.id, "Pi", { providerId: "pi", modelSelection: selection });
      const accepted = store.beginOrchestratedAgentTurn({ conversationId: conversation.id,
        runId: "pi-upgrade-run", content: "Test Pi admission", providerId: "pi", modelSelection: selection,
        reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", configurationRevision: 0,
        association: "authoritative" });
      expect(accepted.turn.providerId).toBe("pi");
      expect(accepted.turn.harnessId).toBe("pi-rpc");
      expect(store.orchestration.startIntent(accepted.turn.runId)?.state).toBe("pending");
    } finally { store.close(); }
  });

  it("rolls back rebuilt tables and schema history if a later constraint cannot be widened", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 107);
      database.exec("ALTER TABLE subagent_traces RENAME TO unexpected_subagents");
      const objects = schemaObjects(database);
      expect(() => migrateRuntimeDatabase(database, 108)).toThrow();
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 107 });
      expect(schemaObjects(database)).toEqual(objects);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v108'").all()).toEqual([]);
      expect(() => database.prepare("INSERT INTO provider_metadata_cache (provider_id) VALUES ('pi')").run()).toThrow();
    } finally { database.close(); }
  });
});
