// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestAttachment,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

function writeFailure(): never {
  throw Object.assign(new Error("Persistent SQLite write failure."), { code: "SQLITE_FULL" });
}

describe("TurnController cancellation persistence and cleanup", () => {
  it.each(["lifecycle", "conversation"] as const)(
    "joins exact cleanup despite persistent cancellation %s writes failing",
    async (stage) => {
      const runtime = await createTurnControllerTestRuntime();
      try {
        const attachment = await turnControllerTestAttachment(runtime,
          "91929394-9192-4192-8192-919293949192", "cancellation-persistence.png");
        const queued = runtime.controller.queue({
          conversationId: runtime.conversationId,
          content: "Keep cleanup observed when cancellation cannot be saved.",
          attachments: [attachment],
        });
        expect(runtime.controller.start(queued.turn.id)).toBe(true);
        expect(runtime.scheduler.callbacks.size).toBeGreaterThan(0);
        runtime.provider.deferOwnedStop("settled");
        const updateConversation = runtime.store.updateConversation.bind(runtime.store);
        const conversationWrite = vi.spyOn(runtime.store, "updateConversation");
        const cancellationWrite = stage === "lifecycle"
          ? vi.spyOn(runtime.store, "updateAgentTurnLifecycle").mockImplementation(writeFailure)
          : conversationWrite.mockImplementation((id, update) => update.status === "failed"
              ? updateConversation(id, update) : writeFailure());
        if (stage === "lifecycle") conversationWrite.mockImplementationOnce(writeFailure);
        runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
        await flushTurnControllerTestPromises();

        expect(cancellationWrite.mock.results.some(({ type }) => type === "throw")).toBe(true);
        expect(runtime.provider.stopOwnedCalls).toEqual([{
          conversationId: runtime.conversationId,
          identity: { runId: queued.turn.runId, turnId: queued.turn.id },
        }]);
        expect(runtime.scheduler.callbacks.size).toBe(0);
        let drained = false;
        const drain = runtime.controller.drainSettlementTasks().then(() => { drained = true; });
        await flushTurnControllerTestPromises();
        expect(drained).toBe(false);
        expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toHaveLength(1);
        expect(runtime.attachmentReleases).toEqual([]);
        expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
          content: "Do not overlap the cleanup owner." })).toThrow("already has an active turn");

        // The cancellation projection still cannot be written. Only the exact
        // cleanup receipt permits the independent terminal transaction.
        runtime.provider.resolveOwnedStop();
        await drain;
        expect(runtime.provider.stopOwnedCalls).toHaveLength(1);
        expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
          status: "failed", terminalReason: "stream-persistence-failed",
        });
        expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
        expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
        expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
        expect(runtime.events.filter(({ type }) => type === "agent.failed" || type === "agent.completed"))
          .toEqual([expect.objectContaining({ type: "agent.failed", turnId: queued.turn.id })]);
      } finally {
        vi.restoreAllMocks();
        runtime.provider.resolveOwnedStop();
        await runtime.controller.drainSettlementTasks();
        runtime.store.close();
      }
    },
  );

  it.each(["missing", "identity-mismatch", "force-detached"] as const)(
    "keeps durable ownership and attachments after failed writes and %s cleanup",
    async (cleanupResult) => {
      const runtime = await createTurnControllerTestRuntime();
      try {
        const attachment = await turnControllerTestAttachment(runtime,
          "81828384-8182-4182-8182-818283848182", "uncertain-cleanup.png");
        const queued = runtime.controller.queue({ conversationId: runtime.conversationId,
          content: "Retain uncertain authority.", attachments: [attachment] });
        expect(runtime.controller.start(queued.turn.id)).toBe(true);
        const initialStatus = runtime.store.agentTurn(queued.turn.id).status;
        vi.spyOn(runtime.store, "updateConversation").mockImplementationOnce(writeFailure);
        vi.spyOn(runtime.store, "updateAgentTurnLifecycle").mockImplementation(writeFailure);
        const stop = vi.spyOn(runtime.provider, "stopOwned").mockResolvedValue(cleanupResult);
        runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
        await flushTurnControllerTestPromises();
        await runtime.controller.drainSettlementTasks();

        expect(stop).toHaveBeenCalledExactlyOnceWith(runtime.conversationId, {
          runId: queued.turn.runId, turnId: queued.turn.id,
        });
        expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
        expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({ status: initialStatus, terminalReason: null });
        expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toHaveLength(1);
        expect(runtime.attachmentReleases).toEqual([]);
        expect(runtime.events.filter(({ type }) => type === "agent.failed" || type === "agent.completed")).toEqual([]);
        expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
          content: "No new writer without an exact receipt." })).toThrow("already has an active turn");
      } finally {
        vi.restoreAllMocks();
        runtime.store.close();
      }
    },
  );

  it("retains recovery ownership when writes also fail after confirmed provider cleanup", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const attachment = await turnControllerTestAttachment(runtime,
        "71727374-7172-4172-8172-717273747172", "persistent-storage-error.png");
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "Do not confuse stopped processes with saved settlement.", attachments: [attachment] });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      runtime.provider.deferOwnedStop("settled");
      vi.spyOn(runtime.store, "updateConversation").mockImplementation(writeFailure);
      vi.spyOn(runtime.store, "updateAgentTurnLifecycle").mockImplementation(writeFailure);
      const retire = vi.spyOn(runtime.store.providerRunOwnership, "clear").mockImplementation(writeFailure);
      runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
      await flushTurnControllerTestPromises();
      expect(runtime.provider.stopOwnedCalls).toEqual([{
        conversationId: runtime.conversationId,
        identity: { runId: queued.turn.runId, turnId: queued.turn.id },
      }]);
      expect(retire).not.toHaveBeenCalled();
      runtime.provider.resolveOwnedStop();
      await runtime.controller.drainSettlementTasks();

      expect(retire).toHaveBeenCalledExactlyOnceWith(queued.turn.id, queued.turn.runId);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toHaveLength(1);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(runtime.attachmentReleases).toEqual([]);
      expect(runtime.store.agentTurn(queued.turn.id).terminalReason).toBeNull();
      expect(runtime.events.filter(({ type }) => type === "agent.failed" || type === "agent.completed")).toEqual([]);
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "Wait for durable recovery." })).toThrow("already has an active turn");
    } finally {
      vi.restoreAllMocks();
      runtime.provider.resolveOwnedStop();
      await runtime.controller.drainSettlementTasks();
      runtime.store.close();
    }
  });
});
