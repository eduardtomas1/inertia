import type { DatabaseMigrationDefinition } from "./catalog";

export const durableMessageQueueMigration: DatabaseMigrationDefinition = {
  name: "PersistMessageQueueAndDispatchReceipts",
  up: `
    CREATE TABLE queued_messages (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (length(content) <= 20000),
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
      status TEXT NOT NULL CHECK (status IN ('queued', 'paused', 'dispatching', 'uncertain', 'rejected', 'accepted', 'removed')),
      position INTEGER NOT NULL,
      after_turn_id TEXT,
      accepted_turn_id TEXT,
      accepted_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX queued_messages_conversation_idx ON queued_messages(conversation_id, position, id);
    CREATE INDEX queued_messages_status_idx ON queued_messages(status, conversation_id);
  `,
};
