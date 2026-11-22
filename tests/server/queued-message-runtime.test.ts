// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { ChatAttachment, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { createQueuedMessageRuntime, UNREAD_FOLLOW_UP_ROUTE_CHANGED } from "../../src/server/runtime/queued-message-runtime";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { QueuedMessageLimitError, queuedIntentDigest, RETAINED_TERMINAL_QUEUED_MESSAGES } from "../../src/server/persistence/queued-message-repository";
import { MessageSendPreparationTimeoutError } from "../../src/server/runtime/commands/message-send-preparation";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestAttachment, turnControllerTestIdentity, turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";
import { ProviderSteerDeliveryUnknownError } from "../../src/server/provider/contracts";
import type { TurnControllerHooks } from "../../src/server/runtime/turns/turn-controller";
import { join } from "node:path";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { hold, release } from "../../src/server/runtime/update-hold";
import { createTurnInteractionCommandHandler } from "../../src/server/runtime/commands/turn-interaction-commands";
import { watcherNoteDelivery } from "../../src/server/runtime/watcher/watcher-note-instruction";
import { MAX_UNREAD_FOLLOW_UP_ROWS, messageQueueResultSchema } from "../../src/shared/queued-messages";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";

afterEach(cleanupTurnControllerTestDirectories);
async function fixture(
  hookOverrides: Partial<TurnControllerHooks> = {},
  options: Parameters<typeof createTurnControllerTestRuntime>[1] = {},
) {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue?.onTurnSettled(turn), ...hookOverrides }, options);
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const events: ServerEvent[] = [];
  const hooks: { operationSettled?: () => void } = {};
  const admission = { closed: false, refusals: 0 };
  const compaction = { active: false };
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
  queue = createQueuedMessageRuntime(dependencies, { signal: abort.signal, compacting: () => compaction.active, track: (operation) => {
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
  return { ...runtime, dependencies, queue, attachments, events, hooks, admission, compaction, drain, command, followUp, stopAndSend, abort,
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

  it("keeps a repeated Stop and send explicit when provider cleanup outlasts the dispatch wait", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      f.provider.deferOwnedStop("settled");
      const id = randomUUID();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await f.stopAndSend(id, initial.turn.id);
      await f.stopAndSend(id, initial.turn.id);
      await vi.advanceTimersByTimeAsync(31_000);
      vi.useRealTimers();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      expect(f.provider.runCount).toBe(1);
      f.provider.resolve({ status: "cancelled" });
      f.provider.resolveOwnedStop();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
      expect(f.provider.runCount).toBe(2);
    } finally { vi.useRealTimers(); f.provider.resolveOwnedStop(); await f.close(); }
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

  it("names the queue limit when another message fills the queue during a refused follow-up", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      f.provider.steerSupported = false;
      vi.spyOn(f.store.queuedMessages, "add").mockImplementationOnce(() => {
        throw new QueuedMessageLimitError();
      });
      await expect(f.followUp()).rejects.toThrow("This follow-up did not reach the agent, and this chat already has three queued messages.");
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
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

describe("Send now while the agent works", () => {
  it("hands the queued message to the running turn as a follow-up and completes its queue entry once", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id); await f.drain();
      await f.command("message.queue.send", id);
      expect(f.provider.steerCalls).toEqual(["Do the next task."]);
      const receipt = f.store.queuedMessages.get(f.conversationId, id)!;
      expect(receipt).toMatchObject({ state: "accepted", turnId: initial.turn.id, content: "", attachments: [] });
      expect(f.store.message(receipt.userMessageId!)).toMatchObject({ content: "Do the next task.", turnId: initial.turn.id });
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("keeps the message queued for the next turn when the agent does not take it now", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id); await f.drain();
      f.provider.steerSupported = false;
      await expect(f.command("message.queue.send", id)).rejects.toThrow("It will send when the turn ends.");
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("holds a queued message whose mid-turn delivery became unknown instead of sending it again", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id); await f.drain();
      vi.spyOn(f.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError());
      await expect(f.command("message.queue.send", id)).rejects.toMatchObject({ delivery: "ambiguous" });
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("blocked");
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("holds a queued message the agent accepted when recording it fails, instead of sending it again", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id); await f.drain();
      vi.spyOn(f.store, "createAcknowledgedFollowUpMessage").mockImplementation(() => { throw new Error("SQLITE_BUSY"); });
      await expect(f.command("message.queue.send", id)).rejects.toThrow("SQLITE_BUSY");
      expect(f.provider.steerCalls).toEqual(["Do the next task."]);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({
        state: "blocked",
        error: "The agent received this message, but Inertia could not record it. Check the chat before sending it again.",
      });
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("sends a queued message's images with the follow-up and keeps them referenced by its message", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const id = randomUUID();
      const image = { id: randomUUID(), name: "queued.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.command("message.queue.enqueue", id, [image]); await f.drain();
      const steer = vi.spyOn(f.provider, "steer");
      await f.command("message.queue.send", id);
      expect(steer).toHaveBeenCalledOnce();
      expect(steer.mock.calls[0]![1].imagePaths).toHaveLength(1);
      const receipt = f.store.queuedMessages.get(f.conversationId, id)!;
      expect(receipt.state).toBe("accepted");
      expect(f.store.message(receipt.userMessageId!).attachments).toMatchObject([{ id: image.id }]);
      expect(f.store.evictableAttachmentIds()).not.toContain(image.id);
      expect(await f.attachments.preview(image.id)).not.toBeNull();
    } finally { await f.close(); }
  });
});

describe("durable runtime message queue", () => {
  it("keeps queued messages waiting while the chat compacts and sends them when compaction ends", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id);
      f.provider.resolve({ status: "completed" }); await f.drain();
      f.compaction.active = true;
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      await f.command("message.queue.send", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
      expect(f.provider.runCount).toBe(1);
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("keeps Send now pressed during a compaction and sends the message once compaction ends after a failed turn", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id);
      f.provider.resolve({ status: "failed" }); await f.drain();
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      f.compaction.active = true;
      await f.command("message.queue.send", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
      expect(f.provider.runCount).toBe(1);
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

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

  it("waits for the provider stop, then starts queued work once the unconfirmed stop releases the chat", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id); f.provider.deferOwnedStop("force-detached");
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.provider.resolve({ status: "completed" }); await flushTurnControllerTestPromises();
      expect(f.provider.runCount).toBe(1);
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      f.provider.resolveOwnedStop(); await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("completed");
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2), { timeout: 3_000 });
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.store.providerRunOwnership.forTurn(initial.turn.id)).toMatchObject({ runId: initial.turn.runId });
      expect(f.store.orchestration.awaitsCleanupProof(f.conversationId)).toBe(true);
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
  }, 60_000);

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

  it("keeps queued messages waiting while Inertia is updating and sends them after the hold ends", async () => {
    const f = await fixture();
    try {
      const initial = f.controller.queue({ conversationId: f.conversationId, content: "First" });
      f.controller.start(initial.turn.id);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      hold();
      try {
        f.provider.resolve({ status: "completed" }); await f.drain();
        expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
        await expect(f.command("message.queue.send", id)).rejects.toThrow("Inertia is updating.");
        await expect(f.stopAndSend(randomUUID(), initial.turn.id)).rejects.toThrow("Inertia is updating.");
        expect(f.store.queuedMessages.list(f.conversationId).map((entry) => entry.id)).toEqual([id]);
        expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
        expect(f.provider.runCount).toBe(1);
      } finally {
        release();
      }
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"), { timeout: 5_000 });
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { release(); await f.close(); }
  });

  it("sends a queued follow-up as the continuation of a turn stopped for an update once the hold ends", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      hold();
      try {
        expect(await f.controller.interruptForUpdate([f.conversationId], "Inertia")).toBe(true);
        await f.drain();
        expect(f.store.agentTurn(initial.turn.id)).toMatchObject({ status: "interrupted", terminalReason: "app-update" });
        expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", error: null });
        expect(f.provider.runCount).toBe(1);
      } finally {
        release();
      }
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"), { timeout: 5_000 });
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { release(); await f.close(); }
  });

  it.each([
    ["app-update", "accepted", 1],
    ["runtime-restart", "waiting", 0],
    ["runtime-shutdown", "waiting", 0],
    ["runtime-crash", "waiting", 0],
  ] as const)("after a turn interrupted by %s the queued follow-up is %s", async (terminalReason, state, runs) => {
    const f = await fixture();
    try {
      const conversation = f.store.conversation(f.conversationId);
      const run = f.store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId, conversationId: f.conversationId,
        label: "Task", detail: null, status: "running", port: null });
      const { turn } = f.store.beginAgentTurn({ conversationId: f.conversationId, runId: run.id, content: "First task",
        providerId: conversation.providerId, modelSelection: conversation.modelSelection, model: "gpt-test",
        reasoningEffort: conversation.reasoningEffort, interactionMode: conversation.interactionMode, accessMode: conversation.accessMode,
        configurationRevision: 0, association: "authoritative" });
      const at = new Date().toISOString();
      f.store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: at });
      f.store.updateAgentTurnLifecycle(turn.id, { status: "interrupted", terminalReason, completedAt: at });
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe(state);
      expect(f.provider.runCount).toBe(runs);
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

describe("follow-ups accepted as the agent finishes its answer", () => {
  type QueueFixture = Awaited<ReturnType<typeof fixture>>;
  const flushStreams = (f: QueueFixture) => {
    for (const [id, callback] of f.scheduler.callbacks) {
      if ((f.scheduler.delays.get(id) ?? 0) >= 1_000) continue;
      f.scheduler.callbacks.delete(id); f.scheduler.delays.delete(id); callback();
    }
  };
  const turnMessages = (f: QueueFixture, turnId: string) => f.store.conversationDetail(f.conversationId)!.messages
    .filter((message) => message.turnId === turnId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map(({ role, content }) => `${role}:${content}`);

  it("keeps the earlier answer and the reply to the follow-up in separate rows around the follow-up", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const identity = turnControllerTestIdentity(f);
      f.provider.emit({ ...identity, type: "text", text: "Answer to the first task." });
      f.provider.emit({ ...identity, type: "text-boundary" });
      const requestId = await f.followUp("Also rename the file.");
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.accepted", disposition: "follow-up" } });
      f.provider.emit({ ...identity, type: "text", text: "Renamed it." });
      flushStreams(f);
      f.provider.resolve({ status: "completed", text: "Answer to the first task.Renamed it." });
      await f.drain();
      expect(turnMessages(f, initial.turn.id)).toEqual([
        "user:First task",
        "assistant:Answer to the first task.",
        "user:Also rename the file.",
        "assistant:Renamed it.",
      ]);
      expect(f.store.message(f.store.agentTurn(initial.turn.id).terminalAssistantMessageId!).content).toBe("Renamed it.");
    } finally { await f.close(); }
  });

  it("records a follow-up the provider confirmed as its turn ended in that turn without queueing it", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      let acknowledge!: (accepted: boolean) => void;
      vi.spyOn(f.provider, "steer").mockImplementation(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
      const requestId = randomUUID();
      const sending = f.queue.turnInteractionHandler(null as unknown as WebSocket, {
        type: "message.send", requestId, payload: { conversationId: f.conversationId, content: "Also rename the file.", attachments: [] },
      });
      await flushTurnControllerTestPromises();
      f.provider.resolve({ status: "completed" });
      acknowledge(true);
      await expect(sending).resolves.toBe("handled");
      await f.drain();
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.accepted", turnId: initial.turn.id, disposition: "follow-up" } });
      expect(f.store.agentTurn(initial.turn.id).status).toBe("completed");
      expect(f.store.conversationDetail(f.conversationId)!.messages
        .filter((message) => message.content === "Also rename the file.")
        .map(({ role, turnId }) => ({ role, turnId }))).toEqual([{ role: "user", turnId: initial.turn.id }]);
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it.each([
    ["codex", "cancelled"],
    ["codex", "failed"],
    ["opencode", "cancelled"],
    ["opencode", "failed"],
  ] as const)("queues a %s follow-up confirmed as its turn ended %s instead of showing it unanswered", async (providerId, status) => {
    const f = await fixture({}, providerId === "opencode"
      ? { modelSelection: providerNativeModelSelection({ providerId: "opencode", modelId: "provider-default" }) }
      : {});
    try {
      const initial = startRunning(f);
      let acknowledge!: (accepted: boolean) => void;
      vi.spyOn(f.provider, "steer").mockImplementation(() => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
      const requestId = randomUUID();
      const sending = f.queue.turnInteractionHandler(null as unknown as WebSocket, {
        type: "message.send", requestId, payload: { conversationId: f.conversationId, content: "Also rename the file.", attachments: [] },
      });
      await flushTurnControllerTestPromises();
      expect(f.store.agentTurn(initial.turn.id).harnessId).toBe(providerId === "opencode" ? "opencode-sdk" : "codex-app-server");
      f.provider.resolve({ status });
      acknowledge(true);
      await expect(sending).resolves.toBe("handled");
      await f.drain();
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.queue", receipt: {
        id: requestId, state: "blocked", error: "The follow-up was accepted as its turn ended. Check this chat before retrying.",
      } } });
      expect(f.store.agentTurn(initial.turn.id).status).toBe(status);
      expect(f.store.conversationDetail(f.conversationId)!.messages
        .some((message) => message.content === "Also rename the file.")).toBe(false);
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("holds a follow-up whose delivery became unknown because its turn ended until the user sends it", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      vi.spyOn(f.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError(true));
      const requestId = await f.followUp();
      const unconfirmed = { id: requestId, state: "blocked", error: "The provider did not confirm whether it received this follow-up. Check this chat before retrying." };
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.queue", receipt: unconfirmed } });
      f.provider.resolve({ status: "completed" });
      await f.drain();
      expect(f.store.agentTurn(f.store.latestAgentTurnForConversation(f.conversationId)!.id).status).toBe("completed");
      expect(f.store.queuedMessages.get(f.conversationId, requestId)).toMatchObject(unconfirmed);
      expect(f.provider.runCount).toBe(1);
      await f.command("message.queue.send", requestId);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("keeps an unconfirmed follow-up ambiguous when the queue has no room for it", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      for (let index = 0; index < 3; index += 1) await f.command("message.queue.enqueue", randomUUID());
      vi.spyOn(f.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError(true));
      await expect(f.followUp("A fourth message.")).rejects.toMatchObject({
        delivery: "ambiguous",
        message: "The provider did not confirm whether it received this follow-up. Check this chat before retrying.",
      });
      expect(f.store.queuedMessages.list(f.conversationId)).toHaveLength(3);
    } finally { await f.close(); }
  });

  it("keeps a follow-up refused before a failed or cancelled turn held in the queue", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const f = await fixture();
      try {
        startRunning(f);
        f.provider.steerSupported = false;
        const requestId = await f.followUp();
        f.provider.resolve({ status });
        await f.drain();
        expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("waiting");
        expect(f.provider.runCount).toBe(1);
      } finally { await f.close(); }
    }
  });

  describe("forwarded watcher notes", () => {
    const note = {
      linkId: "11111111-1111-4111-8111-111111111111",
      wakeId: "22222222-2222-4222-8222-222222222222",
      watcherConversationId: "33333333-3333-4333-8333-333333333333",
      preset: "reviewer" as const,
      watcherLabel: "Codex · test route",
      delivery: "queue" as const,
    };

    it("waits behind user-authored queued messages and dispatches with its attribution and note instruction", async () => {
      const f = await fixture();
      try {
        startRunning(f);
        const noteId = randomUUID();
        const receipt = f.queue.enqueueWatcherNote({
          conversationId: f.conversationId, id: noteId, content: "Check the Windows path handling.", watcherNote: note,
        });
        expect(receipt.receipt).toMatchObject({ id: noteId, watcherNote: note });
        const userId = randomUUID();
        await f.command("message.queue.enqueue", userId);
        expect(f.store.queuedMessages.list(f.conversationId).map(({ id }) => id)).toEqual([userId, noteId]);

        f.provider.resolve({ status: "completed", text: "Done" });
        await f.drain();
        expect(f.store.queuedMessages.get(f.conversationId, userId)?.state).toBe("accepted");
        expect(f.store.queuedMessages.get(f.conversationId, noteId)?.state).toBe("waiting");
        expect(f.provider.input?.prompt).not.toContain("inertia-watcher-note");

        f.provider.resolve({ status: "completed", text: "Done again" });
        await f.drain();
        const accepted = f.store.queuedMessages.get(f.conversationId, noteId)!;
        expect(accepted.state).toBe("accepted");
        expect(f.store.message(accepted.userMessageId!)).toMatchObject({
          content: "Check the Windows path handling.", watcherNote: note,
        });
        expect(f.provider.input?.prompt).toContain("[inertia-watcher-note]");
        expect(f.provider.input?.prompt).toContain("Treat it as review feedback from a colleague");
      } finally { await f.close(); }
    });

    it("keeps a queued note's attribution and note instruction when Send now hands it to the running turn", async () => {
      const f = await fixture();
      try {
        const initial = startRunning(f);
        const noteId = randomUUID();
        f.queue.enqueueWatcherNote({
          conversationId: f.conversationId, id: noteId, content: "Check the Windows path handling.", watcherNote: note,
        });
        await f.command("message.queue.send", noteId);
        expect(f.provider.steerCalls).toHaveLength(1);
        expect(f.provider.steerCalls[0]).toMatch(/^Check the Windows path handling\.\n\n/u);
        expect(f.provider.steerCalls[0]).toContain("[inertia-watcher-note]");
        const receipt = f.store.queuedMessages.get(f.conversationId, noteId)!;
        expect(receipt).toMatchObject({ state: "accepted", turnId: initial.turn.id });
        expect(f.store.message(receipt.userMessageId!)).toMatchObject({
          content: "Check the Windows path handling.", watcherNote: note, turnId: initial.turn.id,
        });
      } finally { await f.close(); }
    });

    it("lets Stop and send go ahead of a waiting note, which then waits for the next turn", async () => {
      const f = await fixture();
      try {
        const initial = startRunning(f);
        const noteId = randomUUID();
        f.queue.enqueueWatcherNote({
          conversationId: f.conversationId, id: noteId, content: "Check the Windows path handling.", watcherNote: note,
        });
        const id = randomUUID();
        await f.stopAndSend(id, initial.turn.id);
        await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
        await f.drain();
        expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
        expect(f.provider.input?.prompt).toContain("Do this instead.");
        expect(f.store.queuedMessages.get(f.conversationId, noteId)?.state).toBe("waiting");
      } finally { await f.close(); }
    });

    it("names the main chat's full queue", async () => {
      const f = await fixture();
      try {
        startRunning(f);
        for (let index = 0; index < 3; index += 1) await f.command("message.queue.enqueue", randomUUID());
        expect(() => f.queue.enqueueWatcherNote({
          conversationId: f.conversationId, id: randomUUID(), content: "One more finding.", watcherNote: note,
        })).toThrow("The main chat's queue is full");
      } finally { await f.close(); }
    });

    it("never turns a watcher delivery into an unattributed steer of a running turn", async () => {
      const f = await fixture();
      try {
        startRunning(f);
        const handler = createTurnInteractionCommandHandler({ ...f.dependencies, watcherDelivery: watcherNoteDelivery(note) });
        await expect(handler(null as unknown as WebSocket, {
          type: "message.send", requestId: randomUUID(),
          payload: { conversationId: f.conversationId, content: "Finding.", attachments: [], activate: false },
        })).rejects.toThrow("This chat is busy");
        expect(f.provider.steerCalls).toEqual([]);
      } finally { await f.close(); }
    });
  });
});

describe("follow-ups the agent accepted but never read (T3 e8c4824b7)", () => {
  type QueueFixture = Awaited<ReturnType<typeof fixture>>;
  // Queue rows and follow-up submissions share one clock, as in production.
  const realClock = { clock: () => new Date() };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const image = () => ({ id: randomUUID(), name: "unread.png", path: "opaque", mimeType: "image/png" as const, size: 8 });
  const steer = async (f: QueueFixture, content: string, media: ChatAttachment[] = []) => {
    const spy = vi.spyOn(f.provider, "steer");
    const requestId = randomUUID();
    await f.queue.turnInteractionHandler(null as unknown as WebSocket, {
      type: "message.send", requestId, payload: { conversationId: f.conversationId, content, attachments: media },
    });
    expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.accepted", disposition: "follow-up" } });
    const steerId = spy.mock.calls.at(-1)![1].steerId!;
    spy.mockRestore();
    return { steerId, message: messagesWith(f, content)[0]! };
  };
  const send = async (f: QueueFixture, content: string, extra: { context?: Record<string, never> } = {}) => {
    const requestId = randomUUID();
    await f.queue.turnInteractionHandler(null as unknown as WebSocket, {
      type: "message.send", requestId, payload: { conversationId: f.conversationId, content, attachments: [], ...extra },
    });
    return requestId;
  };
  const messagesWith = (f: QueueFixture, content: string) => f.store.conversationDetail(f.conversationId)!.messages
    .filter((message) => message.content === content);
  const rows = (f: QueueFixture) => f.store.queuedMessages.list(f.conversationId);
  const unreadRows = (f: QueueFixture) => rows(f).filter(({ userMessageId }) => userMessageId !== null);
  const coverage = (f: QueueFixture, turn: { continuationIdentity: unknown }) => f.store.orchestration.backings.find({
    threadId: f.conversationId, providerId: "codex", workspaceKey: f.workspace, identity: turn.continuationIdentity as never,
  })?.coveredItemIds ?? [];
  // A stale second row naming the same message, as a defect or a lost cancellation could leave.
  const insertStaleRow = (f: QueueFixture, messageId: string) => {
    const id = randomUUID();
    (f.store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).database.prepare(`
      INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity, state,
        created_at, user_message_id) VALUES (?, ?, 'Stale', '[]', ?, '', 'waiting', ?, ?)`)
      .run(id, f.conversationId, queuedIntentDigest("Stale", []), new Date().toISOString(), messageId);
    return id;
  };
  const withSession = (f: QueueFixture) => f.provider.emit({ ...turnControllerTestIdentity(f), type: "session", sessionId: "provider-session" });
  const complete = (f: QueueFixture, extra: Record<string, unknown> = {}) => {
    withSession(f);
    f.provider.resolve({ status: "completed", sessionId: "provider-session", ...extra });
  };
  // A fresh runtime over the same database boots, runs what its start schedules, and stops; the fixture's own
  // runtime keeps reacting to later turns.
  const restart = async (f: QueueFixture) => {
    const abort = new AbortController();
    const tasks = new Set<Promise<unknown>>();
    const runtime = createQueuedMessageRuntime(f.dependencies, { signal: abort.signal, track: (operation) => {
      const task = operation(); tasks.add(task); void task.finally(() => tasks.delete(task)); return task;
    } });
    await runtime.start();
    await f.drain();
    while (tasks.size) await Promise.allSettled(tasks);
    abort.abort();
    await f.drain();
  };

  it("queues a dropped follow-up by reference when its turn settles, out of that turn's coverage, and sends it next on its own message and images", async () => {
    const f = await fixture({}, realClock);
    try {
      const initial = startRunning(f);
      withSession(f);
      const media = image();
      const { steerId, message } = await steer(f, "Also look at this.", [media]);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(f.provider.runCount).toBe(1);
      expect(unreadRows(f)).toEqual([expect.objectContaining({ state: "waiting", userMessageId: message.id,
        content: "Also look at this.", attachments: [expect.objectContaining({ id: media.id })], createdAt: message.createdAt })]);
      expect(coverage(f, initial.turn)).toContain(initial.message.id);
      expect(coverage(f, initial.turn)).not.toContain(message.id);

      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();
      const next = f.store.latestAgentTurnForConversation(f.conversationId)!;
      expect(next.userMessageId).toBe(message.id);
      expect(messagesWith(f, "Also look at this.")).toEqual([expect.objectContaining({ id: message.id, turnId: next.id })]);
      expect(f.provider.input).toMatchObject({ prompt: expect.stringContaining("Also look at this."), imagePaths: [expect.any(String)] });
      expect(unreadRows(f)).toEqual([]);
      complete(f);
      await f.drain();
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("keeps a waiting unread follow-up out of message search, as the timeline hides it, until it runs as its own turn", async () => {
    const f = await fixture({}, realClock);
    const found = (query: string) => {
      const reader = new Database(join(f.directory, "inertia.sqlite"), { readonly: true });
      try { return searchMessages(reader, query).hits.map(({ messageId, turnId }) => ({ messageId, turnId })); }
      finally { reader.close(); }
    };
    try {
      startRunning(f);
      withSession(f);
      const { steerId, message } = await steer(f, "Unread needle follow-up.");
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(unreadRows(f)).toEqual([expect.objectContaining({ state: "waiting", userMessageId: message.id })]);
      expect(found("Unread needle")).toEqual([]);
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();
      const next = f.store.latestAgentTurnForConversation(f.conversationId)!;
      expect(found("Unread needle")).toEqual([{ messageId: message.id, turnId: next.id }]);
      complete(f);
      await f.drain();
    } finally { await f.close(); }
  });

  it("queues nothing for a stopped turn and holds the row of a failed turn", async () => {
    const stopped = await fixture({}, realClock);
    try {
      startRunning(stopped);
      const { steerId } = await steer(stopped, "Also look at this.");
      expect(stopped.controller.cancel(stopped.conversationId)).toBe(true);
      stopped.provider.resolve({ status: "cancelled", unreadFollowUps: [steerId] });
      await stopped.drain();
      expect(rows(stopped)).toEqual([]);
    } finally { await stopped.close(); }
    const failed = await fixture({}, realClock);
    try {
      startRunning(failed);
      const { steerId, message } = await steer(failed, "Also look at this.");
      failed.provider.resolve({ status: "failed", unreadFollowUps: [steerId], error: "Claude could not complete the request.",
        failure: { reason: "provider-error", message: "Claude could not complete the request." } });
      await failed.drain();
      expect(unreadRows(failed)).toEqual([expect.objectContaining({ state: "waiting", userMessageId: message.id })]);
      expect(failed.provider.runCount).toBe(1);
    } finally { await failed.close(); }
  });

  it("adopts the message exactly once, also after a crash between claim and commit", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      const [row] = unreadRows(f);
      // The crash: claimed, never committed.
      expect(f.store.queuedMessages.claim(f.conversationId, row!.id)).toBe(true);
      f.compaction.active = false;
      await restart(f);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      expect(f.store.queuedMessages.get(f.conversationId, row!.id)).toMatchObject({ state: "accepted", userMessageId: message.id });
      complete(f);
      await f.drain();
      // The message is now its own turn's prompt, so a second row naming it is refused, not sent.
      const stale = insertStaleRow(f, message.id);
      await f.command("message.queue.send", stale);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, stale)).toMatchObject({ state: "blocked" });
      await restart(f);
      expect(f.provider.runCount).toBe(2);
      expect(messagesWith(f, "Also look at this.")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("keeps the follow-up's place: behind rows queued before it was sent, ahead of rows queued after", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const before = randomUUID();
      await f.command("message.queue.enqueue", before);
      await tick();
      const { steerId, message } = await steer(f, "Also look at this.");
      await tick();
      const after = randomUUID();
      await f.command("message.queue.enqueue", after);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(rows(f).map(({ id, userMessageId }) => userMessageId ?? id)).toEqual([before, message.id, after]);
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      const prompts: string[] = [];
      for (const run of [2, 3, 4]) {
        await vi.waitFor(() => expect(f.provider.runCount).toBe(run));
        await f.drain();
        prompts.push(f.store.message(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId).id);
        complete(f);
      }
      await f.drain();
      expect(prompts).toEqual([f.store.queuedMessages.get(f.conversationId, before)!.userMessageId, message.id,
        f.store.queuedMessages.get(f.conversationId, after)!.userMessageId]);
    } finally { await f.close(); }
  });

  it("keeps a follow-up Claude read late at its send time and its queue place when it is never answered", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const identity = turnControllerTestIdentity(f);
      const before = randomUUID();
      await f.command("message.queue.enqueue", before);
      await tick();
      f.provider.emit({ ...identity, type: "activity", kind: "command", phase: "started", label: "Build", activityId: "build" });
      const { steerId, message } = await steer(f, "Also look at this.");
      await tick();
      f.provider.emit({ ...identity, type: "text", text: "Build answer." });
      // Claude ends its turn on the answer here, before it reads the follow-up; nothing may move the follow-up.
      f.provider.emit({ ...identity, type: "text-boundary" });
      await tick();
      const after = randomUUID();
      await f.command("message.queue.enqueue", after);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(rows(f).map(({ id, userMessageId }) => userMessageId ?? id)).toEqual([before, message.id, after]);
      expect(f.store.message(message.id).createdAt).toBe(message.createdAt);
      expect(unreadRows(f)[0]!.createdAt).toBe(message.createdAt);
    } finally { await f.close(); }
  });

  it.each([
    ["has room for it", 0, "Build answer."],
    [`already holds ${MAX_UNREAD_FOLLOW_UP_ROWS} unread follow-ups`, MAX_UNREAD_FOLLOW_UP_ROWS, null],
  ] as const)("ends the run on the answer before a follow-up Claude never read only when the queue %s", async (_case, stale, terminal) => {
    const f = await fixture({}, realClock);
    try {
      const initial = startRunning(f);
      const identity = turnControllerTestIdentity(f);
      f.provider.emit({ ...identity, type: "text", text: "Build " });
      const { steerId, message } = await steer(f, "Also look at this.");
      f.provider.emit({ ...identity, type: "text", text: "answer." });
      f.provider.emit({ ...identity, type: "text-boundary" });
      for (let index = 0; index < stale; index += 1) insertStaleRow(f, initial.turn.userMessageId);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      // Past the cap the follow-up stays in its turn, delivered and unanswered, so the run has no last reply.
      expect(unreadRows(f).some(({ userMessageId }) => userMessageId === message.id)).toBe(terminal !== null);
      const terminalId = f.store.agentTurn(initial.turn.id).terminalAssistantMessageId;
      expect(terminalId ? f.store.message(terminalId).content : null).toBe(terminal);
    } finally { await f.close(); }
  });

  it("runs the follow-up first as a request, then an idle direct send, also after a failed turn", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      withSession(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      f.provider.resolve({ status: "failed", sessionId: "provider-session", unreadFollowUps: [steerId],
        error: "Claude could not complete the request.", failure: { reason: "provider-error", message: "Claude could not complete the request." } });
      await f.drain();
      expect(f.provider.runCount).toBe(1);
      const requestId = await send(f, "Next request.");
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      expect(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId).toBe(message.id);
      expect(f.provider.input!.prompt).not.toContain("Next request.");
      complete(f);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(3));
      await f.drain();
      expect(f.provider.input!.prompt).toContain("Next request.");
      expect(f.provider.input!.prompt).not.toContain("Also look at this.");
      expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("accepted");
    } finally { await f.close(); }
  });

  it("lets a direct send with context go first without carrying the waiting follow-up as history", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "text", text: "First answer." });
      const { steerId, message } = await steer(f, "Also look at this.");
      f.compaction.active = true;
      f.provider.resolve({ status: "completed", text: "First answer.", unreadFollowUps: [steerId] });
      await f.drain();
      f.compaction.active = false;
      await send(f, "Context request.", { context: {} });
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      // A fresh session restores the chat, but not the follow-up that waits to be its own turn.
      expect(f.provider.input!.prompt).toContain("First task");
      expect(f.provider.input!.prompt).toContain("Context request.");
      expect(f.provider.input!.prompt).not.toContain("Also look at this.");
      complete(f);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(3));
      expect(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId).toBe(message.id);
      expect(f.provider.input!.prompt.split("Also look at this.")).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(["remove", "send now"] as const)("blocks a refused follow-up visibly, and %s clears it without a boot loop", async (action) => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      f.dependencies.isolatedRuns = { has: () => true } as unknown as TurnInteractionCommandDependencies["isolatedRuns"];
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      const [row] = unreadRows(f);
      expect(row).toMatchObject({ state: "blocked", error: expect.stringContaining("read-only review") });
      await restart(f);
      expect(f.provider.runCount).toBe(1);
      f.dependencies.isolatedRuns = { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"];
      await f.command(action === "remove" ? "message.queue.remove" : "message.queue.send", row!.id);
      await f.drain();
      if (action === "remove") {
        expect(rows(f)).toEqual([]);
        expect(f.provider.runCount).toBe(1);
        expect(messagesWith(f, "Also look at this.")).toEqual([expect.objectContaining({ id: message.id })]);
      } else {
        await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
        expect(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId).toBe(message.id);
        complete(f);
        await f.drain();
      }
      await restart(f);
      expect(f.provider.runCount).toBe(action === "remove" ? 1 : 2);
    } finally { await f.close(); }
  });

  it("cancels the row when the turn that dropped the follow-up is rolled back, and sends nothing after a restart", async () => {
    const f = await fixture({}, realClock);
    try {
      const first = startRunning(f);
      complete(f);
      await f.drain();
      const second = f.controller.queue({ conversationId: f.conversationId, content: "Second task" });
      f.controller.start(second.turn.id);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "status", status: "running" });
      const { steerId } = await steer(f, "Also look at this.");
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(unreadRows(f)).toHaveLength(1);
      const deps = { store: f.store, turns: f.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(f.store.conversationWork),
        providers: { resolveModelRoute: f.provider.resolveModelRoute, isRunning: (id: string) => f.provider.isRunning(id),
          nativeConversation: vi.fn(async () => { throw new Error("No native rewind in this fixture."); }) } };
      await rollbackConversationHistory(deps as never, { conversationId: f.conversationId, turnId: first.turn.id,
        source: { actorId: "human", commandId: "rollback-unread", command: { type: "conversation.rollback", requestId: "rollback-unread",
          payload: { conversationId: f.conversationId, turnId: first.turn.id } } } }, new AbortController().signal);
      expect(rows(f)).toEqual([]);
      f.compaction.active = false;
      await restart(f);
      expect(f.provider.runCount).toBe(2);
      // Even a row that escaped the cancellation never moves a rolled-back message.
      const stale = insertStaleRow(f, messagesWith(f, "Also look at this.")[0]!.id);
      await f.command("message.queue.send", stale);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, stale)).toMatchObject({ state: "blocked" });
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("passes the IPC schema with three queued messages plus the follow-up, and refuses Send now on it during a turn", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      for (const _ of [1, 2]) await f.command("message.queue.enqueue", randomUUID());
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      // The follow-up's row waits outside the cap of three.
      await f.command("message.queue.enqueue", randomUUID());
      expect(rows(f)).toHaveLength(4);
      const requestId = randomUUID();
      await f.queue.handler(null as unknown as WebSocket, { type: "message.queue.get", requestId, payload: { conversationId: f.conversationId } });
      const result = queueResult(f, requestId);
      expect(result?.type === "request.result" && messageQueueResultSchema.safeParse(result.result).success).toBe(true);
      // A turn runs while the row waits; steering it would persist a second copy of the message.
      const running = f.controller.queue({ conversationId: f.conversationId, content: "Other task" });
      f.controller.start(running.turn.id);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "status", status: "running" });
      const [row] = unreadRows(f);
      await expect(f.command("message.queue.send", row!.id)).rejects.toThrow("sends as its own turn");
      expect(messagesWith(f, "Also look at this.")).toEqual([expect.objectContaining({ id: message.id })]);
      expect(f.store.queuedMessages.get(f.conversationId, row!.id)?.state).toBe("waiting");
    } finally { await f.close(); }
  });

  it("keeps the follow-up's images when its row is removed", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const media = image();
      const { steerId, message } = await steer(f, "Also look at this.", [media]);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      await f.command("message.queue.remove", unreadRows(f)[0]!.id);
      await f.drain();
      expect(rows(f)).toEqual([]);
      expect(f.store.message(message.id).attachments).toMatchObject([{ id: media.id }]);
      expect(await f.attachments.preview(media.id)).not.toBeNull();
    } finally { await f.close(); }
  });

  it("blocks a follow-up whose chat changed route since its turn, until the user switches back", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      f.store.updateConversation(f.conversationId, { accessMode: "full" });
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      const [row] = unreadRows(f);
      expect(row).toMatchObject({ state: "blocked", error: UNREAD_FOLLOW_UP_ROUTE_CHANGED });
      expect(f.provider.runCount).toBe(1);
      // Send now re-checks the route: still changed, still blocked.
      await f.command("message.queue.send", row!.id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, row!.id)).toMatchObject({ state: "blocked" });
      expect(f.provider.runCount).toBe(1);
      f.store.updateConversation(f.conversationId, { accessMode: "supervised" });
      await f.command("message.queue.send", row!.id);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      expect(f.store.latestAgentTurnForConversation(f.conversationId)).toMatchObject({ userMessageId: message.id, accessMode: "supervised" });
    } finally { await f.close(); }
  });

  it("starts a direct send at once when the queue is full after a failed turn", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId } = await steer(f, "Also look at this.");
      for (const _ of [1, 2, 3]) await f.command("message.queue.enqueue", randomUUID());
      f.provider.resolve({ status: "failed", unreadFollowUps: [steerId], error: "Claude could not complete the request.",
        failure: { reason: "provider-error", message: "Claude could not complete the request." } });
      await f.drain();
      expect(rows(f)).toHaveLength(4);
      await expect(send(f, "Direct request.")).resolves.toEqual(expect.any(String));
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      expect(f.provider.input!.prompt).toContain("Direct request.");
    } finally { await f.close(); }
  });

  it("queues a direct send behind a follow-up whose turn is still starting", async () => {
    const f = await fixture({}, realClock);
    let release = () => undefined as void;
    try {
      startRunning(f);
      const media = image();
      const { steerId, message } = await steer(f, "Also look at this.", [media]);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const resolve = f.attachments.resolve.bind(f.attachments);
      const slow = vi.spyOn(f.attachments, "resolve").mockImplementation(async (id) => { await gate; return resolve(id); });
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await vi.waitFor(() => expect(unreadRows(f)[0]?.state).toBe("dispatching"));
      const sending = send(f, "Direct request.");
      await vi.waitFor(() => expect(rows(f).some(({ content }) => content === "Direct request.")).toBe(true));
      release();
      const requestId = await sending;
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      slow.mockRestore();
      expect(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId).toBe(message.id);
      expect(queueResult(f, requestId)).toMatchObject({ result: { kind: "message.queue" } });
      complete(f);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(3));
      expect(f.provider.input!.prompt).toContain("Direct request.");
    } finally { release(); await f.close(); }
  });

  it.each(["waiting", "starting"] as const)("starts a direct send whose follow-up head fails while %s, instead of leaving it queued in an idle chat", async (phase) => {
    const f = await fixture({}, realClock);
    let release = () => undefined as void;
    try {
      startRunning(f);
      const { steerId } = await steer(f, "Also look at this.", [image()]);
      const gate = new Promise<void>((resolve) => { release = resolve; });
      // The follow-up's image is gone, so its turn cannot start.
      const missing = vi.spyOn(f.attachments, "resolve").mockImplementation(async () => {
        if (phase === "starting") await gate;
        return null;
      });
      if (phase === "waiting") {
        f.provider.resolve({ status: "failed", unreadFollowUps: [steerId], error: "Claude could not complete the request.",
          failure: { reason: "provider-error", message: "Claude could not complete the request." } });
        await f.drain();
        expect(unreadRows(f)[0]?.state).toBe("waiting");
      } else {
        complete(f, { unreadFollowUps: [steerId] });
        await vi.waitFor(() => expect(unreadRows(f)[0]?.state).toBe("dispatching"));
      }
      const sending = send(f, "Direct request.");
      if (phase === "starting") {
        await vi.waitFor(() => expect(rows(f).some(({ content }) => content === "Direct request.")).toBe(true));
        release();
      }
      const requestId = await sending;
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      missing.mockRestore();
      expect(f.provider.input!.prompt).toContain("Direct request.");
      expect(unreadRows(f)).toEqual([expect.objectContaining({ state: "blocked" })]);
      expect(f.store.queuedMessages.get(f.conversationId, requestId)?.state).toBe("accepted");
    } finally { release(); await f.close(); }
  });

  it("credits a follow-up it could not queue past the bound, so it is never hidden", async () => {
    const f = await fixture({}, realClock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const initial = startRunning(f);
      withSession(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      const other = initial.message.id;
      for (let index = 0; index < 64; index += 1) insertStaleRow(f, other);
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      expect(unreadRows(f).some(({ userMessageId }) => userMessageId === message.id)).toBe(false);
      expect(coverage(f, initial.turn)).toContain(message.id);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Too many unread follow-ups"));
    } finally { warn.mockRestore(); await f.close(); }
  });

  it("sends several unread follow-ups one turn each, in order", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const first = await steer(f, "First follow-up.");
      await tick();
      const second = await steer(f, "Second follow-up.");
      complete(f, { unreadFollowUps: [first.steerId, second.steerId] });
      const adopted: string[] = [];
      for (const run of [2, 3]) {
        await vi.waitFor(() => expect(f.provider.runCount).toBe(run));
        await f.drain();
        adopted.push(f.store.latestAgentTurnForConversation(f.conversationId)!.userMessageId);
        expect(f.provider.input!.prompt.includes("Second follow-up.")).toBe(run === 3);
        complete(f);
      }
      await f.drain();
      expect(adopted).toEqual([first.message.id, second.message.id]);
      expect(f.provider.runCount).toBe(3);
    } finally { await f.close(); }
  });
});
