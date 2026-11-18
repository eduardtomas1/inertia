// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEffectRuntime } from "../../src/server/orchestration-v2/effect-runtime";
import { checkpointCaptureExecutor } from "../../src/server/runtime/checkpoint-capture-executor";
import { TURN_START_STATE_UNREADABLE_MESSAGE } from "../../src/server/runtime/turns/turn-controller-support";
import { orchestrationRunSchema } from "../../src/shared/orchestration-v2";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTurnControllerTestDirectories();
});

/** The error a projection row that no longer matches its schema raises when it is read. */
function unreadableProjection(): unknown {
  try {
    orchestrationRunSchema.parse({ id: "run", status: "not-a-status" });
  } catch (error) {
    return error;
  }
  throw new Error("expected the projection to be unreadable");
}

function failedStartIsSettled(runtime: TurnControllerTestRuntime, turnId: string, runId: string,
  message = TURN_START_STATE_UNREADABLE_MESSAGE): void {
  expect(runtime.store.agentTurn(turnId)).toMatchObject({ status: "failed", terminalReason: "turn-start-failed" });
  expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
  expect(runtime.provider.runCount).toBe(0);
  expect(runtime.store.orchestration.startIntent(runId)).toMatchObject({ state: "failed", failureCode: "start-failed" });
  const run = orchestrationRunSchema.parse(runtime.store.orchestration.events.projection("run", runId)?.value);
  expect(run).toMatchObject({ status: "failed" });
  expect(runtime.store.conversationDetail(runtime.conversationId)?.activities
    .filter((activity) => activity.turnId === turnId && activity.kind === "error"))
    .toEqual([expect.objectContaining({ title: message, status: "failed" })]);
}

describe("turn start with unreadable orchestration state", () => {
  it("settles the turn failed instead of leaving it queued, and the chat takes the next turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start please" });
      vi.spyOn(runtime.store.orchestration.backings, "dispatch").mockImplementationOnce(() => { throw unreadableProjection(); });
      expect(runtime.controller.start(queued.turn.id)).toBe(false);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      failedStartIsSettled(runtime, queued.turn.id, queued.turn.runId);

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
      expect(runtime.controller.start(next.turn.id)).toBe(true);
      await vi.waitFor(() => { expect(runtime.provider.runCount).toBe(1); });
      runtime.provider.resolve({ status: "completed", text: "Done" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(next.turn.id).status).toBe("completed");
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("settles a start deferred behind the previous turn's capture when its resumed read fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const effects = new OrchestrationEffectRuntime(runtime.store.orchestration.effects);
    try {
      runtime.store.orchestration.attachEffectRuntime(effects);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const finalized: string[] = [];
      checkpointCaptureExecutor({ effects, store: runtime.store,
        artifacts: { finalize: async ({ turn }) => { finalized.push(turn.id); await gate; } },
        invalidate: () => undefined })();
      effects.start();
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First" });
      expect(runtime.controller.start(first.turn.id)).toBe(true);
      await vi.waitFor(() => { expect(runtime.provider.runCount).toBe(1); });
      runtime.provider.resolve({ status: "completed", text: "First done" });
      await flushTurnControllerTestPromises();
      await vi.waitFor(() => { expect(finalized).toEqual([first.turn.id]); });

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Second" });
      expect(runtime.controller.start(next.turn.id)).toBe(true);
      expect(runtime.store.orchestration.startIntent(next.turn.runId)?.state).toBe("pending");
      vi.spyOn(runtime.store.orchestration.backings, "dispatch").mockImplementationOnce(() => { throw unreadableProjection(); });
      runtime.provider.runCount = 0;
      release();
      await vi.waitFor(() => { expect(runtime.store.agentTurn(next.turn.id).status).toBe("failed"); });
      await runtime.controller.drainSettlementTasks();
      failedStartIsSettled(runtime, next.turn.id, next.turn.runId);
    } finally { await effects.stop(); await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("keeps the existing message for a failure that is not a saved-state read", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First" });
      vi.spyOn(runtime.store.orchestration.backings, "dispatch").mockImplementationOnce(() => {
        throw new Error("The chat's checkout moved.");
      });
      expect(runtime.controller.start(first.turn.id)).toBe(false);
      await runtime.controller.drainSettlementTasks();
      failedStartIsSettled(runtime, first.turn.id, first.turn.runId, "The chat's checkout moved.");

      // A schema error outside the saved-state reads is not reported as unreadable state.
      const second = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Second" });
      vi.spyOn(runtime.store, "createWorkspaceRun").mockImplementationOnce(() => { throw unreadableProjection(); });
      expect(runtime.controller.start(second.turn.id)).toBe(false);
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.agentTurn(second.turn.id)).toMatchObject({ status: "failed", terminalReason: "turn-start-failed" });
      const titles = runtime.store.conversationDetail(runtime.conversationId)?.activities
        .filter((activity) => activity.turnId === second.turn.id && activity.kind === "error").map(({ title }) => title);
      expect(titles).toHaveLength(1);
      expect(titles![0]).not.toBe(TURN_START_STATE_UNREADABLE_MESSAGE);
      expect(runtime.provider.runCount).toBe(0);
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("still propagates a failure after the turn was handed to the provider, and leaves that turn running", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Run" });
      const effects = runtime.store.orchestration.effects;
      const settle = effects.settle.bind(effects);
      let failed = false;
      vi.spyOn(effects, "settle").mockImplementation((effect, outcome) => {
        if (!failed && outcome.kind === "succeeded") {
          failed = true;
          throw new Error("disk I/O error");
        }
        return settle(effect, outcome);
      });
      expect(() => runtime.controller.start(queued.turn.id)).toThrow("disk I/O error");
      await flushTurnControllerTestPromises();
      expect(runtime.provider.runCount).toBe(1);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(runtime.store.agentTurn(queued.turn.id).status).not.toBe("failed");
      runtime.provider.resolve({ status: "completed", text: "Done" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });
});
