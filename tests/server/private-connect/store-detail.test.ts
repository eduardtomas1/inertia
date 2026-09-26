import { describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationDetail } from "../../../src/shared/contracts";
import { HISTORY_TOO_LARGE_MESSAGE } from "../../../src/server/persistence/conversation-history";
import { privateConnectStoreDetail } from "../../../src/server/private-connect/store-detail";

describe("Private Connect bounded store projection", () => {
  it("requests only the latest bounded history page", () => {
    const detail = { messages: [{ id: "recent" }] } as ConversationDetail;
    const store = { conversationHistory: vi.fn(() => detail), conversation: vi.fn() };
    expect(privateConnectStoreDetail(store, "chat")).toBe(detail);
    expect(store.conversationHistory).toHaveBeenCalledExactlyOnceWith("chat");
    expect(store.conversation).not.toHaveBeenCalled();
  });

  it("retains authorization metadata for stop and input when one turn exceeds the page budget", () => {
    const conversation = { id: "chat", projectId: "project", archivedAt: null } as Conversation;
    const store = {
      conversationHistory: vi.fn(() => { throw new Error(HISTORY_TOO_LARGE_MESSAGE); }),
      conversation: vi.fn(() => conversation),
    };
    const result = privateConnectStoreDetail(store, "chat");
    expect(result?.conversation).toBe(conversation);
    expect(result?.messages).toEqual([]);
    expect(result?.subagents).toEqual([]);
    expect(store.conversation).toHaveBeenCalledExactlyOnceWith("chat");
  });

  it("preserves missing conversations and propagates unrelated storage failures", () => {
    const store = { conversationHistory: vi.fn(() => null), conversation: vi.fn() };
    expect(privateConnectStoreDetail(store, "missing")).toBeNull();
    store.conversationHistory.mockImplementation(() => { throw new Error("database failure"); });
    expect(() => privateConnectStoreDetail(store, "chat")).toThrow("database failure");
    expect(store.conversation).not.toHaveBeenCalled();
  });
});
