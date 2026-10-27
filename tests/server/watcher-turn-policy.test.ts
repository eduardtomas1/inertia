import { describe, expect, it } from "vitest";

import { createWatcherTurnPolicy } from "../../src/server/runtime/watcher/watcher-turn-policy";

describe("watcher turn policy", () => {
  it("refuses tools for a watcher without context access in the shared error shape", async () => {
    const policy = createWatcherTurnPolicy({
      watcherLinks: { policyForConversation: () => ({ status: "active" }) },
      conversation: () => undefined,
    } as never, () => undefined);
    const bridge = policy.hostToolsForTurn({ conversation: { id: "watcher" }, turn: {} } as never)!;
    expect(bridge.definitions).toEqual([]);
    const result = await bridge.invoke({ tool: "inertia_request_context" } as never);
    expect(result.success).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      error: { code: "unknown_tool", message: "That Inertia host tool is not available." },
    });
  });
});
