// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_STOPPED_WHILE_ASLEEP_NOTE } from "../../src/server/runtime/system-suspend-coordinator";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupTurnControllerTestDirectories();
});

async function startedTurn(runtime: TurnControllerTestRuntime) {
  const queued = runtime.controller.queue({
    conversationId: runtime.conversationId,
    content: "Work through the night.",
  });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  await flushTurnControllerTestPromises();
  return queued.turn;
}

describe("turn liveness after a system resume", () => {
  it("interrupts a turn whose provider run ended while the computer slept and releases the chat", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      vi.spyOn(runtime.provider, "ownsRun").mockReturnValue(false);

      expect(runtime.controller.settleTurnsWhoseProviderExited(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE))
        .toEqual([runtime.conversationId]);
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id)).toMatchObject({
        status: "interrupted",
        runState: { state: "interrupted" },
      });
      expect(runtime.store.workspaceRun(turn.runId).detail).toBe(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(() => runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "The chat is usable again.",
      })).not.toThrow();
    } finally {
      runtime.store.close();
    }
  });

  it("leaves a turn alone while its provider still owns the run", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);

      expect(runtime.controller.settleTurnsWhoseProviderExited(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE)).toEqual([]);
      await flushTurnControllerTestPromises();

      expect(runtime.store.agentTurn(turn.id).status).toBe("starting");
      expect(runtime.provider.stopOwnedCalls).toEqual([]);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    } finally {
      runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
      await runtime.controller.drainSettlementTasks();
      runtime.store.close();
    }
  });

  it("does not replace a stop that is already settling", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await startedTurn(runtime);
      runtime.provider.deferOwnedStop("settled");
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      await flushTurnControllerTestPromises();
      vi.spyOn(runtime.provider, "ownsRun").mockReturnValue(false);

      expect(runtime.controller.settleTurnsWhoseProviderExited(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE)).toEqual([]);
      runtime.provider.resolveOwnedStop();
      await runtime.controller.drainSettlementTasks();

      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(runtime.provider.stopOwnedCalls).toHaveLength(1);
    } finally {
      runtime.store.close();
    }
  });

  it("restarts a live turn's provider silence clock after a system resume", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const runtime = await createTurnControllerTestRuntime({}, { clock: () => new Date(now) });
    try {
      await startedTurn(runtime);
      const shell = () => runtime.controller.withProviderActivity(
        runtime.store.shellSnapshot().conversations.find(({ id }) => id === runtime.conversationId)!,
      ).latestTurn?.providerActivityAt;
      expect(shell()).toBe(new Date(now).toISOString());
      now += 40 * 60 * 1_000;

      runtime.controller.restampProviderActivity();
      expect(shell()).toBe(new Date(now).toISOString());
    } finally {
      runtime.store.close();
    }
  });
});
