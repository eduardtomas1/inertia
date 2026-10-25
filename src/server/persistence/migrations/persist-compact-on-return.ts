import type { DatabaseMigrationDefinition } from "./catalog";

export const persistCompactOnReturnMigration: DatabaseMigrationDefinition = {
  name: "PersistCompactOnReturn",
  up: (database) => {
    const columns = (table: string): Set<string> => new Set((database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>).map(({ name }) => name));
    const settings = columns("app_state");
    if (!settings.has("compact_on_return")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN compact_on_return TEXT NOT NULL DEFAULT 'offer'
          CHECK (compact_on_return IN ('offer', 'never'));
      `);
    }
    const usage = columns("thread_usage");
    if (!usage.has("last_request_started_at")) {
      database.exec(`
        ALTER TABLE thread_usage
          ADD COLUMN last_request_started_at TEXT
          CHECK (last_request_started_at IS NULL OR length(last_request_started_at) <= 64);
      `);
    }
    if (!usage.has("prompt_cache_lifetime_ms")) {
      database.exec(`
        ALTER TABLE thread_usage
          ADD COLUMN prompt_cache_lifetime_ms INTEGER
          CHECK (prompt_cache_lifetime_ms IS NULL OR (typeof(prompt_cache_lifetime_ms) = 'integer' AND prompt_cache_lifetime_ms > 0));
      `);
    }
    if (!usage.has("prompt_cache_source")) {
      database.exec(`
        ALTER TABLE thread_usage
          ADD COLUMN prompt_cache_source TEXT
          CHECK (prompt_cache_source IS NULL OR prompt_cache_source IN ('reported', 'configured', 'assumed'));
      `);
    }
  },
};
