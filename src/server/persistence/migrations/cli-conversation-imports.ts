import type { DatabaseMigrationDefinition } from "./catalog";

export const cliConversationImportsMigration: DatabaseMigrationDefinition = {
  name: "CliConversationImports",
  up: `CREATE TABLE cli_conversation_imports (
    source_key TEXT PRIMARY KEY CHECK(length(source_key) = 64),
    provider_id TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude')),
    session_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    imported_at TEXT NOT NULL,
    UNIQUE(provider_id, session_id)
  );`,
};
