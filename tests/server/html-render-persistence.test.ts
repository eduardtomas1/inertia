import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { htmlRendersMigration } from "../../src/server/persistence/migrations/html-renders";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";
import { HtmlRenderRepository, HtmlRenderTurnInactiveError } from "../../src/server/persistence/html-render-repository";
import { messageFromRow } from "../../src/server/persistence/codecs";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";
import { HTML_RENDER_MAX_HTML_BYTES, htmlRenderPlaceholderText } from "../../src/shared/html-render";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];
const RENDER_ID = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-html-render-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  return { workspacePath, databasePath: join(directory, "inertia.sqlite") };
}

function openStore(databasePath: string, workspacePath: string): RuntimeStore {
  return new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
}

function beginTurn(store: RuntimeStore, conversationId: string, runId = "run-render") {
  const conversation = store.conversation(conversationId);
  return store.beginAgentTurn({
    conversationId,
    runId,
    content: "Chart the results.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
}

function seed(store: RuntimeStore, workspacePath: string) {
  const project = store.createProject("Visual replies", workspacePath);
  const conversation = store.createConversation(project.id, "Charts", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const turn = beginTurn(store, conversation.id);
  return { project, conversation, turn };
}

function settle(store: RuntimeStore, turnId: string, status: "completed" | "cancelled"): void {
  const now = new Date().toISOString();
  store.settleAgentTurn(turnId, {
    status,
    terminalAssistantMessageId: null,
    providerSessionAfter: null,
    terminalReason: status === "completed" ? "provider-completed" : "user-cancelled",
    checkpointId: null,
    usageAtCompletion: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
}

const columns = (database: Database.Database, table: string) =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
const tables = (database: Database.Database) =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => name);
const schemaVersion = (database: Database.Database) =>
  (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;

function runMigrationAgain(database: Database.Database): void {
  if (typeof htmlRendersMigration.up !== "function") throw new Error("Expected a guarded migration.");
  htmlRendersMigration.up(database, {
    sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    sourceReleases: [],
    setLegacyBackfillDiagnostics: () => undefined,
  });
}

describe("html render migration", () => {
  it("is schema version 93", () => {
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(93);
    expect(runtimeMigrationCatalog().find(({ name }) => name === htmlRendersMigration.name)?.version).toBe(93);
  });

  it("upgrades a schema-92 database without touching existing messages and is idempotent", async () => {
    const { workspacePath, databasePath } = await workspace();
    const raw = new Database(databasePath);
    migrateRuntimeDatabase(raw, 92);
    expect(columns(raw, "messages")).not.toContain("html_render_json");
    expect(tables(raw)).not.toContain("html_renders");
    raw.close();

    const store = openStore(databasePath, workspacePath);
    const { conversation, turn } = seed(store, workspacePath);
    const compaction = store.createMessage(conversation.id, "/compact", "system", [], null, undefined, {
      compaction: { providerId: "claude", beforeTokens: 100, afterTokens: 10, instructionForwarded: false },
    });
    const notice = store.createMessage(conversation.id, "Imported context.", "system", [], turn.id);
    store.close();

    const upgraded = new Database(databasePath);
    try {
      expect(schemaVersion(upgraded)).toBe(93);
      expect(columns(upgraded, "messages")).toContain("html_render_json");
      expect(columns(upgraded, "html_renders")).toEqual(["id", "conversation_id", "turn_id", "title", "html", "created_at"]);
      expect(tables(upgraded)).toContain("html_renders_conversation_idx");
      const before = { messages: columns(upgraded, "messages"), renders: columns(upgraded, "html_renders"), tables: tables(upgraded) };
      upgraded.transaction(() => runMigrationAgain(upgraded))();
      expect({ messages: columns(upgraded, "messages"), renders: columns(upgraded, "html_renders"), tables: tables(upgraded) })
        .toEqual(before);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM messages WHERE html_render_json IS NOT NULL").get())
        .toEqual({ count: 0 });
    } finally {
      upgraded.close();
    }
    const reopened = openStore(databasePath, workspacePath);
    try {
      expect(reopened.message(compaction.id)).toEqual(compaction);
      expect(reopened.message(notice.id)).toEqual(notice);
      expect(reopened.message(notice.id).htmlRender).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("refuses an unexpected pre-existing metadata column", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 92);
      database.exec("ALTER TABLE messages ADD COLUMN html_render_json BLOB");
      expect(() => runMigrationAgain(database)).toThrow("Unexpected rendered page metadata column.");
    } finally {
      database.close();
    }
  });

  it("upgrades the oldest published fixture through schema 93 and can store a render", async () => {
    const { workspacePath, databasePath } = await workspace();
    await copyFile(resolve("tests/fixtures/database/v0.0.1.sqlite"), databasePath);
    const store = openStore(databasePath, workspacePath);
    try {
      const conversation = store.snapshot().conversations[0]!;
      expect(store.conversationDetail(conversation.id)?.messages.every((message) => message.htmlRender === undefined)).toBe(true);
      const turn = beginTurn(store, conversation.id, "run-fixture-render");
      const created = store.htmlRenders.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        title: "Fixture chart", html: "<p>ok</p>", height: 200,
      });
      expect(store.htmlRenders.read(created.renderId)).toEqual({ conversationId: conversation.id, title: "Fixture chart", html: "<p>ok</p>" });
    } finally {
      store.close();
    }
    const inspection = new Database(databasePath, { readonly: true });
    try {
      expect(schemaVersion(inspection)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      inspection.close();
    }
  });

  it("constrains rendered page metadata to bounded JSON on system messages", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    const { conversation, turn } = seed(store, workspacePath);
    store.close();
    const database = new Database(databasePath);
    try {
      const insert = database.prepare(`INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at, html_render_json)
        VALUES (?, ?, ?, ?, 'x', '[]', '2026-10-07T00:00:00.000Z', ?)`);
      const reference = JSON.stringify({ renderId: RENDER_ID, title: "Chart", height: 360 });
      expect(() => insert.run("m-user", conversation.id, turn.id, "user", reference)).toThrow(/CHECK/u);
      expect(() => insert.run("m-assistant", conversation.id, turn.id, "assistant", reference)).toThrow(/CHECK/u);
      expect(() => insert.run("m-invalid", conversation.id, turn.id, "system", "{not json")).toThrow(/CHECK/u);
      expect(() => insert.run("m-long", conversation.id, turn.id, "system", JSON.stringify({ pad: "x".repeat(1_100) }))).toThrow(/CHECK/u);
      expect(() => insert.run("m-system", conversation.id, turn.id, "system", reference)).not.toThrow();
      const renders = database.prepare(`INSERT INTO html_renders (id, conversation_id, turn_id, title, html, created_at)
        VALUES (?, ?, ?, ?, ?, '2026-10-07T00:00:00.000Z')`);
      expect(() => renders.run(RENDER_ID, conversation.id, turn.id, "Chart", "x".repeat(HTML_RENDER_MAX_HTML_BYTES + 1))).toThrow(/CHECK/u);
      expect(() => renders.run(RENDER_ID, conversation.id, turn.id, "", "<p>x</p>")).toThrow(/CHECK/u);
      expect(() => renders.run(RENDER_ID, "missing-conversation", turn.id, "Chart", "<p>x</p>")).toThrow(/FOREIGN KEY/u);
    } finally {
      database.close();
    }
  });
});

describe("html render persistence", () => {
  it("stores the page and its turn-scoped system message atomically and reads it back", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    try {
      const { conversation, turn } = seed(store, workspacePath);
      const html = "<!doctype html><h1>Ünïcode chart</h1>";
      const created = store.htmlRenders.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        title: "Weekly chart", html, height: 5_000, createdAt: "2026-10-07T10:00:00.000Z",
      });
      expect(created.message).toEqual({
        id: expect.any(String),
        conversationId: conversation.id,
        turnId: turn.id,
        role: "system",
        content: htmlRenderPlaceholderText("Weekly chart"),
        attachments: [],
        createdAt: "2026-10-07T10:00:00.000Z",
        htmlRender: { renderId: created.renderId, title: "Weekly chart", height: 2_000 },
      });
      expect(chatMessageSchema(created.message)).toBe(true);
      expect(store.message(created.message.id)).toEqual(created.message);
      expect(store.conversationDetail(conversation.id)?.messages).toContainEqual(created.message);
      expect(store.htmlRenders.read(created.renderId)).toEqual({ conversationId: conversation.id, title: "Weekly chart", html });
      expect(store.htmlRenders.read("6f9619ff-8b86-4d01-b42d-00c04fc96400")).toBeNull();
      expect(store.htmlRenders.read("../not-an-id")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("rejects renders from another conversation's turn or a settled turn", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    try {
      const { project, conversation, turn } = seed(store, workspacePath);
      const other = store.createConversation(project.id, "Other");
      const input = { runId: turn.runId, turnId: turn.id, title: "Chart", html: "<p>x</p>", height: 360 };
      expect(() => store.htmlRenders.create({ ...input, conversationId: other.id })).toThrow();
      expect(() => store.htmlRenders.create({ ...input, conversationId: conversation.id, runId: "other-run" })).toThrow();
      settle(store, turn.id, "cancelled");
      expect(() => store.htmlRenders.create({ ...input, conversationId: conversation.id }))
        .toThrow(HtmlRenderTurnInactiveError);
      expect(() => store.htmlRenders.create({ ...input, conversationId: conversation.id, title: " padded " })).toThrow();
      expect(() => store.htmlRenders.create({ ...input, conversationId: conversation.id, html: "" })).toThrow();
      expect(() => store.htmlRenders.create({
        ...input, conversationId: conversation.id, html: "é".repeat(HTML_RENDER_MAX_HTML_BYTES / 2 + 1),
      })).toThrow("Invalid rendered page size.");
      expect(store.conversationDetail(conversation.id)?.messages.some(({ role }) => role === "system")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rolls the page back when its message cannot be written", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    const { conversation, turn } = seed(store, workspacePath);
    store.close();
    const database = new Database(databasePath);
    try {
      const repository = new HtmlRenderRepository(database, {
        assertAgentTurnIdentity: () => ({ status: "running" }) as never,
        createMessage: () => { throw new Error("disk full"); },
      });
      expect(() => repository.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id, title: "Chart", html: "<p>x</p>", height: 360,
      })).toThrow("disk full");
      expect(database.prepare("SELECT COUNT(*) AS count FROM html_renders").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("validates rendered page metadata on generic message writes", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    try {
      const { conversation, turn } = seed(store, workspacePath);
      const htmlRender = { renderId: RENDER_ID, title: "Chart", height: 360 };
      expect(() => store.createMessage(conversation.id, "x", "system", [], null, undefined, { htmlRender }))
        .toThrow("Invalid rendered page reference.");
      expect(() => store.createMessage(conversation.id, "x", "assistant", [], turn.id, undefined, { htmlRender }))
        .toThrow("Invalid rendered page reference.");
      expect(() => store.createMessage(conversation.id, "x", "system", [], turn.id, undefined, {
        htmlRender: { ...htmlRender, height: 79 },
      })).toThrow("Invalid rendered page reference.");
    } finally {
      store.close();
    }
  });

  it("deletes pages with their conversation and with their project", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = openStore(databasePath, workspacePath);
    try {
      const { project, conversation, turn } = seed(store, workspacePath);
      const first = store.htmlRenders.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id, title: "First", html: "<p>1</p>", height: 360,
      });
      settle(store, turn.id, "completed");
      store.deleteConversation(conversation.id);
      expect(store.htmlRenders.read(first.renderId)).toBeNull();

      const second = store.createConversation(project.id, "Second", {
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
      });
      const secondTurn = beginTurn(store, second.id, "run-second");
      const kept = store.htmlRenders.create({
        conversationId: second.id, runId: secondTurn.runId, turnId: secondTurn.id, title: "Second", html: "<p>2</p>", height: 360,
      });
      store.removeProject(project.id);
      expect(store.htmlRenders.read(kept.renderId)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("html render message codecs", () => {
  const reference = { renderId: RENDER_ID, title: "Chart", height: 360 };
  const row = {
    id: "message-1",
    conversation_id: "conversation-1",
    turn_id: "turn-1" as string | null,
    role: "system" as const,
    content: "Rendered page: Chart",
    attachments_json: "[]",
    created_at: "2026-10-07T00:00:00.000Z",
    html_render_json: JSON.stringify(reference) as string | null,
  };

  it("projects a reference only for turn-scoped system messages", () => {
    expect(messageFromRow(row).htmlRender).toEqual(reference);
    expect(messageFromRow({ ...row, turn_id: null }).htmlRender).toBeUndefined();
    expect(messageFromRow({ ...row, role: "assistant" as never }).htmlRender).toBeUndefined();
    expect(messageFromRow({ ...row, html_render_json: "{malformed" }).htmlRender).toBeUndefined();
    expect(messageFromRow({ ...row, html_render_json: JSON.stringify({ ...reference, extra: true }) }).htmlRender).toBeUndefined();
    expect(messageFromRow({ ...row, html_render_json: null }).htmlRender).toBeUndefined();
  });

  it("accepts the reference on the wire only under the same conditions", () => {
    const message = { ...messageFromRow(row) };
    expect(chatMessageSchema(message)).toBe(true);
    expect(chatMessageSchema({ ...message, turnId: null })).toBe(false);
    expect(chatMessageSchema({ ...message, role: "assistant" })).toBe(false);
    expect(chatMessageSchema({ ...message, role: "user" })).toBe(false);
    expect(chatMessageSchema({ ...message, htmlRender: { ...reference, renderId: "not-a-uuid" } })).toBe(false);
    expect(chatMessageSchema({ ...message, htmlRender: { ...reference, title: "a\nb" } })).toBe(false);
    expect(chatMessageSchema({ ...message, htmlRender: { ...reference, height: 2_001 } })).toBe(false);
    expect(chatMessageSchema({ ...message, htmlRender: "Chart" })).toBe(false);
    const { htmlRender: _omitted, ...older } = message;
    expect(chatMessageSchema(older)).toBe(true);
  });
});
