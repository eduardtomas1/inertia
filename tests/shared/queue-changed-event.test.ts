import { describe, expect, it } from "vitest";
import type { RuntimeMutationEvent } from "../../src/shared/contracts/events";
import { runtimeEventScopeMatches } from "../../src/shared/contracts/server-event-discriminants";
import { parseServerEvent, serverEventSchema } from "../../src/shared/contracts/server-event-schema";

const conversationId = "22222222-2222-4222-8222-222222222222";
const otherConversationId = "33333333-3333-4333-8333-333333333333";
const sync = { runtimeGeneration: "gen-1", latestSequence: 7 };

function wrap(event: unknown, scope: unknown = { kind: "conversation-detail", conversationId }) {
  return { type: "runtime.event", sync, scope, event };
}

describe("conversation.queue.changed contract", () => {
  it("parses valid bare and sequenced conversation.queue.changed events", () => {
    const bare: RuntimeMutationEvent = { type: "conversation.queue.changed", conversationId, revision: 0 };
    expect(parseServerEvent(bare)).toEqual(bare);

    const maxSafe = { type: "conversation.queue.changed", conversationId, revision: Number.MAX_SAFE_INTEGER };
    expect(parseServerEvent(maxSafe)).toEqual(maxSafe);

    const sequenced = wrap({ type: "conversation.queue.changed", conversationId, revision: 4 });
    expect(parseServerEvent(sequenced)).toEqual(sequenced);
  });

  it("routes conversation.queue.changed to conversation-detail scope only", () => {
    const event: RuntimeMutationEvent = { type: "conversation.queue.changed", conversationId, revision: 3 };
    expect(runtimeEventScopeMatches({ kind: "conversation-detail", conversationId }, event)).toBe(true);
    expect(runtimeEventScopeMatches({ kind: "conversation-detail", conversationId: otherConversationId }, event)).toBe(false);
    expect(runtimeEventScopeMatches({ kind: "shell" }, event)).toBe(false);

    expect(serverEventSchema.safeParse(wrap(event, { kind: "shell" })).success).toBe(false);
    expect(serverEventSchema.safeParse(wrap(event, { kind: "conversation-detail", conversationId: otherConversationId })).success).toBe(false);
  });

  it.each([
    ["negative revision", { type: "conversation.queue.changed", conversationId, revision: -1 }],
    ["fractional revision", { type: "conversation.queue.changed", conversationId, revision: 1.5 }],
    ["NaN revision", { type: "conversation.queue.changed", conversationId, revision: Number.NaN }],
    ["Infinity revision", { type: "conversation.queue.changed", conversationId, revision: Number.POSITIVE_INFINITY }],
    ["unsafe integer revision", { type: "conversation.queue.changed", conversationId, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["string revision", { type: "conversation.queue.changed", conversationId, revision: "1" }],
    ["missing revision", { type: "conversation.queue.changed", conversationId }],
    ["non-string conversationId", { type: "conversation.queue.changed", conversationId: 123, revision: 1 }],
    ["missing conversationId", { type: "conversation.queue.changed", revision: 1 }],
  ])("rejects invalid payload: %s", (_label, payload) => {
    expect(serverEventSchema.safeParse(payload).success).toBe(false);
    expect(serverEventSchema.safeParse(wrap(payload)).success).toBe(false);
  });
});
