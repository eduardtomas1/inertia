import type { DatabaseMigrationDefinition } from "./catalog";

export const conversationNotesMigration: DatabaseMigrationDefinition = {
  name: "ConversationNotes",
  up: `
    CREATE TABLE IF NOT EXISTS conversation_notes (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (length(content) <= 20000 AND instr(content, char(0)) = 0),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      updated_at TEXT NOT NULL
    );
  `,
};
