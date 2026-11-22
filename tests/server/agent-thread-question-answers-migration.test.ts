// @inertia-test-suite portable

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION,
  agentThreadQuestionAnswersMigration,
} from "../../src/server/persistence/migrations/agent-thread-question-answers";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";

const NOW = "2030-01-01T00:00:00.000Z";

function insertOperation(database: Database.Database, id: string, toolName: string, target: string | null): void {
  database.prepare(`
    INSERT INTO agent_thread_operations (
      id, source_conversation_id, source_turn_id, source_run_id, tool_call_id_hash, tool_name,
      request_fingerprint, status, child_conversation_id, input_chars, result_json, failure_message,
      created_at, updated_at, target_turn_id, target_run_id
    ) VALUES (?, NULL, NULL, 'source-run', ?, ?, ?, 'completed', NULL, 12, '{"ok":true}', NULL, ?, ?, ?, ?)
  `).run(id.repeat(64), id.repeat(64), toolName, "f".repeat(64), NOW, NOW, target, target);
}

function operationSchema(database: Database.Database): unknown[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name = 'agent_thread_operations' AND type = 'index' ORDER BY name
  `).all();
}

describe("agent thread question answers migration", () => {
  it("appends the widened operation log as schema 119", () => {
    expect(AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION).toBe(119);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === 119)).toMatchObject({
      name: agentThreadQuestionAnswersMigration.name,
      foreignKeys: "off",
    });
  });

  it("keeps every operation, column and index, and then accepts inertia_answer_question", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION - 1);
      insertOperation(database, "a", "inertia_send_message", "child-turn");
      insertOperation(database, "b", "inertia_stop_conversation", null);
      expect(() => insertOperation(database, "c", "inertia_answer_question", null)).toThrow(/CHECK constraint failed/u);
      const before = {
        rows: database.prepare("SELECT * FROM agent_thread_operations ORDER BY id").all(),
        columns: database.pragma("table_info(agent_thread_operations)"),
        foreignKeys: database.pragma("foreign_key_list(agent_thread_operations)"),
        indexes: operationSchema(database),
      };

      migrateRuntimeDatabase(database);

      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      // Orchestrator V2's PersistDelegatedTasks (schema 124) then appends the client request key and its index.
      expect(database.prepare("SELECT * FROM agent_thread_operations ORDER BY id").all())
        .toEqual((before.rows as Record<string, unknown>[]).map((row) => ({ ...row, client_request_key: null })));
      expect((database.pragma("table_info(agent_thread_operations)") as Array<{ name: string }>)
        .filter(({ name }) => name !== "client_request_key")).toEqual(before.columns);
      expect(database.pragma("foreign_key_list(agent_thread_operations)")).toEqual(before.foreignKeys);
      expect((operationSchema(database) as Array<{ name: string }>)
        .filter(({ name }) => name !== "agent_thread_operations_client_request_idx")).toEqual(before.indexes);
      expect(database.pragma("index_list(agent_thread_operations)")).toEqual(expect.arrayContaining([
        expect.objectContaining({ unique: 1, origin: "u" }),
      ]));
      insertOperation(database, "c", "inertia_answer_question", "child-turn");
      expect(() => insertOperation(database, "d", "inertia_delete_everything", null)).toThrow(/CHECK constraint failed/u);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
