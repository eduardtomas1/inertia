// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { ChatAttachment, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { RuntimeStore } from "../../src/server/database";
import { queuedIntentDigest } from "../../src/server/persistence/queued-message-repository";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";
import { join } from "node:path";

afterEach(cleanupTurnControllerTestDirectories);
async function fixture() {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const runtime = await createTurnControllerTestRuntime({ onTurnSettled: (turn) => queue?.onTurnSettled(turn) });
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const events: ServerEvent[] = [];
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
    const task = operation(); tasks.add(task); void task.finally(() => tasks.delete(task)); return task;
  } });
  const drain = async () => {
    await flushTurnControllerTestPromises();
    while (tasks.size) await Promise.allSettled([...tasks]);
    await flushTurnControllerTestPromises();
  };
  const command = async (type: "message.queue.enqueue" | "message.queue.send" | "message.queue.remove", id: string, media: ChatAttachment[] = []) => {
    await queue!.handler(null as unknown as WebSocket, {
      type, requestId: randomUUID(), payload: { conversationId: runtime.conversationId, id,
        ...(type === "message.queue.enqueue" ? { content: "Do the next task.", attachments: media } : {}),
      },
    } as ClientCommand);
  };
  return { ...runtime, dependencies, queue, attachments, events, drain, command, abort,
    close: async () => { abort.abort(); await drain(); await runtime.controller.dispose(); await attachments.close(); runtime.store.close(); },
  };
}

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
});
