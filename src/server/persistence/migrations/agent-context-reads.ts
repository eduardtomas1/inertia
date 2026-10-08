import type { DatabaseMigrationDefinition } from "./catalog";

export const agentContextReadsMigration: DatabaseMigrationDefinition = {
  name: "RecordAgentContextReads",
  up: `
    CREATE TABLE IF NOT EXISTS agent_context_reads (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      target_conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE
        CHECK (length(target_conversation_id) = 36),
      target_turn_id TEXT NOT NULL
        REFERENCES agent_turns(id) ON DELETE CASCADE
        CHECK (length(target_turn_id) BETWEEN 1 AND 200),
      target_user_message_id TEXT NOT NULL
        REFERENCES messages(id) ON DELETE CASCADE
        CHECK (length(target_user_message_id) BETWEEN 1 AND 200),
      source_conversation_id TEXT NOT NULL CHECK (length(source_conversation_id) = 36),
      source_conversation_title TEXT NOT NULL
        CHECK (length(source_conversation_title) BETWEEN 1 AND 120),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 200
      ),
      access TEXT NOT NULL CHECK (access IN ('own', 'referenced', 'approved')),
      page_count INTEGER NOT NULL CHECK (page_count >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_context_reads_identity_idx
      ON agent_context_reads(
        target_turn_id,
        source_conversation_id,
        ifnull(source_turn_id, '')
      );
    CREATE INDEX IF NOT EXISTS agent_context_reads_target_idx
      ON agent_context_reads(target_conversation_id, target_user_message_id);
  `,
};
