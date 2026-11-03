import type { DatabaseMigrationDefinition } from "./catalog";

export const LIBRARY_SCHEMA_VERSION = 107;

export const libraryMigration: DatabaseMigrationDefinition = {
  name: "PersistLibrary",
  up: `
    CREATE TABLE IF NOT EXISTS library_categories (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      name TEXT NOT NULL
        CHECK (
          length(name) BETWEEN 1 AND 60
          AND trim(name) = name
          AND instr(name, char(0)) = 0
          AND instr(name, char(10)) = 0
          AND instr(name, char(13)) = 0
        ),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS library_categories_name_idx
      ON library_categories(name COLLATE NOCASE);
    CREATE TRIGGER IF NOT EXISTS library_categories_count_limit
      BEFORE INSERT ON library_categories
      WHEN (SELECT COUNT(*) FROM library_categories) >= 100
      BEGIN
        SELECT RAISE(ABORT, 'library category count limit exceeded');
      END;
    CREATE TABLE IF NOT EXISTS saved_answers (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL
        REFERENCES agent_turns(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL
        REFERENCES messages(id) ON DELETE CASCADE,
      category_id TEXT
        REFERENCES library_categories(id) ON DELETE SET NULL,
      title TEXT NOT NULL
        CHECK (
          length(title) BETWEEN 1 AND 120
          AND trim(title) <> ''
          AND instr(title, char(0)) = 0
          AND instr(title, char(10)) = 0
          AND instr(title, char(13)) = 0
        ),
      excerpt TEXT NOT NULL DEFAULT ''
        CHECK (
          length(excerpt) <= 200
          AND instr(excerpt, char(0)) = 0
          AND instr(excerpt, char(10)) = 0
          AND instr(excerpt, char(13)) = 0
        ),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS saved_answers_message_idx
      ON saved_answers(message_id);
    CREATE INDEX IF NOT EXISTS saved_answers_conversation_idx
      ON saved_answers(conversation_id);
    CREATE INDEX IF NOT EXISTS saved_answers_turn_idx
      ON saved_answers(turn_id);
    CREATE INDEX IF NOT EXISTS saved_answers_category_idx
      ON saved_answers(category_id);
    CREATE INDEX IF NOT EXISTS saved_answers_created_idx
      ON saved_answers(created_at, id);
    CREATE TRIGGER IF NOT EXISTS saved_answers_count_limit
      BEFORE INSERT ON saved_answers
      WHEN (SELECT COUNT(*) FROM saved_answers) >= 1000
      BEGIN
        SELECT RAISE(ABORT, 'saved answer count limit exceeded');
      END;
    CREATE INDEX IF NOT EXISTS html_renders_created_idx
      ON html_renders(created_at, id);
  `,
};
