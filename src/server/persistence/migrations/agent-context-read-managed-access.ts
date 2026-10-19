import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Lets the agent context read log record reads of a chat the reading chat
 * manages. SQLite cannot widen a CHECK constraint in place, so the table is
 * rebuilt with every column, row, and index unchanged.
 */
export const agentContextReadManagedAccessMigration: DatabaseMigrationDefinition = {
  name: "RecordManagedAgentContextReads",
  foreignKeys: "off",
  up: `
    CREATE TABLE agent_context_reads_v99 (
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
      access TEXT NOT NULL
        CHECK (access IN ('own', 'referenced', 'approved', 'managed')),
      page_count INTEGER NOT NULL CHECK (page_count >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_context_reads_v99 (
      id, target_conversation_id, target_turn_id, target_user_message_id,
      source_conversation_id, source_conversation_title, source_turn_id,
      access, page_count, created_at, updated_at
    )
    SELECT id, target_conversation_id, target_turn_id, target_user_message_id,
      source_conversation_id, source_conversation_title, source_turn_id,
      access, page_count, created_at, updated_at
    FROM agent_context_reads;
    DROP TABLE agent_context_reads;
    ALTER TABLE agent_context_reads_v99 RENAME TO agent_context_reads;
    CREATE UNIQUE INDEX agent_context_reads_identity_idx
      ON agent_context_reads(
        target_turn_id,
        source_conversation_id,
        ifnull(source_turn_id, '')
      );
    CREATE INDEX agent_context_reads_target_idx
      ON agent_context_reads(target_conversation_id, target_user_message_id);
  `,
};
