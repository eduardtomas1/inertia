import type Database from "better-sqlite3";

export function removeProjectSettingsFromLegacyFixture(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS queued_messages;
    ALTER TABLE projects DROP COLUMN preferences_json;
    ALTER TABLE conversations DROP COLUMN marked_unread_at;
    ALTER TABLE app_state DROP COLUMN light_color_theme;
    ALTER TABLE app_state DROP COLUMN dark_color_theme;
    DELETE FROM schema_migrations WHERE version >= 72;
  `);
  const operationColumns = database.pragma("table_info(agent_thread_operations)") as Array<{ name: string }>;
  for (const column of ["target_turn_id", "target_run_id"]) {
    if (operationColumns.some(({ name }) => name === column)) database.exec(`ALTER TABLE agent_thread_operations DROP COLUMN ${column}`);
  }
}
