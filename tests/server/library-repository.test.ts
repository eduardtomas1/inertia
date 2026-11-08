import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  LIBRARY_FULL_MESSAGE,
  LIBRARY_CATEGORY_DUPLICATE_MESSAGE,
  LIBRARY_CATEGORY_LIMIT_MESSAGE,
  LIBRARY_CATEGORY_MISSING_MESSAGE,
  LibraryRepositoryError,
  SAVED_ANSWER_LIMIT_MESSAGE,
  SAVED_ANSWER_MISSING_MESSAGE,
  SAVED_ANSWER_NOT_FINAL_MESSAGE,
  SAVED_ANSWER_SOURCE_MISSING_MESSAGE,
  SAVED_ANSWER_UNSETTLED_MESSAGE,
} from "../../src/server/persistence/library-repository";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { LIBRARY_SCHEMA_VERSION, libraryMigration } from "../../src/server/persistence/migrations/library";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";
import { publicRuntimeError, userCorrectableRuntimeError } from "../../src/server/runtime-errors";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  MAX_LIBRARY_CATEGORIES,
  MAX_LIBRARY_SERIALIZED_BYTES,
  MAX_SAVED_ANSWERS,
  librarySerializedBytes,
} from "../../src/shared/library";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-library-"));
  directories.push(directory);
  return directory;
}

async function openStore() {
  const directory = await temporaryDirectory();
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Library", directory);
  const conversation = store.createConversation(project.id, "Bread");
  const database = (store as unknown as { database: Database.Database }).database;
  return { store, project, conversation, database, databasePath, directory };
}

let turnCounter = 0;

function beginTurn(store: RuntimeStore, conversationId: string, request: string, at: string) {
  turnCounter += 1;
  return store.beginAgentTurn({
    id: `turn-${turnCounter}`, runId: `run-${turnCounter}`, conversationId, content: request,
    providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
    configurationRevision: 1, association: "authoritative", requestedAt: at,
  }).turn;
}

function settledAnswer(store: RuntimeStore, conversationId: string, options: {
  request?: string;
  answer?: string;
  at?: string;
} = {}) {
  const at = options.at ?? new Date(Date.UTC(2030, 0, 1, 0, 0, turnCounter)).toISOString();
  const turn = beginTurn(store, conversationId, options.request ?? "How do I bake bread?", at);
  const message = store.createMessage(conversationId, options.answer ?? "Mix **flour** and water.", "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed", startedAt: at, completedAt: at, updatedAt: at, terminalAssistantMessageId: message.id,
  });
  return { turn, message };
}

function rejection(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LibraryRepositoryError);
    expect(userCorrectableRuntimeError(error)).toBe(true);
    expect(publicRuntimeError(error)).toBe((error as Error).message);
    return (error as Error).message;
  }
  throw new Error("Expected the library to reject the request.");
}

describe("library categories", () => {
  it("creates, renames and orders categories with case-insensitive unique trimmed names", async () => {
    const { store } = await openStore();
    const bread = store.library.createCategory("  Bread ");
    const apples = store.library.createCategory("apples");
    expect(bread).toMatchObject({ name: "Bread" });
    expect(store.library.categories().map(({ name }) => name)).toEqual(["apples", "Bread"]);
    expect(rejection(() => store.library.createCategory("BREAD"))).toBe(LIBRARY_CATEGORY_DUPLICATE_MESSAGE);
    expect(store.library.createCategory("Ápples").name).toBe("Ápples");
    store.library.createCategory("Écoles");
    expect(rejection(() => store.library.createCategory("écoles"))).toBe(LIBRARY_CATEGORY_DUPLICATE_MESSAGE);
    expect(rejection(() => store.library.renameCategory(apples.id, "bread"))).toBe(LIBRARY_CATEGORY_DUPLICATE_MESSAGE);
    expect(store.library.renameCategory(bread.id, "BREAD")).toMatchObject({ id: bread.id, name: "BREAD" });
    expect(rejection(() => store.library.renameCategory("00000000-0000-4000-8000-000000000000", "Other")))
      .toBe(LIBRARY_CATEGORY_MISSING_MESSAGE);
    expect(() => store.library.createCategory(" ")).toThrow(LibraryRepositoryError);
    expect(() => store.library.createCategory("x".repeat(61))).toThrow(LibraryRepositoryError);
  });

  it("caps categories in the repository and in the schema", async () => {
    const { store, database } = await openStore();
    for (let index = 0; index < MAX_LIBRARY_CATEGORIES; index += 1) store.library.createCategory(`Category ${index}`);
    expect(rejection(() => store.library.createCategory("One more"))).toBe(LIBRARY_CATEGORY_LIMIT_MESSAGE);
    const now = new Date().toISOString();
    expect(() => database.prepare(`INSERT INTO library_categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000000", "Raw", now, now)).toThrow(/library category count limit exceeded/u);
  });

  it("leaves answers unsorted when their category is deleted", async () => {
    const { store, conversation } = await openStore();
    const category = store.library.createCategory("Bread");
    const { turn, message } = settledAnswer(store, conversation.id);
    const saved = store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: category.id });
    expect(saved.categoryId).toBe(category.id);
    store.library.deleteCategory(category.id);
    expect(store.library.snapshot()).toEqual({
      categories: [],
      savedAnswers: [{ ...saved, categoryId: null }],
    });
    expect(rejection(() => store.library.deleteCategory(category.id))).toBe(LIBRARY_CATEGORY_MISSING_MESSAGE);
  });
});

describe("saved answers", () => {
  it("derives the title from the turn request and the excerpt from the final answer", async () => {
    const { store, conversation, project } = await openStore();
    const { turn, message } = settledAnswer(store, conversation.id, {
      request: "\n## Please **explain** sourdough\nwith details",
      answer: `# Sourdough\n\n- Feed the *starter*\n- Wait\n\n${"Knead the dough. ".repeat(30)}`,
    });
    const saved = store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: null });
    expect(saved).toMatchObject({
      conversationId: conversation.id,
      projectId: project.id,
      turnId: turn.id,
      messageId: message.id,
      categoryId: null,
      title: "Please explain sourdough",
    });
    expect(saved.excerpt.startsWith("Sourdough Feed the starter Wait Knead the dough.")).toBe(true);
    expect(saved.excerpt.length).toBeLessThanOrEqual(200);
    expect(saved.excerpt.endsWith("…")).toBe(true);
    expect(store.library.savedAnswer(saved.id)).toEqual(saved);
  });

  it("accepts an explicit title and returns an existing save unchanged", async () => {
    const { store, conversation } = await openStore();
    const category = store.library.createCategory("Bread");
    const { turn, message } = settledAnswer(store, conversation.id);
    const input = { conversationId: conversation.id, turnId: turn.id, messageId: message.id };
    const saved = store.library.saveAnswer({ ...input, categoryId: null, title: "  Bread basics " });
    expect(saved.title).toBe("Bread basics");
    expect(store.library.saveAnswer({ ...input, categoryId: category.id })).toEqual(saved);
    expect(store.library.saveAnswer({ ...input, categoryId: category.id, title: "Loaves" })).toEqual(saved);
    expect(store.library.saveAnswer({ ...input, categoryId: "00000000-0000-4000-8000-000000000000" })).toEqual(saved);
    expect(store.library.savedAnswers()).toEqual([saved]);
    expect(store.library.updateAnswer(saved.id, { categoryId: category.id })).toMatchObject({ id: saved.id, categoryId: category.id });
  });

  it("only saves the settled turn's final assistant message", async () => {
    const { store, conversation } = await openStore();
    const other = store.createConversation(store.conversation(conversation.id).projectId, "Other");
    const at = "2030-02-01T00:00:00.000Z";
    const running = beginTurn(store, conversation.id, "Still working", at);
    const partial = store.createMessage(conversation.id, "Partial", "assistant", [], running.id, at);
    expect(rejection(() => store.library.saveAnswer({
      conversationId: conversation.id, turnId: running.id, messageId: partial.id, categoryId: null,
    }))).toBe(SAVED_ANSWER_UNSETTLED_MESSAGE);
    store.updateAgentTurnLifecycle(running.id, { status: "cancelled", completedAt: at, updatedAt: at });
    const { turn, message } = settledAnswer(store, conversation.id);
    const commentary = store.createMessage(conversation.id, "Commentary", "assistant", [], turn.id);
    const user = store.agentTurn(turn.id).userMessageId;
    for (const messageId of [commentary.id, user, partial.id]) {
      const turnId = messageId === partial.id ? running.id : turn.id;
      expect(rejection(() => store.library.saveAnswer({ conversationId: conversation.id, turnId, messageId, categoryId: null })))
        .toBe(SAVED_ANSWER_NOT_FINAL_MESSAGE);
    }
    expect(rejection(() => store.library.saveAnswer({ conversationId: other.id, turnId: turn.id, messageId: message.id, categoryId: null })))
      .toBe(SAVED_ANSWER_SOURCE_MISSING_MESSAGE);
    expect(rejection(() => store.library.saveAnswer({ conversationId: conversation.id, turnId: "missing", messageId: message.id, categoryId: null })))
      .toBe(SAVED_ANSWER_SOURCE_MISSING_MESSAGE);
    expect(rejection(() => store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: "missing", categoryId: null })))
      .toBe(SAVED_ANSWER_SOURCE_MISSING_MESSAGE);
    expect(rejection(() => store.library.saveAnswer({
      conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: "00000000-0000-4000-8000-000000000000",
    }))).toBe(LIBRARY_CATEGORY_MISSING_MESSAGE);
    expect(store.library.savedAnswers()).toEqual([]);
  });

  it("updates and removes saved answers", async () => {
    const { store, conversation } = await openStore();
    const category = store.library.createCategory("Bread");
    const { turn, message } = settledAnswer(store, conversation.id);
    const saved = store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: null });
    expect(store.library.updateAnswer(saved.id, { categoryId: category.id })).toMatchObject({ categoryId: category.id, title: saved.title });
    expect(store.library.updateAnswer(saved.id, { title: "Renamed" })).toMatchObject({ categoryId: category.id, title: "Renamed" });
    expect(store.library.updateAnswer(saved.id, { categoryId: null })).toMatchObject({ categoryId: null });
    expect(() => store.library.updateAnswer(saved.id, {})).toThrow(LibraryRepositoryError);
    expect(rejection(() => store.library.updateAnswer(saved.id, { categoryId: "00000000-0000-4000-8000-000000000000" })))
      .toBe(LIBRARY_CATEGORY_MISSING_MESSAGE);
    store.library.removeAnswer(saved.id);
    expect(rejection(() => store.library.removeAnswer(saved.id))).toBe(SAVED_ANSWER_MISSING_MESSAGE);
    expect(rejection(() => store.library.updateAnswer(saved.id, { title: "Gone" }))).toBe(SAVED_ANSWER_MISSING_MESSAGE);
  });

  it("lists newest first and cascades with the chat but keeps categories", async () => {
    const { store, conversation, project } = await openStore();
    const other = store.createConversation(project.id, "Other");
    const category = store.library.createCategory("Bread");
    const first = settledAnswer(store, conversation.id, { at: "2030-03-01T00:00:00.000Z" });
    const second = settledAnswer(store, other.id, { at: "2030-03-02T00:00:00.000Z" });
    const older = store.library.saveAnswer({ conversationId: conversation.id, turnId: first.turn.id, messageId: first.message.id, categoryId: category.id });
    const newer = store.library.saveAnswer({ conversationId: other.id, turnId: second.turn.id, messageId: second.message.id, categoryId: category.id });
    expect(store.library.savedAnswers().map(({ id }) => id)).toEqual(
      [older, newer].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map(({ id }) => id),
    );
    store.deleteConversation(conversation.id);
    expect(store.library.snapshot()).toEqual({ categories: [category], savedAnswers: [newer] });
  });

  it("caps saved answers in the repository and in the schema", async () => {
    const { store, conversation, database } = await openStore();
    const { turn } = settledAnswer(store, conversation.id);
    const now = new Date().toISOString();
    const insertMessage = database.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at, turn_id) VALUES (?, ?, 'assistant', 'Filler', ?, ?)
    `);
    const insertAnswer = database.prepare(`
      INSERT INTO saved_answers (id, conversation_id, turn_id, message_id, category_id, title, excerpt, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'Filler', '', ?, ?)
    `);
    database.transaction(() => {
      for (let index = 0; index < MAX_SAVED_ANSWERS; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        insertMessage.run(`filler-${index}`, conversation.id, now, turn.id);
        insertAnswer.run(id, conversation.id, turn.id, `filler-${index}`, now, now);
      }
    })();
    const next = settledAnswer(store, conversation.id);
    expect(rejection(() => store.library.saveAnswer({
      conversationId: conversation.id, turnId: next.turn.id, messageId: next.message.id, categoryId: null,
    }))).toBe(SAVED_ANSWER_LIMIT_MESSAGE);
    insertMessage.run("filler-extra", conversation.id, now, turn.id);
    expect(() => insertAnswer.run("00000000-0000-4000-8000-999999999999", conversation.id, turn.id, "filler-extra", now, now))
      .toThrow(/saved answer count limit exceeded/u);
    expect(store.library.savedAnswers()).toHaveLength(MAX_SAVED_ANSWERS);
  });

  it("publishes a library that validates inside the authoritative snapshot", async () => {
    const { store, conversation } = await openStore();
    const category = store.library.createCategory("Bread");
    const { turn, message } = settledAnswer(store, conversation.id);
    store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: category.id });
    const snapshot = store.shellSnapshot();
    expect(snapshot.library).toEqual(store.library.snapshot());
    expect(parseServerEvent({ type: "snapshot.updated", snapshot })).toBeTruthy();
    expect(() => parseServerEvent({
      type: "snapshot.updated",
      snapshot: { ...snapshot, library: { ...snapshot.library!, categories: [] } },
    })).toThrow("Malformed server event");
  });
});

describe("published library snapshot", () => {
  function fillerAnswers(database: Database.Database, conversationId: string, turnId: string, count: number, text: { title: string; excerpt: string }) {
    const now = new Date().toISOString();
    const insertMessage = database.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at, turn_id) VALUES (?, ?, 'assistant', 'Filler', ?, ?)
    `);
    const insertAnswer = database.prepare(`
      INSERT INTO saved_answers (id, conversation_id, turn_id, message_id, category_id, title, excerpt, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `);
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        insertMessage.run(`filler-${index}`, conversationId, now, turnId);
        insertAnswer.run(id, conversationId, turnId, `filler-${index}`, text.title, text.excerpt, now, now);
      }
    })();
  }

  it("files answers as unsorted when their category cannot be published", async () => {
    const { store, conversation, database } = await openStore();
    const kept = store.library.createCategory("Bread");
    const { turn, message } = settledAnswer(store, conversation.id);
    const saved = store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: kept.id });
    const unpublishable = "00000000-0000-4000-8000-0000000000aa";
    const now = new Date().toISOString();
    database.prepare("INSERT INTO library_categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(unpublishable, "Unreadable", "not a timestamp at all", now);
    const second = settledAnswer(store, conversation.id);
    const orphaned = store.library.saveAnswer({ conversationId: conversation.id, turnId: second.turn.id, messageId: second.message.id, categoryId: null });
    database.prepare("UPDATE saved_answers SET category_id = ? WHERE id = ?").run(unpublishable, orphaned.id);
    const library = store.library.snapshot();
    expect(library.categories).toEqual([kept]);
    expect(library.savedAnswers.find(({ id }) => id === orphaned.id)?.categoryId).toBeNull();
    expect(library.savedAnswers.find(({ id }) => id === saved.id)?.categoryId).toBe(kept.id);
    expect(parseServerEvent({ type: "snapshot.updated", snapshot: store.shellSnapshot() })).toBeTruthy();
  });

  it("reuses the built snapshot until the library or its chats change", async () => {
    const { store, project, database } = await openStore();
    const first = store.library.snapshot();
    expect(store.library.snapshot()).toBe(first);
    const category = store.library.createCategory("Bread");
    const afterCreate = store.library.snapshot();
    expect(afterCreate).not.toBe(first);
    expect(afterCreate.categories).toEqual([category]);
    expect(store.library.snapshot()).toBe(afterCreate);
    const other = store.createConversation(project.id, "Other");
    const { turn, message } = settledAnswer(store, other.id);
    const saved = store.library.saveAnswer({ conversationId: other.id, turnId: turn.id, messageId: message.id, categoryId: null });
    expect(store.library.snapshot().savedAnswers).toEqual([saved]);
    database.prepare("UPDATE saved_answers SET title = 'Edited elsewhere', updated_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", saved.id);
    expect(store.library.snapshot().savedAnswers[0]!.title).toBe("Edited elsewhere");
    const cached = store.library.snapshot();
    store.archiveConversation(other.id, true);
    expect(store.library.snapshot()).toBe(cached);
    store.deleteConversation(other.id);
    expect(store.library.snapshot().savedAnswers).toEqual([]);
    expect(store.library.snapshot().categories).toEqual([category]);
    expect(store.shellSnapshot().library).toBe(store.library.snapshot());
  });

  it("refuses growing writes past the serialized cap and still publishes a library within it", async () => {
    const { store, conversation, database } = await openStore();
    const { turn } = settledAnswer(store, conversation.id);
    fillerAnswers(database, conversation.id, turn.id, 600, { title: "\u0001".repeat(120), excerpt: "\u0001".repeat(200) });
    expect(librarySerializedBytes({ categories: [], savedAnswers: store.library.savedAnswers() })).toBeGreaterThan(MAX_LIBRARY_SERIALIZED_BYTES);
    const next = settledAnswer(store, conversation.id);
    expect(rejection(() => store.library.saveAnswer({
      conversationId: conversation.id, turnId: next.turn.id, messageId: next.message.id, categoryId: null,
    }))).toBe(LIBRARY_FULL_MESSAGE);
    expect(rejection(() => store.library.createCategory("Bread"))).toBe(LIBRARY_FULL_MESSAGE);
    expect(store.library.categories()).toEqual([]);
    const published = store.library.snapshot();
    expect(librarySerializedBytes(published)).toBeLessThanOrEqual(MAX_LIBRARY_SERIALIZED_BYTES);
    expect(published.savedAnswers.length).toBeGreaterThan(0);
    expect(published.savedAnswers.length).toBeLessThan(600);
    expect(parseServerEvent({ type: "snapshot.updated", snapshot: store.shellSnapshot() })).toBeTruthy();
    const all = store.library.savedAnswers();
    for (const answer of all.slice(0, 200)) store.library.removeAnswer(answer.id);
    expect(store.library.createCategory("Bread")).toMatchObject({ name: "Bread" });
    expect(librarySerializedBytes(store.library.snapshot())).toBeLessThanOrEqual(MAX_LIBRARY_SERIALIZED_BYTES);
  });

  it("looks up a saved answer's chat with one row", async () => {
    const { store, conversation } = await openStore();
    const { turn, message } = settledAnswer(store, conversation.id);
    const saved = store.library.saveAnswer({ conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: null });
    expect(store.library.savedAnswerConversationId(saved.id)).toBe(conversation.id);
    expect(store.library.savedAnswerConversationId("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("rendered page metadata", () => {
  it("lists stored pages newest first with chat metadata and without their HTML", async () => {
    const { store, conversation, project } = await openStore();
    const archived = store.createConversation(project.id, "Archived charts");
    const firstAt = "2030-04-01T00:00:00.000Z";
    const secondAt = "2030-04-02T00:00:00.000Z";
    const firstTurn = beginTurn(store, conversation.id, "Chart it", firstAt);
    const secondTurn = beginTurn(store, archived.id, "Chart it again", secondAt);
    const first = store.htmlRenders.create({
      conversationId: conversation.id, runId: firstTurn.runId, turnId: firstTurn.id,
      title: "Revenue", html: "<p>secret revenue</p>", height: 420, createdAt: firstAt,
    });
    const second = store.htmlRenders.create({
      conversationId: archived.id, runId: secondTurn.runId, turnId: secondTurn.id,
      title: "Costs", html: "<p>secret costs</p>", height: 300, createdAt: secondAt,
    });
    store.archiveConversation(archived.id, true);
    const pages = store.library.pages();
    expect(pages).toEqual([
      {
        renderId: second.renderId, title: "Costs", height: second.message.htmlRender!.height,
        conversationId: archived.id, conversationTitle: "Archived charts", projectId: project.id,
        turnId: secondTurn.id, messageId: second.message.id, createdAt: secondAt, archived: true,
      },
      {
        renderId: first.renderId, title: "Revenue", height: first.message.htmlRender!.height,
        conversationId: conversation.id, conversationTitle: "Bread", projectId: project.id,
        turnId: firstTurn.id, messageId: first.message.id, createdAt: firstAt, archived: false,
      },
    ]);
    expect(JSON.stringify(pages)).not.toContain("secret");
    expect(store.messageSearchTarget(first.message.id)).toEqual({
      projectId: project.id, conversationId: conversation.id, turnId: firstTurn.id, messageId: first.message.id,
    });
    expect(store.messageSearchTarget(second.message.id)).toBeNull();
    store.deleteConversation(conversation.id);
    expect(store.library.pages().map(({ renderId }) => renderId)).toEqual([second.renderId]);
  });

  it("walks pages through the creation-time index", async () => {
    const { database } = await openStore();
    const plan = (database.prepare(`EXPLAIN QUERY PLAN SELECT html_renders.id FROM html_renders
      CROSS JOIN conversations ON conversations.id = html_renders.conversation_id
      ORDER BY html_renders.created_at DESC, html_renders.id DESC LIMIT 500`).all() as Array<{ detail: string }>)
      .map(({ detail }) => detail).join("\n");
    expect(plan).toContain("html_renders_created_idx");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("library migration", () => {
  it("is schema 107 and registered in the runtime catalog", () => {
    expect(LIBRARY_SCHEMA_VERSION).toBe(107);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(LIBRARY_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === LIBRARY_SCHEMA_VERSION))
      .toMatchObject({ name: libraryMigration.name, up: libraryMigration.up });
  });

  it("upgrades a schema 106 database without touching existing rows and is idempotent", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "published.sqlite");
    await copyFile(fixture, databasePath);
    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(database, 106);
      const objects = () => (database.prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'library%' OR name LIKE 'saved_answers%' OR name = 'html_renders_created_idx' ORDER BY name",
      ).pluck().all() as string[]);
      expect(objects()).toEqual([]);
      const messages = database.prepare("SELECT * FROM messages ORDER BY rowid").all();
      expect(messages).not.toHaveLength(0);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      expect(objects()).toEqual([
        "html_renders_created_idx",
        "library_categories",
        "library_categories_count_limit",
        "library_categories_name_idx",
        "saved_answers",
        "saved_answers_category_idx",
        "saved_answers_conversation_idx",
        "saved_answers_count_limit",
        "saved_answers_created_idx",
        "saved_answers_message_idx",
        "saved_answers_turn_idx",
      ]);
      expect(database.prepare("SELECT * FROM messages ORDER BY rowid").all()).toEqual(messages);
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 106 ORDER BY version").all()).toEqual(history);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      const now = new Date().toISOString();
      const insert = database.prepare("INSERT INTO library_categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)");
      insert.run("00000000-0000-4000-8000-000000000001", "Bread", now, now);
      expect(() => insert.run("00000000-0000-4000-8000-000000000002", "bread", now, now)).toThrow(/UNIQUE constraint failed/u);
      expect(() => insert.run("00000000-0000-4000-8000-000000000003", " padded", now, now)).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`INSERT INTO saved_answers
        (id, conversation_id, turn_id, message_id, category_id, title, excerpt, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-000000000004', 'missing', 'missing', 'missing', NULL, 'Title', '', ?, ?)`)
        .run(now, now)).toThrow(/FOREIGN KEY constraint failed/u);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      const schemaVersion = database.pragma("schema_version", { simple: true });
      migrateRuntimeDatabase(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }
  });
});
