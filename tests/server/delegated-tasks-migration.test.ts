// @inertia-test-suite portable
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function schemaObjects(database: Database.Database) {
  return database.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
}

function tableData(database: Database.Database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

function columns(database: Database.Database, table: string): string[] {
  return (database.pragma(`table_info("${table}")`) as { name: string }[]).map(({ name }) => name);
}

interface Fixture {
  database: Database.Database;
  parentId: string;
  childId: string;
  turnId: string;
  runId: string;
}

async function v110WithManagedChats(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-delegated-tasks-"));
  directories.push(directory);
  const path = join(directory, "runtime.sqlite");
  await copyFile(resolve("tests/fixtures/database/v0.0.6.sqlite"), path);
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  migrateRuntimeDatabase(database, 110);
  const parent = database.prepare("SELECT id FROM conversations ORDER BY rowid LIMIT 1").get() as { id: string };
  const turn = database.prepare("SELECT id, run_id FROM agent_turns WHERE conversation_id = ? ORDER BY rowid LIMIT 1")
    .get(parent.id) as { id: string; run_id: string };
  const conversationColumns = columns(database, "conversations").filter((name) => name !== "id").map((name) => `"${name}"`).join(", ");
  const childId = randomUUID();
  database.prepare(`INSERT INTO conversations (id, ${conversationColumns}) SELECT ?, ${conversationColumns} FROM conversations WHERE id = ?`)
    .run(childId, parent.id);
  const now = "2026-10-31T10:00:00.000Z";
  database.prepare(`INSERT INTO agent_managed_conversations (child_conversation_id, source_conversation_id, source_turn_id,
    source_run_id, root_conversation_id, source_harness_id, depth, created_at) VALUES (?, ?, ?, ?, ?, 'codex-app-server', 1, ?)`)
    .run(childId, parent.id, turn.id, turn.run_id, parent.id, now);
  const operation = database.prepare(`INSERT INTO agent_thread_operations (id, source_conversation_id, source_turn_id, source_run_id,
    tool_call_id_hash, tool_name, request_fingerprint, status, child_conversation_id, input_chars, result_json, failure_message,
    created_at, updated_at, target_turn_id, target_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  operation.run(digest("create"), parent.id, turn.id, turn.run_id, digest("call-1"), "inertia_create_conversation", digest("f1"),
    "completed", childId, 42, "{\"ok\":true}", null, now, now, null, null);
  operation.run(digest("send"), parent.id, turn.id, turn.run_id, digest("call-2"), "inertia_send_message", digest("f2"),
    "interrupted", childId, 7, null, "The host restarted before this operation settled.", now, now, null, null);
  database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity,
    state, created_at, watcher_note_json) VALUES (?, ?, 'queued', '[]', ?, '[]', 'waiting', ?, NULL)`)
    .run(randomUUID(), parent.id, digest("queued"), now);
  return { database, parentId: parent.id, childId, turnId: turn.id, runId: turn.run_id };
}

function insertOperation(fixture: Fixture, tool: string, key: string | null, suffix = randomUUID()) {
  const now = "2026-10-31T11:00:00.000Z";
  fixture.database.prepare(`INSERT INTO agent_thread_operations (id, source_conversation_id, source_turn_id, source_run_id,
    tool_call_id_hash, tool_name, request_fingerprint, status, child_conversation_id, input_chars, created_at, updated_at,
    client_request_key) VALUES (?, ?, ?, ?, ?, ?, ?, 'approval-pending', NULL, 0, ?, ?, ?)`)
    .run(digest(`op-${suffix}`), fixture.parentId, fixture.turnId, fixture.runId, digest(`call-${suffix}`), tool,
      digest("fingerprint"), now, now, key);
}

function insertDelivery(fixture: Fixture, attribution: unknown, options: { watcher?: boolean; state?: string } = {}) {
  fixture.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity,
    state, created_at, watcher_note_json, delegated_completion_json) VALUES (?, ?, 'results', '[]', ?, '[]', ?, ?, ?, ?)`)
    .run(randomUUID(), fixture.parentId, digest("results"), options.state ?? "waiting", "2026-10-31T12:00:00.000Z",
      options.watcher ? JSON.stringify({ automatic: true }) : null, typeof attribution === "string" ? attribution : JSON.stringify(attribution));
}

describe("delegated task migration", () => {
  it("upgrades managed chats and operations without inventing tasks or wake authority", async () => {
    const fixture = await v110WithManagedChats();
    const { database } = fixture;
    try {
      const before = tableData(database);
      const objects = schemaObjects(database);
      const keys = database.pragma("foreign_key_list(agent_thread_operations)");
      migrateRuntimeDatabase(database, 111);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 111 });
      const after = tableData(database);
      expect(after.agent_managed_conversations).toEqual(before.agent_managed_conversations);
      expect(after.agent_thread_operations).toEqual((before.agent_thread_operations as Record<string, unknown>[])
        .map((row) => ({ ...row, client_request_key: null })));
      expect(after.queued_messages).toEqual((before.queued_messages as Record<string, unknown>[])
        .map((row) => ({ ...row, delegated_completion_json: null })));
      expect(after.delegated_tasks).toEqual([]);
      expect(after.delegated_task_turns).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM orchestration_v2_entities WHERE kind LIKE 'delegat%'").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM orchestration_v2_events WHERE type LIKE 'delegation.%'").get())
        .toEqual({ count: 0 });
      expect(database.pragma("foreign_key_list(agent_thread_operations)")).toEqual(keys);
      const upgraded = schemaObjects(database) as { name: string; sql: string }[];
      for (const object of objects as { name: string; sql: string }[]) expect(upgraded).toContainEqual(object);
      expect(upgraded.map(({ name }) => name)).toEqual(expect.arrayContaining(["agent_thread_operations_client_request_idx",
        "queued_messages_delegated_delivery_idx", "delegated_tasks_parent_delivery_idx", "delegated_tasks_child_status_idx",
        "delegated_tasks_source_turn_idx", "delegated_task_turns_task_idx"]));
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_managed_conversations'").get())
        .toEqual({ sql: expect.stringContaining("depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 2)") });
      expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_thread_operations'").get())
        .toEqual({ sql: expect.stringContaining("UNIQUE(source_turn_id, tool_call_id_hash)") });

      insertOperation(fixture, "inertia_delegate_task", digest("client-1"));
      insertOperation(fixture, "inertia_cancel_task", null);
      insertOperation(fixture, "inertia_cancel_task", null);
      expect(() => insertOperation(fixture, "inertia_delegate_task", digest("client-1"))).toThrow(/UNIQUE/u);
      expect(() => insertOperation(fixture, "inertia_wait_for_task", null)).toThrow(/CHECK/u);
      expect(() => insertOperation(fixture, "inertia_delegate_task", "short")).toThrow(/CHECK/u);

      const attribution = { parentConversationId: randomUUID(), generation: 1, taskIds: [digest("task")] };
      insertDelivery(fixture, attribution);
      expect(() => insertDelivery(fixture, attribution)).toThrow(/UNIQUE/u);
      insertDelivery(fixture, attribution, { state: "cancelled" });
      for (const invalid of [{ ...attribution, taskIds: [] }, { ...attribution, generation: 0 }, { generation: 1, taskIds: ["x"] },
        { ...attribution, taskIds: Array.from({ length: 17 }, (_value, index) => digest(String(index))) },
        { ...attribution, padding: "x".repeat(1_024) }, "not json"]) {
        expect(() => insertDelivery(fixture, invalid, { state: "cancelled" })).toThrow(/CHECK/u);
      }
      expect(() => insertDelivery(fixture, attribution, { watcher: true, state: "cancelled" })).toThrow(/CHECK/u);
      const message = database.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at, attachments_json,
        delegated_completion_json) VALUES (?, ?, ?, 'results', '2026-10-31T12:00:00.000Z', '[]', ?)`);
      message.run(randomUUID(), fixture.parentId, "user", JSON.stringify(attribution));
      expect(() => message.run(randomUUID(), fixture.parentId, "assistant", JSON.stringify(attribution))).toThrow(/CHECK/u);
      expect(() => database.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at, attachments_json,
        watcher_note_json, delegated_completion_json) VALUES (?, ?, 'user', 'both', '2026-10-31T12:00:00.000Z', '[]', '{}', ?)`)
        .run(randomUUID(), fixture.parentId, JSON.stringify(attribution))).toThrow(/CHECK/u);

      const rerunRows = tableData(database);
      const rerunObjects = schemaObjects(database);
      database.prepare("DELETE FROM schema_migrations WHERE version = 111").run();
      migrateRuntimeDatabase(database, 111);
      expect(tableData(database)).toEqual(rerunRows);
      expect(schemaObjects(database)).toEqual(rerunObjects);
    } finally { database.close(); }
  });

  it("rolls the whole upgrade back when the operation rebuild cannot be created", async () => {
    const { database } = await v110WithManagedChats();
    try {
      database.exec("CREATE TABLE agent_thread_operations_v111 (id TEXT)");
      const rows = tableData(database);
      const objects = schemaObjects(database);
      const operationSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_thread_operations'").get();
      expect(() => migrateRuntimeDatabase(database, 111)).toThrow();
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 110 });
      expect(tableData(database)).toEqual(rows);
      expect(schemaObjects(database)).toEqual(objects);
      expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_thread_operations'").get()).toEqual(operationSql);
      expect(columns(database, "queued_messages")).not.toContain("delegated_completion_json");
      expect(columns(database, "messages")).not.toContain("delegated_completion_json");
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('delegated_tasks','delegated_task_turns')").all()).toEqual([]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { database.close(); }
  });

  it("refuses an operation schema it does not recognize", async () => {
    const { database } = await v110WithManagedChats();
    try {
      database.pragma("foreign_keys = OFF");
      database.exec(`ALTER TABLE agent_thread_operations RENAME TO agent_thread_operations_old;
        CREATE TABLE agent_thread_operations (id TEXT PRIMARY KEY, tool_name TEXT NOT NULL CHECK (tool_name IN ('inertia_other')));`);
      database.pragma("foreign_keys = ON");
      expect(() => migrateRuntimeDatabase(database, 111)).toThrow();
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 110 });
    } finally { database.close(); }
  });
});
