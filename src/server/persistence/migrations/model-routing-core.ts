import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Auto routing: one bounded settings document, a per-chat routing mode that
 * defaults every existing chat to manual, and a bounded per-turn decision.
 * The whole operation lives inside `up` so the lineage digest covers it.
 */
export const modelRoutingCoreMigration: DatabaseMigrationDefinition = {
  name: "PersistModelRoutingCore",
  up: (database) => {
    const columns = (table: string): Set<string> => new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!columns("app_state").has("routing_settings_json")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN routing_settings_json TEXT NOT NULL DEFAULT '{}'
          CHECK (length(routing_settings_json) <= 65536);
      `);
    }
    if (!columns("conversations").has("routing_mode")) {
      database.exec(`
        ALTER TABLE conversations
          ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (routing_mode IN ('manual', 'auto'));
      `);
    }
    if (!columns("agent_turns").has("routing_json")) {
      database.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN routing_json TEXT
          CHECK (routing_json IS NULL OR length(routing_json) <= 4096);
      `);
    }
  },
};
