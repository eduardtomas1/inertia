import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  InitiativeRepository,
  InitiativeRepositoryError,
} from "../../src/server/persistence/initiative-repository";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { MAX_INITIATIVES } from "../../src/shared/initiatives";
import { PROJECT_COLOR_NAMES } from "../../src/shared/project-colors";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-initiative-store-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  stores.push(store);
  return { store, directory, databasePath };
}

function failure(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("RuntimeStore initiatives", () => {
  it("creates the initiatives table and membership column at the current schema version", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const database = new Database(databasePath, { readonly: true });
    try {
      expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect((database.prepare("PRAGMA table_info(initiatives)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual([
        "id", "name", "color", "status", "brief", "brief_revision", "preferences_json", "revision", "created_at", "updated_at",
      ]);
      expect((database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>)
        .some(({ name }) => name === "initiative_id")).toBe(true);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'conversations_initiative_idx'").get())
        .toEqual({ name: "conversations_initiative_idx" });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'initiatives_count_limit'").get())
        .toEqual({ name: "initiatives_count_limit" });
    } finally {
      database.close();
    }
  });

  it("creates, lists, updates and deletes initiatives through both snapshots", async () => {
    const { store, databasePath, directory } = await openStore();
    expect(store.snapshot().initiatives).toEqual([]);
    expect(store.shellSnapshot().initiatives).toEqual([]);
    const first = store.initiatives.create({ id: randomUUID(), name: "  Checkout redesign  " });
    expect(first).toMatchObject({
      name: "Checkout redesign", color: "red", status: "active", brief: "", briefRevision: 0, revision: 1,
    });
    expect(first.createdAt).toBe(first.updatedAt);
    const second = store.initiatives.create({ id: randomUUID(), name: "Release 0.1", color: "teal" });
    expect(second.color).toBe("teal");
    expect(store.initiatives.list().map(({ id }) => id)).toEqual([first.id, second.id]);

    const renamed = store.initiatives.update(first.id, 1, { name: "Checkout", color: "violet" });
    expect(renamed).toMatchObject({ name: "Checkout", color: "violet", status: "active", revision: 2 });
    const done = store.initiatives.update(first.id, 2, { status: "done" });
    expect(done).toMatchObject({ status: "done", revision: 3 });
    expect(store.initiatives.update(first.id, 3, { status: "archived" }).status).toBe("archived");
    expect(store.initiatives.update(first.id, 4, { status: "active" }).status).toBe("active");

    store.initiatives.delete(second.id);
    expect(store.snapshot().initiatives?.map(({ id }) => id)).toEqual([first.id]);
    expect(store.shellSnapshot().initiatives?.map(({ id }) => id)).toEqual([first.id]);
    const current = store.initiatives.list();
    store.close();
    stores.splice(0);

    const reopened = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    stores.push(reopened);
    expect(reopened.snapshot().initiatives).toEqual(current);
  });

  it("rejects a stale expected revision without changing the initiative", async () => {
    const { store } = await openStore();
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Docs" });
    store.initiatives.update(initiative.id, 1, { name: "Docs site" });
    const stale = failure(() => store.initiatives.update(initiative.id, 1, { name: "Lost update" }));
    expect(stale).toBeInstanceOf(InitiativeRepositoryError);
    expect(publicRuntimeError(stale)).toBe("The initiative changed elsewhere. Review the latest version and try again.");
    expect(store.initiatives.get(initiative.id)).toMatchObject({ name: "Docs site", revision: 2 });
  });

  it("orders initiatives by creation time, then by id", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    try {
      let at = "2026-10-19T10:00:00.000Z";
      const repository = new InitiativeRepository(raw, () => at);
      const ids = ["c", "a", "b"].map((prefix) => `${prefix.repeat(8)}-1111-4111-8111-111111111111`);
      for (const id of ids) repository.create({ id, name: id });
      at = "2026-10-19T09:00:00.000Z";
      const earlier = repository.create({ id: randomUUID(), name: "Earlier" });
      expect(repository.list().map(({ id }) => id)).toEqual([earlier.id, ids[1], ids[2], ids[0]]);
    } finally {
      raw.close();
    }
  });

  it("assigns and clears membership without changing the chat's project, workspace or chronology", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const conversation = store.createConversation(project.id, "Member chat");
    const before = store.conversationShell(conversation.id)!;
    expect(before.initiativeId).toBeNull();
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Grouping" });

    store.initiatives.assignConversation(conversation.id, initiative.id);
    const assigned = store.conversationShell(conversation.id)!;
    expect(assigned.initiativeId).toBe(initiative.id);
    const { initiativeId: _assigned, ...assignedIdentity } = assigned;
    const { initiativeId: _before, ...beforeIdentity } = before;
    expect(assignedIdentity).toEqual(beforeIdentity);
    expect(store.snapshot().conversations.find(({ id }) => id === conversation.id)?.initiativeId).toBe(initiative.id);
    expect(store.conversationDetail(conversation.id)?.conversation.initiativeId).toBe(initiative.id);

    store.initiatives.assignConversation(conversation.id, null);
    expect(store.conversationShell(conversation.id)).toEqual(before);
  });

  it("creates an initiative and assigns a chat in one transaction", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const conversation = store.createConversation(project.id, "First member");
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Bundled" }, conversation.id);
    expect(store.conversationShell(conversation.id)?.initiativeId).toBe(initiative.id);

    const missingChat = randomUUID();
    const id = randomUUID();
    const error = failure(() => store.initiatives.create({ id, name: "Rolled back" }, missingChat));
    expect(publicRuntimeError(error)).toBe("That chat no longer exists.");
    expect(store.initiatives.get(id)).toBeNull();
  });

  it("only lets active initiatives take chats, and keeps membership when an initiative is archived", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const member = store.createConversation(project.id, "Member");
    const other = store.createConversation(project.id, "Other");
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Lifecycle" }, member.id);
    store.initiatives.update(initiative.id, 1, { status: "archived" });
    expect(store.conversationShell(member.id)?.initiativeId).toBe(initiative.id);

    const archived = failure(() => store.initiatives.assignConversation(other.id, initiative.id));
    expect(archived).toBeInstanceOf(InitiativeRepositoryError);
    expect(publicRuntimeError(archived)).toBe("Only active initiatives can take chats. Reopen the initiative first.");
    expect(() => store.createConversation(project.id, "New member", { initiativeId: initiative.id }))
      .toThrow("Only active initiatives can take chats. Reopen the initiative first.");
    store.initiatives.update(initiative.id, 2, { status: "done" });
    expect(() => store.initiatives.assignConversation(other.id, initiative.id)).toThrow(InitiativeRepositoryError);
    store.initiatives.update(initiative.id, 3, { status: "active" });
    store.initiatives.assignConversation(other.id, initiative.id);
    const created = store.createConversation(project.id, "New member", { initiativeId: initiative.id });
    expect(created.initiativeId).toBe(initiative.id);
    expect(store.conversationShell(created.id)?.initiativeId).toBe(initiative.id);
    expect(store.conversationShell(other.id)?.initiativeId).toBe(initiative.id);
  });

  it("clears membership when an initiative is deleted and never deletes its chats", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const first = store.createConversation(project.id, "First");
    const second = store.createConversation(project.id, "Second");
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Short lived" }, first.id);
    store.initiatives.assignConversation(second.id, initiative.id);

    store.initiatives.delete(initiative.id);
    expect(store.initiatives.list()).toEqual([]);
    const shells = store.shellSnapshot().conversations;
    expect(shells.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
    expect(shells.every(({ initiativeId }) => initiativeId === null)).toBe(true);
  });

  it("removes membership with the chat row when a member chat is deleted", async () => {
    const { store, directory, databasePath } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const member = store.createConversation(project.id, "Member");
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Kept" }, member.id);
    store.deleteConversation(member.id);
    expect(store.initiatives.get(initiative.id)).toMatchObject({ id: initiative.id, status: "active" });
    const raw = new Database(databasePath, { readonly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS count FROM conversations WHERE initiative_id = ?").get(initiative.id))
        .toEqual({ count: 0 });
      expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("rejects missing initiatives and chats with renderer-visible errors", async () => {
    const { store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const conversation = store.createConversation(project.id, "Chat");
    const missing = randomUUID();
    for (const operation of [
      () => store.initiatives.update(missing, 1, { name: "Nope" }),
      () => store.initiatives.delete(missing),
      () => store.initiatives.assignConversation(conversation.id, missing),
      () => store.initiatives.acceptsChats(missing, { require: true }),
      () => store.createConversation(project.id, "Orphan", { initiativeId: missing }),
    ]) {
      const error = failure(operation);
      expect(error).toBeInstanceOf(InitiativeRepositoryError);
      expect(publicRuntimeError(error)).toBe("That initiative no longer exists.");
    }
    expect(store.initiatives.acceptsChats(missing)).toBe(false);
    const initiative = store.initiatives.create({ id: randomUUID(), name: "Real" });
    expect(store.initiatives.acceptsChats(initiative.id)).toBe(true);
    store.initiatives.update(initiative.id, 1, { status: "done" });
    expect(store.initiatives.acceptsChats(initiative.id)).toBe(false);
    expect(() => store.initiatives.acceptsChats(initiative.id, { require: true }))
      .toThrow("Only active initiatives can take chats. Reopen the initiative first.");
    store.initiatives.update(initiative.id, 2, { status: "active" });
    expect(publicRuntimeError(failure(() => store.initiatives.assignConversation(randomUUID(), initiative.id))))
      .toBe("That chat no longer exists.");
    expect(store.shellSnapshot().conversations.map(({ title }) => title)).toEqual(["Chat"]);
  });

  it("rejects invalid names, colours, ids and duplicate ids", async () => {
    const { store } = await openStore();
    const id = randomUUID();
    store.initiatives.create({ id, name: "Original" });
    for (const input of [
      { id: randomUUID(), name: "   " },
      { id: randomUUID(), name: "x".repeat(121) },
      { id: randomUUID(), name: "Two\nlines" },
      { id: randomUUID(), name: "Carriage\rreturn" },
      { id: randomUUID(), name: "nul\0" },
      { id: randomUUID(), name: "Colour", color: "magenta" as never },
      { id: randomUUID(), name: "Colour", color: "#ff0000" as never },
      { id: "not-a-uuid", name: "Id" },
      { id, name: "Duplicate" },
    ]) {
      expect(() => store.initiatives.create(input)).toThrow(InitiativeRepositoryError);
    }
    for (const patch of [
      {},
      { name: "" },
      { color: "magenta" as never },
      { status: "paused" as never },
    ]) {
      expect(() => store.initiatives.update(id, 1, patch)).toThrow(InitiativeRepositoryError);
    }
    expect(store.initiatives.list()).toHaveLength(1);
    expect(store.initiatives.list()[0]).toMatchObject({ id, name: "Original", revision: 1 });
  });

  it("enforces the initiative count limit in the repository and the database", async () => {
    const { store, databasePath } = await openStore();
    for (let index = 0; index < MAX_INITIATIVES; index += 1) {
      store.initiatives.create({ id: randomUUID(), name: `Initiative ${index}` });
    }
    expect(() => store.initiatives.create({ id: randomUUID(), name: "One more" }))
      .toThrow(`Initiatives are limited to ${MAX_INITIATIVES}.`);
    const raw = new Database(databasePath);
    try {
      const at = new Date().toISOString();
      expect(() => raw.prepare(`
        INSERT INTO initiatives (id, name, color, created_at, updated_at)
        VALUES (?, 'Raw', 'blue', ?, ?)
      `).run(randomUUID(), at, at)).toThrow("initiative count limit exceeded");
    } finally {
      raw.close();
    }
    expect(store.initiatives.list()).toHaveLength(MAX_INITIATIVES);
  });

  it("rejects rows that bypass the schema at the database boundary", async () => {
    const { databasePath, store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const conversation = store.createConversation(project.id, "Chat");
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    raw.pragma("foreign_keys = ON");
    const insert = raw.prepare(`
      INSERT INTO initiatives (id, name, color, status, brief, brief_revision, preferences_json, revision, created_at, updated_at)
      VALUES (@id, @name, @color, @status, @brief, @briefRevision, @preferences, @revision, @at, @at)
    `);
    const valid = {
      id: randomUUID(), name: "Valid", color: "green", status: "active", brief: "", briefRevision: 0,
      preferences: "{}", revision: 1, at: new Date().toISOString(),
    };
    try {
      for (const row of [
        { ...valid, id: "short" },
        { ...valid, name: " " },
        { ...valid, name: "" },
        { ...valid, name: " Leading" },
        { ...valid, name: "Trailing " },
        { ...valid, name: "x".repeat(121) },
        { ...valid, name: "😀".repeat(121) },
        { ...valid, name: "a\nb" },
        { ...valid, name: "a\rb" },
        { ...valid, name: "a\tb" },
        { ...valid, color: "#00ff00" },
        { ...valid, color: "magenta" },
        { ...valid, status: "paused" },
        { ...valid, brief: "b".repeat(8_193) },
        // 2,049 characters but 8,196 UTF-8 bytes: the brief limit counts bytes.
        { ...valid, brief: "😀".repeat(2_049) },
        { ...valid, brief: "nul\0" },
        { ...valid, preferences: "x".repeat(65_537) },
        { ...valid, at: "yesterday" },
      ]) {
        expect(() => insert.run(row)).toThrow();
      }
      expect(() => insert.run(valid)).not.toThrow();
      const assign = raw.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?");
      expect(() => assign.run("short", conversation.id)).toThrow();
      expect(() => assign.run(randomUUID(), conversation.id)).toThrow(/FOREIGN KEY/u);
      expect(() => assign.run(valid.id, conversation.id)).not.toThrow();
      raw.prepare("DELETE FROM initiatives WHERE id = ?").run(valid.id);
      expect(raw.prepare("SELECT initiative_id FROM conversations WHERE id = ?").get(conversation.id))
        .toEqual({ initiative_id: null });
    } finally {
      raw.close();
    }
  });

  it("lists every row the database accepts, because zod and the CHECKs share one rule", async () => {
    const { databasePath, store } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    const at = new Date().toISOString();
    const insert = raw.prepare(`
      INSERT INTO initiatives (id, name, color, brief, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Accepted by SQLite, and formerly rejected by the trimming, UTF-16
    // counting zod rules: a non-breaking space name, 120 astral characters, a
    // 2,048-character brief of exactly 8,192 bytes and the column's revision 0.
    const edgeCases = [
      { name: "\u00a0", brief: "", revision: 1 },
      { name: "😀".repeat(120), brief: "😀".repeat(2_048), revision: 1 },
      { name: "Fresh", brief: "", revision: 0 },
    ];
    try {
      for (const [index, edge] of edgeCases.entries()) {
        const id = `${String(index).repeat(8)}-1111-4111-8111-111111111111`;
        insert.run(id, edge.name, PROJECT_COLOR_NAMES[index], edge.brief, edge.revision, at, at);
      }
      const repository = new InitiativeRepository(raw);
      expect(repository.list().map(({ name, revision }) => ({ name, revision })))
        .toEqual(edgeCases.map(({ name, revision }) => ({ name, revision })));
    } finally {
      raw.close();
    }
  });

  it("accepts every palette colour in SQL, pinning the CHECK list to the shared palette", async () => {
    const { databasePath, store } = await openStore();
    store.close();
    stores.splice(0);
    const raw = new Database(databasePath);
    const at = new Date().toISOString();
    try {
      const insert = raw.prepare(`
        INSERT INTO initiatives (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `);
      for (const color of PROJECT_COLOR_NAMES) {
        expect(() => insert.run(randomUUID(), `Colour ${color}`, color, at, at)).not.toThrow();
      }
      const colors = (raw.prepare("SELECT color FROM initiatives ORDER BY rowid").all() as Array<{ color: string }>)
        .map(({ color }) => color);
      expect(colors).toEqual([...PROJECT_COLOR_NAMES]);
      expect(new InitiativeRepository(raw).list().map(({ color }) => color).sort())
        .toEqual([...PROJECT_COLOR_NAMES].sort());
    } finally {
      raw.close();
    }
  });

  it("skips a malformed row, logs it once and keeps the snapshot coherent", async () => {
    const { databasePath, store, directory } = await openStore();
    const project = store.createProject("Initiatives", directory);
    const member = store.createConversation(project.id, "Member of a damaged initiative");
    const healthy = store.initiatives.create({ id: randomUUID(), name: "Healthy" });
    store.close();
    stores.splice(0);
    // 36 characters satisfy the SQL CHECK, but the contract requires a UUID.
    const damagedId = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz";
    const raw = new Database(databasePath);
    try {
      const at = new Date().toISOString();
      raw.prepare(`
        INSERT INTO initiatives (id, name, color, created_at, updated_at) VALUES (?, 'Damaged', 'red', ?, ?)
      `).run(damagedId, at, at);
      raw.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?").run(damagedId, member.id);
    } finally {
      raw.close();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const reopened = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
      stores.push(reopened);
      const shell = reopened.shellSnapshot();
      const full = reopened.snapshot();
      expect(shell.initiatives?.map(({ id }) => id)).toEqual([healthy.id]);
      expect(full.initiatives?.map(({ id }) => id)).toEqual([healthy.id]);
      expect(reopened.initiatives.get(damagedId)).toBeNull();
      for (const conversations of [shell.conversations, full.conversations]) {
        expect(conversations.find(({ id }) => id === member.id)?.initiativeId).toBeNull();
      }
      expect(reopened.conversationShell(member.id)?.initiativeId).toBeNull();
      expect(parseServerEvent({ type: "snapshot.updated", snapshot: shell })).toBeTruthy();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("A malformed initiative was omitted from the runtime snapshot.");
    } finally {
      warn.mockRestore();
    }
  });
});
