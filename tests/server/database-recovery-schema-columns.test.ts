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
const watcherTriggers = [
  "watcher_links_active_limit",
  "watcher_links_detached_final",
  "watcher_links_watched_delete",
];
const contextPacketTriggers = [
  "conversation_context_packets_immutable",
  "conversation_context_packets_consume_once",
  "conversation_context_packets_discard_source_drafts",
  "conversation_context_packets_draft_limit",
];

function labelSchema(database: Database.Database, version: number): void {
  if (version < 99) {
    database.exec(`
      DROP TRIGGER watcher_links_watched_delete;
      DROP TABLE watcher_wakes;
      DROP TABLE watcher_links;
      ALTER TABLE messages DROP COLUMN watcher_note_json;
      ALTER TABLE queued_messages DROP COLUMN watcher_note_json;
    `);
  }
  if (version < 98) database.exec("DROP TABLE conversation_title_locks");
  if (version < 97) database.exec("DROP TABLE restart_continuation_plans");
  if (version < 96) database.exec("DROP TABLE todos");
  if (version < 94) database.exec("DROP TABLE agent_context_reads");
  if (version < 93) database.exec("DROP TABLE html_renders; ALTER TABLE messages DROP COLUMN html_render_json");
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
    { version: 92, sql: "DROP INDEX agent_turns_provider_session_before_idx" },
    { version: 92, sql: "DROP INDEX agent_turns_provider_session_after_idx" },
    { version: 93, sql: "DROP TABLE html_renders" },
    { version: 93, sql: "ALTER TABLE messages DROP COLUMN html_render_json" },
    { version: 93, sql: "DROP INDEX html_renders_conversation_idx" },
    { version: 93, sql: "DROP INDEX html_renders_turn_idx" },
    { version: 94, sql: "DROP TABLE agent_context_reads" },
    { version: 94, sql: "DROP INDEX agent_context_reads_identity_idx" },
    { version: 94, sql: "DROP INDEX agent_context_reads_target_idx" },
    {
      version: 95,
      sql: "DROP TRIGGER conversation_context_packets_immutable; ALTER TABLE conversation_context_packets DROP COLUMN supplement_json",
    },
    ...contextPacketTriggers.map((trigger) => ({ version: 95, sql: `DROP TRIGGER ${trigger}` })),
    ...contextPacketTriggers.map((trigger) => ({ version: 96, sql: `DROP TRIGGER ${trigger}` })),
    { version: 96, sql: "DROP TABLE todos" },
    { version: 96, sql: "ALTER TABLE todos DROP COLUMN note" },
    { version: 96, sql: "DROP INDEX todos_conversation_idx" },
    { version: 97, sql: "DROP TABLE restart_continuation_plans" },
    { version: 97, sql: "ALTER TABLE restart_continuation_plans DROP COLUMN route_identity" },
    { version: 98, sql: "DROP TABLE conversation_title_locks" },
    { version: 99, sql: "DROP TABLE watcher_links" },
    { version: 99, sql: "DROP TABLE watcher_wakes" },
    { version: 99, sql: "ALTER TABLE watcher_links DROP COLUMN events_pending" },
    { version: 99, sql: "ALTER TABLE watcher_wakes DROP COLUMN digest_bytes" },
    { version: 99, sql: "ALTER TABLE watcher_links DROP COLUMN delivery" },
    { version: 99, sql: "ALTER TABLE watcher_links DROP COLUMN findings_total" },
    { version: 99, sql: "ALTER TABLE watcher_wakes DROP COLUMN resolved_by_sequence" },
    { version: 99, sql: "ALTER TABLE watcher_wakes DROP COLUMN commands_declined" },
    { version: 99, sql: "ALTER TABLE messages DROP COLUMN watcher_note_json" },
    { version: 99, sql: "ALTER TABLE queued_messages DROP COLUMN watcher_note_json" },
    { version: 99, sql: "DROP INDEX watcher_links_active_watched_idx" },
    { version: 99, sql: "DROP INDEX watcher_wakes_link_idx" },
    { version: 99, sql: "DROP INDEX watcher_links_project_idx" },
    ...watcherTriggers.map((trigger) => ({ version: 99, sql: `DROP TRIGGER ${trigger}` })),
  ])("skips a schema $version backup after $sql", async ({ version, sql }) => {
    const { older, report, messages } = await backups(version, (database) => database.exec(sql));
    expect(report).toMatchObject({ outcome: "restored", restoredBackup: older.filename, invalidBackupsSkipped: 1 });
    expect(messages).toEqual(["coherent schema"]);
  });

  it.each([87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99])("restores a complete schema %i backup and upgrades it", async (version) => {
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

  it.each([...contextPacketTriggers, ...watcherTriggers])("rejects a backup missing %s during off-thread validation", async (trigger) => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-recovery-columns-"));
    directories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }).close();
    const primary = new Database(databasePath);
    primary.exec(`DROP TRIGGER ${trigger}`);
    const manager = new DatabaseBackupManager(primary, databasePath);
    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    primary.close();
  });
});
