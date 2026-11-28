// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ownedProviderStopBudgetMs } from "../../src/server/provider/run-cleanup-settlement";
import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../src/shared/orchestration-v2";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const NOTE = "The provider process could not be confirmed stopped; it may still be running.";
const LAST_RESORT_MS = ownedProviderStopBudgetMs() + 5_000;

type OwnedStop = "missing" | "identity-mismatch" | "settled" | "force-detached";

async function startedTurn(runtime: TurnControllerTestRuntime, content = "Work until stopped.") {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function providerStop(runtime: TurnControllerTestRuntime, result: () => Promise<OwnedStop>) {
  let released = false;
  const isRunning = runtime.provider.isRunning.bind(runtime.provider);
  vi.spyOn(runtime.provider, "isRunning").mockImplementation((id) => !released && isRunning(id));
  return vi.spyOn(runtime.provider, "stopOwned").mockImplementation(() => {
    released = true;
    return result();
  });
}

function attemptFor(store: RuntimeStore, runId: string) {
  const run = orchestrationRunSchema.parse(store.orchestration.events.projection("run", runId)?.value);
  return orchestrationAttemptSchema.parse(store.orchestration.events.projection("attempt", run.attemptId)?.value);
}

function startNativeControl(store: RuntimeStore, conversationId: string): void {
  store.orchestration.nativeControls.start({
    threadId: conversationId,
    request: { source: { identity: { conversationId } } },
  } as never);
}

async function stopAndSettle(runtime: TurnControllerTestRuntime): Promise<void> {
  expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
  await flushTurnControllerTestPromises();
  await runtime.controller.drainSettlementTasks();
}

describe("stop ladder release", () => {
  it("releases the chat after a force-detached stop with guardian evidence while cleanup stays unproven across restart", async () => {
    const runtime = await createTurnControllerTestRuntime();
    let store = runtime.store;
    try {
      const first = await startedTurn(runtime);
      const owner = runtime.store.providerRunOwnership.forTurn(first.id)!;
      expect(owner).toMatchObject({ runId: first.runId, conversationId: runtime.conversationId });
      expect(attemptFor(store, first.runId).cleanup).toBe("pending");
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(true);
      const stop = providerStop(runtime, async () => "force-detached");

      await stopAndSettle(runtime);
      stop.mockImplementation(async () => "settled");

      expect(store.agentTurn(first.id)).toMatchObject({ status: "cancelled" });
      expect(store.workspaceRun(first.runId).detail).toBe(`Stopped. ${NOTE}`);
      const released = attemptFor(store, first.runId);
      expect(released.cleanup).toBe("unconfirmed-released");
      expect(released.cleanupRelease).toEqual({
        stopOutcome: "force-detached",
        runtimeGenerationId: owner.runtimeGenerationId,
        systemBootId: owner.systemBootId,
        stopBudgetMs: ownedProviderStopBudgetMs(),
        releasedAt: expect.any(String),
      });
      const events = store.orchestration.events.readEvents({
        projectId: store.conversation(runtime.conversationId).projectId, threadId: runtime.conversationId, limit: 500,
      });
      expect(events.filter(({ type }) => type === "attempt.cleanup-released")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ attemptId: released.id, release: released.cleanupRelease }) }),
      ]);
      expect(store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: first.id, runId: first.runId })]);
      expect(store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(false);
      expect(store.orchestration.awaitsCleanupProof(runtime.conversationId)).toBe(true);
      expect(() => startNativeControl(store, runtime.conversationId)).toThrow("cleanup-pending");

      const next = await startedTurn(runtime, "Answer after the stop.");
      expect(runtime.provider.runCount).toBe(2);
      runtime.provider.resolve({ status: "completed", text: "Answered." });
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      expect(store.agentTurn(next.id).status).toBe("completed");
      expect(attemptFor(store, next.runId).cleanup).toBe("confirmed");
      expect(attemptFor(store, first.runId).cleanup).toBe("unconfirmed-released");
      expect(store.orchestration.awaitsCleanupProof(runtime.conversationId)).toBe(true);

      store.close();
      store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
      expect(attemptFor(store, first.runId)).toMatchObject({
        cleanup: "unconfirmed-released", cleanupRelease: released.cleanupRelease,
      });
      expect(store.providerRunOwnership.forConversation(runtime.conversationId))
        .toEqual([expect.objectContaining({ turnId: first.id, runId: first.runId })]);
      expect(store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(false);
      expect(store.orchestration.awaitsCleanupProof(runtime.conversationId)).toBe(true);
      store.orchestration.events.rebuildProjections();
      expect(attemptFor(store, first.runId).cleanup).toBe("unconfirmed-released");
      store.providerRunOwnership.clearRuntimeGeneration("unrelated-generation");
      expect(attemptFor(store, first.runId).cleanup).toBe("unconfirmed-released");
      expect(() => startNativeControl(store, runtime.conversationId)).toThrow("cleanup-pending");

      store.providerRunOwnership.clearRuntimeGeneration(owner.runtimeGenerationId);
      expect(attemptFor(store, first.runId)).toMatchObject({
        cleanup: "confirmed", cleanupRelease: released.cleanupRelease,
      });
      expect(store.orchestration.awaitsCleanupProof(runtime.conversationId)).toBe(false);
      expect(() => startNativeControl(store, runtime.conversationId)).not.toThrow("cleanup-pending");
      expect(store.orchestration.releaseCleanup({ turnId: first.id, runId: first.runId }, released.cleanupRelease!))
        .toBe(false);
      expect(attemptFor(store, first.runId).cleanup).toBe("confirmed");
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
  });

  it("releases the chat when the stop ladder itself outlives its last-resort budget", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, () => new Promise<OwnedStop>(() => undefined));
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(true);
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "Not while the ladder runs." })).toThrow();

      let fired = 0;
      for (const [id, callback] of runtime.scheduler.callbacks) {
        if (runtime.scheduler.delays.get(id) !== LAST_RESORT_MS) continue;
        runtime.scheduler.clearTimeout(id);
        callback();
        fired += 1;
      }
      expect(fired).toBe(1);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "cancelled" });
      expect(attemptFor(runtime.store, turn.runId)).toMatchObject({
        cleanup: "unconfirmed-released", cleanupRelease: { stopOutcome: "expired" },
      });
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(false);
      expect(runtime.store.orchestration.awaitsCleanupProof(runtime.conversationId)).toBe(true);
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "Stop always completes." })).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });

  it("keeps admission fenced when the released run has no durable guardian claim", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      providerStop(runtime, async () => "force-detached");
      vi.spyOn(runtime.store.providerRunOwnership, "forTurn").mockReturnValue(null);

      await stopAndSettle(runtime);

      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "cancelled" });
      const attempt = attemptFor(runtime.store, turn.runId);
      expect(attempt.cleanup).toBe("unconfirmed");
      expect(attempt.cleanupRelease).toBeUndefined();
      expect(runtime.store.orchestration.hasPendingCleanup(runtime.conversationId)).toBe(true);
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId,
        content: "No guardian claim, no release." })).toThrow("cleanup-pending");
    } finally {
      vi.restoreAllMocks();
      runtime.store.close();
    }
  });
});
