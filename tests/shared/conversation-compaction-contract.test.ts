import { describe, expect, it } from "vitest";

import {
  clientCommandSchema,
} from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import {
  CONVERSATION_COMPACT_AND_SEND_REQUEST_TIMEOUT_MS,
  CONVERSATION_COMPACTION_REQUEST_TIMEOUT_MS,
  MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
} from "../../src/shared/runtime-command-timeouts";

describe("conversation compaction contracts", () => {
  it("accepts an optional bounded focus instruction", () => {
    const command = clientCommandSchema.parse({
      type: "conversation.compact",
      requestId: "22222222-2222-4222-8222-222222222222",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        instruction: "  remember the retrieval implementation  ",
      },
    });

    expect(command).toMatchObject({
      type: "conversation.compact",
      payload: { instruction: "remember the retrieval implementation" },
    });
    expect(clientCommandSchema.safeParse({
      type: "conversation.compact",
      requestId: "22222222-2222-4222-8222-222222222222",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        instruction: "x".repeat(4_001),
      },
    }).success).toBe(false);
  });

  it("validates the renderer-safe completion acknowledgement", () => {
    expect(serverEventSchema.safeParse({
      type: "request.result",
      requestId: "22222222-2222-4222-8222-222222222222",
      result: {
        kind: "conversation.compacted",
        conversationId: "11111111-1111-4111-8111-111111111111",
        providerId: "claude",
        instructionForwarded: true,
        message: "Context compacted with the focus instruction.",
      },
    }).success).toBe(true);
    expect(serverEventSchema.safeParse({
      type: "request.result",
      requestId: "22222222-2222-4222-8222-222222222222",
      result: {
        kind: "conversation.compacted",
        conversationId: "11111111-1111-4111-8111-111111111111",
        providerId: "unknown",
        instructionForwarded: "yes",
        message: "Nope",
      },
    }).success).toBe(false);
  });
});

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const sendPayload = {
  conversationId,
  content: "  pick up where we left off  ",
  attachments: [],
  activate: true,
  context: { fileReferences: [{ path: "src/index.ts", lineStart: 1, lineEnd: 4 }] },
};
const compactAndSend = (payload: Record<string, unknown>) => clientCommandSchema.safeParse({
  type: "conversation.compact-and-send",
  requestId,
  payload,
});
const compactAndSendResult = (result: Record<string, unknown>) => serverEventSchema.safeParse({
  type: "request.result",
  requestId,
  result: { kind: "conversation.compact-and-send", conversationId, ...result },
});
const onReturnCompaction = {
  providerId: "claude",
  beforeTokens: 240_000,
  afterTokens: 18_000,
  instructionForwarded: false,
  trigger: "on-return",
};

describe("compact-and-send contracts", () => {
  it("carries every message.send field plus the on-return reason", () => {
    const parsed = compactAndSend({ ...sendPayload, reason: "on-return" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      type: "conversation.compact-and-send",
      payload: { ...sendPayload, content: "pick up where we left off", reason: "on-return" },
    });
    const minimal = compactAndSend({ conversationId, content: "next", reason: "on-return" });
    expect(minimal.data).toEqual({
      type: "conversation.compact-and-send",
      requestId,
      payload: { conversationId, content: "next", attachments: [], reason: "on-return" },
    });
  });

  it("applies the message.send rules and requires the on-return reason", () => {
    expect(compactAndSend({ ...sendPayload }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "manual" }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "on-return", content: "   " }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "on-return", content: "x".repeat(20_001) }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "on-return", conversationId: "chat" }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "on-return", instruction: "focus" }).success).toBe(false);
    expect(compactAndSend({ ...sendPayload, reason: "on-return", context: { unknown: true } }).success).toBe(false);
  });

  it("validates the sent result with an on-return compaction record", () => {
    const sent = { outcome: "sent", turnId, userMessageId: "user-message-1", disposition: "new-turn", compaction: onReturnCompaction };
    expect(compactAndSendResult(sent).success).toBe(true);
    expect(compactAndSendResult({ ...sent, disposition: "follow-up" }).success).toBe(true);
    expect(compactAndSendResult({ ...sent, compaction: { ...onReturnCompaction, trigger: "manual" } }).success).toBe(false);
    expect(compactAndSendResult({ ...sent, compaction: { ...onReturnCompaction, trigger: undefined } }).success).toBe(false);
    expect(compactAndSendResult({ ...sent, turnId: undefined }).success).toBe(false);
    expect(compactAndSendResult({ ...sent, disposition: "queued" }).success).toBe(false);
    expect(compactAndSendResult({ ...sent, outcome: "queued" }).success).toBe(false);
  });

  it("validates the compaction-failed result that sent nothing", () => {
    expect(compactAndSendResult({ outcome: "compaction-failed", message: "Claude could not compact this chat." }).success).toBe(true);
    expect(compactAndSendResult({ outcome: "compaction-failed" }).success).toBe(false);
    expect(compactAndSendResult({ outcome: "compaction-failed", message: 1 }).success).toBe(false);
  });

  it("keeps the request pending through compaction and the send deadline", () => {
    expect(CONVERSATION_COMPACT_AND_SEND_REQUEST_TIMEOUT_MS)
      .toBe(CONVERSATION_COMPACTION_REQUEST_TIMEOUT_MS + MESSAGE_SEND_PREPARATION_TIMEOUT_MS);
    expect(CONVERSATION_COMPACT_AND_SEND_REQUEST_TIMEOUT_MS).toBe(780_000);
  });

  it("updates the compact on return setting", () => {
    const update = (compactOnReturn: unknown) => clientCommandSchema.safeParse({
      type: "settings.update",
      requestId,
      payload: { compactOnReturn },
    });
    expect(update("offer").success).toBe(true);
    expect(update("never").success).toBe(true);
    expect(update("always").success).toBe(false);
  });
});
