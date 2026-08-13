import { describe, expect, it } from "vitest";

import {
  clientCommandSchema,
} from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";

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
