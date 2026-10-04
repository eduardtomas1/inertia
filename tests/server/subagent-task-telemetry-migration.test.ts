import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";
import { subagentTaskTelemetryMigration } from "../../src/server/persistence/migrations/subagent-task-telemetry";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const TELEMETRY_COLUMNS = ["model", "activity", "usage_json", "tool_use_count", "duration_ms"] as const;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-subagent-telemetry-migration-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  return { workspacePath, databasePath: join(directory, "inertia.sqlite") };
}

const tableInfo = (database: Database.Database) =>
  database.prepare("PRAGMA table_info(subagent_traces)").all() as Array<{ name: string }>;
const columnNames = (database: Database.Database) => tableInfo(database).map(({ name }) => name);
const runIndex = (database: Database.Database) => database.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workspace_runs_conversation_started_idx'",
).all();
const schemaVersion = (database: Database.Database) =>
  (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;

function runMigrationAgain(database: Database.Database): void {
  if (typeof subagentTaskTelemetryMigration.up !== "function") throw new Error("Expected a guarded migration.");
  subagentTaskTelemetryMigration.up(database, {
    sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    sourceReleases: [],
    setLegacyBackfillDiagnostics: () => undefined,
  });
}

describe("subagent task telemetry migration", () => {
  it("is schema version 90", () => {
    expect(runtimeMigrationCatalog().find(({ name }) => name === subagentTaskTelemetryMigration.name)?.version).toBe(90);
    expect(subagentTaskTelemetryMigration.name).toBe("PersistSubagentTaskTelemetry");
  });

  it("upgrades a schema-89 database and keeps existing delegated traces readable", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    const project = store.createProject("Upgrade", workspacePath);
    const conversation = store.createConversation(project.id, "Delegated", {
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
    });
    const { turn } = store.beginAgentTurn({
      conversationId: conversation.id,
      runId: "run-upgrade",
      content: "Delegate before the upgrade.",
      providerId: "codex",
      modelSelection: conversation.modelSelection,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: conversation.modelSelection.backendConfigurationRevision,
      association: "authoritative",
    });
    const original = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId: "codex",
      providerTaskId: "task-upgrade",
      providerAgentId: "agent-upgrade",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "tool-upgrade",
      providerRole: "reviewer",
      providerName: "Upgrade reviewer",
      providerStatus: "running",
      status: "running",
      isLive: true,
      description: "Keep this trace.",
      progress: "Working",
      result: null,
      sequence: 1,
    })!.trace;
    store.close();

    const reference = new Database(":memory:");
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(reference, 89);
      for (const column of TELEMETRY_COLUMNS) {
        database.exec(`ALTER TABLE subagent_traces DROP COLUMN ${column}`);
      }
      database.exec("DROP INDEX workspace_runs_conversation_started_idx");
      database.prepare("DELETE FROM schema_migrations WHERE version >= 90").run();
      expect(tableInfo(database)).toEqual(tableInfo(reference));
      expect(schemaVersion(database)).toBe(89);
    } finally {
      reference.close();
      database.close();
    }

    const upgraded = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(upgraded.snapshot().subagents).toEqual([{
        ...original,
        model: null,
        activity: null,
        usage: null,
        toolUseCount: null,
        durationMs: null,
      }]);
      const updated = upgraded.upsertSubagentTrace({
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        providerId: "codex",
        providerTaskId: "task-upgrade",
        providerAgentId: "agent-upgrade",
        parentProviderAgentId: null,
        parentProviderToolUseId: null,
        providerToolUseId: null,
        providerRole: null,
        providerName: null,
        status: "running",
        isLive: true,
        description: null,
        progress: null,
        result: null,
        toolUseCount: 7,
        sequence: 2,
      });
      expect(updated?.trace).toMatchObject({ id: original.id, description: "Keep this trace.", toolUseCount: 7 });
    } finally {
      upgraded.close();
    }
    const migrated = new Database(databasePath);
    try {
      expect(schemaVersion(migrated)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(runIndex(migrated)).toEqual([{ name: "workspace_runs_conversation_started_idx" }]);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      migrated.close();
    }
  });

  it("upgrades the oldest released fixture to the telemetry columns", async () => {
    const { databasePath } = await workspace();
    await copyFile(join(process.cwd(), "tests/fixtures/database/v0.0.1.sqlite"), databasePath);
    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(database);
      for (const column of TELEMETRY_COLUMNS) {
        expect(columnNames(database).filter((name) => name === column)).toHaveLength(1);
      }
      expect(runIndex(database)).toHaveLength(1);
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });

  it.each([
    ["every telemetry column", TELEMETRY_COLUMNS],
    ["only the model column", ["model"]],
    ["only the usage column", ["usage_json"]],
  ] as const)("tolerates %s already existing", (_label, existing) => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 89);
      for (const column of existing) {
        database.exec(`ALTER TABLE subagent_traces ADD COLUMN ${column} ${column.endsWith("_count") || column.endsWith("_ms") ? "INTEGER" : "TEXT"}`);
      }
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
      expect(() => runMigrationAgain(database)).not.toThrow();
      for (const column of TELEMETRY_COLUMNS) {
        expect(columnNames(database).filter((name) => name === column)).toHaveLength(1);
      }
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });
});
