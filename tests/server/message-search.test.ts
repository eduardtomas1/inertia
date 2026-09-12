import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { messageSearchResultSchema } from "../../src/shared/message-search-schema";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-message-search-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory);
  cleanup.push(() => store.close());
  const project = store.createProject("Search fixture", directory);
  const conversation = store.createConversation(project.id, "An unrelated title");
  const database = new Database(databasePath, { readonly: true });
  cleanup.push(() => { database.close(); });
  return { store, database, databasePath, directory, project, conversation };
}

function answer(store: RuntimeStore, conversationId: string, content: string, turnId: string = randomUUID()) {
  const user = store.createMessage(conversationId, "Please investigate this issue");
  const turn = store.createAgentTurn({
    id: turnId, conversationId, runId: randomUUID(), userMessageId: user.id,
    providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
    configurationRevision: 0, association: "authoritative",
  });
  const message = store.createMessage(conversationId, content, "assistant", [], turn.id);
  store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: message.id, terminalReason: "provider-completed" });
  return { user, turn, message };
}

describe("persisted message search", () => {
  it("streams candidates without a temporary ordering B-tree", async () => {
    const { store, database, conversation } = await fixture();
    store.createMessage(conversation.id, "needle");
    const prepared = vi.spyOn(database, "prepare");
    let statements: string[];
    try {
      searchMessages(database, "needle", { maxScanMs: 0 });
      statements = prepared.mock.calls.map(([sql]) => sql);
    } finally { prepared.mockRestore(); }
    const plans = statements.flatMap((sql) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.match(/\?/gu) ?? []).map(() => null))) as Array<{ detail: string }>;
    expect(plans.map(({ detail }) => detail)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("USE TEMP B-TREE"),
    ]));
  });

  it.each(["archived", "system", "nonterminal"] as const)("checks the scan deadline while traversing newer %s rows", async (kind) => {
    const { store, database, databasePath, conversation, project } = await fixture();
    store.createMessage(conversation.id, "old needle", "user", [], null, "2026-01-01T00:00:00.000Z");
    const excluded = store.createConversation(project.id, "Excluded history");
    if (kind === "archived") store.archiveConversation(excluded.id, true);
    const writer = new Database(databasePath);
    try {
      const insert = writer.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, '', '[]', '2026-09-08T00:00:00.000Z')");
      writer.transaction(() => {
        for (let index = 0; index < 256; index += 1) insert.run(`excluded-${index}`, excluded.id, kind === "nonterminal" ? "assistant" : kind === "archived" ? "user" : "system");
      })();
    } finally { writer.close(); }
    let ticks = 0;
    expect(searchMessages(database, "needle", { now: () => ticks++, maxScanMs: 8 })).toMatchObject({
      hits: [], incomplete: true,
    });
    expect(ticks).toBeLessThanOrEqual(10);
  });

  it("finds user text and canonical answers across chunks, without exposing work logs or archived chats", async () => {
    const { store, database, conversation, project } = await fixture();
    const user = store.createMessage(conversation.id, "Find literal [x]%_\\ and ÁRBOL");
    const { turn, message } = answer(store, conversation.id, "The answer contains the split nee", "legacy-turn-123");
    store.appendMessageContent(message.id, "dle across");
    store.appendMessageContent(message.id, " chunks.");
    const commentary = store.createMessage(conversation.id, "needle hidden commentary", "assistant", [], turn.id);
    expect(store.messageSearchTarget(commentary.id)).toBeNull();
    expect(store.messageSearchTarget(message.id)).toEqual({ projectId: project.id, conversationId: conversation.id, turnId: turn.id, messageId: message.id });
    store.createMessage(conversation.id, "needle system", "system");
    store.createMessage(conversation.id, "needle unfinalized", "assistant");
    const archived = store.createConversation(project.id, "Archived");
    store.createMessage(archived.id, "needle archived");
    store.archiveConversation(archived.id, true);
    store.settleConversation(conversation.id, true);
    const found = searchMessages(database, "needle across chunks");
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ messageId: message.id, turnId: turn.id, projectId: project.id, conversationId: conversation.id, role: "assistant" });
    expect(messageSearchResultSchema.safeParse(found).success).toBe(true);
    expect(searchMessages(database, "needle").hits.map(({ messageId }) => messageId)).toEqual([message.id]);
    expect(searchMessages(database, "[x]%_\\").hits[0]?.messageId).toBe(user.id);
    expect(searchMessages(database, "árbol").hits[0]?.messageId).toBe(user.id);
    store.archiveConversation(conversation.id, true);
    expect(searchMessages(database, "needle").hits).toEqual([]);
    expect(store.messageSearchTarget(message.id)).toBeNull();
  });

  it("checks the deadline between ordered chunks without returning a partial message", async () => {
    const { store, database, databasePath, conversation } = await fixture();
    const message = store.createMessage(conversation.id, "needle prefix ");
    const writer = new Database(databasePath);
    try {
      const insert = writer.prepare("INSERT INTO message_content_chunks (message_id, content) VALUES (?, ?)");
      writer.transaction(() => {
        for (let index = 0; index < 128; index += 1) insert.run(message.id, `part-${index} `);
      })();
    } finally { writer.close(); }
    let ticks = 0;
    expect(searchMessages(database, "needle", { now: () => ticks++, maxScanMs: 8 })).toMatchObject({
      hits: [], incomplete: true,
    });
    expect(ticks).toBeLessThanOrEqual(10);
  });

  it("preserves ordered Unicode and NUL content while bounding chunk bytes", async () => {
    const { store, database, conversation } = await fixture();
    const message = store.createMessage(conversation.id, "α\0nee");
    store.appendMessageContent(message.id, "dle 😀");
    store.appendMessageContent(message.id, " suffix");
    const content = store.message(message.id).content;
    expect(searchMessages(database, "needle 😀 suffix", { maxScanBytes: Buffer.byteLength(content) })).toMatchObject({
      hits: [expect.objectContaining({ messageId: message.id })], incomplete: false,
    });
    expect(searchMessages(database, "needle", { maxScanBytes: Buffer.byteLength(content) - 1 })).toMatchObject({
      hits: [], incomplete: true,
    });
  });

  it("returns a deterministic bounded newest-first page and reports incomplete scans", async () => {
    const { store, database, conversation } = await fixture();
    for (let index = 0; index < 25; index += 1) store.createMessage(conversation.id, `needle ${index}`);
    const result = searchMessages(database, "needle");
    expect(result.hits).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.incomplete).toBe(false);
    expect(result).toEqual(searchMessages(database, "needle"));
    expect(result.hits.map(({ createdAt, messageId }) => `${createdAt}:${messageId}`)).toEqual(
      result.hits.map(({ createdAt, messageId }) => `${createdAt}:${messageId}`).sort().reverse(),
    );
    expect(searchMessages(database, "absent", { maxScanBytes: 1 })).toMatchObject({ hits: [], incomplete: true });
    expect(searchMessages(database, "needle", { maxScanMs: 0 })).toMatchObject({ hits: [], incomplete: true });
    expect(searchMessages(database, "needle", { maxScanBytes: 1 })).toMatchObject({ hits: [], incomplete: true });
  });

  it("remains current after edits, deletion and a fresh read connection, without writing an index", async () => {
    const { store, database, databasePath, conversation, project } = await fixture();
    const message = store.createMessage(conversation.id, "durable needle");
    expect(searchMessages(database, "needle").hits[0]?.messageId).toBe(message.id);
    const reopened = new Database(databasePath, { readonly: true });
    try {
      expect(searchMessages(reopened, "needle")).toEqual(searchMessages(database, "needle"));
      const before = reopened.pragma("schema_version", { simple: true });
      store.appendMessageContent(message.id, " updated");
      expect(searchMessages(reopened, "needle updated").hits).toHaveLength(1);
      store.deleteConversation(conversation.id);
      expect(searchMessages(reopened, "needle").hits).toEqual([]);
      expect(reopened.pragma("schema_version", { simple: true })).toBe(before);
      expect(store.project(project.id).id).toBe(project.id);
    } finally { reopened.close(); }
  });

  it("scans past an eligible empty message instead of failing the search", async () => {
    const { store, database, databasePath, conversation } = await fixture();
    const older = store.createMessage(conversation.id, "old needle", "user", [], null, "2026-01-01T00:00:00.000Z");
    const writer = new Database(databasePath);
    try {
      // Recovery imports accept an empty user message, which stays searchable.
      writer.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'user', '', '[]', '2026-09-08T00:00:00.000Z')")
        .run("empty-user-message", conversation.id);
    } finally { writer.close(); }
    expect(searchMessages(database, "needle")).toMatchObject({
      hits: [expect.objectContaining({ messageId: older.id })], incomplete: false,
    });
  });
});
