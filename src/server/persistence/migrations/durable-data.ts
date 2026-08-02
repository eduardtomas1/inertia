import type { DatabaseMigrationDefinition } from "./catalog";

export const durableDataMigrationDefinitions = [
  {
    name: "AppendStreamTextChunks",
    up: `
      CREATE TABLE IF NOT EXISTS message_content_chunks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL
          REFERENCES messages(id) ON DELETE CASCADE,
        content TEXT NOT NULL
          CHECK (length(content) BETWEEN 1 AND 1048576)
      );
      CREATE INDEX IF NOT EXISTS message_content_chunks_message_sequence_idx
        ON message_content_chunks(message_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS reasoning_content_chunks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        reasoning_id TEXT NOT NULL
          REFERENCES agent_reasonings(id) ON DELETE CASCADE,
        content TEXT NOT NULL
          CHECK (length(content) BETWEEN 1 AND 1048576)
      );
      CREATE INDEX IF NOT EXISTS reasoning_content_chunks_reasoning_sequence_idx
        ON reasoning_content_chunks(reasoning_id, sequence ASC);
    `,
  },
  {
    name: "RecordIdempotentRecoveryImports",
    up: `
      CREATE TABLE IF NOT EXISTS recovery_import_receipts (
        digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
        projects INTEGER NOT NULL CHECK (projects >= 0),
        conversations INTEGER NOT NULL CHECK (conversations >= 0),
        messages INTEGER NOT NULL CHECK (messages >= 0),
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_import_journals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        operation_id TEXT NOT NULL UNIQUE
          CHECK (length(operation_id) BETWEEN 1 AND 64),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        authorized_root TEXT NOT NULL
          CHECK (length(CAST(authorized_root AS BLOB)) BETWEEN 1 AND 4096),
        projects INTEGER NOT NULL CHECK (projects BETWEEN 0 AND 10000),
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    name: "MakeStreamChunksNulSafe",
    up: `
      CREATE TABLE message_content_chunks_v44 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL
          REFERENCES messages(id) ON DELETE CASCADE,
        content TEXT NOT NULL
          CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 4194304)
      );
      INSERT INTO message_content_chunks_v44 (sequence, message_id, content)
      SELECT sequence, message_id, content FROM message_content_chunks;
      DROP TABLE message_content_chunks;
      ALTER TABLE message_content_chunks_v44 RENAME TO message_content_chunks;
      CREATE INDEX message_content_chunks_message_sequence_idx
        ON message_content_chunks(message_id, sequence ASC);

      CREATE TABLE reasoning_content_chunks_v44 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        reasoning_id TEXT NOT NULL
          REFERENCES agent_reasonings(id) ON DELETE CASCADE,
        content TEXT NOT NULL
          CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 4194304)
      );
      INSERT INTO reasoning_content_chunks_v44 (sequence, reasoning_id, content)
      SELECT sequence, reasoning_id, content FROM reasoning_content_chunks;
      DROP TABLE reasoning_content_chunks;
      ALTER TABLE reasoning_content_chunks_v44 RENAME TO reasoning_content_chunks;
      CREATE INDEX reasoning_content_chunks_reasoning_sequence_idx
        ON reasoning_content_chunks(reasoning_id, sequence ASC);
    `,
  },
] satisfies readonly DatabaseMigrationDefinition[];
