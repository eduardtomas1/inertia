import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { RuntimeStore } from "../../../src/server/database";
import { migrateRuntimeDatabase } from "../../../src/server/persistence/migrations/runtime-catalog";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime } from "../../support/turn-controller-runtime";

const deviceId = "33333333-3333-4333-8333-333333333333";
afterEach(cleanupTurnControllerTestDirectories);

it("persists remote origin with the queued user message and preserves it after restart", async () => {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId,
    content: "A remotely submitted request", privateConnectDeviceId: deviceId });
  expect(queued.message.privateConnectDeviceId).toBe(deviceId);
  expect(runtime.store.message(queued.message.id).privateConnectDeviceId).toBe(deviceId);
  expect(runtime.store.conversationDetail(runtime.conversationId)?.messages)
    .toContainEqual(expect.objectContaining({ id: queued.message.id, privateConnectDeviceId: deviceId }));
  runtime.store.close();
  const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
  try { expect(reopened.message(queued.message.id).privateConnectDeviceId).toBe(deviceId); }
  finally { reopened.close(); }
});

it("rejects invalid device attribution without committing a message or turn", async () => {
  const runtime = await createTurnControllerTestRuntime();
  try {
    const before = runtime.store.conversationDetail(runtime.conversationId)!;
    expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
      content: "Do not commit", privateConnectDeviceId: "not-a-device" })).toThrow("Invalid remote message origin");
    expect(runtime.store.conversationDetail(runtime.conversationId)!.messages).toEqual(before.messages);
    expect(runtime.store.conversationDetail(runtime.conversationId)!.agentTurns).toEqual(before.agentTurns);
    const local = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Local request" });
    expect(local.message).not.toHaveProperty("privateConnectDeviceId");
  } finally { runtime.store.close(); }
});

it("appends origin metadata to schema 74 without rewriting old messages or lineage", () => {
  const database = new Database(":memory:");
  try {
    migrateRuntimeDatabase(database, 74);
    const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    database.exec(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
        VALUES ('p', 'Project', '/synthetic', '#888888', 'ready', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, project_id, title, created_at, updated_at)
        VALUES ('c', 'p', 'Conversation', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES ('m', 'c', 'user', 'Existing message', '2030-01-01T00:00:00.000Z');
    `);
    const messages = database.prepare("SELECT * FROM messages").all() as Record<string, unknown>[];
    migrateRuntimeDatabase(database);
    expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 74 ORDER BY version").all()).toEqual(history);
    expect(database.prepare("SELECT * FROM messages").all())
      .toEqual(messages.map((message) => ({ ...message, private_connect_device_id: null })));
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally { database.close(); }
});
