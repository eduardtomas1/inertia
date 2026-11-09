import type { DatabaseMigrationDefinition } from "./catalog";

export const CODEX_COMPACTION_LIMIT_SCHEMA_VERSION = 114;

export const codexCompactionLimitMigration: DatabaseMigrationDefinition = {
  name: "PersistCodexCompactionLimit",
  up: (database) => {
    const columns = new Set((database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("codex_auto_compact_token_limit")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN codex_auto_compact_token_limit INTEGER DEFAULT 300000
          CHECK (codex_auto_compact_token_limit IS NULL OR (typeof(codex_auto_compact_token_limit) = 'integer' AND codex_auto_compact_token_limit BETWEEN 100000 AND 1000000));
      `);
    }
  },
};
