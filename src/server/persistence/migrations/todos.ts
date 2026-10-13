import type { DatabaseMigrationDefinition } from "./catalog";

export const todosMigration: DatabaseMigrationDefinition = {
  name: "PersistTodos",
  up: `
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      title TEXT NOT NULL
        CHECK (
          length(title) BETWEEN 1 AND 200
          AND trim(title) <> ''
          AND instr(title, char(0)) = 0
          AND instr(title, char(10)) = 0
          AND instr(title, char(13)) = 0
        ),
      note TEXT NOT NULL DEFAULT ''
        CHECK (length(note) <= 2000 AND instr(note, char(0)) = 0),
      priority TEXT
        CHECK (priority IS NULL OR priority IN ('urgent', 'high', 'medium', 'low')),
      due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
      completed_at TEXT
        CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),
      conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL
        CHECK (conversation_id IS NULL OR length(conversation_id) = 36),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
    );
    CREATE INDEX IF NOT EXISTS todos_conversation_idx
      ON todos(conversation_id);
    CREATE TRIGGER IF NOT EXISTS todos_count_limit
      BEFORE INSERT ON todos
      WHEN (SELECT COUNT(*) FROM todos) >= 200
      BEGIN
        SELECT RAISE(ABORT, 'task count limit exceeded');
      END;
  `,
};
