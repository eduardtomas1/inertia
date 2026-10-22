import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { todosCountLimitTriggerIsValid } from "../../src/server/persistence/todos-schema";
import { TodoRepository, TodoRepositoryError } from "../../src/server/persistence/todo-repository";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { MAX_DONE_TODOS, MAX_OPEN_TODOS } from "../../src/shared/todos";

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
      expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect((database.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual([
        "id", "title", "note", "priority", "due_date", "completed_at", "conversation_id", "created_at", "updated_at",
        "due_time", "project_id", "linked_at",
      ]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todos_conversation_idx'").get())
        .toEqual({ name: "todos_conversation_idx" });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todos_project_idx'").get())
        .toEqual({ name: "todos_project_idx" });
    } finally {
      database.close();
    }
  });

  it("upgrades a schema 98 task table: existing rows read back with empty new fields and only open rows count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-todo-upgrade-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    const raw = new Database(databasePath);
    try {
      raw.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(raw, 98);
      expect((raw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(98);
      const insert98 = raw.prepare(`
        INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `);
      const at = "2026-10-20T09:00:00.000Z";
      const openId = randomUUID();
      const doneId = randomUUID();
      insert98.run(openId, "Open before the upgrade", "Keep me", "high", "2026-10-22", null, at, at);
      insert98.run(doneId, "Done before the upgrade", "", null, null, "2026-10-20T10:00:00.000Z", at, at);

      migrateRuntimeDatabase(raw);

      expect((raw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(raw.prepare("SELECT due_time, project_id, linked_at FROM todos ORDER BY id").all())
        .toEqual([
          { due_time: null, project_id: null, linked_at: null },
          { due_time: null, project_id: null, linked_at: null },
        ]);
      const repository = new TodoRepository(raw);
      expect(repository.get(openId)).toEqual({
        id: openId, title: "Open before the upgrade", note: "Keep me", priority: "high", dueDate: "2026-10-22",
        dueTime: null, projectId: null, completedAt: null, conversationId: null, linkedAt: null,
        createdAt: at, updatedAt: at,
      });
      expect(repository.get(doneId)).toMatchObject({ dueTime: null, projectId: null, linkedAt: null, completedAt: "2026-10-20T10:00:00.000Z" });
      expect(todosCountLimitTriggerIsValid(raw)).toBe(true);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todos_project_idx'").get())
        .toEqual({ name: "todos_project_idx" });

      const insert = raw.prepare(`
        INSERT INTO todos (id, title, note, completed_at, created_at, updated_at)
        VALUES (?, 'Raw', '', ?, ?, ?)
      `);
      for (let index = 0; index < MAX_DONE_TODOS - 1; index += 1) insert.run(randomUUID(), at, at, at);
      for (let index = 0; index < MAX_OPEN_TODOS - 2; index += 1) insert.run(randomUUID(), null, at, at);
      expect(() => insert.run(randomUUID(), null, at, at)).not.toThrow();
      expect(raw.prepare("SELECT COUNT(*) AS count FROM todos WHERE completed_at IS NULL").get()).toEqual({ count: MAX_OPEN_TODOS });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM todos WHERE completed_at IS NOT NULL").get()).toEqual({ count: MAX_DONE_TODOS });
      expect(() => insert.run(randomUUID(), null, at, at)).toThrow("task count limit exceeded");
      expect(() => insert.run(randomUUID(), at, at, at)).not.toThrow();
    } finally {
      raw.close();
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
      dueTime: null, projectId: null, completedAt: null, conversationId: null, linkedAt: null,
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

  it("links a task to a chat, stamps the link time, takes the chat's project and clears the link when the chat is deleted", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Tasks", directory);
    const conversation = store.createConversation(project.id, "Task chat");
    const todo = store.todos.create({ id: randomUUID(), title: "Hand off" });
    const before = Date.now();
    const linked = store.todos.link(todo.id, conversation.id);
    expect(linked).toMatchObject({ conversationId: conversation.id, completedAt: null, projectId: project.id });
    expect(Date.parse(linked.linkedAt!)).toBeGreaterThanOrEqual(before);
    expect(store.todos.get(todo.id)).toEqual(linked);
    expect(() => store.todos.link(todo.id, conversation.id)).toThrow("That task is already handed to an agent.");

    store.deleteConversation(conversation.id);
    expect(store.todos.list()[0]).toMatchObject({ id: todo.id, conversationId: null });
  });

  it("refuses to hand off a done task", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Tasks", directory);
    const conversation = store.createConversation(project.id, "Task chat");
    const todo = store.todos.create({ id: randomUUID(), title: "Already done" });
    store.todos.update(todo.id, { completed: true });
    expect(() => store.todos.link(todo.id, conversation.id)).toThrow("Reopen the task before handing it off.");
    expect(store.todos.get(todo.id)).toMatchObject({ conversationId: null, linkedAt: null });
    expect(store.todos.get(todo.id)?.completedAt).not.toBeNull();
  });

  it("re-links a task only when it still points at the chat it replaces", async () => {
    const { store, directory } = await openStore();
    const first = store.createProject("First", directory);
    const second = store.createProject("Second", directory);
    const original = store.createConversation(first.id, "Original");
    const retry = store.createConversation(second.id, "Retry");
    const elsewhere = store.createConversation(second.id, "Elsewhere");
    const todo = store.todos.create({ id: randomUUID(), title: "Retry me" });
    const initial = store.todos.link(todo.id, original.id);

    expect(() => store.todos.link(todo.id, retry.id, { replaces: elsewhere.id }))
      .toThrow("This task was handed off somewhere else in the meantime.");
    expect(store.todos.get(todo.id)).toEqual(initial);

    const relinked = store.todos.link(todo.id, retry.id, { replaces: original.id });
    expect(relinked).toMatchObject({ conversationId: retry.id, projectId: second.id });
    expect(relinked.linkedAt! >= initial.linkedAt!).toBe(true);
    expect(() => store.todos.link(todo.id, elsewhere.id, { replaces: original.id }))
      .toThrow("This task was handed off somewhere else in the meantime.");
    expect(store.conversation(original.id)).toBeTruthy();

    const unlinked = store.todos.create({ id: randomUUID(), title: "Never handed off" });
    expect(() => store.todos.link(unlinked.id, retry.id, { replaces: original.id }))
      .toThrow("This task was handed off somewhere else in the meantime.");
  });

  it("stores a due time with its day, clears it with the day and refuses a time without a day", async () => {
    const { store } = await openStore();
    const todo = store.todos.create({ id: randomUUID(), title: "Call", dueDate: "2026-10-22", dueTime: "15:00" });
    expect(todo).toMatchObject({ dueDate: "2026-10-22", dueTime: "15:00" });
    expect(store.todos.get(todo.id)).toMatchObject({ dueDate: "2026-10-22", dueTime: "15:00" });
    expect(store.todos.update(todo.id, { dueDate: "2026-10-23" })).toMatchObject({ dueDate: "2026-10-23", dueTime: "15:00" });
    expect(store.todos.update(todo.id, { dueTime: "09:30" })).toMatchObject({ dueDate: "2026-10-23", dueTime: "09:30" });
    expect(store.todos.update(todo.id, { dueTime: null })).toMatchObject({ dueDate: "2026-10-23", dueTime: null });
    store.todos.update(todo.id, { dueTime: "18:45" });

    expect(store.todos.update(todo.id, { dueDate: null })).toMatchObject({ dueDate: null, dueTime: null });
    expect(store.todos.get(todo.id)).toMatchObject({ dueDate: null, dueTime: null });

    for (const operation of [
      () => store.todos.update(todo.id, { dueTime: "15:00" }),
      () => store.todos.update(todo.id, { dueDate: null, dueTime: "15:00" }),
      () => store.todos.create({ id: randomUUID(), title: "Time only", dueTime: "15:00" }),
    ]) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TodoRepositoryError);
      expect((failure as Error).message).toBe("Add a day before a time.");
    }
    expect(() => store.todos.update(todo.id, { dueDate: "2026-10-24", dueTime: "24:00" })).toThrow(TodoRepositoryError);
    expect(store.todos.get(todo.id)).toMatchObject({ dueDate: null, dueTime: null });
  });

  it("assigns tasks to existing projects and nulls them when the project goes away", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Tasks", directory);
    const todo = store.todos.create({ id: randomUUID(), title: "Scoped", projectId: project.id });
    expect(todo.projectId).toBe(project.id);
    expect(store.todos.update(todo.id, { projectId: null }).projectId).toBeNull();
    expect(store.todos.update(todo.id, { projectId: project.id }).projectId).toBe(project.id);
    for (const operation of [
      () => store.todos.update(todo.id, { projectId: randomUUID() }),
      () => store.todos.create({ id: randomUUID(), title: "Lost", projectId: randomUUID() }),
    ]) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TodoRepositoryError);
      expect(publicRuntimeError(failure)).toBe("That project no longer exists.");
    }
    store.removeProject(project.id);
    expect(store.todos.get(todo.id)?.projectId).toBeNull();
  });

  it("rejects missing tasks with renderer-visible errors", async () => {
    const { store } = await openStore();
    const missing = randomUUID();
    for (const operation of [
      () => store.todos.update(missing, { title: "Nope" }),
      () => store.todos.delete(missing),
      () => store.todos.link(missing, randomUUID()),
      () => store.todos.link(missing, randomUUID(), { replaces: randomUUID() }),
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

  it("limits open tasks in the repository and the database while done tasks do not count", async () => {
    const { store, databasePath } = await openStore();
    const ids: string[] = [];
    for (let index = 0; index < MAX_OPEN_TODOS; index += 1) {
      ids.push(store.todos.create({ id: randomUUID(), title: `Task ${index}` }).id);
    }
    let failure: unknown;
    try { store.todos.create({ id: randomUUID(), title: "One more" }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TodoRepositoryError);
    expect(publicRuntimeError(failure)).toBe("You have 200 open tasks. Finish or delete some first.");
    const raw = new Database(databasePath);
    const insert = raw.prepare(`
      INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
      VALUES (?, 'Raw', '', NULL, NULL, ?, NULL, ?, ?)
    `);
    const at = new Date().toISOString();
    try {
      expect(() => insert.run(randomUUID(), null, at, at)).toThrow("task count limit exceeded");
      expect(() => insert.run(randomUUID(), at, at, at)).not.toThrow();
    } finally {
      raw.close();
    }

    store.todos.update(ids[0]!, { completed: true });
    const reopened = store.todos.create({ id: randomUUID(), title: "Room again" });
    expect(() => store.todos.update(ids[0]!, { completed: false }))
      .toThrow("You have 200 open tasks. Finish or delete some first.");
    store.todos.delete(reopened.id);
    expect(store.todos.update(ids[0]!, { completed: false }).completedAt).toBeNull();
    expect(store.todos.list().filter(({ completedAt }) => completedAt === null)).toHaveLength(MAX_OPEN_TODOS);
  });

  it("keeps only the newest done tasks after a completion and clears done tasks on request", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    try {
      let at = "2026-10-21T10:00:00.000Z";
      const repository = new TodoRepository(raw, () => at);
      const insert = raw.prepare(`
        INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
        VALUES (?, ?, '', NULL, NULL, ?, NULL, ?, ?)
      `);
      const doneIds = Array.from({ length: MAX_DONE_TODOS }, (_, index) => {
        const id = randomUUID();
        const completedAt = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
        insert.run(id, `Done ${index}`, completedAt, completedAt, completedAt);
        return id;
      });
      const open = repository.create({ id: randomUUID(), title: "Still open" });
      expect(repository.list()).toHaveLength(MAX_DONE_TODOS + 1);

      at = "2026-10-21T11:00:00.000Z";
      const finished = repository.create({ id: randomUUID(), title: "Finish me" });
      at = "2026-10-21T12:00:00.000Z";
      repository.update(finished.id, { completed: true });
      const done = repository.list().filter(({ completedAt }) => completedAt !== null).map(({ id }) => id);
      expect(done).toHaveLength(MAX_DONE_TODOS);
      expect(done).toContain(finished.id);
      expect(done).not.toContain(doneIds[0]);
      expect(done).toContain(doneIds[1]);
      expect(repository.get(open.id)).toMatchObject({ completedAt: null });

      expect(repository.clearDone()).toBe(MAX_DONE_TODOS);
      expect(repository.list().map(({ id }) => id)).toEqual([open.id]);
      expect(repository.clearDone()).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("leaves a corrupt row out of the list and warns once about it", async () => {
    const { store, databasePath } = await openStore();
    const valid = store.todos.create({ id: randomUUID(), title: "Valid" });
    store.close();
    stores.splice(0);
    const corruptId = randomUUID();
    const raw = new Database(databasePath);
    try {
      raw.prepare(`
        INSERT INTO todos (id, title, note, priority, due_date, completed_at, conversation_id, created_at, updated_at)
        VALUES (?, 'Corrupt', '', NULL, '2026-02-30', NULL, NULL, ?, ?)
      `).run(corruptId, valid.createdAt, valid.createdAt);
    } finally {
      raw.close();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const reopened = new RuntimeStore(databasePath, join(databasePath, ".."), { recoverInterruptedRuns: false });
      stores.push(reopened);
      expect(reopened.todos.list().map(({ id }) => id)).toEqual([valid.id]);
      expect(reopened.snapshot().todos?.map(({ id }) => id)).toEqual([valid.id]);
      expect(reopened.todos.get(corruptId)).toBeNull();
      expect(() => reopened.todos.update(corruptId, { title: "Fix" })).toThrow("That task no longer exists.");
      const warnings = warn.mock.calls.filter(([message]) => String(message).includes(corruptId));
      expect(warnings).toHaveLength(1);
      reopened.todos.delete(corruptId);
      expect(reopened.todos.list().map(({ id }) => id)).toEqual([valid.id]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the serialized task list within the snapshot bound", async () => {
    const { store } = await openStore();
    const note = "\u0001".repeat(2_000);
    let failure: unknown;
    for (let index = 0; index < MAX_OPEN_TODOS && !failure; index += 1) {
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
      INSERT INTO todos (id, title, note, priority, due_date, due_time, project_id, completed_at, conversation_id, linked_at, created_at, updated_at)
      VALUES (@id, @title, @note, @priority, @dueDate, @dueTime, @projectId, NULL, @conversationId, @linkedAt, @at, @at)
    `);
    const valid = { id: randomUUID(), title: "Valid", note: "", priority: null, dueDate: null, dueTime: null, projectId: null, conversationId: null, linkedAt: null, at: new Date().toISOString() };
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
        { ...valid, dueTime: "1500" },
        { ...valid, linkedAt: "now" },
        { ...valid, projectId: randomUUID() },
      ]) {
        expect(() => insert.run(row)).toThrow();
      }
      expect(() => insert.run(valid)).not.toThrow();
    } finally {
      raw.close();
    }
  });
});
