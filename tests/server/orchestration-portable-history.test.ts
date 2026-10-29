// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import {
  PortableHistoryBudgetError, portableHistoryBudget, portableHistoryCost,
  selectPortableHistory, type PortableHistoryItem,
} from "../../src/server/orchestration-v2/portable-history";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime } from "../support/turn-controller-runtime";

const item = (id: string, role: "user" | "assistant", text: string): PortableHistoryItem => ({
  id, threadId: "thread-1", role, text, runId: `run-${id}`, turnId: `turn-${id}`, providerBackingId: null,
  kind: role === "user" ? "user-message" : "assistant-message", status: "completed",
});

afterEach(cleanupTurnControllerTestDirectories);

describe("T3-compatible portable history selection", () => {
  it("preserves short history intact and chronological with explicit provenance", () => {
    const items = [item("1", "user", "Original request"), item("2", "assistant", "Partial response")];
    items[1]!.status = "interrupted";
    const result = selectPortableHistory({ threadId: "thread-1", items, budget: 16_000 });
    expect(result.items).toEqual(items);
    expect(result.omittedCount).toBe(0);
    expect(result.rendered).toContain('"status":"interrupted"');
    expect(result.rendered.indexOf("Original request")).toBeLessThan(result.rendered.indexOf("Partial response"));
    expect(result.cost).toBe(portableHistoryCost(result.items, result.context));
    expect(result.context).toContain("inertia_request_context");
  });

  it("prioritizes recent user/assistant and opening context without clipping large messages", () => {
    const items = [item("opening", "user", "Beginning"), item("large", "assistant", "x".repeat(12_000)),
      item("recent", "user", "Latest question"), item("answer", "assistant", "Latest answer")];
    const result = selectPortableHistory({ threadId: "thread-1", items, budget: 3_000, previouslyOmitted: 300 });
    expect(result.items.map(({ id }) => id)).toEqual(["opening", "recent", "answer"]);
    expect(result.omittedItemIds).toEqual(["large"]);
    expect(result.omittedCount).toBe(301);
    expect(result.cost).toBeLessThanOrEqual(3_000);
    expect(result.rendered).not.toContain("xxx");
  });

  it("reserves the entire new prompt, images, native occupancy and response space", () => {
    expect(portableHistoryBudget({ currentPromptBytes: 50_000, imageCount: 1,
      modelWindow: 100_000, nativeUsedTokens: 10_000 })).toBe(6_808);
    expect(portableHistoryBudget({ currentPromptBytes: 80_000, imageCount: 0,
      modelWindow: 100_000 })).toBe(0);
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0,
      modelWindow: 1_000_000, configuredCap: 100_000 })).toBe(64_000);
    expect(portableHistoryBudget({ currentPromptBytes: 20_000, imageCount: 0,
      modelWindow: 100_000, reportedWindow: 40_000 })).toBe(4_000);
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [], budget: 1 }))
      .toThrow(PortableHistoryBudgetError);
  });

  it("rejects foreign identity, duplicate entries and unsupported private state", () => {
    const first = item("1", "user", "Question");
    expect(() => selectPortableHistory({ threadId: "other", items: [first], budget: 16_000 })).toThrow("identity");
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [first, first], budget: 16_000 })).toThrow("identity");
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [{ ...first, reasoning: "private" } as never], budget: 16_000 })).toThrow();
  });
});

describe("portable history durable source", () => {
  it("reads complete stream chunks, omits oversized entries and leaves the current message separate", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.createMessage(runtime.conversationId, "Original request", "user");
      runtime.store.createMessage(runtime.conversationId, "x".repeat(65_000), "assistant");
      runtime.store.createMessage(runtime.conversationId, "Small answer", "assistant");
      const current = runtime.store.createMessage(runtime.conversationId, "New request untouched", "user");
      const history = runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        excludedMessageId: current.id, capacityBytes: 16_000, currentPromptBytes: 100, imageCount: 0 });
      expect(history?.selection.items.map(({ text }) => text)).toEqual(["Original request", "Small answer"]);
      expect(history?.omittedMessageCount).toBe(1);
      expect(history?.blocks[0]?.content).not.toContain("New request untouched");
    } finally { runtime.store.close(); }
  });

  it("retains endpoint containment and fails admission when a context handoff cannot fit", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.createMessage(runtime.conversationId, "Unattributed private context", "user");
      const history = runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        capacityBytes: 16_000, currentPromptBytes: 100, imageCount: 0,
        route: { backendProfileId: "different", endpointIdentity: "https://other.example", includeUnattributed: false } });
      expect(history?.messageCount).toBe(0);
      expect(history?.withheldMessageCount).toBe(1);
      expect(history?.blocks[0]?.content).not.toContain("private context");
      expect(() => runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        capacityBytes: 16_000, currentPromptBytes: 30_000, modelWindow: 32_000, imageCount: 0 }))
        .toThrow(PortableHistoryBudgetError);
    } finally { runtime.store.close(); }
  });
});
