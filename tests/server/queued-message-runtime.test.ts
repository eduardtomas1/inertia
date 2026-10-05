// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { ChatAttachment, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { RuntimeStore } from "../../src/server/database";
import { queuedIntentDigest, RETAINED_TERMINAL_QUEUED_MESSAGES } from "../../src/server/persistence/queued-message-repository";
import { MessageSendPreparationTimeoutError } from "../../src/server/runtime/commands/message-send-preparation";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestAttachment, turnControllerTestIdentity, turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";
import { ProviderSteerDeliveryUnknownError } from "../../src/server/provider/contracts";
import type { TurnControllerHooks } from "../../src/server/runtime/turns/turn-controller";
import { join } from "node:path";

afterEach(cleanupTurnControllerTestDirectories);
async function fixture(hookOverrides: Partial<TurnControllerHooks> = {}) {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue?.onTurnSettled(turn), ...hookOverrides });
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const events: ServerEvent[] = [];
  const hooks: { operationSettled?: () => void } = {};
  const admission = { closed: false, refusals: 0 };
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
      resolvePayloads: async (requested: ChatAttachment[]) => requested.map((attachment) => ({ attachment, bytes: Buffer.from("89504e470d0a1a0a", "hex") })),
      releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined,
    broadcastSnapshot: () => undefined, send: (_socket, event) => { events.push(event); },
  };
  queue = createQueuedMessageRuntime(dependencies, { signal: abort.signal, track: (operation) => {
    if (admission.closed && ++admission.refusals < 50) return Promise.reject(new Error("The runtime is preparing for an application update."));
    const task = operation().then((value) => { hooks.operationSettled?.(); return value; }); tasks.add(task); void task.finally(() => tasks.delete(task)); return task;
  } });
  const drain = async () => {
    await flushTurnControllerTestPromises();
    while (tasks.size) await Promise.allSettled(tasks);
    await flushTurnControllerTestPromises();
  };
  const command = async (type: "message.queue.enqueue" | "message.queue.send" | "message.queue.remove", id: string, media: ChatAttachment[] = []) => {
    await queue!.handler(null as unknown as WebSocket, {
      type, requestId: randomUUID(), payload: { conversationId: runtime.conversationId, id,
        ...(type === "message.queue.enqueue" ? { content: "Do the next task.", attachments: media } : {}),
      },
    } as ClientCommand);
  };
  const stopAndSend = async (id: string, turnId: string, content = "Do this instead.") => {
    await queue!.handler(null as unknown as WebSocket, {
      type: "message.queue.stop-and-send", requestId: id,
      payload: { conversationId: runtime.conversationId, id, turnId, content, attachments: [] },
    });
  };
  const followUp = async (content = "Also check the tests.") => {
    const requestId = randomUUID();
    await queue!.turnInteractionHandler(null as unknown as WebSocket, {
      type: "message.send", requestId, payload: { conversationId: runtime.conversationId, content, attachments: [] },
    });
    return requestId;
  };
  return { ...runtime, dependencies, queue, attachments, events, hooks, admission, drain, command, followUp, stopAndSend, abort,
    close: async () => { abort.abort(); await drain(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); },
  };
}

const startRunning = (f: Awaited<ReturnType<typeof fixture>>) => {
  const initial = f.controller.queue({ conversationId: f.conversationId, content: "First task" });
  f.controller.start(initial.turn.id);
  f.provider.emit({ ...turnControllerTestIdentity(f), type: "status", status: "running" });
  return initial;
};
const queueResult = (f: Awaited<ReturnType<typeof fixture>>, requestId: string) =>
  f.events.find((event) => event.type === "request.result" && event.requestId === requestId);

describe("stop and send", () => {
  it("stops the exact running turn and starts the message as the next turn on the same provider session", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "session", sessionId: "provider-session" });
      const id = randomUUID();
      await f.stopAndSend(id, initial.turn.id);
      expect(queueResult(f, id)).toMatchObject({ result: { kind: "message.queue", receipt: { id, content: "Do this instead." } } });
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
      expect(f.provider.runCount).toBe(2);
      expect(f.provider.input).toMatchObject({ sessionId: "provider-session", prompt: expect.stringContaining("Do this instead.") });
      await f.stopAndSend(id, initial.turn.id);
      await f.drain();
      expect(f.provider.runCount).toBe(2);
      expect(f.store.latestAgentTurnForConversation(f.conversationId)?.status).not.toBe("cancelled");
    } finally { await f.close(); }
  });

  it("keeps the message queued and leaves a different running turn alone", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const id = randomUUID();
      await f.stopAndSend(id, randomUUID());
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      expect(f.store.agentTurn(initial.turn.id).status).toBe("running");
      expect(f.provider.cancelCount).toBe(0);
    } finally { await f.close(); }
  });

  it("refuses without stopping the agent while earlier queued messages wait", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      await f.command("message.queue.enqueue", randomUUID());
      await expect(f.stopAndSend(randomUUID(), initial.turn.id)).rejects.toThrow("Send or remove the queued message first.");
      expect(f.store.queuedMessages.list(f.conversationId)).toHaveLength(1);
      expect(f.store.agentTurn(initial.turn.id).status).toBe("running");
      expect(f.provider.cancelCount).toBe(0);
    } finally { await f.close(); }
  });
});

describe("follow-ups that never reach the running agent", () => {

  it("queues a refused follow-up under its request id and sends it once after the turn completes", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      f.provider.steerSupported = false;
      const requestId = await f.followUp();
      expect(f.provider.steerCalls).toEqual(["Also check the tests."]);
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.queue", receipt: { id: requestId, state: "waiting", content: "Also check the tests." } } });
      expect(f.store.queuedMessages.list(f.conversationId)).toHaveLength(1);
      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("accepted"));
      await f.drain();
      const receipt = f.store.queuedMessages.get(f.conversationId, requestId)!;
      expect(f.store.message(receipt.userMessageId!).content).toBe("Also check the tests.");
      expect(f.provider.runCount).toBe(2);
      expect(f.provider.steerCalls).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("queues a follow-up that arrives after the turn ended but before provider cleanup finished", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      f.provider.deferOwnedStop("settled");
      f.provider.resolve({ status: "completed" }); await flushTurnControllerTestPromises();
      expect(f.controller.isActive(f.conversationId)).toBe(true);
      const requestId = await f.followUp();
      expect(f.provider.steerCalls).toEqual([]);
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.queue", receipt: { id: requestId } } });
      expect(f.provider.runCount).toBe(1);
      f.provider.resolveOwnedStop();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("accepted"));
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { f.provider.resolveOwnedStop(); await f.close(); }
  });

  it("keeps a follow-up the agent may have received out of the queue", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      vi.spyOn(f.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError());
      await expect(f.followUp()).rejects.toMatchObject({ delivery: "ambiguous" });
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("rejects a refused follow-up without queueing it when three messages already wait", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      for (let index = 0; index < 3; index += 1) await f.command("message.queue.enqueue", randomUUID());
      f.provider.steerSupported = false;
      await expect(f.followUp("A fourth message.")).rejects.toThrow("already has three queued messages");
      expect(f.store.queuedMessages.list(f.conversationId).map(({ content }) => content)).toEqual(Array(3).fill("Do the next task."));
    } finally { await f.close(); }
  });
});

describe("durable runtime message queue", () => {
  it("dispatches in the background after completion and replays a lost enqueue acknowledgement without a duplicate turn", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First task" });
      f.controller.start(initial.turn.id);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      expect(f.provider.runCount).toBe(1);
      f.provider.resolve({ status: "completed", text: "Done" });
      await f.drain();
      const receipt = f.store.queuedMessages.get(f.conversationId, id)!;
      expect(receipt).toMatchObject({ state: "accepted", turnId: expect.any(String), userMessageId: expect.any(String) });
      expect(f.provider.runCount).toBe(2);
      expect(f.store.message(receipt.userMessageId!).content).toBe("Do the next task.");
      await f.command("message.queue.enqueue", id);
      await f.drain();
      expect(f.provider.runCount).toBe(2);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toEqual(receipt);
    } finally { await f.close(); }
  });

  it("never starts queued work while exact provider cleanup remains unconfirmed", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.deferOwnedStop("force-detached");
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.provider.resolve({ status: "completed" }); await flushTurnControllerTestPromises();
      f.provider.resolveOwnedStop(); await f.drain();
      expect(f.provider.runCount).toBe(1);
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
    } finally { await f.close(); }
  });

  it("preserves queued image ownership over restart and removes it only after its last reference", async () => {
    const f = await fixture();
    let reopened: RuntimeStore | undefined;
    try {
      const id = randomUUID();
      const image = { id: randomUUID(), name: "queued.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.command("message.queue.enqueue", id, [image]); await f.drain();
      expect(await f.attachments.preview(image.id)).not.toBeNull();
      expect(f.store.attachments()).toMatchObject([{ id: image.id }]);
      expect(f.store.evictableAttachmentIds()).not.toContain(image.id);
      f.store.close();
      reopened = new RuntimeStore(join(f.directory, "inertia.sqlite"), f.workspace, { recoverInterruptedRuns: false });
      expect(reopened.queuedMessages.list(f.conversationId)).toMatchObject([{ id, attachments: [{ id: image.id }] }]);
      await f.attachments.reconcile(reopened.attachments());
      expect(await f.attachments.preview(image.id)).not.toBeNull();
      const removed = reopened.queuedMessages.cancel(f.conversationId, id)!;
      expect(reopened.referencedAttachmentIds(removed.attachments.map(({ id: attachmentId }) => attachmentId)).size).toBe(0);
      await f.attachments.release([image.id]);
      expect(await f.attachments.preview(image.id)).toBeNull();
    } finally { reopened?.close(); f.abort.abort(); await f.attachments.close(); }
  });

  it("keeps a queued message and its images when the provider refuses its image count", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      const images = Array.from({ length: 33 }, (_, index) => ({
        id: randomUUID(), name: `queued-${index}.png`, path: "opaque", mimeType: "image/png" as const, size: 8,
      }));
      await f.command("message.queue.enqueue", id, images); await f.drain();
      const resolve = vi.spyOn(f.attachments, "resolve");
      await f.command("message.queue.send", id); await f.drain();
      const queued = f.store.queuedMessages.get(f.conversationId, id);
      expect(queued?.state).toBe("blocked");
      expect(queued?.error).toContain("accepts at most 32 images per message. Remove some images and send again.");
      expect(resolve).not.toHaveBeenCalled();
      expect(queued?.attachments.map(({ id: attachmentId }) => attachmentId)).toEqual(images.map(({ id: attachmentId }) => attachmentId));
      expect(f.provider.runCount).toBe(0);
      expect(await f.attachments.preview(images[0]!.id)).not.toBeNull();
    } finally { await f.close(); }
  });

  it("rolls back retained media if durable enqueue fails", async () => {
    const f = await fixture();
    try {
      const image = { id: randomUUID(), name: "rollback.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      vi.spyOn(f.store.queuedMessages, "add").mockImplementationOnce(() => { throw new Error("SQLite unavailable"); });
      await expect(f.command("message.queue.enqueue", randomUUID(), [image])).rejects.toThrow("SQLite unavailable");
      expect(await f.attachments.preview(image.id)).toBeNull();
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("blocks automatic and explicit dispatch after the access route changes", async () => {
    const f = await fixture();
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.store.updateConversation(f.conversationId, { accessMode: "full" });
      await f.command("message.queue.send", id);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "blocked", error: expect.stringContaining("access") });
      expect(f.provider.runCount).toBe(0);
      await f.command("message.queue.remove", id);
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("reconciles an interrupted pre-admission claim and keeps accepted receipts immutable", async () => {
    const f = await fixture();
    try {
      const conversation = f.store.conversation(f.conversationId);
      const id = randomUUID();
      f.store.queuedMessages.add({ id, conversation, content: "Next", attachments: [], digest: queuedIntentDigest("Next", []) });
      expect(f.store.queuedMessages.claim(f.conversationId, id)).toBe(true);
      f.store.queuedMessages.reconcile();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      f.store.queuedMessages.claim(f.conversationId, id);
      const queued = f.controller.queue({ conversationId: f.conversationId, content: "Next", queuedMessageId: id });
      f.store.queuedMessages.reconcile();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "accepted", turnId: queued.turn.id });
      expect(f.store.queuedMessages.claim(f.conversationId, id)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["route", "archive"] as const)("rechecks %s after asynchronous preparation before provider admission", async (change) => {
    const f = await fixture();
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const verify = vi.fn(() => pending);
      f.dependencies.verifyProviderInstallation = verify;
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      const sending = f.command("message.queue.send", id);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      if (change === "route") f.store.updateConversation(f.conversationId, { accessMode: "full" });
      else f.store.archiveConversation(f.conversationId, true);
      release(); await sending;
      expect(f.provider.runCount).toBe(0);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "blocked", turnId: null });
    } finally { await f.close(); }
  });

  it("dispatches the next eligible message when a blocked head is removed", async () => {
    const f = await fixture();
    try {
      const first = randomUUID(); await f.command("message.queue.enqueue", first); await f.drain();
      f.store.updateConversation(f.conversationId, { accessMode: "full" });
      await f.command("message.queue.send", first);
      const second = randomUUID(); await f.command("message.queue.enqueue", second); await f.drain();
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "Another task" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, second)?.state).toBe("waiting");
      await f.command("message.queue.remove", first); await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, second)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("waits for provider cleanup that outlasts the dispatch and admission waits instead of stalling the queue", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const f = await fixture({ releaseTurnAttachments: () => cleanup });
    try {
      const image = await turnControllerTestAttachment(f, randomUUID());
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First", attachments: [image] });
      f.controller.start(initial.turn.id);
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      f.provider.resolve({ status: "completed" });
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(121_000);
      vi.useRealTimers();
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("completed");
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
      expect(admission).not.toHaveBeenCalled();
      expect(f.provider.runCount).toBe(1);
      finishCleanup();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { vi.useRealTimers(); finishCleanup(); await f.close(); }
  });

  it.each([
    ["an unavailable admission", () => Promise.resolve(null)],
    ["an admission timeout", () => Promise.reject(new MessageSendPreparationTimeoutError("Preparing this message took too long. No turn was started."))],
  ] as const)("returns the head to waiting and dispatches it again after %s", async (_name, failure) => {
    const f = await fixture();
    try {
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission").mockImplementationOnce(failure);
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id);
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(admission).toHaveBeenCalledTimes(2);
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it.each([
    ["failed", "an unavailable admission", () => Promise.resolve(null)],
    ["cancelled", "an admission timeout", () => Promise.reject(new MessageSendPreparationTimeoutError("Preparing this message took too long. No turn was started."))],
  ] as const)("retries an explicit send once more after a %s turn and %s", async (status, _name, failure) => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status }); await f.drain();
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission").mockImplementationOnce(failure);
      await f.command("message.queue.send", id);
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(admission).toHaveBeenCalledTimes(2);
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("retries an explicit send only once after a failed turn and leaves it queued for another request", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status: "failed" }); await f.drain();
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission").mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await f.command("message.queue.send", id);
      await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(2));
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
      expect(f.provider.runCount).toBe(1);
      await f.command("message.queue.send", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("does not carry an explicit send retry to a different queued message", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status: "failed" }); await f.drain();
      const first = randomUUID(); await f.command("message.queue.enqueue", first);
      const second = randomUUID(); await f.command("message.queue.enqueue", second); await f.drain();
      const cleanup = f.controller.waitForProviderCleanup.bind(f.controller);
      vi.spyOn(f.controller, "waitForProviderCleanup").mockImplementation(async (ids, deadline) => {
        if (deadline === undefined) f.store.queuedMessages.cancel(f.conversationId, first);
        return cleanup(ids, deadline);
      });
      vi.spyOn(f.controller, "acquireTurnAdmission").mockResolvedValueOnce(null);
      await f.command("message.queue.send", first);
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, first)?.state).toBe("cancelled"));
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, second)?.state).toBe("waiting");
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("consumes a wake-up that arrives after the dispatch loop finishes but before it is released", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status: "completed" }); await f.drain();
      const active = vi.spyOn(f.controller, "isActive").mockReturnValue(true);
      f.hooks.operationSettled = () => {
        f.hooks.operationSettled = undefined;
        active.mockRestore();
        f.queue.onTurnSettled(f.store.latestAgentTurnForConversation(f.conversationId)!);
      };
      const id = randomUUID(); await f.command("message.queue.enqueue", id);
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("waits for refused runtime admission to reopen instead of rescheduling in a microtask loop", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.resolve({ status: "completed" }); await f.drain();
      f.admission.closed = true;
      const id = randomUUID(); await f.command("message.queue.enqueue", id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.admission.refusals).toBe(1);
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      f.admission.closed = false;
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"), { timeout: 5_000 });
      await f.drain();
      expect(f.admission.refusals).toBe(1);
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("returns a claimed head to waiting when runtime shutdown interrupts its dispatch", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id);
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission").mockImplementationOnce(async () => {
        f.abort.abort(new Error("The runtime is shutting down."));
        throw new Error("The runtime is shutting down.");
      });
      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("keeps only the most recent terminal receipts when messages are cancelled or accepted", async () => {
    const f = await fixture();
    try {
      const conversation = f.store.conversation(f.conversationId);
      const add = (content: string) => {
        const id = randomUUID();
        f.store.queuedMessages.add({ id, conversation, content, attachments: [], digest: queuedIntentDigest(content, []) });
        return { id, digest: queuedIntentDigest(content, []) };
      };
      const replayable = ({ id, digest }: { id: string; digest: string }) => f.store.queuedMessages.replay(f.conversationId, id, digest) !== null;
      const waiting = add("Still waiting");
      const cancelled = Array.from({ length: RETAINED_TERMINAL_QUEUED_MESSAGES + 2 }, (_, index) => {
        const entry = add(`Cancelled ${index}`);
        f.store.queuedMessages.cancel(f.conversationId, entry.id);
        return entry;
      });
      expect(cancelled.map(replayable)).toEqual(cancelled.map((_, index) => index >= 2));
      const accepted = add("Accepted");
      f.store.queuedMessages.claim(f.conversationId, accepted.id);
      f.controller.queue({ conversationId: f.conversationId, content: "Accepted", queuedMessageId: accepted.id });
      expect(cancelled.map(replayable)).toEqual(cancelled.map((_, index) => index >= 3));
      expect(f.store.queuedMessages.get(f.conversationId, accepted.id)?.state).toBe("accepted");
      expect(f.store.queuedMessages.get(f.conversationId, waiting.id)?.state).toBe("waiting");
    } finally { await f.close(); }
  });
});
