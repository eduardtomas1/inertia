import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { DelegatedTaskView } from "../../src/shared/orchestration-delegation";
import { queuedItemsInDeliveryOrder } from "../../src/shared/orchestration-queue";
import { delegatedDeliveryId } from "../../src/server/persistence/queued-message-repository";
import { WATCHER_DELIVERY_DETAIL, cancelStaleWatcherNote } from "../../src/server/runtime/watcher/watcher-delivery";
import { WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import { cleanupTurnControllerTestDirectories } from "../support/turn-controller-runtime";
import { createDelegationFixture, queuedDeliveries } from "../support/delegation-fixture";
import {
  beginStoreTurn,
  createDelegationManagerFixture,
  parsed,
  settleTurnRow,
} from "../support/delegation-manager-fixture";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupWatcherFixtures();
  await cleanupTurnControllerTestDirectories();
});

async function createFinding(
  f: WatcherFixture,
  link: Awaited<ReturnType<WatcherFixture["attach"]>>,
  text: string,
): Promise<string> {
  await f.startWatchedTurn(`Work for ${text}`);
  await f.finishTurn(f.watched.id, "Done.");
  await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
  await vi.waitFor(() => {
    if (!f.provider.runs.has(link.watcherConversationId)) throw new Error("no final pass");
  });
  await f.finishTurn(link.watcherConversationId, text);
  const wake = f.watchers.coordinator.feed(link.id).items[0]!;
  expect(wake.outcome).toBe("finding");
  return wake.wakeId;
}

describe("Phase 5 Package 4: Watcher V2 queue integration", () => {
  it("enqueues watcher notes in FIFO order alongside user items and merges with delegated deliveries by request time", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const wakeId = await createFinding(f, link, "Check null pointer in parser.");
      await f.command("watcher.pause", { linkId: link.id });
      await f.startWatchedTurn("Running turn");

      const userFirstId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: f.watched.id,
        itemId: userFirstId,
        content: "User first",
        requestedAt: "2030-01-01T00:01:00.000Z",
      });

      const watcherDeliveryId = randomUUID();
      const reply = await f.command("watcher.note.deliver", {
        linkId: link.id,
        wakeId,
        mode: "queue",
        deliveryId: watcherDeliveryId,
      });
      expect(reply).toMatchObject({ result: { delivery: { mode: "queue", state: "queued" } } });

      const userAfterId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: f.watched.id,
        itemId: userAfterId,
        content: "User after watcher",
        requestedAt: "2030-01-01T00:05:00.000Z",
      });

      const active = f.store.orchestration.queue.listActive(f.watched.id);
      expect(active.map(({ id, kind, queuePosition }) => ({ id, kind, queuePosition }))).toEqual([
        { id: userFirstId, kind: "message", queuePosition: 1 },
        { id: watcherDeliveryId, kind: "watcher-note", queuePosition: 2 },
        { id: userAfterId, kind: "message", queuePosition: 3 },
      ]);

      const watcherItem = f.store.orchestration.queue.getItem(watcherDeliveryId)!;
      expect(watcherItem).toMatchObject({
        kind: "watcher-note",
        createdBy: "system",
        creationSource: "server",
        followsThreadSelection: true,
      });

      // Delegated delivery requested between userFirst and userAfter merges by request time.
      const delegatedId = randomUUID();
      const merged = queuedItemsInDeliveryOrder([
        ...active,
        {
          id: delegatedId,
          kind: "delegated-results",
          queuePosition: null,
          requestedAt: "2030-01-01T00:02:00.000Z",
        },
      ]);
      expect(merged.map(({ id }) => id)).toEqual([
        userFirstId,
        watcherDeliveryId,
        delegatedId,
        userAfterId,
      ]);
    } finally {
      await f.close();
    }
  });

  it("coalesces per watcher (1 waiting note per linkId) by superseding the prior waiting note atomically", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const firstWakeId = await createFinding(f, link, "First finding.");
      const secondWakeId = await createFinding(f, link, "Second finding.");
      await f.command("watcher.pause", { linkId: link.id });
      await f.startWatchedTurn("Busy");

      const firstId = randomUUID();
      await f.command("watcher.note.deliver", { linkId: link.id, wakeId: firstWakeId, mode: "queue", deliveryId: firstId });
      expect(f.store.orchestration.queue.getItem(firstId)?.state).toBe("waiting");

      const secondId = randomUUID();
      await f.command("watcher.note.deliver", { linkId: link.id, wakeId: secondWakeId, mode: "queue", deliveryId: secondId });

      expect(f.store.orchestration.queue.getItem(firstId)).toMatchObject({
        state: "cancelled",
        cancelReason: "superseded",
      });
      expect(f.store.orchestration.queue.getItem(secondId)).toMatchObject({
        state: "waiting",
        kind: "watcher-note",
      });
      const firstWake = f.store.watcherLinks.getWake(firstWakeId);
      expect(firstWake?.delivery).toMatchObject({
        state: "failed",
        detail: WATCHER_DELIVERY_DETAIL.superseded,
      });
    } finally {
      await f.close();
    }
  });

  it("cancels stale watcher notes with reason 'stale' when detached or reviewed turn rolled back", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const wakeId = await createFinding(f, link, "Finding on turn to detach.");
      await f.command("watcher.pause", { linkId: link.id });
      await f.startWatchedTurn("Busy");

      const deliveryId = randomUUID();
      await f.command("watcher.note.deliver", { linkId: link.id, wakeId, mode: "queue", deliveryId });
      expect(f.store.orchestration.queue.getItem(deliveryId)?.state).toBe("waiting");

      // Detach the watcher link -> note becomes stale.
      await f.command("watcher.detach", { linkId: link.id });
      expect(f.watchers.delivery.cancelIfStale(f.watched.id, deliveryId)).toBe(true);
      expect(f.store.orchestration.queue.getItem(deliveryId)).toMatchObject({
        state: "cancelled",
        cancelReason: "stale",
      });
      expect(f.store.watcherLinks.getWake(wakeId)?.delivery).toMatchObject({
        state: "failed",
      });
      // Re-checking already-cancelled item is a clean no-op.
      expect(cancelStaleWatcherNote(f.store, f.watched.id, deliveryId)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each([
    ["pi", "pi-rpc"],
    ["cursor", "cursor-sdk"],
  ] as const)("allows manifest-driven steering for %s (%s)", async (providerId, harnessId) => {
    const selection = providerNativeModelSelection({ providerId, modelId: "test-model" });
    const f = await createWatcherFixture({
      watchedSelection: { ...selection, harnessId },
    });
    try {
      const link = await f.attach();
      const wakeId = await createFinding(f, link, "Manifest steer finding.");
      await f.command("watcher.pause", { linkId: link.id });
      await f.startWatchedTurn("Busy");

      const reply = await f.command("watcher.note.deliver", {
        linkId: link.id,
        wakeId,
        mode: "steer",
        deliveryId: randomUUID(),
      });
      expect(reply).toMatchObject({ result: { delivery: { mode: "steer", state: "sent" } } });
      expect(f.provider.steerCalls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe("Phase 5 Package 4: Delegation V2 queue events & audit bug fixes", () => {
  it("emits V2 queue.item-enqueued with earliest completion timestamp and withdraws with queue.item-cancelled", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate two");
      const first = fixture.delegate(source, { title: "First" });
      const second = fixture.delegate(source, { title: "Second" });
      await fixture.finish(source);

      await fixture.finish(first.childTurn, { text: "First answer" });
      fixture.delegation.onChildChanged(first.childId);
      const firstFinalizedAt = fixture.delegation.get(first.task.taskId)!.result!.finalizedAt;

      const deliveryId = delegatedDeliveryId(fixture.parentId, 1);
      const queueItem = fixture.runtime.store.orchestration.queue.getItem(deliveryId);
      expect(queueItem).toMatchObject({
        id: deliveryId,
        kind: "delegated-results",
        createdBy: "system",
        creationSource: "server",
        followsThreadSelection: true,
        state: "waiting",
        requestedAt: firstFinalizedAt,
      });

      // Second task merges into generation 1; earliest timestamp remains firstFinalizedAt.
      await fixture.finish(second.childTurn, { text: "Second answer" });
      fixture.delegation.onChildChanged(second.childId);
      expect(queuedDeliveries(fixture)[0]!.createdAt).toBe(firstFinalizedAt);

      // Disposing both tasks withdraws the V2 queue item atomically.
      fixture.delegation.dispose(first.task.taskId, "user-dismiss", "req-1");
      fixture.delegation.dispose(second.task.taskId, "user-dismiss", "req-2");
      expect(fixture.runtime.store.orchestration.queue.getItem(deliveryId)).toMatchObject({
        state: "cancelled",
        cancelReason: "withdrawn",
      });
    } finally {
      fixture.close();
    }
  });

  it("Bug #11: re-planning with generation === null after disarm(setting-off) never collides with an earlier receipt", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const first = fixture.delegate(source, { title: "One" });
      await fixture.finish(source);
      await fixture.finish(first.childTurn, { text: "Done" });
      fixture.delegation.onChildChanged(first.childId);

      // Turn off automatic wakes -> tasks move back to pending, mailbox withdrawn (gen=1).
      fixture.delegation.disarm({
        parentConversationId: fixture.parentId,
        scope: "conversation",
        sourceTurnId: null,
        reason: "setting-off",
        trigger: "off-1",
      });
      expect(queuedDeliveries(fixture)).toEqual([]);

      // Archive parent -> automatic plan disposes pending tasks with result.generation === null.
      fixture.runtime.store.archiveConversation(fixture.parentId, true);
      const plan1 = fixture.delegation.planDelivery(fixture.parentId, "automatic");
      expect(plan1.generation).toBeNull();
      expect(plan1.disposed).toContain(first.task.taskId);
      expect(fixture.delegation.get(first.task.taskId)!.delivery.state).toBe("disposed");

      // Re-open, add a second task, disarm setting-off again, archive again -> must NOT collide!
      fixture.runtime.store.archiveConversation(fixture.parentId, false);
      const second = fixture.delegate(source, { title: "Two" });
      await fixture.finish(second.childTurn, { text: "Done 2" });
      fixture.delegation.onChildChanged(second.childId);
      fixture.delegation.disarm({
        parentConversationId: fixture.parentId,
        scope: "conversation",
        sourceTurnId: null,
        reason: "setting-off",
        trigger: "off-2",
      });
      fixture.runtime.store.archiveConversation(fixture.parentId, true);
      const plan2 = fixture.delegation.planDelivery(fixture.parentId, "automatic");
      expect(plan2.generation).toBeNull();
      expect(plan2.disposed).toContain(second.task.taskId);
      expect(fixture.delegation.get(second.task.taskId)!.delivery.state).toBe("disposed");
    } finally {
      fixture.close();
    }
  });

  it("Bug #9: delegation-reads reads queue-item.delivery.turnId via mailbox.deliveryId and rebuildIndex paginates mailboxes", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const first = fixture.delegate(source, { title: "Alpha" });
      await fixture.finish(source);
      await fixture.finish(first.childTurn, { text: "Alpha done" });
      fixture.delegation.onChildChanged(first.childId);

      const wake = fixture.wake(fixture.parentId, 1);
      fixture.delegation.markDispatched(fixture.parentId, 1, wake.id);

      // Even if legacy messages/queued_messages columns are wiped, V2 queue-item.delivery.turnId answers wakeTurnId & wakeGeneration.
      fixture.database.prepare("UPDATE messages SET delegated_completion_json = NULL WHERE conversation_id = ?")
        .run(fixture.parentId);
      fixture.database.prepare("UPDATE queued_messages SET turn_id = NULL WHERE conversation_id = ?")
        .run(fixture.parentId);

      expect(fixture.delegation.reads.wakeTurnId(fixture.parentId, 1)).toBe(wake.id);
      const turnRow = fixture.delegation.reads.turn(wake.id)!;
      expect(fixture.delegation.reads.wakeGeneration(fixture.parentId, turnRow)).toBe(1);

      const rebuilt = fixture.delegation.rebuildIndex();
      expect(rebuilt.tasks).toBeGreaterThanOrEqual(1);
    } finally {
      fixture.close();
    }
  });

  it("D.7 Stop attribution: DelegationTaskService.cancel writes run-control.interrupt-recorded via requestAgentStop", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", {
        task: "Inspect cache invalidation.",
        title: "Cache check",
      }));
      // Admit a V2-tracked child turn attached to the task so runControl tracks the active run.
      f.active.delete(view.conversationId);
      settleTurnRow(f.store, f.database, view.firstTurnId, "completed", "Initial step");
      const tracked = beginStoreTurn(f.store, view.conversationId, "Continue cache check", {}, { admit: true }).turn;
      f.store.orchestration.delegation.attach(view.taskId, tracked.id, "send");
      f.active.set(view.conversationId, { turnId: tracked.id, runId: tracked.runId });

      const target = f.service.prepareCancel(f.source.id, view.taskId);
      expect(target.identity).toEqual({ turnId: tracked.id, runId: tracked.runId });
      await f.service.cancel(target, "op-agent-cancel");
      await f.drain();

      const interruptEvents = f.database.prepare(
        "SELECT payload_json FROM orchestration_v2_events WHERE thread_id = ? AND type = 'run-control.interrupt-recorded'",
      ).all(view.conversationId) as Array<{ payload_json: string }>;
      expect(interruptEvents).toHaveLength(1);
      const payload = JSON.parse(interruptEvents[0]!.payload_json) as { cause?: string; expectedTurnId?: string };
      expect(payload.cause).toBe("agent");
      expect(payload.expectedTurnId).toBe(tracked.id);
    } finally {
      await f.close();
    }
  });

  it("prepareCancel allows cancelling a delegated task with queued-only / held work on its child chat after Stop", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", {
        task: "Refactor module.",
        title: "Refactor",
      }));
      // Simulate child turn stopped, leaving a held queued item on the child chat.
      f.active.delete(view.conversationId);
      const queuedItemId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: view.conversationId,
        itemId: queuedItemId,
        content: "Queued follow-up",
        createdBy: "agent",
        creationSource: "mcp",
        queueHeld: true,
      });

      const target = f.service.prepareCancel(f.source.id, view.taskId);
      expect(target.task.taskId).toBe(view.taskId);
      const cancelled = await f.service.cancel(target, "op-cancel-held");
      expect(cancelled).toEqual({ taskId: view.taskId, status: "cancel_requested" });
      expect(f.store.orchestration.queue.getItem(queuedItemId)).toMatchObject({
        state: "cancelled",
        cancelReason: "withdrawn",
      });
    } finally {
      await f.close();
    }
  });

  it("Bug #11: schedules bounded retry on transient offerDelegated failure instead of swallowing silently", async () => {
    const f = await createDelegationManagerFixture();
    try {
      let attempts = 0;
      const RetryServiceCtor = f.service.constructor as new (options: Record<string, unknown>) => typeof f.service;
      const retryService = new RetryServiceCtor({
        store: f.store,
        turns: f.turns as never,
        interactions: { approvals: f.approvals, inputs: f.inputs },
        offerRetryDelayMs: () => 5,
        queue: () => ({
          offerDelegated: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("transient bus error");
          },
          sendDelegated: async () => undefined,
        }),
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", {
        task: "Check retry.",
        title: "Retry check",
      }));
      f.active.delete(view.conversationId);
      settleTurnRow(f.store, f.database, view.firstTurnId, "completed", "Done!");
      await retryService.onTurnSettled(f.store.agentTurn(view.firstTurnId));

      await vi.waitFor(() => {
        expect(attempts).toBe(3);
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
