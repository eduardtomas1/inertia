import type { DatabaseMigrationDefinition } from "./catalog";

export const queuedMessagesMigration: DatabaseMigrationDefinition = {
  name: "PersistRuntimeQueuedMessages",
  up: `
    CREATE TABLE queued_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (length(content) <= 20000),
      attachments_json TEXT NOT NULL CHECK (json_valid(attachments_json)),
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
      route_identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting','dispatching','blocked','accepted','cancelled')),
      created_at TEXT NOT NULL,
      error TEXT CHECK (error IS NULL OR length(error) <= 1000),
      turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
      user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
    );
    CREATE INDEX queued_messages_conversation_state_idx ON queued_messages(conversation_id, state, sequence);
  `,
};
