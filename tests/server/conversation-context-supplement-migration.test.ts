// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function schemaObjects(database: Database.Database) {
  return database.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
}

function tableData(database: Database.Database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

function foreignKeys(database: Database.Database) {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, database.pragma(`foreign_key_list("${name.replaceAll('"', '""')}")`)]);
}

function insertPacket(database: Database.Database, supplementBytes: number | null, consumed = false) {
  const conversation = database.prepare("SELECT id FROM conversations WHERE length(id) = 36 ORDER BY id LIMIT 1").get() as
    { id: string };
  const projectId = "00000000-0000-4000-8000-000000000110";
  const id = randomUUID();
  const supplement = supplementBytes === null ? null
    : JSON.stringify({ commands: ["x".repeat(supplementBytes - '{"commands":[""]}'.length)] });
  database.prepare(`INSERT INTO conversation_context_packets (
      id, source_conversation_id, target_conversation_id, source_project_id, target_project_id,
      source_conversation_title, source_project_name, source_workspace_label, target_workspace_label,
      workspace_relation, note, excerpts_json, message_count, character_count, created_at,
      consumed_message_id, consumed_request_id, consumed_at, dropped_message_count, transport_version,
      delivered_budget_bytes, delivered_message_count, delivered_character_count, delivered_omitted_count, supplement_json
    ) VALUES (?, ?, ?, ?, ?, 'Source', 'Project', 'Workspace', 'Workspace', 'same-workspace', 'Note', '[{"a":1}]', 1, 1,
      '2026-10-31T00:00:00.000Z', ?, ?, ?, 0, 3, ?, ?, ?, ?, ?)`).run(id, randomUUID(), conversation.id, projectId, projectId,
    ...(consumed ? [randomUUID(), randomUUID(), "2026-10-31T00:00:01.000Z", 1024, 1, 1, 0]
      : [null, null, null, null, null, null, null]), supplement);
  return id;
}

async function releasedDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-context-supplement-"));
  directories.push(directory);
  const path = join(directory, "runtime.sqlite");
  await copyFile(resolve("tests/fixtures/database/v0.0.6.sqlite"), path);
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  migrateRuntimeDatabase(database, 109);
  const columns = (database.pragma("table_info(conversations)") as { name: string }[]).map(({ name }) => name)
    .filter((name) => name !== "id").map((name) => `"${name}"`).join(", ");
  database.prepare(`INSERT INTO conversations (id, ${columns}) SELECT ?, ${columns} FROM conversations ORDER BY rowid LIMIT 1`)
    .run(randomUUID());
  return database;
}

describe("conversation context supplement bound migration", () => {
  it("raises the supplement bound while preserving rows, indexes, triggers and foreign keys", async () => {
    const database = await releasedDatabase();
    try {
      insertPacket(database, 4_000);
      insertPacket(database, null, true);
      expect(() => insertPacket(database, 8_192)).toThrow(/CHECK/u);
      const rows = tableData(database);
      const objects = schemaObjects(database);
      const keys = foreignKeys(database);
      migrateRuntimeDatabase(database, 110);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 110 });
      expect(tableData(database)).toEqual(rows);
      expect(schemaObjects(database)).toEqual(objects);
      expect(foreignKeys(database)).toEqual(keys);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      const widened = insertPacket(database, 12_288);
      expect(() => insertPacket(database, 12_289)).toThrow(/CHECK/u);
      expect(() => database.prepare("UPDATE conversation_context_packets SET supplement_json = NULL WHERE id = ?").run(widened))
        .toThrow("conversation context packets are immutable");
      insertPacket(database, null);
      expect(() => insertPacket(database, null)).toThrow("conversation context draft limit reached");
      const widenedRows = tableData(database);
      database.prepare("DELETE FROM schema_migrations WHERE version = 110").run();
      migrateRuntimeDatabase(database, 110);
      expect(tableData(database)).toEqual(widenedRows);
      expect(schemaObjects(database)).toEqual(objects);
    } finally { database.close(); }
  });

  it("rolls back the rebuild and its dropped triggers when the replacement cannot be created", async () => {
    const database = await releasedDatabase();
    try {
      database.exec("CREATE TABLE conversation_context_packets_v110 (id TEXT)");
      const objects = schemaObjects(database);
      const rows = tableData(database);
      expect(() => migrateRuntimeDatabase(database, 110)).toThrow();
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 109 });
      expect(schemaObjects(database)).toEqual(objects);
      expect(tableData(database)).toEqual(rows);
      expect(() => insertPacket(database, 8_192)).toThrow(/CHECK/u);
    } finally { database.close(); }
  });
});
