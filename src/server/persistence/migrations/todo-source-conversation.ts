import type { DatabaseMigrationDefinition } from "./catalog";

export const TODO_SOURCE_CONVERSATION_SCHEMA_VERSION = 108;

/**
 * Records the chat a task was written from, separately from the chat a task
 * was handed to. A nullable column with a NULL default can carry its foreign
 * key without rebuilding the table, and deleting the chat clears it.
 */
export const todoSourceConversationMigration: DatabaseMigrationDefinition = {
  name: "PersistTodoSourceConversation",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(todos)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const existing = columns.find((column) => column.name === "source_conversation_id");
    if (existing && (existing.type !== "TEXT" || existing.notnull !== 0)) {
      throw new Error("Unexpected task column.");
    }
    if (!existing) {
      database.exec(`
        ALTER TABLE todos ADD COLUMN source_conversation_id TEXT
          REFERENCES conversations(id) ON DELETE SET NULL
          CHECK (source_conversation_id IS NULL OR length(source_conversation_id) = 36);
      `);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS todos_source_conversation_idx
        ON todos(source_conversation_id);
    `);
  },
};
