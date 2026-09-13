// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestAttachment,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("TurnController terminal result persistence", () => {
  it("settles a failed terminal session write only after exact cleanup joins", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const attachment = await turnControllerTestAttachment(
        runtime, "91929394-9192-4192-8192-919293949192", "terminal-result.png",
      );
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Persist this provider result.",
        attachments: [attachment],
      });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      runtime.provider.deferOwnedStop("settled");
      const update = vi.spyOn(runtime.store, "updateConversation")
        .mockImplementationOnce(() => {
          throw new Error("Injected terminal session persistence failure.");
        });
      runtime.provider.resolve({
        status: "completed",
        sessionId: "terminal-provider-session",
        text: "Completed response.",
      });
      await flushTurnControllerTestPromises();

      expect(update).toHaveBeenNthCalledWith(1, runtime.conversationId,
        expect.objectContaining({ providerSessionId: "terminal-provider-session" }));
      expect(update.mock.results[0]?.type).toBe("throw");
      expect(runtime.provider.cancelCount).toBeGreaterThan(0);
      expect(runtime.provider.stopOwnedCalls).toEqual([{
        conversationId: runtime.conversationId,
        identity: { runId: queued.turn.runId, turnId: queued.turn.id },
      }]);
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "running", runState: { state: "cancelling" }, terminalReason: null,
      });
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toHaveLength(1);
      expect(runtime.attachmentReleases).toEqual([]);
      expect(() => runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Wait for exact provider cleanup.",
      })).toThrow("already has an active turn");

      runtime.provider.resolveOwnedStop();
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();

      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "failed", runState: { state: "failed" },
        terminalReason: "stream-persistence-failed",
      });
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
      expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
      expect(runtime.events).toContainEqual(expect.objectContaining({
        type: "agent.failed", message: "Injected terminal session persistence failure.",
      }));
      const retry = runtime.controller.queue({
        conversationId: runtime.conversationId, content: "Retry after the failed write.",
      });
      expect(runtime.controller.start(retry.turn.id)).toBe(true);
      runtime.provider.resolve({ status: "completed", text: "Retry completed." });
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(retry.turn.id).status).toBe("completed");
    } finally {
      runtime.store.close();
    }
  });

  it.each(["missing", "identity-mismatch", "force-detached"] as const)(
    "retains the failed result owner when cleanup is %s",
    async (cleanupResult) => {
      const runtime = await createTurnControllerTestRuntime();
      try {
        const queued = runtime.controller.queue({
          conversationId: runtime.conversationId, content: "Keep uncertain cleanup fenced.",
        });
        expect(runtime.controller.start(queued.turn.id)).toBe(true);
        const update = vi.spyOn(runtime.store, "updateConversation")
          .mockImplementationOnce(() => {
            throw new Error("Injected terminal session persistence failure.");
          });
        const stopOwned = vi.spyOn(runtime.provider, "stopOwned")
          .mockResolvedValue(cleanupResult);
        runtime.provider.resolve({ status: "completed", sessionId: "terminal-provider-session" });
        await flushTurnControllerTestPromises();
        await flushTurnControllerTestPromises();

        expect(update).toHaveBeenNthCalledWith(1, runtime.conversationId,
          expect.objectContaining({ providerSessionId: "terminal-provider-session" }));
        expect(update.mock.results[0]?.type).toBe("throw");
        expect(stopOwned).toHaveBeenCalledWith(runtime.conversationId, {
          runId: queued.turn.runId, turnId: queued.turn.id,
        });
        expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
          status: "running", runState: { state: "cancelling" }, terminalReason: null,
        });
        expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
        expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
          .toHaveLength(1);
        expect(runtime.events.some((event) => event.type === "agent.completed")).toBe(false);
        expect(() => runtime.controller.queue({
          conversationId: runtime.conversationId, content: "Do not bypass uncertain ownership.",
        })).toThrow("already has an active turn");
      } finally {
        runtime.store.close();
      }
    },
  );
});
