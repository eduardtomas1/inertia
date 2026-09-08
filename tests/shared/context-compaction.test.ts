import { describe, expect, it } from "vitest";
import { contextCompactionLabel, isContextCompaction } from "../../src/shared/context-compaction";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";

const compaction = { providerId: "codex" as const, beforeTokens: 173000, afterTokens: 5690, instructionForwarded: false };
describe("confirmed context compaction receipts", () => {
  it("matches the demonstrated token label and preserves zero", () => {
    expect(contextCompactionLabel(compaction)).toBe("Compacted context 173K → 5.69K tokens");
    expect(contextCompactionLabel({ ...compaction, afterTokens: 0 })).toBe("Compacted context 173K → 0 tokens");
    expect(contextCompactionLabel({ ...compaction, afterTokens: null })).toBe("Compacted context");
    expect(contextCompactionLabel({ ...compaction, beforeTokens: null })).toBe("Compacted context");
  });
  it("accepts receipts only on conversation-scoped system rows", () => {
    const message = { id: "receipt", conversationId: "chat", turnId: null, role: "system", content: "/compact", attachments: [], createdAt: "2026-09-08T10:00:00.000Z", compaction };
    expect(chatMessageSchema(message)).toBe(true);
    expect(chatMessageSchema({ ...message, role: "assistant" })).toBe(false);
    expect(chatMessageSchema({ ...message, turnId: "fabricated-turn" })).toBe(false);
    for (const afterTokens of [NaN, Infinity, -1, 1.5, "5690"]) expect(isContextCompaction({ ...compaction, afterTokens })).toBe(false);
    expect(isContextCompaction({ ...compaction, providerId: "unknown" })).toBe(false);
    expect(isContextCompaction({ ...compaction, extra: true })).toBe(false);
  });
});
