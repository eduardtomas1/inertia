import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { messageSearchResultSchema } from "../../src/shared/message-search";

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
  it("finds user text and canonical answers across chunks, without exposing work logs or archived chats", async () => {
    const { store, database, conversation, project } = await fixture();
    const user = store.createMessage(conversation.id, "Find literal [x]%_\\ and ÁRBOL");
    const { turn, message } = answer(store, conversation.id, "The answer contains the split nee", "legacy-turn-123");
    store.appendMessageContent(message.id, "dle across");
    store.appendMessageContent(message.id, " chunks.");
    store.createMessage(conversation.id, "needle hidden commentary", "assistant", [], turn.id);
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
});
