import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { MessageQueueController } from "../../src/server/runtime/message-queue-controller";
import { createMessageQueueCommandHandler } from "../../src/server/runtime/commands/message-queue-commands";
import type { AgentTurn, MessageSendAcceptance } from "../../src/shared/contracts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-durable-queue-"));
  const workspace = join(directory, "workspace"); await mkdir(workspace);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace);
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = store.createProject("Queue tests", workspace);
  const conversation = store.createConversation(project.id, "Queue");
  const enqueue = (content: string, afterTurnId: string | null = null) => {
    const item = { id: randomUUID(), conversationId: conversation.id, content, afterTurnId };
    store.messageQueue.enqueue(item); return item;
  };
  const createTurn = () => store.beginAgentTurn({
    id: randomUUID(), runId: randomUUID(), conversationId: conversation.id, content: "Work",
    providerId: "codex", harnessId: "codex-app-server", backendProfileId: conversation.modelSelection.backendProfileId,
    model: conversation.modelSelection.modelId, modelAlias: null, reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
    providerSessionBefore: null, usageAtStart: null, configurationRevision: 0, association: "authoritative",
  }).turn;
  const operations: Promise<void>[] = [];
  const dispatch = vi.fn(async (item: { conversationId: string }, accept: (receipt: MessageSendAcceptance) => void) => {
    const turn = createTurn();
    accept({ kind: "message.accepted", conversationId: item.conversationId, turnId: turn.id, userMessageId: turn.userMessageId, disposition: "new-turn" });
  });
  const queue = new MessageQueueController({ store, dispatch,
    isActive: () => false, canDispatch: () => true, changed: vi.fn(), track: (operation) => { operations.push(operation); },
  });
  return { directory, databasePath, workspace, store, conversation, enqueue, createTurn, operations, dispatch, queue };
}

describe("durable message queue", () => {
  it("reconciles an accepted send receipt after queue acknowledgement was interrupted", async () => {
    const { store, enqueue, queue, dispatch, conversation, createTurn } = await fixture();
    const message = enqueue("Accepted once");
    store.messageQueue.claim(conversation.id, message.id, false);
    const turn = createTurn();
    store.messageSendReceipts.begin({ type: "message.send", requestId: message.id,
      payload: { conversationId: conversation.id, content: message.content, attachments: [], activate: false } });
    store.messageSendReceipts.accept(message.id, { type: "request.result", requestId: message.id,
      result: { kind: "message.accepted", conversationId: conversation.id, turnId: turn.id, userMessageId: turn.userMessageId, disposition: "new-turn" } });
    store.messageQueue.recoverInterrupted();
    queue.start();
    expect(store.messageQueue.list(conversation.id)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not fail provider discovery when the queue cannot be read at startup", async () => {
    const { store, queue } = await fixture();
    vi.spyOn(store.messageQueue, "conversationIds").mockImplementation(() => { throw new Error("SQLITE_IOERR"); });
    expect(() => queue.start()).not.toThrow();
  });

  it("isolates a corrupt reconciliation receipt from other chats at startup", async () => {
    const { store, enqueue, queue, dispatch, operations, conversation } = await fixture();
    const uncertain = enqueue("Unknown delivery");
    store.messageQueue.claim(conversation.id, uncertain.id, false);
    store.messageQueue.recoverInterrupted();
    const other = store.createConversation(conversation.projectId, "Other queue");
    store.messageQueue.enqueue({ id: randomUUID(), conversationId: other.id, content: "Independent", afterTurnId: null });
    vi.spyOn(store.messageSendReceipts, "accepted").mockImplementation(() => { throw new Error("corrupt receipt"); });
    dispatch.mockImplementation(async () => { throw new RuntimeRequestError("Test stops before provider dispatch"); });
    expect(() => queue.start()).not.toThrow(); await Promise.all(operations);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].conversationId).toBe(other.id);
    expect(store.messageQueue.list(conversation.id)[0]?.status).toBe("uncertain");
  });

  it("cancels an outbox identity even when removal arrives before enqueue", async () => {
    const { store, conversation } = await fixture();
    const id = randomUUID();
    store.messageQueue.remove(conversation.id, id);
    expect(() => store.messageQueue.enqueue({ id, conversationId: conversation.id, content: "Delayed enqueue", afterTurnId: null })).toThrow("different content");
    expect(store.messageQueue.list(conversation.id)).toEqual([]);
  });
  it("dispatches without a mounted renderer and chains the next prompt to the admitted turn", async () => {
    const { store, enqueue, queue, operations, dispatch, conversation } = await fixture();
    const first = enqueue("First"); const second = enqueue("Second");
    queue.start(); await Promise.all(operations);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const latest = store.latestAgentTurnForConversation(conversation.id)!;
    expect(store.messageQueue.list(conversation.id)).toEqual([expect.objectContaining({ id: second.id, afterTurnId: latest.id, status: "queued" })]);
    // A duplicate renderer enqueue and Send now cannot execute an acknowledged queue ID again.
    store.messageQueue.enqueue(first); await queue.send(conversation.id, first.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    store.updateAgentTurnLifecycle(latest.id, { status: "completed", updatedAt: new Date().toISOString() });
    queue.onTurnSettled({ ...latest, status: "completed" }); await Promise.all(operations);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.messageQueue.list(conversation.id)).toEqual([]);
  });

  it("keeps interrupted dispatches visible and never retries them after restart", async () => {
    const { store, enqueue, databasePath, workspace, conversation } = await fixture();
    const first = enqueue("May have reached the provider");
    store.messageQueue.claim(conversation.id, first.id, false);
    store.close();
    const reopened = new RuntimeStore(databasePath, workspace);
    try {
      const dispatch = vi.fn(); const operations: Promise<void>[] = [];
      const queue = new MessageQueueController({ store: reopened, isActive: () => false, canDispatch: () => true,
        changed: vi.fn(), dispatch, track: (operation) => { operations.push(operation); },
      });
      queue.start(); await queue.send(conversation.id, first.id); await Promise.all(operations);
      expect(dispatch).not.toHaveBeenCalled();
      expect(reopened.messageQueue.list(conversation.id)).toEqual([expect.objectContaining({ id: first.id, status: "uncertain" })]);
    } finally { reopened.close(); }
  });

  it("distinguishes rejected delivery from ambiguous delivery and requires explicit retry", async () => {
    const { store, enqueue, queue, operations, dispatch, conversation } = await fixture();
    const item = enqueue("Try once");
    dispatch.mockRejectedValueOnce(new RuntimeRequestError("Provider unavailable"));
    queue.start(); await Promise.all(operations);
    expect(store.messageQueue.list(conversation.id)[0]?.status).toBe("rejected");
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockRejectedValueOnce(new RuntimeRequestError("Accepted but save failed", undefined, "ambiguous"));
    await queue.send(conversation.id, item.id);
    expect(store.messageQueue.list(conversation.id)[0]?.status).toBe("uncertain");
    await queue.send(conversation.id, item.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("preserves an accepted receipt even if publication subsequently fails", async () => {
    const { store, enqueue, queue, dispatch, conversation, createTurn } = await fixture();
    const item = enqueue("Accepted once");
    dispatch.mockImplementationOnce(async (_, accepted) => {
      const turn = createTurn();
      accepted({ kind: "message.accepted", conversationId: conversation.id, turnId: turn.id, userMessageId: turn.userMessageId, disposition: "new-turn" });
      throw new Error("publication failed");
    });
    await queue.send(conversation.id, item.id);
    store.messageQueue.enqueue(item); await queue.send(conversation.id, item.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.messageQueue.list(conversation.id)).toEqual([]);
  });

  it("supports bounded FIFO reordering, pause, removal, and rejects identity reuse", async () => {
    const { store, enqueue, queue, operations, dispatch, conversation } = await fixture();
    const first = enqueue("First"); const second = enqueue("Second"); enqueue("Third");
    expect(() => enqueue("Fourth")).toThrow("queue is full");
    expect(() => store.messageQueue.enqueue({ ...first, content: "Different" })).toThrow("different content");
    store.messageQueue.move(conversation.id, second.id, "up");
    store.messageQueue.pause(conversation.id, second.id, true);
    queue.start(); await Promise.all(operations); expect(dispatch).not.toHaveBeenCalled();
    store.messageQueue.remove(conversation.id, second.id);
    store.messageQueue.enqueue(second);
    expect(store.messageQueue.list(conversation.id).map((item) => item.id)).not.toContain(second.id);
    expect(store.messageQueue.list(conversation.id)[0]?.id).toBe(first.id);
  });

  it("does not dispatch after failure, while archived, or with obsolete turn authority", async () => {
    const { store, enqueue, createTurn, queue, operations, dispatch, conversation } = await fixture();
    const turn = createTurn(); const item = enqueue("Wait for success", turn.id);
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", updatedAt: new Date().toISOString() });
    queue.onTurnSettled({ ...turn, status: "failed" } as AgentTurn); queue.start();
    expect(dispatch).not.toHaveBeenCalled();
    store.messageQueue.remove(conversation.id, item.id);
    const completed = createTurn();
    store.updateAgentTurnLifecycle(completed.id, { status: "completed", updatedAt: new Date().toISOString() });
    enqueue("After success", completed.id);
    store.archiveConversation(conversation.id, true); queue.start();
    expect(dispatch).not.toHaveBeenCalled();
    store.archiveConversation(conversation.id, false);
    createTurn(); queue.start(); await Promise.all(operations);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("projects the queue on exact-conversation details and command results", async () => {
    const { store, queue, conversation, createTurn } = await fixture();
    createTurn();
    const send = vi.fn();
    const handler = createMessageQueueCommandHandler({ store, queue, changed: vi.fn(), send });
    const payload = { action: "enqueue" as const, conversationId: conversation.id, id: randomUUID(), content: "Persist me", afterTurnId: null };
    await handler({} as never, { type: "message.queue", requestId: randomUUID(), payload });
    expect(store.conversationDetail(conversation.id)?.queuedMessages).toEqual([expect.objectContaining({ id: payload.id, content: "Persist me" })]);
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: expect.objectContaining({ kind: "message.queue", conversationId: conversation.id }) }));
  });

  it("recovers queued drafts paused and in-flight sends uncertain without duplicating an import", async () => {
    const { directory, store, conversation, enqueue } = await fixture();
    enqueue("Review after recovery");
    const inFlight = enqueue("Possibly accepted");
    store.messageQueue.claim(conversation.id, inFlight.id, true);
    const exported = store.exportRecoveryData();
    const target = join(directory, "recovered"); await mkdir(target);
    expect((await store.importRecoveryData(exported, target)).alreadyImported).toBe(false);
    expect((await store.importRecoveryData(exported, target)).alreadyImported).toBe(true);
    const recovered = store.shellSnapshot().conversations.find((entry) => entry.id !== conversation.id)!;
    expect(store.messageQueue.list(recovered.id)).toEqual([
      expect.objectContaining({ content: "Review after recovery", status: "paused" }),
      expect.objectContaining({ content: "Possibly accepted", status: "uncertain" }),
    ]);
  });
});
