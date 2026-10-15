import type { DatabaseMigrationDefinition } from "./catalog";

export const conversationTitleLocksMigration: DatabaseMigrationDefinition = {
  name: "PersistConversationTitleLocks",
  up: `
    CREATE TABLE IF NOT EXISTS conversation_title_locks (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE
    );
  `,
};
