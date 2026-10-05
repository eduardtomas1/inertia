import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  DatabaseBackupManager,
  databaseRecoveryPaths,
} from "../../src/server/persistence/database-recovery";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const notificationColumns = ["quota_warnings_enabled", "quota_warning_threshold", "notify_only_in_background"];
const telemetryColumns = ["model", "activity", "usage_json", "tool_use_count", "duration_ms"];

function labelSchema(database: Database.Database, version: number): void {
  if (version < 92) database.exec("DROP TABLE cli_conversation_imports; DROP INDEX agent_turns_provider_session_before_idx; DROP INDEX agent_turns_provider_session_after_idx; ALTER TABLE agent_turns DROP COLUMN origin");
  if (version < 91) database.exec("ALTER TABLE app_state DROP COLUMN muted_custom_colors");
  if (version < 90) {
    for (const column of telemetryColumns) database.exec(`ALTER TABLE subagent_traces DROP COLUMN ${column}`);
    database.exec("DROP INDEX workspace_runs_conversation_started_idx");
  }
  if (version < 88) {
    for (const column of notificationColumns) database.exec(`ALTER TABLE app_state DROP COLUMN ${column}`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE version > ?").run(version);
}

async function backups(version: number, mutate: (database: Database.Database) => void) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-recovery-columns-"));
  directories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  const project = store.createProject("Recovery", directory);
  const conversation = store.createConversation(project.id, "Recovery test");
  store.createMessage(conversation.id, "coherent schema", "user");
  const older = await store.createBackup();
  store.createMessage(conversation.id, "malformed schema", "assistant");
  const newer = await store.createBackup();
  store.close();
  const backupsDirectory = databaseRecoveryPaths(databasePath).backupsDirectory;
  for (const backup of [older, newer]) {
    const database = new Database(join(backupsDirectory, backup.filename));
    labelSchema(database, version);
    if (backup === newer) mutate(database);
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    database.close();
  }
  writeFileSync(databasePath, "invalid primary");
  const recovered = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  const report = recovered.databaseRecoveryReport();
  const messages = recovered.conversationDetail(conversation.id)?.messages.map(({ content }) => content);
  recovered.close();
  return { databasePath, older, newer, report, messages };
}

describe("database health check for settings and subagent columns", () => {
  it.each([
    ...notificationColumns.map((column) => ({ version: 88, sql: `ALTER TABLE app_state DROP COLUMN ${column}` })),
    ...notificationColumns.map((column) => ({ version: 89, sql: `ALTER TABLE app_state DROP COLUMN ${column}` })),
    ...notificationColumns.map((column) => ({ version: 90, sql: `ALTER TABLE app_state DROP COLUMN ${column}` })),
    ...telemetryColumns.map((column) => ({ version: 90, sql: `ALTER TABLE subagent_traces DROP COLUMN ${column}` })),
    { version: 90, sql: "DROP INDEX workspace_runs_conversation_started_idx" },
    { version: 91, sql: "ALTER TABLE app_state DROP COLUMN muted_custom_colors" },
    { version: 92, sql: "DROP TABLE cli_conversation_imports" },
    { version: 92, sql: "ALTER TABLE agent_turns DROP COLUMN origin" },
    { version: 92, sql: "DROP INDEX agent_turns_provider_session_after_idx" },
  ])("skips a schema $version backup after $sql", async ({ version, sql }) => {
    const { older, report, messages } = await backups(version, (database) => database.exec(sql));
    expect(report).toMatchObject({ outcome: "restored", restoredBackup: older.filename, invalidBackupsSkipped: 1 });
    expect(messages).toEqual(["coherent schema"]);
  });

  it.each([87, 88, 89, 90, 91, 92])("restores a complete schema %i backup and upgrades it", async (version) => {
    const { databasePath, newer, report, messages } = await backups(version, () => undefined);
    expect(report).toMatchObject({ outcome: "restored", restoredBackup: newer.filename, invalidBackupsSkipped: 0 });
    expect(messages).toEqual(["coherent schema", "malformed schema"]);
    const upgraded = new Database(databasePath, { readonly: true });
    expect((upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    upgraded.close();
  });

  it("rejects a backup missing a settings column during off-thread validation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-recovery-columns-"));
    directories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }).close();
    const primary = new Database(databasePath);
    primary.exec("ALTER TABLE app_state DROP COLUMN notify_only_in_background");
    const manager = new DatabaseBackupManager(primary, databasePath);
    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    primary.close();
  });
});
