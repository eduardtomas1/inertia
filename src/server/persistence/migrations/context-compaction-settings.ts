import type { DatabaseMigrationDefinition } from "./catalog";

export const CONTEXT_COMPACTION_SETTINGS_SCHEMA_VERSION = 113;

export const contextCompactionSettingsMigration: DatabaseMigrationDefinition = {
  name: "PersistContextCompactionSettings",
  up: (database) => {
    const columns = new Set((database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("compact_before_cache_expires")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN compact_before_cache_expires INTEGER NOT NULL DEFAULT 0
          CHECK (compact_before_cache_expires IN (0, 1));
      `);
    }
    if (!columns.has("claude_auto_compact_window")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN claude_auto_compact_window INTEGER DEFAULT 400000
          CHECK (claude_auto_compact_window IS NULL OR (typeof(claude_auto_compact_window) = 'integer' AND claude_auto_compact_window BETWEEN 100000 AND 1000000));
      `);
    }
  },
};
