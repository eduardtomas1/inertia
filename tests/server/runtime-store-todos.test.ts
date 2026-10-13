import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { TodoRepository, TodoRepositoryError } from "../../src/server/persistence/todo-repository";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { MAX_TODOS } from "../../src/shared/todos";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-todo-store-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  stores.push(store);
  return { store, directory, databasePath };
}

describe("RuntimeStore tasks", () => {
  it("creates the todos table at the current schema version", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(96);
      expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(96);
      expect((database.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual([
        "id", "title", "note", "priority", "due_date", "completed_at", "conversation_id", "created_at", "updated_at",
      ]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todos_conversation_idx'").get())
        .toEqual({ name: "todos_conversation_idx" });
    } finally {
      database.close();
    }
  });

  it("creates, lists, updates, completes, reopens and deletes tasks through both snapshots", async () => {
    const { store, databasePath, directory } = await openStore();
    expect(store.snapshot().todos).toEqual([]);
    expect(store.shellSnapshot().todos).toEqual([]);
    const firstId = randomUUID();
    const first = store.todos.create({ id: firstId, title: "  Write the release notes  " });
    expect(first).toMatchObject({
      id: firstId, title: "Write the release notes", note: "", priority: null, dueDate: null,
      completedAt: null, conversationId: null,
    });
    expect(first.createdAt).toBe(first.updatedAt);
    const second = store.todos.create({ id: randomUUID(), title: "Fix the flaky test", note: "Only on Linux.", priority: "urgent", dueDate: "2026-10-13" });
    expect(store.todos.list().map(({ id }) => id)).toEqual([first.id, second.id]);

    const updated = store.todos.update(first.id, { title: "Write notes", note: "Short.", priority: "high", dueDate: "2026-10-20" });
    expect(updated).toMatchObject({ title: "Write notes", note: "Short.", priority: "high", dueDate: "2026-10-20", completedAt: null });
    const cleared = store.todos.update(first.id, { priority: null, dueDate: null });
    expect(cleared).toMatchObject({ title: "Write notes", note: "Short.", priority: null, dueDate: null });

    const completed = store.todos.update(first.id, { completed: true });
    expect(completed.completedAt).not.toBeNull();
    expect(store.todos.update(first.id, { completed: true }).completedAt).toBe(completed.completedAt);
    expect(store.todos.update(first.id, { completed: false }).completedAt).toBeNull();

    store.todos.delete(second.id);
    expect(store.snapshot().todos?.map(({ id }) => id)).toEqual([first.id]);
    expect(store.shellSnapshot().todos?.map(({ id }) => id)).toEqual([first.id]);
    const current = store.todos.list();
    store.close();
    stores.splice(0);

    const reopened = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    stores.push(reopened);
    expect(reopened.snapshot().todos).toEqual(current);
  });

  it("orders tasks by creation time, then by id", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    try {
      let at = "2026-10-12T10:00:00.000Z";
      const repository = new TodoRepository(raw, () => at);
      const ids = ["c", "a", "b"].map((prefix) => `${prefix.repeat(8)}-1111-4111-8111-111111111111`);
      for (const id of ids) repository.create({ id, title: id });
      at = "2026-10-12T09:00:00.000Z";
      const earlier = repository.create({ id: randomUUID(), title: "Earlier" });
      expect(repository.list().map(({ id }) => id)).toEqual([earlier.id, ids[1], ids[2], ids[0]]);
    } finally {
      raw.close();
    }
  });

  it("links a task to a chat, reopens it and clears the link when the chat is deleted", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Tasks", directory);
    const conversation = store.createConversation(project.id, "Task chat");
    const todo = store.todos.create({ id: randomUUID(), title: "Hand off" });
    store.todos.update(todo.id, { completed: true });
    const linked = store.todos.link(todo.id, conversation.id);
    expect(linked).toMatchObject({ conversationId: conversation.id, completedAt: null });
    expect(() => store.todos.link(todo.id, conversation.id)).toThrow("That task is already handed to an agent.");

    store.deleteConversation(conversation.id);
    expect(store.todos.list()[0]).toMatchObject({ id: todo.id, conversationId: null });
  });

  it("rejects missing tasks with renderer-visible errors", async () => {
    const { store } = await openStore();
    const missing = randomUUID();
    for (const operation of [
      () => store.todos.update(missing, { title: "Nope" }),
      () => store.todos.delete(missing),
      () => store.todos.link(missing, randomUUID()),
    ]) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TodoRepositoryError);
      expect(publicRuntimeError(failure)).toBe("That task no longer exists.");
    }
  });

  it("rejects invalid titles, notes, dates, ids and duplicate ids", async () => {
    const { store } = await openStore();
    const id = randomUUID();
    store.todos.create({ id, title: "Original" });
    for (const input of [
      { id: randomUUID(), title: "   " },
      { id: randomUUID(), title: "x".repeat(201) },
      { id: randomUUID(), title: "Two\nlines" },
      { id: randomUUID(), title: "Note", note: "n".repeat(2_001) },
      { id: randomUUID(), title: "Note", note: "nul\0" },
      { id: randomUUID(), title: "Date", dueDate: "2026-02-30" },
      { id: randomUUID(), title: "Date", dueDate: "2026-10-12T00:00:00.000Z" },
      { id: randomUUID(), title: "Priority", priority: "soon" as never },
      { id: "not-a-uuid", title: "Id" },
      { id, title: "Duplicate" },
    ]) {
      expect(() => store.todos.create(input)).toThrow(TodoRepositoryError);
    }
    for (const patch of [
      {},
      { title: "" },
      { note: "n".repeat(2_001) },
      { dueDate: "2026-13-01" },
    ]) {
      expect(() => store.todos.update(id, patch)).toThrow(TodoRepositoryError);
    }
    expect(store.todos.list()).toHaveLength(1);
    expect(store.todos.list()[0]).toMatchObject({ id, title: "Original" });
  });

  it("enforces the task count limit in the repository and the database", async () => {
    const { store, databasePath } = await openStore();
    for (let index = 0; index < MAX_TODOS; index += 1) {
      store.todos.create({ id: randomUUID(), title: `Task ${index}` });
    }
    expect(() => store.todos.create({ id: randomUUID(), title: "One more" }))
      .toThrow(`Tasks are limited to ${MAX_TODOS}.`);
    const raw = new Database(databasePath);
    try {
      expect(() => raw.prepare(`
        INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
        VALUES (?, 'Raw', '', NULL, NULL, NULL, NULL, ?, ?)
      `).run(randomUUID(), new Date().toISOString(), new Date().toISOString())).toThrow("task count limit exceeded");
    } finally {
      raw.close();
    }
    expect(store.todos.list()).toHaveLength(MAX_TODOS);
  });

  it("keeps the serialized task list within the snapshot bound", async () => {
    const { store } = await openStore();
    const note = "\u0001".repeat(2_000);
    let failure: unknown;
    for (let index = 0; index < MAX_TODOS && !failure; index += 1) {
      try {
        store.todos.create({ id: randomUUID(), title: `Task ${index}`, note });
      } catch (error) {
        failure = error;
      }
    }
    expect(failure).toBeInstanceOf(TodoRepositoryError);
    expect((failure as Error).message).toBe("Tasks exceed the safe local storage limit.");
    const last = store.todos.list().at(-1)!;
    store.todos.update(last.id, { note: "" });
    expect(() => store.todos.update(last.id, { note })).not.toThrow();
    expect(() => store.todos.create({ id: randomUUID(), title: "Overflow", note })).toThrow("Tasks exceed the safe local storage limit.");
  });

  it("rejects rows that bypass the schema at the database boundary", async () => {
    const { databasePath, store } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    const insert = raw.prepare(`
      INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
      VALUES (@id, @title, @note, @priority, @dueDate, NULL, @conversationId, @at, @at)
    `);
    const valid = { id: randomUUID(), title: "Valid", note: "", priority: null, dueDate: null, conversationId: null, at: new Date().toISOString() };
    try {
      for (const row of [
        { ...valid, id: "short" },
        { ...valid, title: " " },
        { ...valid, title: "x".repeat(201) },
        { ...valid, title: "a\rb" },
        { ...valid, note: "n".repeat(2_001) },
        { ...valid, priority: "soon" },
        { ...valid, dueDate: "2026-1-1" },
        { ...valid, conversationId: randomUUID() },
      ]) {
        expect(() => insert.run(row)).toThrow();
      }
      expect(() => insert.run(valid)).not.toThrow();
    } finally {
      raw.close();
    }
  });
});
