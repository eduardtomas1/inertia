import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEffectRuntime } from "../../src/server/orchestration-v2/effect-runtime";
import {
  executeSteerViaEffectRuntime,
  registerRunControlEffectHandlers,
} from "../../src/server/runtime/run-control-effect-handlers";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const runtimes: OrchestrationEffectRuntime[] = [];
const unregisters: Array<() => void> = [];
const harnesses: TurnControllerTestRuntime[] = [];

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const harness of harnesses.splice(0)) {
    await harness.controller.dispose("runtime-shutdown");
    harness.store.close();
  }
  await cleanupTurnControllerTestDirectories();
});

async function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("run-control effect handlers", () => {
  it("executes a steer whose caller attaches after authority.begin resolves instead of settling unconfirmed and hanging", async () => {
    const harness = await createTurnControllerTestRuntime();
    harnesses.push(harness);
    const { store, controller: turns, conversationId } = harness;
    const conversation = store.conversation(conversationId);
    const effects = new OrchestrationEffectRuntime(store.orchestration.effects);
    runtimes.push(effects);
    effects.start();
    unregisters.push(registerRunControlEffectHandlers({ effects, store, turns }));

    const queued = turns.queue({
      conversationId: conversation.id,
      content: "Initial prompt",
      activateConversation: false,
    });
    turns.start(queued.turn.id);

    const start = await store.orchestration.authority.begin<
      { kind: "requested"; effectId: string } | { kind: "closed" } | { kind: "untracked" }
    >({
      source: {
        actorId: "runtime",
        commandId: "steer-race-1",
        command: { type: "queue.steer", conversationId: conversation.id },
      },
      threadId: conversation.id,
      projectId: conversation.projectId,
      commandType: "queue.steer",
      rejection: null,
    }, (ticket) => store.orchestration.runControl.requestSteer(ticket, queued.turn.runId, queued.turn.id));

    expect(start.kind).toBe("lead");
    if (start.kind !== "lead" || start.intake.kind !== "requested") {
      throw new Error("Expected requested steer effect");
    }
    start.ticket.finish(null);

    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    const work = vi.fn(async () => ({ kind: "accepted" as const }));
    const outcome = await withTimeout(
      executeSteerViaEffectRuntime(store, start.intake.effectId, work),
      500,
    );
    expect(outcome).toEqual({ kind: "accepted" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("rejects pending steer callers when effect handlers are unregistered during shutdown", async () => {
    const harness = await createTurnControllerTestRuntime();
    harnesses.push(harness);
    const { store, controller: turns } = harness;
    const effects = new OrchestrationEffectRuntime(store.orchestration.effects, { concurrency: 1 });
    runtimes.push(effects);
    effects.start();
    const unregister = registerRunControlEffectHandlers({ effects, store, turns });
    unregisters.push(unregister);

    const pending = executeSteerViaEffectRuntime(
      store,
      "unclaimed-effect-id",
      async () => "never",
    );

    unregister();
    await effects.stop();

    await expect(withTimeout(pending, 500)).rejects.toThrow(/stopped|unregistered|cancelled/iu);
  });

  it("rejects immediately instead of hanging if a steer effect already settled before attachment", async () => {
    const harness = await createTurnControllerTestRuntime();
    harnesses.push(harness);
    const { store, controller: turns, conversationId } = harness;
    const conversation = store.conversation(conversationId);
    const effects = new OrchestrationEffectRuntime(store.orchestration.effects);
    runtimes.push(effects);
    effects.start();
    unregisters.push(registerRunControlEffectHandlers({ effects, store, turns }));

    const queued = turns.queue({
      conversationId: conversation.id,
      content: "Initial prompt",
      activateConversation: false,
    });
    turns.start(queued.turn.id);

    const start = await store.orchestration.authority.begin<
      { kind: "requested"; effectId: string } | { kind: "closed" } | { kind: "untracked" }
    >({
      source: {
        actorId: "runtime",
        commandId: "steer-already-settled-1",
        command: { type: "queue.steer", conversationId: conversation.id },
      },
      threadId: conversation.id,
      projectId: conversation.projectId,
      commandType: "queue.steer",
      rejection: null,
    }, (ticket) => store.orchestration.runControl.requestSteer(ticket, queued.turn.runId, queued.turn.id));

    if (start.kind !== "lead" || start.intake.kind !== "requested") {
      throw new Error("Expected requested steer effect");
    }
    start.ticket.finish(null);

    await effects.awaitSettled(start.intake.effectId);

    const work = vi.fn(async () => ({ kind: "accepted" as const }));
    await expect(
      withTimeout(executeSteerViaEffectRuntime(store, start.intake.effectId, work), 500),
    ).rejects.toThrow(/already settled/iu);
    expect(work).not.toHaveBeenCalled();
  });
});
