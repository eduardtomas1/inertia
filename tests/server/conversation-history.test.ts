import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import Database from "better-sqlite3";
import { RuntimeStore } from "../../src/server/database";
import { historyPredicate } from "../../src/server/persistence/conversation-history";
import { MAX_CONVERSATION_HISTORY_BYTES, type ConversationHistoryCursor } from "../../src/shared/conversation-history";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { sendRuntimeEvent, MAX_QUEUED_RUNTIME_EVENT_BYTES } from "../../src/server/runtime-protocol";
import type { ConversationDetail, ServerEvent } from "../../src/shared/contracts";

const fixtures: { directory: string; store: RuntimeStore }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-history-page-"));
  const store = new RuntimeStore(join(directory, "test.sqlite"), directory);
  fixtures.push({ directory, store });
  const project = store.createProject("History", directory);
  const conversation = store.createConversation(project.id, "Large chat");
  return { store, conversation, databasePath: join(directory, "test.sqlite") };
}
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
function answer(store: RuntimeStore, conversationId: string, index: number, content: string) {
  const at = new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
  const { turn } = store.beginAgentTurn({ id: `turn-${index}`, runId: `run-${index}`, conversationId,
    content: `Request ${index}`, providerId: "codex", harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
    interactionMode: "build", accessMode: "supervised", configurationRevision: 1,
    association: "authoritative", requestedAt: at });
  const message = store.createMessage(conversationId, content, "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: at, completedAt: at,
    updatedAt: at, terminalAssistantMessageId: message.id });
  return message;
}
function result(detail: ConversationDetail): ServerEvent {
  return { type: "request.result", requestId: "history-page", result: { kind: "conversation.detail",
    conversationId: detail.conversation.id, state: "ready", detail } };
}

describe("plan document on the latest history page", () => {
  function planned(documentTurn: number, planTurns: Iterable<number>) {
    const { store, conversation } = fixture();
    for (let index = 0; index < 60; index++) answer(store, conversation.id, index, `Answer ${index}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const index of [documentTurn, ...planTurns]) {
      vi.setSystemTime(Date.UTC(2030, 0, 2, 0, 0, index));
      store.upsertAgentPlan({ conversationId: conversation.id, runId: `run-${index}`, turnId: `turn-${index}`,
        explanation: index === documentTurn ? "# Plan: Ship the fix" : null,
        steps: [{ step: "Ship the fix", status: index === documentTurn ? "pending" : "inProgress" }] });
    }
    vi.useRealTimers();
    return { store, conversation };
  }
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it("includes the document of a plan on an older page when consecutive plan turns lead to the newest plan", () => {
    const { store, conversation } = planned(5, range(6, 59));
    const page = store.conversationHistory(conversation.id)!;
    expect(page.agentTurns.some(({ id }) => id === "turn-5")).toBe(false);
    expect(page.plans.filter(({ runId }) => runId === "run-5")).toEqual([expect.objectContaining({
      turnId: "turn-5", explanation: "# Plan: Ship the fix" })]);
    expect(page.plans.at(-1)?.runId).toBe("run-59");
    expect(new Set(page.plans.map(({ runId }) => runId)).size).toBe(page.plans.length);

    const older = store.conversationHistory(conversation.id, { before: page.history!.older! })!;
    expect(older.plans.filter(({ runId }) => runId === "run-5")).toHaveLength(1);
  });

  it("leaves out a document separated from the newest plan by turns without a plan", () => {
    const { store, conversation } = planned(5, range(11, 59));
    expect(store.conversationHistory(conversation.id)!.plans.some(({ runId }) => runId === "run-5")).toBe(false);
  });

  it("adds nothing when the documented plan is already on the latest page", () => {
    const { store, conversation } = planned(50, range(51, 59));
    expect(store.conversationHistory(conversation.id)!.plans.map(({ runId }) => runId))
      .toEqual(range(50, 59).map((index) => `run-${index}`));
  });
});

describe("bounded conversation history", () => {
  it("scopes legacy history rows through the conversation-turn index instead of scanning the chat", () => {
    const { conversation, databasePath } = fixture();
    const at = "2030-01-01T00:00:30.000Z";
    const scope = { units: [{ kind: "turn" as const, id: "turn-1", at }], older: null, upper: at };
    const where = historyPredicate("activities", scope, conversation.id);
    const database = new Database(databasePath, { readonly: true });
    try {
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM activities WHERE ${where.sql}`)
        .all(...where.parameters) as { detail: string }[];
      expect(plan.map(({ detail }) => detail).join("\n")).toContain("activities_conversation_turn_created_idx");
      expect(plan.map(({ detail }) => detail).join("\n")).not.toContain("activities_conversation_created_idx");
    } finally {
      database.close();
    }
  });

  it("keeps the newest 60 unique gallery attachments across unloaded pages without exposing bodies or paths", () => {
    const { store, conversation } = fixture();
    const attachment = (index: number) => ({ id: `image-${index}`, name: `image-${index}.png`,
      path: `PRIVATE_PATH_${index}`, mimeType: "image/png" as const, size: 42 });
    for (let index = 0; index < 65; index++) store.createMessage(conversation.id, `PRIVATE_BODY_${index}`,
      "user", [attachment(index)], null, new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString());
    store.createMessage(conversation.id, "Repeated image", "user", [attachment(64)], null, "2030-01-02T00:00:00.000Z");
    const other = store.createConversation(conversation.projectId, "Other gallery");
    store.createMessage(other.id, "Foreign attachment", "user", [attachment(99)]);
    const page = store.conversationHistory(conversation.id)!;
    expect(page.messages).toHaveLength(40);
    expect(page.attachmentGallery?.map(({ id }) => id)).toEqual(Array.from({ length: 60 }, (_, index) => `image-${64 - index}`));
    expect(JSON.stringify(page.attachmentGallery)).not.toMatch(/PRIVATE_|path|image-99/u);
    expect(parseServerEvent(result(page))).toEqual(result(page));
    const entry = page.attachmentGallery![0]!;
    for (const invalid of [[{ ...entry, path: "PRIVATE_PATH" }], [entry, entry],
      [{ ...entry, size: -1 }], Array.from({ length: 61 }, (_, index) => ({ ...entry, id: `extra-${index}` }))]) {
      expect(() => parseServerEvent(result({ ...page, attachmentGallery: invalid }))).toThrow("Malformed server event");
    }
  });

  it("pages normal turn-linked history beyond the transport ceiling without losing identities or closing the socket", () => {
    const { store, conversation } = fixture();
    const text = "x".repeat(450_000);
    for (let index = 0; index < 150; index++) answer(store, conversation.id, index, text);
    expect(text.length * 150).toBeGreaterThan(MAX_QUEUED_RUNTIME_EVENT_BYTES);
    const sent: string[] = [];
    const terminate = vi.fn();
    const socket = { readyState: 1, bufferedAmount: 0, terminate,
      send: (value: string, done: () => void) => { sent.push(value); done(); } } as unknown as WebSocket;
    const seen = new Set<string>();
    let before: ConversationHistoryCursor | null = null;
    do {
      const page: ConversationDetail = store.conversationHistory(conversation.id, before ? { before } : {})!;
      const event = result(page);
      expect(parseServerEvent(event)).toEqual(event);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(MAX_CONVERSATION_HISTORY_BYTES + 1024);
      for (const turn of page.agentTurns) { expect(seen.has(turn.id)).toBe(false); seen.add(turn.id); }
      sendRuntimeEvent(socket, event);
      before = page.history!.older;
    } while (before);
    expect(seen.size).toBe(150);
    sendRuntimeEvent(socket, { type: "request.ok", requestId: "still-connected" });
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "request.ok", requestId: "still-connected" });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("can load a searched old message directly and keeps other conversations out", () => {
    const { store, conversation } = fixture();
    let first = "";
    for (let index = 0; index < 55; index++) {
      const message = answer(store, conversation.id, index, `Answer ${index}`);
      if (index === 0) first = message.id;
    }
    const recent = store.conversationHistory(conversation.id)!;
    expect(recent.messages.some(({ id }) => id === first)).toBe(false);
    const target = store.conversationHistory(conversation.id, { messageId: first })!;
    expect(target.messages.some(({ id }) => id === first)).toBe(true);
    expect(parseServerEvent(result(target))).toEqual(result(target));
    const other = store.createConversation(conversation.projectId, "Other");
    expect(() => store.conversationHistory(other.id, { messageId: first })).toThrow("no longer available");
  });

  it("pages equal-timestamp legacy messages without skipping or duplicating records", () => {
    const { store, conversation } = fixture();
    for (let index = 0; index < 90; index++) store.createMessage(conversation.id, `Legacy ${index}`, "assistant", [], null, "2030-01-01T00:00:00.000Z");
    const seen = new Set<string>();
    let before: ConversationHistoryCursor | null = null;
    do {
      const page: ConversationDetail = store.conversationHistory(conversation.id, before ? { before } : {})!;
      for (const message of page.messages) { expect(seen.has(message.id)).toBe(false); seen.add(message.id); }
      before = page.history!.older;
    } while (before);
    expect(seen.size).toBe(90);
  });
});
