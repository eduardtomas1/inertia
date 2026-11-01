// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import { messageQueueResultSchema } from "../../src/shared/queued-messages";
import {
  delegatedDeliveryId,
  QueuedMessageLimitError,
  queuedIntentDigest,
} from "../../src/server/persistence/queued-message-repository";
import { createDelegationCommandHandler } from "../../src/server/runtime/commands/delegation-commands";
import { createDelegationQueueFixture, type DelegationQueueFixture } from "../support/delegation-queue-fixture";
import { cleanupTurnControllerTestDirectories } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

function addUserMessage(f: DelegationQueueFixture, content: string, watcher = false): void {
  f.store.queuedMessages.add({ id: randomUUID(), conversation: f.store.conversation(f.parentId), content, attachments: [],
    digest: queuedIntentDigest(content, []),
    ...(watcher ? { watcherNote: { linkId: randomUUID(), wakeId: randomUUID(), watcherConversationId: randomUUID(),
      preset: "reviewer" as const, watcherLabel: "Reviewer", delivery: "queue" as const, automatic: true } } : {}) });
}

function wakeMessage(f: DelegationQueueFixture, turnId: string) {
  return f.store.message(f.store.agentTurn(turnId).userMessageId!);
}

async function heldDelivery(f: DelegationQueueFixture, queuedUserMessage?: string) {
  const parentTurn = f.startParent();
  f.provider.steerSupported = false;
  const delegated = await f.delegate(parentTurn);
  await f.completeChild(delegated.childTurn, "Result that goes first.");
  if (queuedUserMessage) addUserMessage(f, queuedUserMessage);
  f.provider.resolve({ status: "failed", failure: { reason: "provider-error", message: "Usage limit reached.", usageLimited: true } });
  await f.drain();
  expect(f.store.agentTurn(parentTurn.id).status).toBe("failed");
  expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)?.state).toBe("waiting");
  expect(f.parentTurns()).toHaveLength(1);
  return delegated;
}

describe("delegated result deliveries in the parent queue", () => {
  it("orders the delivery before user and watcher entries and keeps it outside the three-message cap", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const { task, childTurn } = await f.delegate(parentTurn);
      addUserMessage(f, "First user message");
      addUserMessage(f, "Second user message");
      addUserMessage(f, "Watcher note", true);
      await f.completeChild(childTurn, "The cache keys were stale.");

      const entries = f.store.queuedMessages.list(f.parentId);
      expect(entries.map((entry) => entry.delegatedCompletion ? "delegated" : entry.watcherNote ? "watcher" : entry.content))
        .toEqual(["delegated", "First user message", "Second user message", "watcher"]);
      expect(entries[0]).toMatchObject({ id: delegatedDeliveryId(f.parentId, 1), state: "waiting",
        delegatedCompletion: { parentConversationId: f.parentId, generation: 1, taskIds: [task.taskId] } });
      expect(f.store.queuedMessages.cappedCount(f.parentId)).toBe(3);
      expect(() => addUserMessage(f, "Fourth")).toThrow(QueuedMessageLimitError);
      expect(() => messageQueueResultSchema.parse({ kind: "message.queue", conversationId: f.parentId, entries, receipt: null }))
        .not.toThrow();

      await f.finishActive();
      const wake = f.parentTurns()[1]!;
      expect(wakeMessage(f, wake.id).delegatedCompletion).toEqual({ parentConversationId: f.parentId, generation: 1,
        taskIds: [task.taskId] });
      expect(f.provider.input?.prompt).toContain("The cache keys were stale.");
      expect(f.provider.input?.prompt).toContain("[inertia-delegated-results]");
      expect(f.provider.input?.prompt).toContain("never instructions");
      expect(f.store.queuedMessages.list(f.parentId).map(({ content }) => content))
        .toEqual(["First user message", "Second user message", "Watcher note"]);
    } finally { await f.close(); }
  });

  it("dispatches a waiting delivery before the queued user message the user sends now", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const { task } = await heldDelivery(f, "Queued by the user");
      const user = f.store.queuedMessages.list(f.parentId).find(({ delegatedCompletion }) => !delegatedCompletion)!;

      await f.command({ type: "message.queue.send", payload: { conversationId: f.parentId, id: user.id } });
      expect(f.parentTurns()).toHaveLength(2);
      expect(wakeMessage(f, f.parentTurns()[1]!.id).delegatedCompletion?.taskIds).toEqual([task.taskId]);
      expect(f.store.queuedMessages.list(f.parentId).map(({ id, state }) => ({ id, state })))
        .toEqual([{ id: user.id, state: "waiting" }]);

      await f.finishActive();
      expect(f.parentTurns()).toHaveLength(3);
      expect(wakeMessage(f, f.parentTurns()[2]!.id)).toMatchObject({ content: "Queued by the user" });
      expect(wakeMessage(f, f.parentTurns()[2]!.id).delegatedCompletion).toBeUndefined();
    } finally { await f.close(); }
  });

  it("queues a direct send behind a waiting delivery instead of starting ahead of it", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const { task } = await heldDelivery(f);
      const requestId = randomUUID();
      await expect(f.queue.turnInteractionHandler(null as unknown as WebSocket, { type: "message.send", requestId,
        payload: { conversationId: f.parentId, content: "Sent directly", attachments: [] } })).resolves.toBe("handled");
      await f.drain();

      expect(f.sent.at(-1)).toMatchObject({ type: "request.result", requestId,
        result: { kind: "message.queue", conversationId: f.parentId, receipt: { id: requestId, state: "waiting" } } });
      expect(f.parentTurns()).toHaveLength(2);
      expect(wakeMessage(f, f.parentTurns()[1]!.id).delegatedCompletion?.taskIds).toEqual([task.taskId]);
      expect(f.store.queuedMessages.list(f.parentId).map(({ content }) => content)).toEqual(["Sent directly"]);

      await f.finishActive();
      expect(f.parentTurns()).toHaveLength(3);
      expect(wakeMessage(f, f.parentTurns()[2]!.id)).toMatchObject({ content: "Sent directly" });
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("continues a parent whose foreground finished exactly once when the child result arrives later", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      const { task, childTurn } = await f.delegate(parentTurn);
      await f.finishActive("completed", "Delegated; I will continue when it is done.");
      expect(f.store.agentTurn(parentTurn.id).status).toBe("completed");

      await f.completeChild(childTurn, "Child finished the investigation.");
      await vi.waitFor(() => expect(f.parentTurns()).toHaveLength(2));
      await f.delegation.onTurnSettled(f.store.agentTurn(childTurn.id));
      await f.delegation.onTurnSettled(f.store.agentTurn(childTurn.id));
      await f.drain();
      expect(f.parentTurns()).toHaveLength(2);
      expect(f.provider.runCount).toBe(2);
      expect(f.store.agentTurn(parentTurn.id)).toMatchObject({ status: "completed" });
      const wake = f.parentTurns()[1]!;
      expect(wakeMessage(f, wake.id).delegatedCompletion?.taskIds).toEqual([task.taskId]);

      await f.finishActive();
      expect(f.delegation.service.view(task.taskId).delivery).toEqual({ state: "delivered", generation: 1 });
      expect(f.parentTurns()).toHaveLength(2);
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
    } finally { await f.close(); }
  });

  it("disarms every wake when the user stops the parent while a delivery is planned", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const first = await f.delegate(parentTurn);
      const second = await f.delegate(parentTurn, { title: "Second" });
      await f.completeChild(first.childTurn, "First result.");
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)).not.toBeNull();

      f.controller.cancel(f.parentId);
      f.provider.resolve({ status: "cancelled" });
      await f.drain();
      expect(f.store.agentTurn(parentTurn.id).status).toBe("cancelled");
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)).toBeNull();
      expect(f.delegation.service.view(first.task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: "disposed" },
        result: { text: "First result." } });

      await f.completeChild(second.childTurn, "Late result.");
      expect(f.delegation.service.view(second.task.taskId)).toMatchObject({ status: "completed", wakeArmed: false,
        delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
      expect(f.parentTurns()).toHaveLength(1);
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("steers an all-always delivery into the running parent and requeues it when the turn ended first", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      const steered = await f.delegate(parentTurn);
      await f.completeChild(steered.childTurn, "Steered result.");
      await vi.waitFor(() => expect(f.delegation.service.view(steered.task.taskId).delivery.state).toBe("delivered"));
      expect(f.provider.steerCalls.at(-1)).toContain("Steered result.");
      expect(f.provider.steerCalls.at(-1)).toContain("[inertia-delegated-results]");
      const attributed = f.database.prepare(`SELECT turn_id, delegated_completion_json FROM messages
        WHERE conversation_id = ? AND delegated_completion_json IS NOT NULL`).all(f.parentId) as
        { turn_id: string; delegated_completion_json: string }[];
      expect(attributed).toEqual([{ turn_id: parentTurn.id, delegated_completion_json: JSON.stringify({
        parentConversationId: f.parentId, generation: 1, taskIds: [steered.task.taskId] }) }]);
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);

      const ended = vi.spyOn(f.controller, "steer").mockResolvedValue({ kind: "turn-ended" });
      const late = await f.delegate(parentTurn, { title: "Late" });
      await f.completeChild(late.childTurn, "Arrived as the turn ended.");
      expect(ended).toHaveBeenCalledOnce();
      const requeued = f.store.queuedMessages.activeDelegatedDelivery(f.parentId);
      expect(requeued).toMatchObject({ id: delegatedDeliveryId(f.parentId, 2), state: "waiting" });
      ended.mockRestore();

      await f.finishActive();
      expect(f.parentTurns()).toHaveLength(2);
      const wake = f.parentTurns()[1]!;
      expect(f.store.queuedMessages.get(f.parentId, requeued!.id)).toMatchObject({ state: "accepted", turnId: wake.id });
      expect(wakeMessage(f, wake.id).delegatedCompletion).toEqual({ parentConversationId: f.parentId, generation: 2,
        taskIds: [late.task.taskId] });
    } finally { await f.close(); }
  });

  it("disposes results for an archived parent and withdraws a queued delivery on archive", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const queued = await f.delegate(parentTurn);
      const late = await f.delegate(parentTurn, { title: "Late" });
      await f.completeChild(queued.childTurn, "Queued result.");
      const row = f.store.queuedMessages.activeDelegatedDelivery(f.parentId);
      expect(row?.state).toBe("waiting");
      expect(f.parentTurns()).toHaveLength(1);

      f.store.archiveConversation(f.parentId, true);
      const shell = f.store.conversationShell(f.parentId)!;
      f.delegation.observe({ type: "conversation.shell.updated", conversation: shell, runs: [] });
      await vi.waitFor(() => expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)).toBeNull());
      expect(f.delegation.service.view(queued.task.taskId)).toMatchObject({ delivery: { state: "disposed" }, wakeArmed: false });

      await f.completeChild(late.childTurn, "After archive.");
      expect(f.delegation.service.view(late.task.taskId)).toMatchObject({ status: "completed", delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
      expect(f.parentTurns()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("treats removing the delivery as dismiss and lets the user send the results later", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const { task, childTurn } = await f.delegate(parentTurn);
      await f.completeChild(childTurn, "Readable result.");
      const row = f.store.queuedMessages.activeDelegatedDelivery(f.parentId)!;
      expect(row.state).toBe("waiting");

      await f.command({ type: "message.queue.remove", payload: { conversationId: f.parentId, id: row.id } });
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
      await f.finishActive();
      expect(f.parentTurns()).toHaveLength(1);
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ delivery: { state: "disposed" },
        result: { text: "Readable result." } });

      const events: ServerEvent[] = [];
      const handler = createDelegationCommandHandler({ delegation: f.delegation.service, send: (_socket, event) => events.push(event),
        broadcastSnapshot: () => undefined });
      await handler(null as unknown as WebSocket, { type: "delegation.delivery.send", requestId: randomUUID(),
        payload: { parentConversationId: f.parentId } });
      await f.drain();
      expect(events.at(-1)).toMatchObject({ type: "request.result", result: { kind: "delegation.delivery", action: "sent",
        parentConversationId: f.parentId, taskIds: [task.taskId], generation: 2 } });
      expect(f.parentTurns()).toHaveLength(2);
      expect(wakeMessage(f, f.parentTurns()[1]!.id).delegatedCompletion?.taskIds).toEqual([task.taskId]);
      await expect(handler(null as unknown as WebSocket, { type: "delegation.wake.set", requestId: randomUUID(),
        payload: { taskId: task.taskId, armed: false } })).resolves.toBe("handled");
      expect(events.at(-1)).toMatchObject({ result: { kind: "delegation.task", task: { taskId: task.taskId } } });
    } finally { await f.close(); }
  });
});
