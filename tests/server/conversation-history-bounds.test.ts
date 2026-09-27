import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { CONVERSATION_RECORDS_TOO_LARGE_MESSAGE } from "../../src/server/persistence/conversation-history";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { ConversationDetail, ServerEvent } from "../../src/shared/contracts";
import { MAX_CONVERSATION_HISTORY_BYTES, type ConversationHistoryCursor } from "../../src/shared/conversation-history";

const fixtures: { directory: string; store: RuntimeStore }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-history-bounds-"));
  const store = new RuntimeStore(join(directory, "test.sqlite"), directory);
  fixtures.push({ directory, store });
  const project = store.createProject("History", directory);
  const conversation = store.createConversation(project.id, "Reviewed chat");
  return { store, conversation, database: (store as unknown as { database: Database.Database }).database };
}
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
function answer(store: RuntimeStore, conversationId: string, index: number, content = `Answer ${index}`) {
  const at = new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
  const { turn } = store.beginAgentTurn({ id: `turn-${index}`, runId: `run-${index}`, conversationId,
    content: `Request ${index}`, providerId: "codex", harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
    interactionMode: "build", accessMode: "supervised", configurationRevision: 1,
    association: "authoritative", requestedAt: at });
  const message = store.createMessage(conversationId, content, "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: at, completedAt: at,
    updatedAt: at, terminalAssistantMessageId: message.id });
  return turn;
}
function event(detail: ConversationDetail): ServerEvent {
  return { type: "request.result", requestId: "history", result: { kind: "conversation.detail",
    conversationId: detail.conversation.id, state: "ready", detail } };
}
function pages(store: RuntimeStore, conversationId: string): ConversationDetail[] {
  const loaded: ConversationDetail[] = [];
  let before: ConversationHistoryCursor | null = null;
  do {
    const page: ConversationDetail = store.conversationHistory(conversationId, before ? { before } : {})!;
    loaded.push(page);
    before = page.history!.older;
  } while (before && loaded.length < 10);
  return loaded;
}

describe("conversation-scoped records in history pages", () => {
  it("sends review, usage and goal records only with the latest page and never counts them against turns", () => {
    const { store, conversation, database } = fixture();
    for (let index = 0; index < 60; index++) answer(store, conversation.id, index);
    const insert = database.prepare(`INSERT INTO diff_review_notes
      (id, conversation_id, path, hunk_id, line_ids_json, target_fingerprint, body, stale, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?, 0, ?, ?)`);
    const lineIds = JSON.stringify(Array.from({ length: 4_700 }, (_, index) => `l${index}xxxxxx`));
    for (let index = 0; index < 130; index++) {
      insert.run(`note-${index}`, conversation.id, `src/file-${index}.ts`, lineIds, "a".repeat(64),
        "b".repeat(8_000), "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    }
    const loaded = pages(store, conversation.id);
    expect(loaded.map(({ agentTurns }) => agentTurns.length)).toEqual([40, 20]);
    expect(loaded.map(({ reviewNotes }) => reviewNotes.length)).toEqual([130, 0]);
    const target = store.conversationHistory(conversation.id, { turnId: "turn-0" })!;
    expect([target.reviewNotes, target.usage, target.goals, target.reviewStates, target.reviewSummaries])
      .toEqual([[], [], [], [], []]);
    for (const page of loaded) expect(parseServerEvent(event(page))).toEqual(event(page));
  });

  it("bounds conversation-scoped records separately with a readable error", () => {
    const { store, conversation, database } = fixture();
    answer(store, conversation.id, 0);
    const insert = database.prepare(`INSERT INTO diff_review_notes
      (id, conversation_id, path, hunk_id, line_ids_json, target_fingerprint, body, stale, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?, 0, ?, ?)`);
    const lineIds = JSON.stringify(Array.from({ length: 4_700 }, (_, index) => `l${index}xxxxxx`));
    for (let index = 0; index * 64_000 <= MAX_CONVERSATION_HISTORY_BYTES / 2; index++) {
      insert.run(`note-${index}`, conversation.id, `src/file-${index}.ts`, lineIds, "a".repeat(64),
        "b".repeat(8_000), "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    }
    let thrown: unknown;
    try { store.conversationHistory(conversation.id); } catch (error) { thrown = error; }
    expect(publicRuntimeError(thrown)).toBe(CONVERSATION_RECORDS_TOO_LARGE_MESSAGE);
    expect(store.conversationHistory(conversation.id, { turnId: "turn-0" })!.agentTurns).toHaveLength(1);
  });
});

describe("oversized and missing history", () => {
  it("shows why a searched message or turn is unavailable", () => {
    const { store, conversation } = fixture();
    const failure = (request: Parameters<RuntimeStore["conversationHistory"]>[1]) => {
      try { store.conversationHistory(conversation.id, request); } catch (error) { return publicRuntimeError(error); }
      return null;
    };
    expect(failure({ messageId: "missing" })).toBe("This message is no longer available.");
    expect(failure({ turnId: "missing" })).toBe("This turn is no longer available.");
  });

  it("marks one oversized turn as omitted and keeps loading older turns", () => {
    const { store, conversation } = fixture();
    for (let index = 0; index < 3; index++) {
      answer(store, conversation.id, index, index === 1 ? "x".repeat(MAX_CONVERSATION_HISTORY_BYTES + 1) : `ok ${index}`);
    }
    const loaded = pages(store, conversation.id);
    expect(loaded.flatMap(({ agentTurns }) => agentTurns.map(({ id }) => id)).sort()).toEqual(["turn-0", "turn-1", "turn-2"]);
    expect(loaded.at(-1)!.history!.older).toBeNull();
    const omitted = loaded.find(({ history }) => history?.omittedTurnIds)!;
    expect(omitted.history!.omittedTurnIds).toEqual(["turn-1"]);
    expect(omitted.messages.map(({ role, content }) => [role, content])).toEqual([["user", "Request 1"]]);
    expect(Buffer.byteLength(JSON.stringify(event(omitted)))).toBeLessThan(MAX_CONVERSATION_HISTORY_BYTES);
    expect(parseServerEvent(event(omitted))).toEqual(event(omitted));
    expect(store.conversationHistory(conversation.id, { turnId: "turn-1" })!.history!.omittedTurnIds).toEqual(["turn-1"]);
    expect(() => parseServerEvent(event({ ...omitted, history: { older: null, omittedTurnIds: ["turn-2"] } })))
      .toThrow("Malformed server event");
  });
});
