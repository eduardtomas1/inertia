// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("turn clock correction and durable settlement repair", () => {
  it.each(["completed", "cancelled"] as const)("settles %s after wall time moves backwards", async (outcome) => {
    let wallTime = Date.parse("2030-01-01T00:00:00.000Z");
    const runtime = await createTurnControllerTestRuntime({}, { clock: () => new Date(wallTime) });
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Finish across a clock correction." });
      runtime.controller.start(queued.turn.id);
      wallTime += 1000;
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      const before = runtime.store.agentTurn(queued.turn.id);
      wallTime -= 60_000;
      if (outcome === "cancelled") runtime.controller.cancel(runtime.conversationId);
      else runtime.provider.resolve({ status: "completed", text: "Finished." });
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();
      const after = runtime.store.agentTurn(queued.turn.id);
      expect(after.status).toBe(outcome);
      expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
      expect(runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." }).turn.status).toBe("queued");
    } finally { runtime.store.close(); }
  });

  it("lets Stop repair a failed terminal commit only after exact provider cleanup", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Recover a transient write failure." });
      runtime.controller.start(queued.turn.id);
      const write = vi.spyOn(runtime.store, "settleAgentTurn").mockImplementation(() => { throw new Error("Temporary SQLite failure"); });
      runtime.provider.resolve({ status: "completed", text: "Finished." });
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
      write.mockRestore();
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      expect(runtime.store.agentTurn(queued.turn.id).status).toBe("failed");
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
    } finally { runtime.store.close(); }
  });
});
