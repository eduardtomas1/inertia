import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import {
  TODO_SOURCE_CONVERSATION_SCHEMA_VERSION,
  todoSourceConversationMigration,
} from "../../src/server/persistence/migrations/todo-source-conversation";
import { TodoRepository } from "../../src/server/persistence/todo-repository";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "inertia-todo-source-"));
  directories.push(created);
  return created;
}

function columns(database: Database.Database): string[] {
  return (database.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>).map(({ name }) => name);
}

function runMigration(database: Database.Database): void {
  const up = todoSourceConversationMigration.up;
  if (typeof up === "string") throw new Error("The source chat migration is a callback.");
  database.transaction(() => up(database, {
    sourceSchemaVersion: TODO_SOURCE_CONVERSATION_SCHEMA_VERSION - 1,
  } as never))();
}

describe("PersistTodoSourceConversation migration", () => {
  it("is schema 108, appended after the managed context read rebuild", () => {
    expect(TODO_SOURCE_CONVERSATION_SCHEMA_VERSION).toBe(108);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(TODO_SOURCE_CONVERSATION_SCHEMA_VERSION);
    expect(todoSourceConversationMigration.name).toBe("PersistTodoSourceConversation");
    expect(todoSourceConversationMigration.foreignKeys).toBeUndefined();
  });

  it("upgrades a schema 107 task table in place and keeps every row and hand-off link", async () => {
    const root = await directory();
    const databasePath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    const project = store.createProject("Billing", root);
    const chat = store.createConversation(project.id, "Release prep", { activate: false });
    store.close();

    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      DROP INDEX todos_source_conversation_idx;
      ALTER TABLE todos DROP COLUMN source_conversation_id;
    `);
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(TODO_SOURCE_CONVERSATION_SCHEMA_VERSION);
    expect(columns(legacy)).not.toContain("source_conversation_id");
    const at = "2026-10-20T09:00:00.000Z";
    const linked = randomUUID();
    const plain = randomUUID();
    legacy.prepare(`
      INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at,
        due_time, project_id, linked_at)
      VALUES (?, 'Handed off', '', NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?)
    `).run(linked, chat.id, at, at, project.id, at);
    legacy.prepare(`
      INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
      VALUES (?, 'Plain', 'Keep me', 'high', NULL, NULL, NULL, ?, ?)
    `).run(plain, at, at);
    const before = legacy.prepare("SELECT * FROM todos ORDER BY id").all();
    legacy.close();

    const upgraded = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    expect(upgraded.todos.get(linked)).toMatchObject({
      conversationId: chat.id, linkedAt: at, projectId: project.id, sourceConversationId: null,
    });
    expect(upgraded.todos.get(plain)).toMatchObject({ note: "Keep me", conversationId: null, sourceConversationId: null });
    upgraded.close();

    const inspected = new Database(databasePath);
    try {
      expect(inspected.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ?")
        .get(TODO_SOURCE_CONVERSATION_SCHEMA_VERSION)).toEqual({ applied: 1 });
      expect(columns(inspected).at(-1)).toBe("source_conversation_id");
      expect(inspected.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todos_source_conversation_idx'",
      ).get()).toEqual({ name: "todos_source_conversation_idx" });
      expect((inspected.prepare("SELECT * FROM todos ORDER BY id").all() as Array<Record<string, unknown>>)
        .map(({ source_conversation_id: source, ...row }) => {
          expect(source).toBeNull();
          return row;
        })).toEqual(before);
      expect(inspected.pragma("foreign_key_check")).toEqual([]);
    } finally {
      inspected.close();
    }
  });

  it("clears the source when the chat is deleted and rejects malformed or unknown chats", async () => {
    const root = await directory();
    const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Billing", root);
      const chat = store.createConversation(project.id, "Release prep", { activate: false });
      const id = randomUUID();
      store.todos.create({ id, title: "From the chat", projectId: project.id, sourceConversationId: chat.id });
      expect(store.todos.get(id)).toMatchObject({ sourceConversationId: chat.id, conversationId: null, linkedAt: null });

      const database = (store as unknown as { database: Database.Database }).database;
      const at = "2026-10-20T09:00:00.000Z";
      const insert = database.prepare(`
        INSERT INTO todos (id, title, note, created_at, updated_at, source_conversation_id)
        VALUES (?, 'Raw', '', ?, ?, ?)
      `);
      expect(() => insert.run(randomUUID(), at, at, "short")).toThrow(/CHECK constraint failed|FOREIGN KEY/u);
      expect(() => insert.run(randomUUID(), at, at, randomUUID())).toThrow(/FOREIGN KEY constraint failed/u);

      store.deleteConversation(chat.id);
      expect(store.todos.get(id)).toMatchObject({ sourceConversationId: null, title: "From the chat" });
    } finally {
      store.close();
    }
  });

  it("is idempotent and refuses a source column with an unexpected shape", async () => {
    const root = await directory();
    const database = new Database(join(root, "inertia.sqlite"));
    try {
      database.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(database, TODO_SOURCE_CONVERSATION_SCHEMA_VERSION - 1);
      expect(columns(database)).not.toContain("source_conversation_id");
      runMigration(database);
      runMigration(database);
      expect(columns(database).filter((name) => name === "source_conversation_id")).toHaveLength(1);
      expect(new TodoRepository(database).list()).toEqual([]);
    } finally {
      database.close();
    }

    const malformed = new Database(join(root, "malformed.sqlite"));
    try {
      malformed.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(malformed, TODO_SOURCE_CONVERSATION_SCHEMA_VERSION - 1);
      malformed.exec("ALTER TABLE todos ADD COLUMN source_conversation_id INTEGER");
      expect(() => runMigration(malformed)).toThrow("Unexpected task column.");
    } finally {
      malformed.close();
    }
  });
});
