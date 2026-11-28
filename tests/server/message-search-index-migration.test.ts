// @inertia-test-suite portable

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  MESSAGE_SEARCH_INDEX_SCHEMA_VERSION,
  messageSearchIndexMigration,
} from "../../src/server/persistence/migrations/message-search-index";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import { removeOrchestratorV2FromFixture } from "../support/legacy-project-settings-schema";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function searchSchema(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT type || ':' || name AS entry FROM sqlite_master
    WHERE name LIKE 'message_search%' AND name NOT LIKE 'message_search_index_%' ORDER BY name
  `).pluck().all() as string[]);
}

describe("message search index migration", () => {
  it("appends the search index as schema 122", () => {
    expect(MESSAGE_SEARCH_INDEX_SCHEMA_VERSION).toBe(122);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(MESSAGE_SEARCH_INDEX_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === 122)?.name).toBe(messageSearchIndexMigration.name);
  });

  it("marks an empty database as fully indexed", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, MESSAGE_SEARCH_INDEX_SCHEMA_VERSION - 1);
      expect(searchSchema(database)).toEqual([]);
      migrateRuntimeDatabase(database);
      expect(searchSchema(database)).toEqual([
        "table:message_search_backfill",
        "trigger:message_search_chunk_changed",
        "trigger:message_search_chunk_deleted",
        "trigger:message_search_chunk_inserted",
        "table:message_search_documents",
        "index:message_search_documents_unindexed_idx",
        "table:message_search_index",
        "trigger:message_search_message_changed",
        "trigger:message_search_message_deleted",
        "trigger:message_search_message_inserted",
      ]);
      expect(database.prepare("SELECT complete FROM message_search_backfill").pluck().all()).toEqual([1]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'message_content_chunks' ORDER BY name").pluck().all())
        .toEqual(["message_search_chunk_changed", "message_search_chunk_deleted", "message_search_chunk_inserted"]);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("upgrades existing history without indexing it, then indexes it in the background", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-message-search-migration-"));
    directories.push(directory);
    const path = join(directory, "inertia.sqlite");
    const previous = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    const project = previous.createProject("History", directory);
    const conversation = previous.createConversation(project.id, "Before");
    const older = previous.createMessage(conversation.id, "older needle", "user", [], null, "2025-01-01T00:00:00.000Z");
    const streamed = previous.createMessage(conversation.id, "streamed nee", "user", [], null, "2025-02-01T00:00:00.000Z");
    previous.appendMessageContent(streamed.id, "dle tail");
    previous.close();
    const legacy = new Database(path);
    // Strip post-122 Orchestrator V2 schema so this fixture is a genuine schema-121 database.
    removeOrchestratorV2FromFixture(legacy);
    legacy.exec(`
      DROP TRIGGER message_search_message_inserted;
      DROP TRIGGER message_search_message_changed;
      DROP TRIGGER message_search_message_deleted;
      DROP TRIGGER message_search_chunk_inserted;
      DROP TRIGGER message_search_chunk_changed;
      DROP TRIGGER message_search_chunk_deleted;
      DROP TABLE message_search_index;
      DROP TABLE message_search_documents;
      DROP TABLE message_search_backfill;
      DELETE FROM schema_migrations WHERE version >= ${MESSAGE_SEARCH_INDEX_SCHEMA_VERSION};
    `);
    expect(searchSchema(legacy)).toEqual([]);
    legacy.close();

    const store = new RuntimeStore(path, directory, { recoverInterruptedRuns: false });
    const reader = new Database(path, { readonly: true });
    try {
      expect(reader.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(reader.prepare("SELECT complete, before_created_at, before_message_id FROM message_search_backfill").all())
        .toEqual([{ complete: 0, before_created_at: null, before_message_id: null }]);
      expect(reader.prepare("SELECT count(*) FROM message_search_documents").pluck().get()).toBe(0);
      expect(searchMessages(reader, "needle tail")).toMatchObject({ indexing: true, hits: [expect.objectContaining({ messageId: streamed.id })] });
      const newer = store.createMessage(conversation.id, "newer needle");
      expect(reader.prepare("SELECT state FROM message_search_documents WHERE message_id = ?").pluck().get(newer.id)).toBe(0);
      expect(searchMessages(reader, "needle").hits.map(({ messageId }) => messageId)).toEqual([newer.id, streamed.id, older.id]);
      let batches = 1;
      while (store.indexMessageSearchBatch(1_000).remaining) batches += 1;
      expect(batches).toBeLessThan(5);
      expect(reader.prepare("SELECT complete FROM message_search_backfill").pluck().get()).toBe(1);
      expect(reader.prepare("SELECT message_id, state FROM message_search_documents ORDER BY message_id").all())
        .toEqual([newer.id, streamed.id, older.id].sort().map((id) => ({ message_id: id, state: 1 })));
      expect(searchMessages(reader, "needle")).toMatchObject({ indexing: false, incomplete: false, continuation: null });
      expect(searchMessages(reader, "needle").hits.map(({ messageId }) => messageId)).toEqual([newer.id, streamed.id, older.id]);
      expect(reader.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      reader.close();
      store.close();
    }
  });
});
