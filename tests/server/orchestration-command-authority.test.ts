// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import { OrchestrationLaneReentry, OrchestrationCommandLanes } from "../../src/server/orchestration-v2/command-lanes";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import type { ChatAttachment, ClientCommand, ModelSelection, ServerEvent } from "../../src/shared/contracts";
import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../src/shared/orchestration-v2";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestAttachment,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";
import { resolveNativeModelRoute } from "./model-route-fixture";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTurnControllerTestDirectories();
});

type OwnedStop = "missing" | "identity-mismatch" | "settled" | "force-detached";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

async function fixture() {
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue.onTurnSettled(turn) });
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const events: ServerEvent[] = [];
  const resolvePayloads = vi.fn(async (requested: ChatAttachment[]) =>
    requested.map((attachment) => ({ attachment, bytes: Buffer.from("89504e470d0a1a0a", "hex") })));
  const dependencies: TurnInteractionCommandDependencies = {
    store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
    backendProfileController: {
      validateSelection: (selection: unknown) => selection,
      isExternalSelection: () => false, readiness: async () => null,
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(), pendingInputs: new Map(), dataDirectory: runtime.directory, enableProviders: true,
    attachmentResolver: {
      resolvePayloads, releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined,
    broadcastSnapshot: () => undefined, send: (_socket, event) => { events.push(event); },
  };
  const scheduled = { count: 0 };
  const queue = createQueuedMessageRuntime(dependencies, { signal: abort.signal, track: (operation) => {
    scheduled.count += 1;
    const task = operation();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  } });
  const socket = null as unknown as WebSocket;
  const send = (requestId: string, content = "Also check the tests.", media: ChatAttachment[] = []) =>
    queue.turnInteractionHandler(socket, { type: "message.send", requestId,
      payload: { conversationId: runtime.conversationId, content, attachments: media } });
  const stop = (requestId: string, expectedTurnId?: string) => queue.turnInteractionHandler(socket, { type: "agent.stop", requestId,
    payload: { conversationId: runtime.conversationId, ...(expectedTurnId ? { expectedTurnId } : {}) } });
  const queueCommand = (command: ClientCommand) => queue.handler(socket, command);
  const replies = (requestId: string) => events.filter((event) => "requestId" in event && event.requestId === requestId);
  const drain = async () => {
    await flushTurnControllerTestPromises();
    while (tasks.size) await Promise.allSettled(tasks);
    await runtime.controller.drainSettlementTasks();
    await flushTurnControllerTestPromises();
  };
  const startRunning = () => {
    const initial = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First task" });
    runtime.controller.start(initial.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
    return initial.turn;
  };
  const attempt = (runId: string) => {
    const run = orchestrationRunSchema.parse(runtime.store.orchestration.events.projection("run", runId)?.value);
    return orchestrationAttemptSchema.parse(runtime.store.orchestration.events.projection("attempt", run.attemptId)?.value);
  };
  const threadEvents = () => runtime.store.orchestration.events.readEvents({
    projectId: runtime.store.conversation(runtime.conversationId).projectId, threadId: runtime.conversationId, limit: 500,
  });
  const controlEffects = (kind: "provider.interrupt" | "provider.steer") => threadEvents()
    .filter(({ type }) => type === (kind === "provider.interrupt" ? "run-control.interrupt-recorded" : "run-control.steer-requested"))
    .map(({ payload }) => runtime.store.orchestration.effects.get((payload as { effectId: string }).effectId)!);
  const abandon = async () => {
    abort.abort();
    await attachments.close();
  };
  const close = async () => {
    abort.abort();
    await drain();
    await runtime.controller.dispose();
    await attachments.close();
    runtime.store.close();
  };
  return { ...runtime, attachments, events, dependencies, queue, scheduled, resolvePayloads, send, stop, queueCommand, replies,
    drain, startRunning, attempt, threadEvents, controlEffects, abandon, close };
}

describe("command lanes", () => {
  it("fails fast when a section enters its own lane and lets other lanes and later work through", async () => {
    const lanes = new OrchestrationCommandLanes();
    await expect(lanes.run("thread-a", () => lanes.run("thread-a", () => "nested"))).rejects.toBeInstanceOf(OrchestrationLaneReentry);
    await expect(lanes.run("thread-a", async () => {
      await Promise.resolve();
      return await lanes.run("thread-a", () => "nested after await");
    })).rejects.toBeInstanceOf(OrchestrationLaneReentry);
    await expect(lanes.run("thread-a", () => lanes.run("thread-b", () => "other thread"))).resolves.toBe("other thread");
    let later: Promise<string> | null = null;
    await lanes.run("thread-a", () => {
      later = Promise.resolve().then(() => lanes.run("thread-a", () => "after the section"));
    });
    await expect(later).resolves.toBe("after the section");
    expect(lanes.holds("thread-a")).toBe(false);
    await lanes.close();
  });
});

describe("message.send authority", () => {
  it("replays a duplicate steer request with exactly one provider steer", async () => {
    const f = await fixture();
    try {
      f.startRunning();
      const requestId = randomUUID();
      await Promise.all([f.send(requestId), f.send(requestId)]);
      expect(f.provider.steerCalls).toEqual(["Also check the tests."]);
      const [first, second] = f.replies(requestId);
      expect(first).toMatchObject({ type: "request.result", result: { kind: "message.accepted", disposition: "follow-up" } });
      expect(second).toEqual(first);
      await f.send(requestId);
      expect(f.provider.steerCalls).toHaveLength(1);
      expect(f.replies(requestId)[2]).toEqual(first);
      const [steer] = f.controlEffects("provider.steer");
      expect(steer).toMatchObject({ state: "succeeded", replayPolicy: "process-bound" });
      expect(f.store.orchestration.runControl.steer(steer!.id)).toMatchObject({ state: "settled", outcome: "accepted",
        messageId: (first as unknown as { result: { userMessageId: string } }).result.userMessageId });
    } finally { await f.close(); }
  });

  it("imports the attachments of two concurrent identical sends once and starts one turn", async () => {
    const f = await fixture();
    try {
      const image = await turnControllerTestAttachment(f, randomUUID());
      const requestId = randomUUID();
      await Promise.all([f.send(requestId, "Look at this.", [image]), f.send(requestId, "Look at this.", [image])]);
      await f.drain();
      expect(f.resolvePayloads).toHaveBeenCalledTimes(1);
      expect(f.provider.runCount).toBe(1);
      const [first, second] = f.replies(requestId);
      expect(first).toMatchObject({ result: { kind: "message.accepted", disposition: "new-turn" } });
      expect(second).toEqual(first);
      await f.send(requestId, "Look at this.", [image]);
      expect(f.resolvePayloads).toHaveBeenCalledTimes(1);
      expect(f.replies(requestId)[2]).toEqual(first);
    } finally { await f.close(); }
  });

  it("does not hold the chat's lane while a new turn is still being prepared", async () => {
    const f = await fixture();
    try {
      const gate = deferred();
      const resolving = deferred();
      f.resolvePayloads.mockImplementationOnce(async (requested: ChatAttachment[]) => {
        resolving.resolve();
        await gate.promise;
        return requested.map((attachment) => ({ attachment, bytes: Buffer.from("89504e470d0a1a0a", "hex") }));
      });
      const image = await turnControllerTestAttachment(f, randomUUID());
      const sending = f.send(randomUUID(), "Slow preparation.", [image]);
      await resolving.promise;
      await expect(f.store.orchestration.lanes.run(f.conversationId, () => "free")).resolves.toBe("free");
      await expect(f.stop(randomUUID())).resolves.toBe("mutation");
      gate.resolve();
      await expect(sending).resolves.toBe("handled");
      await f.drain();
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });
});

describe("Stop authority", () => {
  it("routes a send after a committed Stop to the after-turn path instead of steering the stopping run", async () => {
    const f = await fixture();
    try {
      f.startRunning();
      f.provider.deferOwnedStop("settled");
      const cancelled = deferred();
      const cancel = f.provider.cancel.bind(f.provider);
      vi.spyOn(f.provider, "cancel").mockImplementation(() => {
        cancelled.resolve();
        return cancel();
      });
      const stopping = f.stop(randomUUID());
      await cancelled.promise;
      const requestId = randomUUID();
      await f.send(requestId, "After the stop.");
      expect(f.provider.steerCalls).toEqual([]);
      expect(f.replies(requestId)[0]).toMatchObject({ result: { kind: "message.queue", receipt: { id: requestId } } });
      f.provider.resolve({ status: "cancelled" });
      f.provider.resolveOwnedStop();
      await expect(stopping).resolves.toBe("mutation");
      await f.drain();
    } finally { f.provider.resolveOwnedStop(); await f.close(); }
  });

  it("lets a send whose intake came first reach the provider before Stop interrupts it", async () => {
    const f = await fixture();
    try {
      f.startRunning();
      const order: string[] = [];
      const steerStarted = deferred();
      const steerGate = deferred();
      vi.spyOn(f.provider, "steer").mockImplementation(async () => {
        order.push("steer-started");
        steerStarted.resolve();
        await steerGate.promise;
        order.push("steer-delivered");
        return true;
      });
      const cancel = f.provider.cancel.bind(f.provider);
      vi.spyOn(f.provider, "cancel").mockImplementation(() => {
        order.push("cancel");
        return cancel();
      });
      const runControl = f.store.orchestration.runControl;
      const awaitSettled = runControl.awaitSettled.bind(runControl);
      const stopWaiting = deferred<readonly string[]>();
      vi.spyOn(runControl, "awaitSettled").mockImplementation((ids, deadlineAt) => {
        stopWaiting.resolve(ids);
        return awaitSettled(ids, deadlineAt);
      });
      const sending = f.send(randomUUID(), "Before the stop.");
      await steerStarted.promise;
      const stopping = f.stop(randomUUID());
      expect(await stopWaiting.promise).toEqual([f.controlEffects("provider.steer")[0]!.id]);
      expect(order).toEqual(["steer-started"]);
      steerGate.resolve();
      await expect(sending).resolves.toBe("handled");
      await expect(stopping).resolves.toBe("mutation");
      expect(order).toEqual(["steer-started", "steer-delivered", "cancel"]);
    } finally { await f.close(); }
  });

  it("refuses a Stop whose expected turn is stale as superseded before stopping anything", async () => {
    const f = await fixture();
    try {
      const turn = f.startRunning();
      const requestId = randomUUID();
      const staleTurnId = randomUUID();
      await expect(f.stop(requestId, staleTurnId)).rejects.toMatchObject({ code: "superseded" });
      await expect(f.stop(requestId, staleTurnId)).rejects.toThrow("A newer run has already started");
      expect(f.provider.cancelCount).toBe(0);
      expect(f.provider.stopOwnedCalls).toEqual([]);
      expect(f.store.agentTurn(turn.id).status).toBe("running");
      expect(f.attempt(turn.runId).interruptRequestedAt).toBeNull();
      expect(f.controlEffects("provider.interrupt")).toEqual([]);
      await expect(f.stop(randomUUID(), turn.id)).resolves.toBe("mutation");
      await f.drain();
      expect(f.store.agentTurn(turn.id).status).toBe("cancelled");
    } finally { await f.close(); }
  });

  it("replays a repeated Stop command id from its receipt without stopping twice", async () => {
    const f = await fixture();
    try {
      const turn = f.startRunning();
      const cancel = vi.spyOn(f.controller, "cancel");
      const requestId = randomUUID();
      await expect(f.stop(requestId, turn.id)).resolves.toBe("mutation");
      await f.drain();
      await expect(f.stop(requestId, turn.id)).resolves.toBe("mutation");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.threadEvents().filter(({ type }) => type === "run-control.interrupt-recorded")).toHaveLength(1);
      const [effect] = f.controlEffects("provider.interrupt");
      expect(effect).toMatchObject({ state: "succeeded", replayPolicy: "process-bound" });
      expect(f.store.orchestration.runControl.attemptInterrupt(f.attempt(turn.runId).id)).toMatchObject({
        effectId: effect!.id, expectedTurnId: turn.id, outcome: "settled", unresponsiveAt: null,
      });
      expect(f.store.agentTurn(turn.id).status).toBe("cancelled");
    } finally { await f.close(); }
  });

  it("accepts a Stop with nothing to stop and replays it without stopping a later run", async () => {
    const f = await fixture();
    try {
      const requestId = randomUUID();
      const command = { type: "agent.stop", requestId, payload: { conversationId: f.conversationId } };
      await expect(f.stop(requestId)).resolves.toBe("mutation");
      const projectId = f.store.conversation(f.conversationId).projectId;
      expect(f.store.orchestration.events.receipt({ actorId: "human", commandId: requestId, projectId,
        threadId: f.conversationId }, command)).toMatchObject({ status: "accepted", result: { stop: "idle" } });
      const turn = f.startRunning();
      await expect(f.stop(requestId)).resolves.toBe("mutation");
      expect(f.provider.cancelCount).toBe(0);
      expect(f.store.agentTurn(turn.id).status).toBe("running");
      expect(f.threadEvents().filter(({ type }) => type.startsWith("run-control."))).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("retires the start of a run stopped before dispatch so no provider ever starts", async () => {
    const f = await fixture();
    try {
      const queued = f.controller.queue({ conversationId: f.conversationId, content: "Never started." });
      const start = f.store.orchestration.startIntent(queued.turn.runId);
      expect(start?.state).toBe("pending");
      await expect(f.stop(randomUUID())).resolves.toBe("mutation");
      expect(f.store.orchestration.effects.get(start!.id)).toMatchObject({ state: "retired", failureCode: "stopped" });
      expect(f.controller.start(queued.turn.id)).toBe(false);
      await f.drain();
      expect(f.provider.runCount).toBe(0);
      expect(f.store.agentTurn(queued.turn.id).status).toBe("cancelled");
      expect(f.controlEffects("provider.interrupt")[0]).toMatchObject({ state: "succeeded" });
    } finally { await f.close(); }
  });

  it("flags the attempt unresponsive at the grace deadline and settles the interrupt as failed on release without proving cleanup", async () => {
    const f = await fixture();
    try {
      const turn = f.startRunning();
      const ownedStop = deferred<OwnedStop>();
      const stopCalls = [deferred(), deferred()];
      let calls = 0;
      let escalated: (() => void) | undefined;
      const stopOwned = (_conversationId: string, _identity: unknown, _graceMs?: number,
        hooks?: { escalated?(): void }): Promise<OwnedStop> => {
        escalated ??= hooks?.escalated;
        stopCalls[calls++]?.resolve();
        return ownedStop.promise;
      };
      vi.spyOn(f.provider, "stopOwned").mockImplementation(stopOwned as typeof f.provider.stopOwned);
      const first = f.stop(randomUUID());
      await stopCalls[0]!.promise;
      const attemptId = f.attempt(turn.runId).id;
      expect(f.store.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({ unresponsiveAt: null, escalations: 0 });
      escalated!();
      const unresponsive = f.store.orchestration.runControl.attemptInterrupt(attemptId);
      expect(unresponsive).toMatchObject({ unresponsiveAt: expect.any(String), escalations: 1, outcome: null });
      expect(orchestrationRunSchema.parse(f.store.orchestration.events.projection("run", turn.runId)?.value).completedAt).toBeNull();
      const second = f.stop(randomUUID());
      await stopCalls[1]!.promise;
      expect(f.store.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({
        unresponsiveAt: unresponsive!.unresponsiveAt, escalations: 2,
      });
      expect(f.threadEvents().filter(({ type }) => type === "run-control.interrupt-escalated")
        .map(({ payload }) => (payload as { cause: string }).cause)).toEqual(["grace-expired", "user"]);
      expect(f.controlEffects("provider.interrupt")).toHaveLength(1);
      ownedStop.resolve("force-detached");
      await expect(first).resolves.toBe("mutation");
      await expect(second).resolves.toBe("mutation");
      await f.drain();
      const [effect] = f.controlEffects("provider.interrupt");
      expect(effect).toMatchObject({ state: "failed", failureCode: "stop-force-detached" });
      expect(f.store.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({
        outcome: "force-detached", unresponsiveAt: unresponsive!.unresponsiveAt, settledAt: expect.any(String),
      });
      expect(f.attempt(turn.runId).cleanup).toBe("unconfirmed-released");
      expect(f.store.orchestration.awaitsCleanupProof(f.conversationId)).toBe(true);
      expect(f.store.agentTurn(turn.id).status).toBe("cancelled");
    } finally { await f.close(); }
  });

  it("counts a second Stop before the grace deadline as an escalation without flagging the attempt unresponsive", async () => {
    const f = await fixture();
    try {
      const turn = f.startRunning();
      const ownedStop = deferred<OwnedStop>();
      const stopCalls = [deferred(), deferred()];
      let calls = 0;
      vi.spyOn(f.provider, "stopOwned").mockImplementation((() => {
        stopCalls[calls++]?.resolve();
        return ownedStop.promise;
      }) as typeof f.provider.stopOwned);
      const first = f.stop(randomUUID());
      await stopCalls[0]!.promise;
      const second = f.stop(randomUUID());
      await stopCalls[1]!.promise;
      const attemptId = f.attempt(turn.runId).id;
      expect(f.store.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({
        unresponsiveAt: null, escalations: 1, outcome: null,
      });
      expect(f.threadEvents().filter(({ type }) => type === "run-control.interrupt-escalated")
        .map(({ payload }) => (payload as { cause: string }).cause)).toEqual(["user"]);
      ownedStop.resolve("settled");
      await expect(first).resolves.toBe("mutation");
      await expect(second).resolves.toBe("mutation");
      await f.drain();
      expect(f.store.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({
        unresponsiveAt: null, outcome: "settled",
      });
    } finally { await f.close(); }
  });

  it("retires a running interrupt effect after a restart instead of replaying it", async () => {
    const f = await fixture();
    let reopened: RuntimeStore | null = null;
    try {
      const turn = f.startRunning();
      f.provider.deferOwnedStop("settled");
      const cancelled = deferred();
      vi.spyOn(f.provider, "cancel").mockImplementation(() => {
        cancelled.resolve();
        return true;
      });
      void f.stop(randomUUID()).catch(() => undefined);
      await cancelled.promise;
      const [effect] = f.controlEffects("provider.interrupt");
      expect(effect).toMatchObject({ state: "running" });
      const attemptId = f.attempt(turn.runId).id;
      const stopCalls = f.provider.stopOwnedCalls.length;
      f.store.close();
      reopened = new RuntimeStore(join(f.directory, "inertia.sqlite"), f.workspace);
      expect(reopened.orchestration.effects.get(effect!.id)).toMatchObject({ state: "retired", failureCode: "runtime-lost" });
      expect(reopened.orchestration.runControl.attemptInterrupt(attemptId)).toMatchObject({ effectId: effect!.id, outcome: null });
      expect(f.provider.stopOwnedCalls).toHaveLength(stopCalls);
    } finally {
      reopened?.close();
      await f.abandon();
    }
  });
});

describe("configuration and queue authority", () => {
  const selection = (modelId: string): ModelSelection => providerNativeModelSelection({ providerId: "codex", modelId,
    alias: null, reasoningEffort: null, providerOptions: {} });

  function conversationHandler(f: Awaited<ReturnType<typeof fixture>>) {
    return createConversationCommandHandler({
      store: f.store,
      providers: { resolveModelRoute: (value: ModelSelection) => resolveNativeModelRoute(value) },
      backendProfileController: {
        isExternalSelection: () => false,
        validateSelection: (value: ModelSelection) => value,
        supportsNativeFastModeControl: () => false,
      },
    } as unknown as ConversationCommandDependencies);
  }

  it("refuses a configuration change during a run inside the lane, replays the refusal, and still renames", async () => {
    const f = await fixture();
    try {
      const turn = f.startRunning();
      const handler = conversationHandler(f);
      const update = (requestId: string, payload: Record<string, unknown>) => handler(null as never, {
        type: "conversation.update", requestId, payload: { conversationId: f.conversationId, ...payload },
      } as ClientCommand);
      const refused = randomUUID();
      await expect(update(refused, { modelSelection: selection("gpt-next") })).rejects.toThrow("Stop the active run or review");
      await expect(update(randomUUID(), { title: "Renamed while running" })).resolves.toBe("mutation");
      expect(f.store.conversation(f.conversationId).title).toBe("Renamed while running");
      f.provider.resolve({ status: "completed" });
      await f.drain();
      expect(f.store.agentTurn(turn.id).status).toBe("completed");
      await expect(update(refused, { modelSelection: selection("gpt-next") })).rejects.toThrow("Stop the active run or review");
      expect(f.store.conversation(f.conversationId).modelSelection.modelId).toBe("gpt-test");
      await expect(update(randomUUID(), { modelSelection: selection("gpt-next") })).resolves.toBe("mutation");
      expect(f.store.conversation(f.conversationId).modelSelection.modelId).toBe("gpt-next");
      expect(f.threadEvents().filter(({ type }) => type === "thread.configured").at(-1)?.payload)
        .toMatchObject({ selection: { modelId: "gpt-next" } });
    } finally { await f.close(); }
  });

  it("creates one queue entry for a duplicate enqueue request and re-kicks a replayed send without sending twice", async () => {
    const f = await fixture();
    try {
      f.startRunning();
      const id = randomUUID();
      const enqueue: ClientCommand = { type: "message.queue.enqueue", requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id, content: "Next task.", attachments: [] } };
      await Promise.all([f.queueCommand(enqueue), f.queueCommand(enqueue)]);
      await f.queueCommand(enqueue);
      expect(f.store.queuedMessages.list(f.conversationId)).toHaveLength(1);
      const send: ClientCommand = { type: "message.queue.send", requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id } };
      await f.queueCommand(send);
      expect(f.provider.steerCalls).toEqual(["Next task."]);
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      await f.drain();
      const scheduled = f.scheduled.count;
      await f.queueCommand(send);
      await f.drain();
      expect(f.provider.steerCalls).toHaveLength(1);
      expect(f.provider.runCount).toBe(1);
      expect(f.scheduled.count).toBe(scheduled + 1);
    } finally { await f.close(); }
  });
});
