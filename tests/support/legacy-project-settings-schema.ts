import type Database from "better-sqlite3";

export function removePost79SchemaFromLegacyFixture(database: Database.Database): void {
  // These fixtures intentionally rewind a current database. Remove the newer
  // durable structures as well as their receipts before replaying migrations.
  database.exec(`
    DROP TRIGGER IF EXISTS messages_history_revision;
    DROP TRIGGER IF EXISTS messages_history_revision_delete;
    DROP TRIGGER IF EXISTS agent_reasonings_history_revision;
    DROP TRIGGER IF EXISTS agent_reasonings_history_revision_delete;
    DROP TRIGGER IF EXISTS activities_history_revision;
    DROP TRIGGER IF EXISTS activities_history_revision_delete;
    DROP TABLE IF EXISTS conversation_content_revisions;
    DROP INDEX IF EXISTS agent_turns_history_order_idx;
    DROP INDEX IF EXISTS subagents_history_order_idx;
    DROP INDEX IF EXISTS agent_plans_history_order_idx;
    DROP TABLE IF EXISTS queued_messages;
    DROP TABLE IF EXISTS message_send_receipts;
    DROP TABLE IF EXISTS recovered_final_answers;
    DELETE FROM schema_migrations WHERE version >= 80;
  `);
  const appColumns = database.pragma("table_info(app_state)") as Array<{ name: string }>;
  for (const column of ["attachment_storage_gib", "auto_remove_old_attachments"]) {
    if (appColumns.some(({ name }) => name === column)) database.exec(`ALTER TABLE app_state DROP COLUMN ${column}`);
  }
  const operationColumns = database.pragma("table_info(agent_thread_operations)") as Array<{ name: string }>;
  for (const column of ["target_turn_id", "target_run_id"]) {
    if (operationColumns.some(({ name }) => name === column)) database.exec(`ALTER TABLE agent_thread_operations DROP COLUMN ${column}`);
  }
}

/** Undo only the new columns when a test reconstructs a pre-72 database. */
export function removeProjectSettingsFromLegacyFixture(database: Database.Database): void {
  removePost79SchemaFromLegacyFixture(database);
  database.exec(`
    ALTER TABLE projects DROP COLUMN preferences_json;
    ALTER TABLE conversations DROP COLUMN marked_unread_at;
    ALTER TABLE app_state DROP COLUMN light_color_theme;
    ALTER TABLE app_state DROP COLUMN dark_color_theme;
    DELETE FROM schema_migrations WHERE version >= 72;
  `);
}
