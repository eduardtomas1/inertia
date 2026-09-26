import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RuntimeStore } from "../../src/server/database";
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
  return { store, conversation };
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

describe("bounded conversation history", () => {
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

  it("fails one indivisible oversized turn before it reaches the transport", () => {
    const { store, conversation } = fixture();
    answer(store, conversation.id, 0, "x".repeat(MAX_CONVERSATION_HISTORY_BYTES + 1));
    expect(() => store.conversationHistory(conversation.id)).toThrow("Your history is saved");
    expect(store.conversationShell(conversation.id)?.id).toBe(conversation.id);
  });
});
