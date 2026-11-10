import type Database from "better-sqlite3";

export function removeProjectSettingsFromLegacyFixture(database: Database.Database): void {
  removeWatcherLinksFromLegacyFixture(database);
  database.exec(`
    DROP TABLE IF EXISTS html_renders;
    DROP TABLE IF EXISTS cli_conversation_imports;
    DROP INDEX IF EXISTS agent_turns_provider_session_before_idx;
    DROP INDEX IF EXISTS agent_turns_provider_session_after_idx;
    DROP TABLE IF EXISTS usage_limited_turns;
    DROP TABLE IF EXISTS usage_limit_resume_plans;
    DROP TABLE IF EXISTS queued_messages;
    ALTER TABLE projects DROP COLUMN preferences_json;
    ALTER TABLE conversations DROP COLUMN marked_unread_at;
    ALTER TABLE app_state DROP COLUMN light_color_theme;
    ALTER TABLE app_state DROP COLUMN dark_color_theme;
    ALTER TABLE app_state DROP COLUMN light_custom_color;
    ALTER TABLE app_state DROP COLUMN dark_custom_color;
    ALTER TABLE app_state DROP COLUMN quota_warnings_enabled;
    ALTER TABLE app_state DROP COLUMN quota_warning_threshold;
    ALTER TABLE app_state DROP COLUMN notify_only_in_background;
    ALTER TABLE app_state DROP COLUMN muted_custom_colors;
    DELETE FROM schema_migrations WHERE version >= 72;
  `);
  const operationColumns = database.pragma("table_info(agent_thread_operations)") as Array<{ name: string }>;
  if ((database.pragma("table_info(messages)") as Array<{ name: string }>).some(({ name }) => name === "html_render_json")) database.exec("ALTER TABLE messages DROP COLUMN html_render_json");
  if ((database.pragma("table_info(agent_turns)") as Array<{ name: string }>).some(({ name }) => name === "origin")) database.exec("ALTER TABLE agent_turns DROP COLUMN origin");
  for (const column of ["target_turn_id", "target_run_id"]) {
    if (operationColumns.some(({ name }) => name === column)) database.exec(`ALTER TABLE agent_thread_operations DROP COLUMN ${column}`);
  }
}

export function removeWatcherLinksFromLegacyFixture(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS watcher_links_watched_delete;
    DROP TABLE IF EXISTS watcher_wakes;
    DROP TABLE IF EXISTS watcher_links;
  `);
  for (const table of ["messages", "queued_messages"]) {
    if ((database.pragma(`table_info(${table})`) as Array<{ name: string }>).some(({ name }) => name === "watcher_note_json")) {
      database.exec(`ALTER TABLE ${table} DROP COLUMN watcher_note_json`);
    }
  }
  if ((database.pragma("table_info(messages)") as Array<{ name: string }>).some(({ name }) => name === "duo_comparison_json")) {
    database.exec("ALTER TABLE messages DROP COLUMN duo_comparison_json");
  }
  removeCustomAgentsFromLegacyFixture(database);
  database.exec("DELETE FROM schema_migrations WHERE version >= 99");
}

export function removeCustomAgentsFromLegacyFixture(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS custom_agents_count_limit;
    DROP TABLE IF EXISTS custom_agents;
  `);
  for (const [table, column] of [["messages", "custom_agent_call_json"], ["subagent_traces", "custom_agent_id"]] as const) {
    if ((database.pragma(`table_info(${table})`) as Array<{ name: string }>).some(({ name }) => name === column)) {
      database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
}
