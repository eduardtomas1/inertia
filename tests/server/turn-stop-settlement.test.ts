// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { ownedProviderStopBudgetMs } from "../../src/server/provider/run-cleanup-settlement";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const NOTE = "The provider process could not be confirmed stopped; it may still be running.";
const LAST_RESORT_MS = ownedProviderStopBudgetMs() + 5_000;

async function startedTurn(runtime: TurnControllerTestRuntime) {
  const queued = runtime.controller.queue({
    conversationId: runtime.conversationId,
    content: "Work until stopped.",
  });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function runDelayed(runtime: TurnControllerTestRuntime, delayMs: number): number {
  let ran = 0;
  for (const [id, callback] of runtime.scheduler.callbacks) {
    if (runtime.scheduler.delays.get(id) !== delayMs) continue;
    runtime.scheduler.clearTimeout(id);
    callback();
    ran += 1;
  }
  return ran;
}

type OwnedStop = "missing" | "identity-mismatch" | "settled" | "force-detached";

function providerStop(
  runtime: TurnControllerTestRuntime,
  result: () => Promise<OwnedStop>,
) {
  let released = false;
  const isRunning = runtime.provider.isRunning.bind(runtime.provider);
  vi.spyOn(runtime.provider, "isRunning").mockImplementation((id) => !released && isRunning(id));
  return vi.spyOn(runtime.provider, "stopOwned").mockImplementation(() => {
    released = true;
    return result();
  });
}

function deferredStop() {
  let resolve!: (value: OwnedStop) => void;
  const promise = new Promise<OwnedStop>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function stoppingBroadcasts(runtime: TurnControllerTestRuntime): number {
  return runtime.events.filter((event) => JSON.stringify(event).includes("\"cancelling\"")).length;
}

describe("turn stop settlement", () => {
  it("reports a run whose settlement is still releasing when a Stop arrives too late to cancel it", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      const stop = deferredStop();
      providerStop(runtime, () => stop.promise);
      expect(runtime.controller.isReleasing(runtime.conversationId)).toBe(true);

      runtime.provider.resolve({ status: "completed" });
      await flushTurnControllerTestPromises();
      stop.resolve("settled");
      await Promise.resolve();
      await Promise.resolve();
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
      expect(runtime.controller.isReleasing(runtime.conversationId)).toBe(true);

      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
      expect(runtime.controller.isReleasing(runtime.conversationId)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });


  it("finalizes a stopped turn with a note and keeps the ownership row when the provider is force-detached", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id)).toMatchObject({
        status: "cancelled",
        runState: { state: "cancelled" },
      });
      expect(runtime.store.workspaceRun(turn.runId).detail).toBe(`Stopped. ${NOTE}`);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.controller.activeConversationIds()).toEqual([]);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: turn.id, runId: turn.runId })]);
      expect(runtime.scheduler.callbacks.size).toBe(0);
      expect(() => runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Keep uncertain cleanup fenced.",
      })).toThrow("cleanup-pending");
      runtime.store.providerRunOwnership.clear(turn.id, "wrong-run");
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(true);
      runtime.store.providerRunOwnership.clear(turn.id, turn.runId);
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(false);
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "Cleanup is confirmed now." })).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("finalizes a natural completion without the stop note when the provider is force-detached", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");

      runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
      expect(JSON.stringify(runtime.store.agentTurn(turn.id))).not.toContain(NOTE);
      expect(runtime.store.workspaceRun(turn.runId).detail).not.toContain(NOTE);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: turn.id, runId: turn.runId })]);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("keeps the ownership row when a late provider result follows a force-detached stop", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      runtime.provider.resolve({ status: "cancelled" });
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: turn.id })]);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it.each(["missing", "identity-mismatch"] as const)(
    "finalizes a stopped turn without a note when the provider stop reports %s",
    async (outcome) => {
      const runtime = await createTurnControllerTestRuntime();
      try {
        const turn = await startedTurn(runtime);
        providerStop(runtime, async () => outcome);

        expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
        await flushTurnControllerTestPromises();
        await runtime.controller.drainSettlementTasks();

        expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
        expect(runtime.store.workspaceRun(turn.runId).detail).toBe("Stopped");
        expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
        expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
          .toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        runtime.store.close();
      }
    },
  );

  it("finalizes a stopped turn with a note when the provider stop throws", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => {
        throw new Error("stop failed");
      });

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.workspaceRun(turn.runId).detail).toBe(`Stopped. ${NOTE}`);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("clears the ownership row when a stopped provider settles late", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      const stop = deferredStop();
      providerStop(runtime, () => stop.promise);

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("cancelling");
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);

      stop.resolve("settled");
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.workspaceRun(turn.runId).detail).toBe("Stopped");
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("never shows stopping while a natural completion waits for provider cleanup", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      runtime.provider.deferOwnedStop("settled");
      const before = stoppingBroadcasts(runtime);
      const visible = runtime.store.agentTurn(turn.id).runState?.state;

      runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe(visible);
      expect(visible).not.toBe("cancelling");
      expect(runtime.store.workspaceRun(turn.runId).detail).not.toContain("Stopping");

      runtime.provider.resolveOwnedStop();
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
      expect(stoppingBroadcasts(runtime)).toBe(before);
    } finally {
      runtime.provider.resolveOwnedStop();
      runtime.store.close();
    }
  });

  it("forces the provider stop when Stop is pressed again while the turn is stopping", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      await startedTurn(runtime);
      const stop = deferredStop();
      const stopOwned = providerStop(runtime, () => stop.promise);

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();

      expect(stopOwned).toHaveBeenCalledTimes(2);
      expect((stopOwned.mock.calls[1] as unknown[] | undefined)?.[2]).toBe(0);
      stop.resolve("force-detached");
      await runtime.controller.drainSettlementTasks();
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("clears the ownership row and broadcasts the shell when a force-detached stop is confirmed late", async () => {
    const shells: string[] = [];
    const runtime = await createTurnControllerTestRuntime({
      broadcastConversationShell: (conversationId) => { shells.push(conversationId); },
    });
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toHaveLength(1);
      shells.length = 0;

      runtime.controller.providerCleanupConfirmedLate({
        conversationId: runtime.conversationId,
        runId: turn.runId,
        turnId: turn.id,
      });
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
      expect(shells).toEqual([runtime.conversationId]);
      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("keeps the ownership row when a late cleanup confirmation names another run", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      runtime.controller.providerCleanupConfirmedLate({
        conversationId: runtime.conversationId,
        runId: `${turn.runId}-other`,
        turnId: turn.id,
      });
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: turn.id, runId: turn.runId })]);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("clears the ownership row when cleanup is confirmed late while the stop is still settling", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      const stop = deferredStop();
      providerStop(runtime, () => stop.promise);
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();

      runtime.controller.providerCleanupConfirmedLate({
        conversationId: runtime.conversationId,
        runId: turn.runId,
        turnId: turn.id,
      });
      await flushTurnControllerTestPromises();
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toHaveLength(1);

      stop.resolve("force-detached");
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("finalizes through the last-resort timer when the provider stop never returns", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, () => new Promise(() => undefined));

      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("cancelling");

      expect(runDelayed(runtime, LAST_RESORT_MS)).toBe(1);
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.store.workspaceRun(turn.runId).detail).toBe(`Stopped. ${NOTE}`);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
        .toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });
});
