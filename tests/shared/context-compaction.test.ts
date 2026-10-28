import { describe, expect, it } from "vitest";
import { CONTEXT_COMPACTION_TRIGGERS, contextCompactionLabel, isContextCompaction } from "../../src/shared/context-compaction";
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
  it("records an optional manual or on-return trigger within the stored size", () => {
    expect(CONTEXT_COMPACTION_TRIGGERS).toEqual(["manual", "on-return"]);
    for (const trigger of CONTEXT_COMPACTION_TRIGGERS) expect(isContextCompaction({ ...compaction, trigger })).toBe(true);
    for (const trigger of ["automatic", null, "", 1]) expect(isContextCompaction({ ...compaction, trigger })).toBe(false);
    expect(isContextCompaction({ ...compaction, trigger: undefined })).toBe(false);
    expect(isContextCompaction({ ...compaction, trigger: "on-return", extra: true })).toBe(false);
    const widest = { providerId: "antigravity", beforeTokens: Number.MAX_SAFE_INTEGER, afterTokens: Number.MAX_SAFE_INTEGER, instructionForwarded: false, trigger: "on-return" };
    expect(isContextCompaction(widest)).toBe(true);
    expect(JSON.stringify(widest).length).toBeLessThan(256);
  });
  it("records which session instruction a compaction sent, or that it sent none", () => {
    const digest = "a".repeat(64);
    expect(isContextCompaction({ ...compaction, sessionInstructionDigest: digest })).toBe(true);
    expect(isContextCompaction({ ...compaction, sessionInstructionDigest: null })).toBe(true);
    expect(isContextCompaction({ ...compaction, trigger: "manual", sessionInstructionDigest: digest })).toBe(true);
    for (const sessionInstructionDigest of ["A".repeat(64), "a".repeat(63), "", 1, undefined]) {
      expect(isContextCompaction({ ...compaction, sessionInstructionDigest })).toBe(false);
    }
    const widest = { providerId: "antigravity", beforeTokens: Number.MAX_SAFE_INTEGER, afterTokens: Number.MAX_SAFE_INTEGER, instructionForwarded: false, trigger: "on-return", sessionInstructionDigest: digest };
    expect(isContextCompaction(widest)).toBe(true);
    expect(JSON.stringify(widest).length).toBeLessThan(256);
  });
});
