import type { DatabaseMigrationDefinition } from "./catalog";

export const cliConversationImportsMigration: DatabaseMigrationDefinition = {
  name: "CliConversationImports",
  up: `CREATE TABLE cli_conversation_imports (
    source_key TEXT PRIMARY KEY CHECK(length(source_key) = 64),
    provider_id TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude')),
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL CHECK(length(cwd) > 0),
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    imported_at TEXT NOT NULL,
    source_messages INTEGER NOT NULL CHECK(source_messages > 0),
    omitted_messages INTEGER NOT NULL CHECK(omitted_messages >= 0 AND omitted_messages < source_messages),
    omitted_bytes INTEGER NOT NULL CHECK(omitted_bytes >= 0),
    dropped_records INTEGER NOT NULL CHECK(dropped_records >= 0),
    continuation TEXT NOT NULL CHECK(continuation IN ('native', 'context')),
    UNIQUE(provider_id, session_id)
  );
  ALTER TABLE agent_turns ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin = 'cli-import');
  CREATE INDEX agent_turns_provider_session_before_idx ON agent_turns(provider_id, provider_session_before) WHERE provider_session_before IS NOT NULL;
  CREATE INDEX agent_turns_provider_session_after_idx ON agent_turns(provider_id, provider_session_after) WHERE provider_session_after IS NOT NULL;`,
};
