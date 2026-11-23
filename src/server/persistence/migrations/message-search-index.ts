import type { DatabaseMigrationDefinition } from "./catalog";

export const MESSAGE_SEARCH_INDEX_SCHEMA_VERSION = 122;

export const messageSearchIndexMigration: DatabaseMigrationDefinition = {
  name: "IndexMessageSearchText",
  up: `
    CREATE TABLE IF NOT EXISTS message_search_documents (
      document_id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      state INTEGER NOT NULL CHECK (state IN (0, 1, 2))
    );
    CREATE INDEX IF NOT EXISTS message_search_documents_unindexed_idx
      ON message_search_documents(state) WHERE state <> 1;
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search_index USING fts5(
      content, tokenize = 'trigram', detail = none, content = '', contentless_delete = 1
    );
    INSERT INTO message_search_index (message_search_index, rank) VALUES ('automerge', 0);
    INSERT INTO message_search_index (message_search_index, rank) VALUES ('crisismerge', 256);
    INSERT INTO message_search_index (message_search_index, rank) VALUES ('usermerge', 4);
    CREATE TABLE IF NOT EXISTS message_search_backfill (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      before_created_at TEXT,
      before_message_id TEXT,
      CHECK ((before_created_at IS NULL) = (before_message_id IS NULL))
    );
    INSERT OR IGNORE INTO message_search_backfill (singleton, complete)
    SELECT 1, NOT EXISTS (SELECT 1 FROM messages);

    CREATE TRIGGER IF NOT EXISTS message_search_message_inserted AFTER INSERT ON messages BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents WHERE message_id = NEW.id
      );
      DELETE FROM message_search_documents WHERE message_id = NEW.id;
      INSERT INTO message_search_documents (message_id, state) VALUES (NEW.id, 0);
    END;
    CREATE TRIGGER IF NOT EXISTS message_search_message_changed AFTER UPDATE OF content ON messages
    WHEN OLD.content IS NOT NEW.content BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents WHERE message_id = NEW.id AND state = 1
      );
      UPDATE message_search_documents SET state = 0 WHERE message_id = NEW.id AND state <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS message_search_message_deleted AFTER DELETE ON messages BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents WHERE message_id = OLD.id
      );
      DELETE FROM message_search_documents WHERE message_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS message_search_chunk_inserted AFTER INSERT ON message_content_chunks
    WHEN EXISTS (
      SELECT 1 FROM message_search_documents WHERE message_id = NEW.message_id AND state <> 0
    ) BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents WHERE message_id = NEW.message_id AND state = 1
      );
      UPDATE message_search_documents SET state = 0 WHERE message_id = NEW.message_id;
    END;
    CREATE TRIGGER IF NOT EXISTS message_search_chunk_changed AFTER UPDATE ON message_content_chunks BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents
        WHERE message_id IN (OLD.message_id, NEW.message_id) AND state = 1
      );
      UPDATE message_search_documents SET state = 0
      WHERE message_id IN (OLD.message_id, NEW.message_id) AND state <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS message_search_chunk_deleted AFTER DELETE ON message_content_chunks
    WHEN EXISTS (
      SELECT 1 FROM message_search_documents WHERE message_id = OLD.message_id AND state <> 0
    ) BEGIN
      DELETE FROM message_search_index WHERE rowid IN (
        SELECT document_id FROM message_search_documents WHERE message_id = OLD.message_id AND state = 1
      );
      UPDATE message_search_documents SET state = 0 WHERE message_id = OLD.message_id;
    END;
  `,
};
