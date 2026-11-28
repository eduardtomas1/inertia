// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { ChatAttachment, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { isItemCovered } from "../../src/server/orchestration-v2/backing-repository";
import { createQueuedMessageRuntime, QUEUED_DOCUMENTS_WAIT_FOR_TURN_END, UNREAD_FOLLOW_UP_ROUTE_CHANGED } from "../../src/server/runtime/queued-message-runtime";
import { MAX_QUEUED_USER_AND_AGENT_ITEMS, MAX_QUEUED_WATCHER_NOTES } from "../../src/shared/orchestration-queue";
import { QUEUED_ROUTE_CHANGED_ERROR } from "../../src/shared/queued-messages";
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
import {
  continuationIdentityForSelection,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import { hold, release } from "../../src/server/runtime/update-hold";
import { createTurnInteractionCommandHandler } from "../../src/server/runtime/commands/turn-interaction-commands";
import { requestAgentStop } from "../../src/server/runtime/commands/agent-stop-command";
import { NATIVE_RESUME_TEXT, PROMPTED_RESUME_TEXT } from "../../src/server/runtime/queued-message-runtime-helpers";
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

  it("preserves stop-and-send authority across a transient dispatch failure and an update hold", async () => {
    const f = await fixture();
    try {
      const first = startRunning(f);
      const id1 = randomUUID();
      const admission = vi.spyOn(f.controller, "acquireTurnAdmission").mockResolvedValueOnce(null);
      await f.stopAndSend(id1, first.turn.id, "Retry after transient failure");
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id1)?.state).toBe("accepted"));
      await f.drain();
      expect(admission).toHaveBeenCalledTimes(2);
      expect(f.provider.runCount).toBe(2);
      admission.mockRestore();

      const second = f.store.latestAgentTurnForConversation(f.conversationId)!;
      const id2 = randomUUID();
      const cleanup = f.controller.waitForProviderCleanup.bind(f.controller);
      let heldOnce = false;
      const cleanupSpy = vi.spyOn(f.controller, "waitForProviderCleanup").mockImplementation(async (ids, deadline) => {
        const ready = await cleanup(ids, deadline);
        if (!heldOnce && deadline !== undefined) {
          heldOnce = true;
          hold();
        }
        return ready;
      });
      await f.stopAndSend(id2, second.id, "Resume after update hold");
      await vi.waitFor(() => expect(heldOnce).toBe(true));
      cleanupSpy.mockRestore();
      release();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id2)?.state).toBe("accepted"), { timeout: 5_000 });
      await f.drain();
      expect(f.provider.runCount).toBe(3);
    } finally { release(); await f.close(); }
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

  it("holds earlier queued messages (H1-stop) and sends the Stop-and-send item at position 1", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const earlierId = randomUUID();
      await f.command("message.queue.enqueue", earlierId);
      const urgentId = randomUUID();
      await f.stopAndSend(urgentId, initial.turn.id, "Urgent override.");
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, urgentId)?.state).toBe("accepted"));
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
      expect(f.provider.cancelCount).toBe(1);
      expect(f.store.orchestration.queue.getItem(earlierId)?.queueHeld).toBe(true);
      expect(f.store.queuedMessages.get(f.conversationId, earlierId)?.state).toBe("waiting");
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
      vi.spyOn(f.store.orchestration.queue, "enqueue").mockImplementationOnce(() => {
        throw new QueuedMessageLimitError();
      });
      await expect(f.followUp()).rejects.toThrow(`This follow-up did not reach the agent, and this chat already has ${MAX_QUEUED_USER_AND_AGENT_ITEMS} queued messages.`);
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a refused follow-up without queueing it when the queue is full (20 messages)", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      for (let index = 0; index < MAX_QUEUED_USER_AND_AGENT_ITEMS; index += 1) await f.command("message.queue.enqueue", randomUUID());
      f.provider.steerSupported = false;
      await expect(f.followUp("A twenty-first message.")).rejects.toThrow(`already has ${MAX_QUEUED_USER_AND_AGENT_ITEMS} queued messages`);
      expect(f.store.queuedMessages.list(f.conversationId).map(({ content }) => content)).toEqual(Array(MAX_QUEUED_USER_AND_AGENT_ITEMS).fill("Do the next task."));
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
      vi.spyOn(f.store.orchestration.queue, "enqueue").mockImplementationOnce(() => { throw new Error("SQLite unavailable"); });
      await expect(f.command("message.queue.enqueue", randomUUID(), [image])).rejects.toThrow("SQLite unavailable");
      expect(await f.attachments.preview(image.id)).toBeNull();
      expect(f.store.queuedMessages.list(f.conversationId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("blocks automatic and explicit dispatch after the workspace route changes (Decision 4.3)", async () => {
    const f = await fixture();
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "other-worktree") });
      await f.command("message.queue.send", id);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "blocked", error: expect.stringContaining("workspace") });
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
      if (change === "route") f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "changed-worktree") });
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
      f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "other-worktree") });
      await f.command("message.queue.send", first);
      f.store.updateConversation(f.conversationId, { worktreePath: null });
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
      for (let index = 0; index < MAX_QUEUED_USER_AND_AGENT_ITEMS; index += 1) await f.command("message.queue.enqueue", randomUUID());
      vi.spyOn(f.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError(true));
      await expect(f.followUp("A twenty-first message.")).rejects.toMatchObject({
        delivery: "ambiguous",
        message: "The provider did not confirm whether it received this follow-up. Check this chat before retrying.",
      });
      expect(f.store.queuedMessages.list(f.conversationId)).toHaveLength(MAX_QUEUED_USER_AND_AGENT_ITEMS);
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

    it("dispatches in FIFO order with user-authored queued messages and carries its attribution and note instruction", async () => {
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
        expect(f.store.orchestration.queue.listActive(f.conversationId).map(({ id }) => id)).toEqual([noteId, userId]);

        f.provider.resolve({ status: "completed", text: "Done" });
        await f.drain();
        const accepted = f.store.queuedMessages.get(f.conversationId, noteId)!;
        expect(accepted.state).toBe("accepted");
        expect(f.store.queuedMessages.get(f.conversationId, userId)?.state).toBe("waiting");
        expect(f.store.message(accepted.userMessageId!)).toMatchObject({
          content: "Check the Windows path handling.", watcherNote: note,
        });
        expect(f.provider.input?.prompt).toContain("[inertia-watcher-note]");
        expect(f.provider.input?.prompt).toContain("Treat it as review feedback from a colleague");

        f.provider.resolve({ status: "completed", text: "Done again" });
        await f.drain();
        expect(f.store.queuedMessages.get(f.conversationId, userId)?.state).toBe("accepted");
        expect(f.provider.input?.prompt).not.toContain("inertia-watcher-note");
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

    it("names the main chat's full watcher queue (5 distinct watchers)", async () => {
      const f = await fixture();
      try {
        startRunning(f);
        for (let index = 0; index < MAX_QUEUED_WATCHER_NOTES; index += 1) {
          f.queue.enqueueWatcherNote({
            conversationId: f.conversationId,
            id: randomUUID(),
            content: `Finding ${index + 1}.`,
            watcherNote: { ...note, linkId: randomUUID(), wakeId: randomUUID() },
          });
        }
        expect(() => f.queue.enqueueWatcherNote({
          conversationId: f.conversationId, id: randomUUID(), content: "One more finding.", watcherNote: { ...note, linkId: randomUUID(), wakeId: randomUUID() },
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
  const backingFor = (f: QueueFixture, turn: { continuationIdentity: unknown }) => f.store.orchestration.backings.find({
    threadId: f.conversationId, providerId: "codex", workspaceKey: f.workspace, identity: turn.continuationIdentity as never,
  });
  const coversTurnItem = (f: QueueFixture, turn: { runId: string; continuationIdentity: unknown }, messageId: string): boolean => {
    const backing = backingFor(f, turn);
    if (!backing) return false;
    const ordinal = (f.store.orchestration.events.projection("run", turn.runId)?.value as { ordinal?: number } | undefined)?.ordinal ?? null;
    return isItemCovered(backing, messageId, ordinal);
  };
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
      expect(coversTurnItem(f, initial.turn, initial.message.id)).toBe(true);
      expect(coversTurnItem(f, initial.turn, message.id)).toBe(false);

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
      f.store.orchestration.queue.claim({ conversationId: f.conversationId, itemId: row!.id, mode: "run" });
      f.compaction.active = false;
      await restart(f);
      // Phase 5 H5-restart holds active items on boot; explicit resume dispatches once.
      expect(f.store.orchestration.queue.getItem(row!.id)?.queueHeld).toBe(true);
      await f.queue.resume(f.conversationId, randomUUID());
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

  it("blocks a follow-up whose chat changed workspace route since its turn, until the user switches back", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId, message } = await steer(f, "Also look at this.");
      f.compaction.active = true;
      complete(f, { unreadFollowUps: [steerId] });
      await f.drain();
      const originalWorktree = f.store.conversation(f.conversationId).worktreePath;
      f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "other-worktree") });
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
      f.store.updateConversation(f.conversationId, { worktreePath: originalWorktree });
      await f.command("message.queue.send", row!.id);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      expect(f.store.latestAgentTurnForConversation(f.conversationId)).toMatchObject({ userMessageId: message.id, accessMode: "supervised" });
    } finally { await f.close(); }
  });

  it("starts a direct send at once when the queue is full (20 items) after a failed turn", async () => {
    const f = await fixture({}, realClock);
    try {
      startRunning(f);
      const { steerId } = await steer(f, "Also look at this.");
      for (let i = 0; i < MAX_QUEUED_USER_AND_AGENT_ITEMS; i += 1) await f.command("message.queue.enqueue", randomUUID());
      f.provider.resolve({ status: "failed", unreadFollowUps: [steerId], error: "Claude could not complete the request.",
        failure: { reason: "provider-error", message: "Claude could not complete the request." } });
      await f.drain();
      expect(rows(f)).toHaveLength(MAX_QUEUED_USER_AND_AGENT_ITEMS + 1);
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
      expect(coversTurnItem(f, initial.turn, message.id)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Too many unread follow-ups"));
    } finally { warn.mockRestore(); await f.close(); }
  });

  // inertia_send_message's modes (#761) on a child chat with a dropped follow-up waiting in its queue.
  const failWithUnread = async (f: QueueFixture) => {
    startRunning(f);
    withSession(f);
    const { steerId, message } = await steer(f, "Also look at this.");
    f.provider.resolve({ status: "failed", sessionId: "provider-session", unreadFollowUps: [steerId],
      error: "Claude could not complete the request.", failure: { reason: "provider-error", message: "Claude could not complete the request." } });
    await f.drain();
    expect(unreadRows(f)).toEqual([expect.objectContaining({ state: "waiting", userMessageId: message.id })]);
    return message;
  };

  it("keeps a parent's queued messages behind an unread follow-up, which does not count toward the 20-item cap", async () => {
    const f = await fixture({}, realClock);
    try {
      const message = await failWithUnread(f);
      await tick();
      const ids = Array.from({ length: MAX_QUEUED_USER_AND_AGENT_ITEMS }, () => randomUUID());
      for (const [index, id] of ids.entries()) {
        f.queue.enqueueManagedMessage({ conversationId: f.conversationId, id, content: `Managed task ${index + 1}` });
      }
      expect(() => f.queue.enqueueManagedMessage({ conversationId: f.conversationId, id: randomUUID(), content: "Overflow" }))
        .toThrow(QueuedMessageLimitError);
      expect(rows(f).map(({ id, userMessageId }) => userMessageId ?? id)).toEqual([message.id, ...ids]);
      await f.drain();
      // The failed turn holds the queue for the user, as for any queued message.
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
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

describe("messages a parent chat queues for its managed child", () => {
  it("wait in the child's own queue behind the running turn, refuse past 20, and send after the turn completes", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const ids = Array.from({ length: MAX_QUEUED_USER_AND_AGENT_ITEMS }, () => randomUUID());
      for (const [index, id] of ids.entries()) {
        const result = f.queue.enqueueManagedMessage({ conversationId: f.conversationId, id, content: `  Managed task ${index + 1}  ` });
        expect(result.receipt).toMatchObject({ id, state: "waiting", content: `Managed task ${index + 1}` });
        expect(result.entries.map((entry) => entry.id)).toEqual(ids.slice(0, index + 1));
      }
      expect(() => f.queue.enqueueManagedMessage({ conversationId: f.conversationId, id: randomUUID(), content: "Overflow" }))
        .toThrow(QueuedMessageLimitError);
      await f.drain();
      expect(f.provider.runCount).toBe(1);
      f.provider.resolve({ status: "completed", text: "Done" });
      await f.drain();
      expect(f.provider.runCount).toBe(2);
      const receipt = f.store.queuedMessages.get(f.conversationId, ids[0]!)!;
      expect(receipt).toMatchObject({ state: "accepted", turnId: expect.any(String) });
      expect(f.store.message(receipt.userMessageId!).content).toBe("Managed task 1");
      expect(f.store.queuedMessages.list(f.conversationId).map((entry) => entry.id)).toEqual(ids.slice(1));
    } finally { await f.close(); }
  });
});

describe("editing, re-confirming and documents in the queue", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Access = { interactionMode: "build" | "plan"; accessMode: "supervised" | "auto-edit" | "full" };
  const run = async (f: Fixture, command: ClientCommand) => {
    await f.queue.handler(null as unknown as WebSocket, command);
    const event = queueResult(f, command.requestId);
    return event?.type === "request.result" && event.result.kind === "message.queue" ? event.result : null;
  };
  const edit = (
    f: Fixture,
    id: string,
    content = "Updated queued prompt.",
    expectedRevision = 0,
    attachments?: ChatAttachment[],
  ) => run(f, {
    type: "message.queue.edit",
    requestId: randomUUID(),
    payload: { conversationId: f.conversationId, id, content, expectedRevision, ...(attachments !== undefined ? { attachments } : {}) },
  });
  const reconfirm = (f: Fixture, id: string, confirmed?: Access) => run(f, {
    type: "message.queue.reconfirm", requestId: randomUUID(),
    payload: { conversationId: f.conversationId, id, ...(confirmed ? { confirmed } : {}) },
  });
  const textDocument = () => ({ id: randomUUID(), name: "notes.txt", path: "opaque", mimeType: "text/plain" as const, size: 7 });
  const resolveAsText = (f: Fixture) => {
    f.dependencies.attachmentResolver = {
      resolvePayloads: async (requested: ChatAttachment[]) => requested.map((attachment) => ({ attachment, bytes: Buffer.from("Read me") })),
      releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"];
  };

  it("edits a queued message in place with expectedRevision, updating content and releasing dropped attachments", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      const image = { id: randomUUID(), name: "queued.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.command("message.queue.enqueue", id, [image]); await f.drain();
      const result = await edit(f, id, "Edited task in place.", 0, []);
      expect(result?.receipt).toMatchObject({ id, content: "Edited task in place.", attachments: [], editRevision: 1, state: "waiting" });
      expect(result?.entries).toHaveLength(1);
      expect(await f.attachments.preview(image.id)).toBeNull();
      await expect(edit(f, id, "Stale revision edit.", 0)).rejects.toThrow("changed before your edit");
    } finally { await f.close(); }
  });

  it("keeps an in-place edited message at its slot, and refuses to edit one that is already dispatching", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const edited = randomUUID();
      const claimed = randomUUID();
      await f.command("message.queue.enqueue", edited); await f.drain();
      await f.command("message.queue.enqueue", claimed); await f.drain();
      await edit(f, edited, "Edited first task.", 0);
      f.store.orchestration.queue.claim({ conversationId: f.conversationId, itemId: claimed, mode: "run" });
      await expect(edit(f, claimed, "Cannot edit dispatching.", 0)).rejects.toThrow("already being sent");
      expect(f.store.orchestration.queue.getItem(claimed)?.state).toBe("dispatching");
      f.store.orchestration.queue.releaseClaim({ conversationId: f.conversationId, itemId: claimed, reason: "transient" });
      await edit(f, claimed, "Edited second task.", 0);
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("completed");
      expect(f.provider.runCount).toBe(2);
      expect(f.provider.input?.prompt).toContain("Edited first task.");
    } finally { await f.close(); }
  });

  it("refuses to edit a forwarded watcher note", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      f.queue.enqueueWatcherNote({ conversationId: f.conversationId, id, content: "Check the tests.", watcherNote: {
        linkId: randomUUID(), wakeId: randomUUID(), watcherConversationId: randomUUID(),
        preset: "reviewer", watcherLabel: "Codex · test route", delivery: "queue",
      } });
      await expect(edit(f, id, "Try editing note.", 0)).rejects.toThrow("watcher note");
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
    } finally { await f.close(); }
  });

  it("re-confirms a workspace-route-blocked message and sends it through the queue", async () => {
    const f = await fixture();
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "other-worktree") });
      await f.command("message.queue.send", id);
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "blocked", error: QUEUED_ROUTE_CHANGED_ERROR });
      f.store.updateConversation(f.conversationId, { worktreePath: null });
      const result = await reconfirm(f, id);
      expect(result?.confirmation).toBeUndefined();
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("Decision 4.3: does not block queued dispatch when accessMode widens to full", async () => {
    const f = await fixture();
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.store.updateConversation(f.conversationId, { accessMode: "full" });
      await f.command("message.queue.send", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("Decision 4.3: does not block queued dispatch when leaving Plan for Build", async () => {
    const f = await fixture({}, { interactionMode: "plan" });
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      f.store.updateConversation(f.conversationId, { interactionMode: "build" });
      await f.command("message.queue.send", id);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("refuses to re-confirm a message that is not blocked on a settings change", async () => {
    const f = await fixture();
    try {
      const id = randomUUID(); await f.command("message.queue.enqueue", id); await f.drain();
      await expect(reconfirm(f, id)).rejects.toThrow("not waiting on a settings change");
      f.store.queuedMessages.block(f.conversationId, id, "The agent received this message, but Inertia could not record it.");
      await expect(reconfirm(f, id)).rejects.toThrow("not waiting on a settings change");
      expect(f.provider.runCount).toBe(0);
    } finally { await f.close(); }
  });

  it("queues documents and sends them with the next turn", async () => {
    const f = await fixture();
    try {
      resolveAsText(f);
      startRunning(f);
      const id = randomUUID();
      const document = textDocument();
      await f.command("message.queue.enqueue", id, [document]); await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({ state: "waiting", attachments: [{ id: document.id, mimeType: "text/plain" }] });
      f.provider.resolve({ status: "completed" }); await f.drain();
      const receipt = f.store.queuedMessages.get(f.conversationId, id)!;
      expect(receipt.state).toBe("accepted");
      expect(f.provider.runCount).toBe(2);
      expect(f.store.message(receipt.userMessageId!).attachments).toMatchObject([{ id: document.id }]);
    } finally { await f.close(); }
  });

  it("refuses to steer a queued document into the running turn and keeps it for the next turn", async () => {
    const f = await fixture();
    try {
      resolveAsText(f);
      startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id, [textDocument()]); await f.drain();
      const steer = vi.spyOn(f.provider, "steer");
      await expect(f.command("message.queue.send", id)).rejects.toThrow(QUEUED_DOCUMENTS_WAIT_FOR_TURN_END);
      expect(steer).not.toHaveBeenCalled();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      f.provider.resolve({ status: "completed" }); await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
    } finally { await f.close(); }
  });

  it("preserves explicit manual send when sendDuringTurn races with a failed turn end", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      const steerSpy = vi.spyOn(f.controller, "steer").mockImplementationOnce(async () => {
        f.provider.resolve({ status: "failed", error: "provider crashed" });
        await flushTurnControllerTestPromises();
        return { kind: "turn-ended" };
      });

      await f.command("message.queue.send", id);
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();

      expect(steerSpy).toHaveBeenCalledOnce();
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("preserves stop-and-send override when a concurrent schedule runs while turns.isActive is still true", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      const id = randomUUID();
      const realCleanup = f.controller.waitForProviderCleanup.bind(f.controller);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const cleanupSpy = vi.spyOn(f.controller, "waitForProviderCleanup")
        .mockImplementationOnce(async () => {
          await cleanupGate;
          return true;
        })
        .mockImplementation(realCleanup);

      await f.stopAndSend(id, initial.turn.id, "Must survive intermediate schedule");
      let holdActive = true;
      const realIsActive = f.controller.isActive.bind(f.controller);
      const activeSpy = vi.spyOn(f.controller, "isActive").mockImplementation(
        (conversationId) => holdActive || realIsActive(conversationId),
      );

      // Trigger a concurrent schedule while turns.isActive() still reports true.
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("waiting");
      expect(f.provider.runCount).toBe(1);

      holdActive = false;
      releaseCleanup();
      await vi.waitFor(() => expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted"));
      await f.drain();
      expect(f.provider.runCount).toBe(2);
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
      cleanupSpy.mockRestore();
      activeSpy.mockRestore();
    } finally { await f.close(); }
  });

  it("does not leak background track rejections into foreground message.queue.send or reconfirm", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      f.admission.closed = true;
      await f.command("message.queue.enqueue", id);
      // Immediately send while the background track rejection may still be settling in running.
      f.admission.closed = false;
      await expect(f.command("message.queue.send", id)).resolves.toBeUndefined();
      await f.drain();
      expect(f.store.queuedMessages.get(f.conversationId, id)?.state).toBe("accepted");
      expect(f.provider.runCount).toBe(1);

      const secondId = randomUUID();
      await f.command("message.queue.enqueue", secondId);
      await f.drain();
      f.store.updateConversation(f.conversationId, { worktreePath: join(f.workspace, "other-worktree") });
      f.admission.closed = true;
      f.queue.onCompactionSettled(f.conversationId);
      f.admission.closed = false;
      await expect(f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.reconfirm",
        requestId: randomUUID(),
        payload: {
          conversationId: f.conversationId,
          id: secondId,
        },
      })).resolves.toBe("handled");
    } finally { await f.close(); }
  });
});

describe("Phase 5 sol-loop hardening (S3, S5, S11, S12)", () => {
  it("S3: re-reads edited content, reordered head, and idle Stop (H1) landing during waitForProviderCleanup", async () => {
    const f = await fixture();
    let releaseCleanup!: () => void;
    try {
      const initial = startRunning(f);
      const firstId = randomUUID();
      const secondId = randomUUID();
      await f.command("message.queue.enqueue", firstId);
      await f.command("message.queue.enqueue", secondId);
      await f.drain();

      const realCleanup = f.controller.waitForProviderCleanup.bind(f.controller);
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const cleanupSpy = vi.spyOn(f.controller, "waitForProviderCleanup").mockImplementationOnce(async (ids, deadline) => {
        await cleanupGate;
        return realCleanup(ids, deadline);
      });

      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledOnce());

      // Edit secondId and reorder it ahead of firstId while dispatch awaits cleanup.
      await f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.edit",
        requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id: secondId, expectedRevision: 0, content: "Freshly edited new head." },
      });
      await f.queue.reorder(f.conversationId, secondId, firstId, randomUUID());
      releaseCleanup();

      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();
      cleanupSpy.mockRestore();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("completed");
      expect(f.store.orchestration.queue.getItem(secondId)?.state).toBe("delivered");
      expect(f.provider.input?.prompt).toContain("Freshly edited new head.");
      expect(f.store.orchestration.queue.getItem(firstId)?.state).toBe("waiting");

      // Now test idle Stop landing during waitForProviderCleanup holds firstId and dispatches nothing.
      let releaseSecondCleanup!: () => void;
      const secondGate = new Promise<void>((resolve) => { releaseSecondCleanup = resolve; });
      const secondSpy = vi.spyOn(f.controller, "waitForProviderCleanup").mockImplementationOnce(async (ids, deadline) => {
        await secondGate;
        return realCleanup(ids, deadline);
      });
      f.provider.resolve({ status: "completed" });
      await vi.waitFor(() => expect(secondSpy).toHaveBeenCalledOnce());
      await requestAgentStop(f.dependencies, {
        conversationId: f.conversationId,
        expectedTurnId: null,
        cause: "user",
        source: { actorId: "human", commandId: randomUUID(), command: { type: "agent.stop" } },
        rejection: null,
      });
      releaseSecondCleanup();
      await f.drain();
      secondSpy.mockRestore();
      expect(f.provider.runCount).toBe(2);
      expect(f.store.orchestration.queue.getItem(firstId)).toMatchObject({ state: "waiting", queueHeld: true });
    } finally { releaseCleanup?.(); await f.close(); }
  });

  it("S3: aborts turn admission atomically when Stop holds a dispatching item during preparation and enforces claim ordinal/revision in turn-repository", async () => {
    const f = await fixture();
    let releaseVerify!: () => void;
    try {
      const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
      const verify = vi.fn(() => verifyGate);
      f.dependencies.verifyProviderInstallation = verify;

      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      const sending = f.command("message.queue.send", id);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      expect(f.store.orchestration.queue.getItem(id)?.state).toBe("dispatching");

      // Stop lands mid-preparation: marks the dispatching item queueHeld = true.
      await requestAgentStop(f.dependencies, {
        conversationId: f.conversationId,
        expectedTurnId: null,
        cause: "user",
        source: { actorId: "human", commandId: randomUUID(), command: { type: "agent.stop" } },
        rejection: null,
      });
      releaseVerify();
      await sending;
      await f.drain();

      expect(f.provider.runCount).toBe(0);
      expect(f.store.orchestration.queue.getItem(id)).toMatchObject({ state: "waiting", queueHeld: true });

      // Direct turn-repository SQLite transaction guard rejects mismatched dispatchOrdinal/editRevision.
      f.store.orchestration.queue.release({ conversationId: f.conversationId, cause: "R3-resume", itemIds: [id] });
      f.store.orchestration.queue.claim({ conversationId: f.conversationId, itemId: id, mode: "run" });
      const claimed = f.store.orchestration.queue.getItem(id)!;
      expect(() => f.controller.queue({
        conversationId: f.conversationId,
        content: "Stale ordinal",
        queuedMessageId: id,
        orchestrationRequest: {
          actorId: "runtime",
          commandId: `queue:${id}:${claimed.dispatchOrdinal + 99}`,
          command: { type: "message.send", queuedDispatchOrdinal: claimed.dispatchOrdinal + 99, queuedEditRevision: claimed.contentRef.editRevision },
        },
      })).toThrow(/revision-conflict/u);
      expect(f.store.agentTurnsForConversation(f.conversationId)).toHaveLength(0);
    } finally { releaseVerify?.(); await f.close(); }
  });

  it("S5: Resume continues a stopped native-resume turn first before draining held queued items, and honors deferred resume across compaction & replay", async () => {
    const f = await fixture();
    try {
      const initial = startRunning(f);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "session", sessionId: "native-sess-1" });
      const queuedId = randomUUID();
      await f.command("message.queue.enqueue", queuedId);
      await f.drain();

      // Stop Turn 1 -> holds queuedId with H1-stop; Turn 1 has resumable session on codex-app-server.
      f.provider.resolve({ status: "cancelled", sessionId: "native-sess-1" });
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");
      expect(f.store.orchestration.queue.getItem(queuedId)?.queueHeld).toBe(true);

      // Press Resume while compacting: releases hold, records durable resume intent, defers start.
      f.compaction.active = true;
      const resumeRequestId = randomUUID();
      await f.queue.resume(f.conversationId, resumeRequestId);
      await f.drain();
      expect(f.provider.runCount).toBe(1);
      expect(f.store.orchestration.queue.getItem(queuedId)).toMatchObject({ state: "waiting", queueHeld: false });
      expect(f.store.orchestration.queue.getState(f.conversationId)?.pendingSendIntent).toMatchObject({
        kind: "resume",
        requestId: resumeRequestId,
      });

      // Compaction ends -> automatic drainer honors pending resume and runs NATIVE continuation FIRST!
      f.compaction.active = false;
      f.queue.onCompactionSettled(f.conversationId);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();
      expect(f.provider.input).toMatchObject({
        sessionId: "native-sess-1",
        prompt: expect.stringContaining(NATIVE_RESUME_TEXT),
      });
      expect(f.provider.input?.prompt).not.toContain(PROMPTED_RESUME_TEXT);
      expect(f.store.orchestration.queue.getItem(queuedId)?.state).toBe("waiting");

      // Replaying the same resume requestId does not start a duplicate continuation turn.
      await f.queue.resume(f.conversationId, resumeRequestId);
      expect(f.provider.runCount).toBe(2);

      // Once the continued turn completes, the released queued item drains automatically next!
      f.provider.resolve({ status: "completed", sessionId: "native-sess-1" });
      await vi.waitFor(() => expect(f.provider.runCount).toBe(3));
      await f.drain();
      expect(f.store.orchestration.queue.getItem(queuedId)?.state).toBe("delivered");
      expect(f.provider.input?.prompt).toContain("Do the next task.");
    } finally { await f.close(); }
  });

  it("S11: editInPlaceOperation fails cleanly when attachment prep throws and clears in-flight ticket so retry with same requestId succeeds", async () => {
    const f = await fixture();
    try {
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();
      const image = { id: randomUUID(), name: "expired.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      const retryRequestId = randomUUID();
      const resolveSpy = vi.spyOn(f.dependencies.attachmentResolver!, "resolvePayloads")
        .mockRejectedValueOnce(new Error("Attachment expired."));

      await expect(f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.edit",
        requestId: retryRequestId,
        payload: { conversationId: f.conversationId, id, expectedRevision: 0, content: "Edited with retry", attachments: [image] },
      })).rejects.toThrow("Attachment expired.");
      resolveSpy.mockRestore();

      // Retry with the exact same requestId MUST complete instead of hanging on a stuck ticket!
      await expect(f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.edit",
        requestId: retryRequestId,
        payload: { conversationId: f.conversationId, id, expectedRevision: 0, content: "Edited with retry", attachments: [image] },
      })).resolves.toBe("handled");
      expect(f.store.queuedMessages.get(f.conversationId, id)).toMatchObject({
        content: "Edited with retry",
        editRevision: 1,
        attachments: [expect.objectContaining({ id: image.id })],
      });
    } finally { await f.close(); }
  });

  it("S12: R4 onWorktreeSetupRetried rebinds & releases pre-setup held items on successful recordCreation, ignores rejectCreation, and skips when a newer run exists", async () => {
    const f = await fixture();
    try {
      const firstId = randomUUID();
      await f.command("message.queue.enqueue", firstId);
      await f.drain();

      const rejectedPath = join(f.directory, "worktrees", `rejected-${f.conversationId}`);
      f.store.conversationWorktrees.beginCreation(
        f.conversationId,
        rejectedPath,
        `inertia/rejected-${f.conversationId.slice(0, 8)}`,
        randomUUID(),
      );
      f.queue.onCompactionSettled(f.conversationId);
      await f.drain();
      expect(f.store.orchestration.queue.getItem(firstId)?.queueHeld).toBe(true);
      expect(f.provider.runCount).toBe(0);

      // Still incomplete -> onWorktreeSetupRetried does nothing.
      f.queue.onWorktreeSetupRetried(f.conversationId);
      expect(f.store.orchestration.queue.getItem(firstId)?.queueHeld).toBe(true);

      // Rejecting failed worktree creation does NOT trigger R4 release!
      f.store.conversationWorktrees.rejectCreation(f.conversationId);
      await f.drain();
      expect(f.store.orchestration.queue.getItem(firstId)?.queueHeld).toBe(true);
      expect(f.provider.runCount).toBe(0);

      // Successful worktree preparation: recordCreation transitions worktreePath from null -> createdPath.
      const createdPath = join(f.directory, "worktrees", f.conversationId);
      mkdirSync(createdPath, { recursive: true });
      const createdBranch = `inertia/${f.conversationId.slice(0, 8)}`;
      const ownershipToken = randomUUID();
      f.store.conversationWorktrees.beginCreation(f.conversationId, createdPath, createdBranch, ownershipToken);
      f.store.conversationWorktrees.recordCreation(f.conversationId, createdPath, createdBranch, {
        path: createdPath,
        branch: createdBranch,
        head: "a".repeat(40),
        worktreeId: "wt-1",
        repositoryIdentity: "b".repeat(64),
        ownershipToken,
        filesystemReceipt: {
          version: 1,
          worktreesDirectory: { device: "1", inode: "2", birthtimeNs: "3" },
          adminDirectory: { device: "1", inode: "4", birthtimeNs: "5" },
        },
      });
      expect(f.store.conversation(f.conversationId).worktreePath).toBe(createdPath);

      // onWorktreeSetupRetried rebinds pre-setup held item to createdPath, releases with R4, and dispatches (NOT route-changed)!
      f.queue.onWorktreeSetupRetried(f.conversationId);
      await vi.waitFor(() => expect(f.provider.runCount).toBe(1));
      await f.drain();
      expect(f.store.orchestration.queue.getItem(firstId)?.state).toBe("delivered");
      f.provider.resolve({ status: "completed" });
      await f.drain();

      // Now simulate another hold followed by a newer executed run -> onWorktreeSetupRetried MUST NOT release!
      const secondId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: f.conversationId,
        itemId: secondId,
        content: "Held before newer run",
        queueHeld: true,
      });
      const newerTurn = f.controller.queue({ conversationId: f.conversationId, content: "Newer manual turn" });
      f.controller.start(newerTurn.turn.id);
      f.provider.resolve({ status: "completed" });
      await f.drain();
      expect(f.store.orchestration.queue.getItem(secondId)?.queueHeld).toBe(true);

      f.queue.onWorktreeSetupRetried(f.conversationId);
      await f.drain();
      expect(f.store.orchestration.queue.getItem(secondId)).toMatchObject({ state: "waiting", queueHeld: true });
      expect(f.provider.runCount).toBe(2);
    } finally { await f.close(); }
  });

  it("S3: claims sendDuringTurn BEFORE image resolution so concurrent edits are rejected and steer sends the exact claimed revision", async () => {
    const f = await fixture();
    let releaseResolve!: () => void;
    try {
      startRunning(f);
      const id = randomUUID();
      const image = { id: randomUUID(), name: "snap.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.enqueue",
        requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id, content: "Original image prompt.", attachments: [image] },
      });
      await f.drain();

      const realResolve = f.attachments.resolve.bind(f.attachments);
      const gate = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const resolveSpy = vi.spyOn(f.attachments, "resolve").mockImplementationOnce(async (attachmentId) => {
        await gate;
        return await realResolve(attachmentId);
      });

      const sending = f.command("message.queue.send", id);
      await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledOnce());
      // Claim is already held during image resolution so a concurrent edit MUST be rejected!
      expect(f.store.orchestration.queue.getItem(id)?.state).toBe("dispatching");
      await expect(f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.edit",
        requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id, expectedRevision: 0, content: "Stale concurrent edit." },
      })).rejects.toThrow("already being sent");

      releaseResolve();
      await sending;
      expect(f.provider.steerCalls).toEqual(["Original image prompt."]);
      expect(f.store.orchestration.queue.getItem(id)?.state).toBe("delivered");

      // Clean release if image resolution fails before steer.
      const brokenId = randomUUID();
      const brokenImage = { id: randomUUID(), name: "missing.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.command("message.queue.enqueue", brokenId, [brokenImage]);
      await f.drain();
      vi.spyOn(f.attachments, "resolve").mockResolvedValueOnce(null);
      await expect(f.command("message.queue.send", brokenId)).rejects.toThrow("no longer available");
      expect(f.store.orchestration.queue.getItem(brokenId)?.state).toBe("waiting");
    } finally { releaseResolve?.(); await f.close(); }
  });

  it("S14: explicit message.queue.send on a held head during an active turn releases and steers it, while automatic dispatch keeps held items skipped", async () => {
    const f = await fixture();
    try {
      startRunning(f);
      const heldId = randomUUID();
      const secondHeldId = randomUUID();
      await f.command("message.queue.enqueue", heldId);
      await f.command("message.queue.enqueue", secondHeldId);
      await f.drain();
      f.store.orchestration.queue.hold({ conversationId: f.conversationId, cause: "H1-stop", itemIds: [heldId, secondHeldId] });
      expect(f.store.orchestration.queue.getItem(heldId)?.queueHeld).toBe(true);

      // Explicit Send now on held head during active turn MUST release & steer it (not no-op!).
      await f.command("message.queue.send", heldId);
      expect(f.provider.steerCalls).toEqual(["Do the next task."]);
      expect(f.store.orchestration.queue.getItem(heldId)?.state).toBe("delivered");
      expect(f.store.orchestration.queue.getItem(secondHeldId)).toMatchObject({ state: "waiting", queueHeld: true });

      // Completing the turn does NOT auto-dispatch the remaining held user item!
      f.provider.resolve({ status: "completed" });
      await f.drain();
      expect(f.provider.runCount).toBe(1);
      expect(f.store.orchestration.queue.getItem(secondHeldId)).toMatchObject({ state: "waiting", queueHeld: true });
    } finally { await f.close(); }
  });

  it("S6: sendNow with textOnly rejects without claiming when a desktop edit attaches a file during cleanup wait", async () => {
    const f = await fixture();
    let releaseCleanup!: () => void;
    try {
      const id = randomUUID();
      await f.command("message.queue.enqueue", id);
      await f.drain();

      const realCleanup = f.controller.waitForProviderCleanup.bind(f.controller);
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const cleanupSpy = vi.spyOn(f.controller, "waitForProviderCleanup").mockImplementationOnce(async (ids, deadline) => {
        await cleanupGate;
        return await realCleanup(ids, deadline);
      });

      const sending = f.queue.sendNow(f.conversationId, id, randomUUID(), { textOnly: true });
      await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledOnce());

      // Desktop edit adds an attachment while Private Connect sendNow awaits cleanup.
      const image = { id: randomUUID(), name: "attached-mid-wait.png", path: "opaque", mimeType: "image/png" as const, size: 8 };
      await f.queue.handler(null as unknown as WebSocket, {
        type: "message.queue.edit",
        requestId: randomUUID(),
        payload: { conversationId: f.conversationId, id, expectedRevision: 0, content: "Now with attachment.", attachments: [image] },
      });

      releaseCleanup();
      await expect(sending).rejects.toThrow("Queued messages with attachments cannot be sent from a paired device.");
      await f.drain();
      expect(f.provider.runCount).toBe(0);
      expect(f.store.orchestration.queue.getItem(id)).toMatchObject({ state: "waiting", dispatchOrdinal: 0 });
    } finally { releaseCleanup?.(); await f.close(); }
  });

  it("S5: Resume continues a stopped native-resume turn on its original modelSelection & sessionId even after live composer switches provider", async () => {
    const f = await fixture();
    try {
      const codexInfo = turnControllerTestProviderInfo();
      const claudeInfo = { ...codexInfo, id: "claude" as const, label: "Claude Code", command: "fake-claude", models: [{ ...codexInfo.models[0]!, id: "claude-sonnet-4", label: "Claude Sonnet 4" }] };
      f.dependencies.providerInfo = () => [codexInfo, claudeInfo];
      f.provider.resolveModelRoute = (selection) => {
        const providerId = providerIdForHarness(selection.harnessId) ?? "codex";
        const harnessId = providerNativeHarnessId(providerId);
        const backendProfile = providerNativeBackendProfile(providerId);
        return {
          providerId,
          harnessId,
          backendProfile,
          compatibility: resolveHarnessBackendCompatibility(harnessId, backendProfile),
          continuationIdentity: continuationIdentityForSelection(selection, null, false),
        };
      };

      const initial = startRunning(f);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "session", sessionId: "native-codex-sess-1" });
      f.provider.resolve({ status: "cancelled", sessionId: "native-codex-sess-1" });
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).status).toBe("cancelled");

      // Remove any backing entity for the stopped turn so Resume must carry & validate the saved sessionId explicitly (S5),
      // and verify the stopped turn is never marked superseded (S17).
      f.store.orchestration.effects.connection.prepare(
        "DELETE FROM orchestration_v2_entities WHERE kind = 'provider-backing' AND thread_id = ?",
      ).run(f.conversationId);

      // Switch live composer to Claude BEFORE clicking Resume.
      const claudeSelection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-sonnet-4" });
      f.store.updateConversation(f.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      expect(f.store.conversation(f.conversationId).providerId).toBe("claude");

      await f.queue.resume(f.conversationId, randomUUID());
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();

      // Resumed turn MUST run on Codex with the stopped turn's modelSelection and native sessionId!
      expect(f.provider.input).toMatchObject({
        providerId: "codex",
        model: initial.turn.model,
        sessionId: "native-codex-sess-1",
        prompt: expect.stringContaining(NATIVE_RESUME_TEXT),
      });
      // S17: Cross-provider Resume must NOT mark the stopped turn superseded (would strip it from portable forks).
      const superseded = f.store.orchestration.effects.connection.prepare(
        "SELECT id FROM orchestration_v2_entities WHERE kind = 'superseded-turn' AND thread_id = ?",
      ).all(f.conversationId);
      expect(superseded).toEqual([]);
      // Live composer stays on Claude.
      expect(f.store.conversation(f.conversationId).providerId).toBe("claude");
    } finally { await f.close(); }
  });

  it("S5: Resume on a non-native-resume harness (Pi) whose stopped turn already ran does not send a spurious prompt on empty queue, and dispatches waiting items when present", async () => {
    const piSelection = providerNativeModelSelection({ providerId: "pi", modelId: "provider-default" });
    const f = await fixture({}, {
      modelSelection: piSelection,
      resolveModelRoute: (selection) => {
        const providerId = providerIdForHarness(selection.harnessId) ?? "pi";
        const harnessId = providerNativeHarnessId(providerId);
        const backendProfile = providerNativeBackendProfile(providerId);
        return {
          providerId,
          harnessId,
          backendProfile,
          compatibility: resolveHarnessBackendCompatibility(harnessId, backendProfile),
          continuationIdentity: continuationIdentityForSelection(selection, null, false),
        };
      },
    });
    try {
      const piInfo = { ...turnControllerTestProviderInfo(), id: "pi" as const, label: "Pi", command: "fake-pi" };
      f.dependencies.providerInfo = () => [piInfo];
      const initial = startRunning(f);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "activity", kind: "tool", phase: "started", label: "Read file", activityId: "act-1" });
      f.provider.resolve({ status: "cancelled", text: "Partial work" });
      await f.drain();
      expect(f.store.agentTurn(initial.turn.id).harnessId).toBe("pi-rpc");

      // Empty queue -> Resume MUST NOT send a spurious literal prompt!
      await f.queue.resume(f.conversationId, randomUUID());
      await f.drain();
      expect(f.provider.runCount).toBe(1);

      // With a held waiting item -> Resume releases and dispatches that item directly!
      const waitingId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: f.conversationId,
        itemId: waitingId,
        content: "Next queued task for Pi",
        queueHeld: true,
      });
      await f.queue.resume(f.conversationId, randomUUID());
      await vi.waitFor(() => expect(f.provider.runCount).toBe(2));
      await f.drain();
      expect(f.provider.input?.prompt).toContain("Next queued task for Pi");
      expect(f.provider.input?.prompt).not.toContain(PROMPTED_RESUME_TEXT);
      expect(f.store.orchestration.queue.getItem(waitingId)?.state).toBe("delivered");
    } finally { await f.close(); }
  });
});
