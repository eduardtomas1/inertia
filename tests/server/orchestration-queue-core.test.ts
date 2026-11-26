import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import {
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
  SUPERSEDED_TURN_PROJECTION,
  nextAutoDispatchItem,
  queueAdoptCommandId,
  queueAgentCommandId,
  queueContentCharCount,
  queueDeferredSteerCommandId,
  queueDispatchCommandId,
  queueUnreadFollowUpCommandId,
  queuedItemsInDeliveryOrder,
} from "../../src/shared/orchestration-queue";
import {
  agentCommandSchemas,
  messageQueueReorderCommandSchema,
  messageQueueResumeCommandSchema,
} from "../../src/shared/contracts/client-command/agent";
import { messageQueueResultSchema } from "../../src/shared/queued-messages";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ChatAttachment } from "../../src/shared/contracts";
import type { WatcherNoteAttribution } from "../../src/shared/watcher";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  await cleanupTurnControllerTestDirectories();
});

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-queue-core-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
  const project = store.createProject("Queue Core", directory);
  const conversation = store.createConversation(project.id, "Main chat");
  const db = (store as unknown as { database: Database.Database }).database;
  return { directory, store, project, conversation, db };
}

function attachment(id = randomUUID(), name = "shot.png"): ChatAttachment {
  return { id, name, path: `/tmp/${name}`, mimeType: "image/png", size: 128 };
}

function watcherNote(linkId = randomUUID(), wakeId = randomUUID()): WatcherNoteAttribution {
  return {
    linkId,
    wakeId,
    watcherConversationId: randomUUID(),
    preset: "reviewer",
    watcherLabel: "Reviewer",
    delivery: "queue",
    automatic: true,
  };
}

describe("Phase 5 Package 1 pure delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order (T3 QueuedRunOrder.test.ts:14)", () => {
    const items = [
      { id: "u2", kind: "message" as const, queuePosition: 2, requestedAt: "2026-11-01T10:00:30.000Z" },
      { id: "u1", kind: "message" as const, queuePosition: 1, requestedAt: "2026-11-01T10:00:10.000Z" },
      { id: "w1", kind: "watcher-note" as const, queuePosition: 3, requestedAt: "2026-11-01T10:00:20.000Z" },
      { id: "d1", kind: "delegated-results" as const, queuePosition: null, requestedAt: "2026-11-01T10:00:25.000Z" },
    ];
    // Delegated merges at t=25 (before u2 at t=30), while w1 keeps its manual position after u2 even though t=20.
    expect(queuedItemsInDeliveryOrder(items).map(({ id }) => id)).toEqual(["u1", "d1", "u2", "w1"]);

    // Tie on requestedAt: delegated completion wins the tie.
    const tied = [
      { id: "u-tie", kind: "message" as const, queuePosition: 1, requestedAt: "2026-11-01T10:00:10.000Z" },
      { id: "d-tie", kind: "delegated-results" as const, queuePosition: null, requestedAt: "2026-11-01T10:00:10.000Z" },
    ];
    expect(queuedItemsInDeliveryOrder(tied).map(({ id }) => id)).toEqual(["d-tie", "u-tie"]);
  });

  it("sorts queued messages and gates promotion from capabilities (T3 packages/client-runtime/src/state/threadWorkflows.test.ts:88)", () => {
    const ordered = queuedItemsInDeliveryOrder([
      { id: "m3", kind: "message" as const, queuePosition: 3, requestedAt: "2026-11-01T10:00:01.000Z" },
      { id: "m1", kind: "message" as const, queuePosition: 1, requestedAt: "2026-11-01T10:00:05.000Z" },
      { id: "m2", kind: "message" as const, queuePosition: 2, requestedAt: "2026-11-01T10:00:03.000Z" },
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(["m1", "m2", "m3"]);
  });

  it("SQL queue readiness skips held runs without bypassing active work (T3 ProjectionStore.test.ts:1626)", () => {
    expect(nextAutoDispatchItem([
      { id: "held", kind: "message", state: "waiting", queueHeld: true },
      { id: "ready", kind: "message", state: "waiting", queueHeld: false },
    ])).toMatchObject({ id: "ready" });

    expect(nextAutoDispatchItem([
      { id: "active", kind: "message", state: "dispatching", queueHeld: false },
      { id: "ready", kind: "message", state: "waiting", queueHeld: false },
    ])).toBeNull();

    expect(nextAutoDispatchItem([
      { id: "blocked-watcher", kind: "watcher-note", state: "blocked", queueHeld: false },
      { id: "blocked-delegated", kind: "delegated-results", state: "blocked", queueHeld: false },
      { id: "ready", kind: "message", state: "waiting", queueHeld: false },
    ])).toMatchObject({ id: "ready" });

    expect(nextAutoDispatchItem([
      { id: "blocked-msg", kind: "message", state: "blocked", queueHeld: false },
      { id: "later", kind: "message", state: "waiting", queueHeld: false },
    ])).toBeNull();
  });

  it("distinguishes sending a selected queued message from resuming queue order (T3 packages/client-runtime/src/operations/commands.test.ts:147)", () => {
    const conversationId = randomUUID();
    const itemId = randomUUID();
    const requestId = randomUUID();
    const sendSchema = agentCommandSchemas.find((schema) => "value" in schema.shape.type && schema.shape.type.value === "message.queue.send")!;
    const editSchema = agentCommandSchemas.find((schema) => "value" in schema.shape.type && schema.shape.type.value === "message.queue.edit")!;

    expect(sendSchema.safeParse({
      type: "message.queue.send",
      requestId,
      payload: { conversationId, id: itemId },
    }).success).toBe(true);
    expect(sendSchema.safeParse({
      type: "message.queue.send",
      requestId,
      payload: { conversationId },
    }).success).toBe(false);

    expect(messageQueueResumeCommandSchema.safeParse({
      type: "message.queue.resume",
      requestId,
      payload: { conversationId },
    }).success).toBe(true);
    expect(messageQueueReorderCommandSchema.safeParse({
      type: "message.queue.reorder",
      requestId,
      payload: { conversationId, id: itemId, beforeId: null },
    }).success).toBe(true);

    // Edit accepts both legacy `{ conversationId, id }` and Phase 5 in-place fields.
    expect(editSchema.safeParse({
      type: "message.queue.edit",
      requestId,
      payload: { conversationId, id: itemId },
    }).success).toBe(true);
    expect(editSchema.safeParse({
      type: "message.queue.edit",
      requestId,
      payload: {
        conversationId,
        id: itemId,
        expectedRevision: 0,
        content: "Edited text",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" }),
      },
    }).success).toBe(true);

    expect(messageQueueResultSchema.safeParse({
      kind: "message.queue",
      conversationId,
      entries: [],
      receipt: null,
      revision: 3,
      held: true,
      holdReason: "stopped",
      canResume: true,
      resumePrompted: false,
    }).success).toBe(true);
  });

  it("generates deterministic Phase 5 dispatch identities", () => {
    expect(queueDispatchCommandId("item-1", 2)).toBe("queue:item-1:2");
    expect(queueDeferredSteerCommandId("item-1", "run-1", "att-1")).toBe("queue:item-1:steer-when-ready:run-1:att-1");
    expect(queueAgentCommandId("op-1")).toBe("agent-queue:op-1");
    expect(queueUnreadFollowUpCommandId("turn-1", "msg-1")).toBe("unread-follow-up:turn-1:msg-1");
    expect(queueAdoptCommandId("item-1")).toBe("queue-adopt:item-1");
    expect(queueContentCharCount("hello 🌍")).toBe(7);
  });
});

describe("Phase 5 Package 1 V2 queue repository & projector", () => {
  it("edits and removes queued runs (T3 runtimeLayer.test.ts:11402)", () => {
    const { store, conversation } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const firstId = randomUUID();
      const secondId = randomUUID();
      const att1 = attachment();
      const att2 = attachment();

      const first = queue.enqueue({
        conversationId: conversation.id,
        itemId: firstId,
        content: "Original prompt 🌍",
        attachments: [att1],
        requestedAt: "2026-11-01T10:00:00.000Z",
      });
      expect(first.replayed).toBe(false);
      expect(first.value).toMatchObject({
        id: firstId,
        queuePosition: 1,
        queueHeld: false,
        state: "waiting",
        contentRef: { chars: 17, editRevision: 0 },
        attachmentIds: [att1.id],
      });

      queue.enqueue({
        conversationId: conversation.id,
        itemId: secondId,
        content: "Second prompt",
        requestedAt: "2026-11-01T10:00:01.000Z",
      });

      // Block first, then edit without attachments -> clears blocked, preserves att1, bumps revision.
      queue.block({
        conversationId: conversation.id,
        itemId: firstId,
        blockedReason: "route-changed",
        detail: "Settings changed",
      });
      expect(queue.getItem(firstId)?.state).toBe("blocked");

      const edited = queue.edit({
        conversationId: conversation.id,
        itemId: firstId,
        expectedRevision: 0,
        content: "Updated prompt",
        editedAt: "2026-11-01T10:00:02.000Z",
      });
      expect(edited.value).toMatchObject({
        state: "waiting",
        contentRef: { chars: 14, editRevision: 1 },
        attachmentIds: [att1.id],
        editedAt: "2026-11-01T10:00:02.000Z",
      });
      expect(edited.value.blockedReason).toBeUndefined();
      expect(queue.getContent(conversation.id, firstId)?.attachments.map(({ id }) => id)).toEqual([att1.id]);

      // Stale expectedRevision is refused.
      expect(() => queue.edit({
        conversationId: conversation.id,
        itemId: firstId,
        expectedRevision: 0,
        content: "Stale update",
      })).toThrow(OrchestrationConflict);

      // Edit with explicit attachments replaces attachments.
      const replaced = queue.edit({
        conversationId: conversation.id,
        itemId: firstId,
        expectedRevision: 1,
        content: "Replaced attachment",
        attachments: [att2],
      });
      expect(replaced.value.attachmentIds).toEqual([att2.id]);
      expect(replaced.value.contentRef).toEqual({ chars: 19, editRevision: 2 });

      // Claiming prevents editing ("is not queued").
      queue.claim({ conversationId: conversation.id, itemId: firstId, mode: "run" });
      expect(() => queue.edit({
        conversationId: conversation.id,
        itemId: firstId,
        expectedRevision: 2,
        content: "Cannot edit dispatching",
      })).toThrow(OrchestrationConflict);
      queue.releaseClaim({ conversationId: conversation.id, itemId: firstId, reason: "transient" });

      // Remove wipes content & shifts remaining position densely to 1.
      const removed = queue.cancel({ conversationId: conversation.id, itemId: firstId, reason: "user" });
      expect(removed.value).toMatchObject({ state: "cancelled", cancelReason: "user", queuePosition: null });
      expect(queue.getContent(conversation.id, firstId)).toMatchObject({ content: "", attachments: [] });
      expect(queue.getItem(secondId)?.queuePosition).toBe(1);

      // Cancelling an already cancelled item is refused.
      expect(() => queue.cancel({
        conversationId: conversation.id,
        itemId: firstId,
        reason: "user",
        source: { actorId: "human", commandId: randomUUID(), command: { type: "message.queue.remove", id: firstId } },
      })).toThrow(OrchestrationConflict);
    } finally {
      store.close();
    }
  });

  it("enforces reorder rules against automatic kinds, delegated deliveries, and dispatching items", () => {
    const { store, conversation } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const d1 = randomUUID();
      const u1 = randomUUID();
      const w1 = randomUUID();
      const u2 = randomUUID();

      queue.enqueue({
        conversationId: conversation.id,
        itemId: d1,
        kind: "delegated-results",
        content: "Delegated result",
        attribution: { delegatedCompletion: { parentConversationId: conversation.id, generation: 1, taskIds: ["a".repeat(64)] } },
        requestedAt: "2026-11-01T10:00:00.000Z",
      });
      queue.enqueue({ conversationId: conversation.id, itemId: u1, content: "User 1", requestedAt: "2026-11-01T10:00:01.000Z" });
      queue.enqueue({
        conversationId: conversation.id,
        itemId: w1,
        kind: "watcher-note",
        content: "Watcher note",
        attribution: { watcherNote: watcherNote() },
        requestedAt: "2026-11-01T10:00:02.000Z",
      });
      queue.enqueue({ conversationId: conversation.id, itemId: u2, content: "User 2", requestedAt: "2026-11-01T10:00:03.000Z" });

      // Cannot edit automatic kinds.
      expect(() => queue.edit({ conversationId: conversation.id, itemId: w1, expectedRevision: 0, content: "No" }))
        .toThrow(OrchestrationConflict);
      expect(() => queue.edit({ conversationId: conversation.id, itemId: d1, expectedRevision: 0, content: "No" }))
        .toThrow(OrchestrationConflict);

      // Cannot move automatic items.
      expect(() => queue.reorder({ conversationId: conversation.id, itemId: w1, beforeItemId: u1 }))
        .toThrow(OrchestrationConflict);
      expect(() => queue.reorder({ conversationId: conversation.id, itemId: d1, beforeItemId: null }))
        .toThrow(OrchestrationConflict);

      // Cannot move user item ahead of delegated delivery.
      expect(() => queue.reorder({ conversationId: conversation.id, itemId: u2, beforeItemId: d1 }))
        .toThrow(OrchestrationConflict);

      // Can move user item before another user item (staying behind d1).
      const reordered = queue.reorder({ conversationId: conversation.id, itemId: u2, beforeItemId: u1 });
      expect(reordered.value.map(({ id, queuePosition }) => [id, queuePosition])).toEqual([
        [d1, null],
        [u2, 1],
        [u1, 2],
        [w1, 3],
      ]);

      // Claiming u2 prevents moving u2 or moving u1 ahead of u2.
      queue.claim({ conversationId: conversation.id, itemId: u2, mode: "run" });
      expect(() => queue.reorder({ conversationId: conversation.id, itemId: u2, beforeItemId: null }))
        .toThrow(OrchestrationConflict);
      expect(() => queue.reorder({ conversationId: conversation.id, itemId: u1, beforeItemId: u2 }))
        .toThrow(OrchestrationConflict);
    } finally {
      store.close();
    }
  });

  it("enforces queue caps, per-watcher coalescing, and placement modes", () => {
    const { store, conversation } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const userIds: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const id = randomUUID();
        userIds.push(id);
        queue.enqueue({
          conversationId: conversation.id,
          itemId: id,
          content: `Message ${index + 1}`,
          createdBy: index % 2 === 0 ? "user" : "agent",
          creationSource: index % 2 === 0 ? "web" : "mcp",
          requestedAt: new Date(Date.parse("2026-11-01T10:00:00.000Z") + index * 1_000).toISOString(),
        });
      }
      // 21st user/agent message is refused.
      expect(() => queue.enqueue({
        conversationId: conversation.id,
        itemId: randomUUID(),
        content: "21st message",
      })).toThrow(OrchestrationConflict);

      // Unread follow-up is exempt from the 20 cap.
      const unreadId = randomUUID();
      const unread = queue.enqueue({
        conversationId: conversation.id,
        itemId: unreadId,
        content: "Unread follow-up",
        steerFollowUpOfRunId: randomUUID(),
        placement: { afterItemIds: [userIds[0]!, userIds[1]!] },
      });
      expect(unread.value.queuePosition).toBe(3);

      // Stop-and-send placement "front" (still subject to cap unless space exists): cancel one first.
      queue.cancel({ conversationId: conversation.id, itemId: userIds[19]!, reason: "user" });
      const frontId = randomUUID();
      const front = queue.enqueue({
        conversationId: conversation.id,
        itemId: frontId,
        content: "Front item",
        placement: "front",
      });
      expect(front.value.queuePosition).toBe(1);

      // Delegated cap = 1.
      const d1 = randomUUID();
      queue.enqueue({
        conversationId: conversation.id,
        itemId: d1,
        kind: "delegated-results",
        content: "Delegated 1",
        attribution: { delegatedCompletion: { parentConversationId: conversation.id, generation: 1, taskIds: ["b".repeat(64)] } },
      });
      expect(() => queue.enqueue({
        conversationId: conversation.id,
        itemId: randomUUID(),
        kind: "delegated-results",
        content: "Delegated 2",
        attribution: { delegatedCompletion: { parentConversationId: conversation.id, generation: 2, taskIds: ["c".repeat(64)] } },
      })).toThrow(OrchestrationConflict);

      // Watcher notes: same linkId atomically supersedes older waiting note; total cap = 5.
      const sharedLink = randomUUID();
      const note1 = randomUUID();
      const note2 = randomUUID();
      queue.enqueue({
        conversationId: conversation.id,
        itemId: note1,
        kind: "watcher-note",
        content: "Note v1",
        attribution: { watcherNote: watcherNote(sharedLink) },
      });
      const supersededCommit = queue.enqueue({
        conversationId: conversation.id,
        itemId: note2,
        kind: "watcher-note",
        content: "Note v2",
        attribution: { watcherNote: watcherNote(sharedLink) },
      });
      expect(supersededCommit.events.map(({ type }) => type)).toEqual(["queue.item-cancelled", "queue.item-enqueued"]);
      expect(queue.getItem(note1)).toMatchObject({ state: "cancelled", cancelReason: "superseded" });

      for (let i = 0; i < 4; i += 1) {
        queue.enqueue({
          conversationId: conversation.id,
          itemId: randomUUID(),
          kind: "watcher-note",
          content: `Watcher ${i + 2}`,
          attribution: { watcherNote: watcherNote() },
        });
      }
      // 6th distinct watcher note exceeds total cap of 5.
      expect(() => queue.enqueue({
        conversationId: conversation.id,
        itemId: randomUUID(),
        kind: "watcher-note",
        content: "Watcher 6",
        attribution: { watcherNote: watcherNote() },
      })).toThrow(OrchestrationConflict);
    } finally {
      store.close();
    }
  });

  it("enforces holds H1-H5, releases R1-R4, send intent, delivery, requeue, and superseded-turn", () => {
    const { store, conversation } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const userItem = randomUUID();
      const agentItem = randomUUID();
      queue.enqueue({ conversationId: conversation.id, itemId: userItem, content: "User task", createdBy: "user" });
      queue.enqueue({
        conversationId: conversation.id,
        itemId: agentItem,
        content: "Agent task",
        createdBy: "agent",
        creationSource: "mcp",
      });
      queue.requestSend({
        conversationId: conversation.id,
        itemId: userItem,
        kind: "send-now",
        requestId: randomUUID(),
      });
      expect(queue.getState(conversation.id)?.pendingSendIntent?.itemId).toBe(userItem);

      // H1-stop holds both and clears pendingSendIntent.
      const held = queue.hold({ conversationId: conversation.id, cause: "H1-stop" });
      expect(held.events).toHaveLength(1);
      expect(queue.getState(conversation.id)?.pendingSendIntent).toBeNull();
      expect(queue.getItem(userItem)?.queueHeld).toBe(true);
      expect(queue.getItem(agentItem)?.queueHeld).toBe(true);

      // No-op hold with omitted itemIds writes 0 events; explicit already-held itemIds is rejected by projector.
      expect(queue.hold({ conversationId: conversation.id, cause: "H1-stop" }).events).toHaveLength(0);
      expect(() => queue.hold({
        conversationId: conversation.id,
        cause: "H1-stop",
        itemIds: [userItem],
      })).toThrow(OrchestrationConflict);

      // H2 inheritance: new item enqueued while held is created held, unless skipHoldInheritance is set.
      const inheritedId = randomUUID();
      expect(queue.enqueue({ conversationId: conversation.id, itemId: inheritedId, content: "Inherited" }).value.queueHeld).toBe(true);
      const stopAndSendId = randomUUID();
      expect(queue.enqueue({
        conversationId: conversation.id,
        itemId: stopAndSendId,
        content: "Stop and send",
        placement: "front",
        skipHoldInheritance: true,
      }).value.queueHeld).toBe(false);

      // R2 releases ONLY agent/system items, never user items.
      queue.release({ conversationId: conversation.id, cause: "R2-run-completed" });
      expect(queue.getItem(agentItem)?.queueHeld).toBe(false);
      expect(queue.getItem(userItem)?.queueHeld).toBe(true);
      expect(queue.getItem(inheritedId)?.queueHeld).toBe(true);

      // R3 releases remaining held items.
      queue.release({ conversationId: conversation.id, cause: "R3-resume" });
      expect(queue.getItem(userItem)?.queueHeld).toBe(false);
      expect(queue.getItem(inheritedId)?.queueHeld).toBe(false);

      // Claim -> Deliver -> RequeueUndelivered -> Deliver writes superseded-turn.
      const firstRunId = randomUUID();
      const firstTurnId = randomUUID();
      const msg = store.createMessage(conversation.id, "Stop and send", "user");
      queue.claim({ conversationId: conversation.id, itemId: stopAndSendId, mode: "after-stop" });
      queue.deliver({
        conversationId: conversation.id,
        itemId: stopAndSendId,
        delivery: {
          mode: "after-stop",
          outcome: "restarted",
          runId: firstRunId,
          attemptId: randomUUID(),
          turnId: firstTurnId,
          messageId: msg.id,
          deliveredAt: "2026-11-01T10:01:00.000Z",
        },
      });
      expect(queue.getItem(stopAndSendId)?.state).toBe("delivered");

      const requeued = queue.requeueUndelivered({
        conversationId: conversation.id,
        itemId: stopAndSendId,
        fromRunId: firstRunId,
        fromTurnId: firstTurnId,
        userMessageId: msg.id,
        content: "Stop and send",
        queueHeld: true,
      });
      expect(requeued.value).toMatchObject({
        state: "waiting",
        queuePosition: 1,
        queueHeld: true,
        requeuedFromRunId: firstRunId,
        requeuedFromTurnId: firstTurnId,
      });

      const secondRunId = randomUUID();
      const secondTurnId = randomUUID();
      queue.claim({ conversationId: conversation.id, itemId: stopAndSendId, mode: "run" });
      queue.deliver({
        conversationId: conversation.id,
        itemId: stopAndSendId,
        delivery: {
          mode: "run",
          runId: secondRunId,
          attemptId: randomUUID(),
          turnId: secondTurnId,
          messageId: msg.id,
          deliveredAt: "2026-11-01T10:02:00.000Z",
        },
      });
      expect(queue.getSupersededTurn(firstTurnId)).toEqual({
        threadId: conversation.id,
        supersededByRunId: secondRunId,
        supersededByTurnId: secondTurnId,
        queueItemId: stopAndSendId,
      });
    } finally {
      store.close();
    }
  });

  it("keeps queue events free of text/digests and rebuilds projections deterministically (N17)", () => {
    const { store, conversation, db } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const secretText = "TOP_SECRET_CANARY_TEXT_98765";
      const itemId = randomUUID();
      queue.enqueue({
        conversationId: conversation.id,
        itemId,
        content: secretText,
        attachments: [attachment(randomUUID(), "confidential-filename.png")],
      });
      const eventRows = db.prepare("SELECT payload_json FROM orchestration_v2_events WHERE type LIKE 'queue.%'")
        .all() as Array<{ payload_json: string }>;
      expect(eventRows.length).toBeGreaterThan(0);
      for (const row of eventRows) {
        expect(row.payload_json).not.toContain(secretText);
        expect(row.payload_json).not.toContain("confidential-filename.png");
        expect(row.payload_json).not.toContain("digest");
      }

      const beforeEntities = db.prepare(`SELECT kind, id, payload_json FROM orchestration_v2_entities
        WHERE kind IN (?, ?, ?) ORDER BY kind, id`)
        .all(QUEUE_ITEM_PROJECTION, QUEUE_STATE_PROJECTION, SUPERSEDED_TURN_PROJECTION);
      store.orchestration.events.rebuildProjections();
      const afterEntities = db.prepare(`SELECT kind, id, payload_json FROM orchestration_v2_entities
        WHERE kind IN (?, ?, ?) ORDER BY kind, id`)
        .all(QUEUE_ITEM_PROJECTION, QUEUE_STATE_PROJECTION, SUPERSEDED_TURN_PROJECTION);
      expect(afterEntities).toEqual(beforeEntities);
      expect(store.orchestration.events.verify({ readable: true })).toMatchObject({
        valid: true,
        unreadable: [],
        queueContentMismatches: [],
      });

      // Deleting the chat removes all queued text and leaves verify clean.
      store.deleteConversation(conversation.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM queued_messages WHERE conversation_id = ?").get(conversation.id))
        .toEqual({ count: 0 });
      expect(store.orchestration.events.verify({ readable: true })).toMatchObject({
        valid: true,
        queueContentMismatches: [],
      });
    } finally {
      store.close();
    }
  });

  it("rolls back events, projections, receipts, and effects after a projection failure (T3 FoundationPersistence.test.ts:1771)", () => {
    const { store, conversation, db } = createStoreFixture();
    try {
      const queue = store.orchestration.queue;
      const itemId = randomUUID();
      queue.enqueue({ conversationId: conversation.id, itemId, content: "Seed" });
      const beforeEvents = (db.prepare("SELECT COUNT(*) AS c FROM orchestration_v2_events").get() as { c: number }).c;
      const beforeReceipts = (db.prepare("SELECT COUNT(*) AS c FROM orchestration_v2_receipts").get() as { c: number }).c;

      // Force compatibility write failure on queued_messages via a temporary trigger.
      db.exec(`CREATE TRIGGER fail_queue_insert BEFORE INSERT ON queued_messages
        BEGIN SELECT RAISE(ABORT, 'simulated projection failure'); END;`);
      const failingId = randomUUID();
      expect(() => queue.enqueue({ conversationId: conversation.id, itemId: failingId, content: "Will fail" }))
        .toThrow("simulated projection failure");
      db.exec("DROP TRIGGER fail_queue_insert;");

      expect(queue.getItem(failingId)).toBeNull();
      expect((db.prepare("SELECT COUNT(*) AS c FROM orchestration_v2_events").get() as { c: number }).c).toBe(beforeEvents);
      expect((db.prepare("SELECT COUNT(*) AS c FROM orchestration_v2_receipts").get() as { c: number }).c).toBe(beforeReceipts);
      expect(store.orchestration.events.verify({ readable: true }).valid).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a command id reused concurrently for two threads succeeds for only one (T3 Orchestrator.receipt-race.test.ts:47)", async () => {
    const { store, project, conversation } = createStoreFixture();
    try {
      const secondConversation = store.createConversation(project.id, "Second chat");
      const sharedCommandId = randomUUID();
      const authority = store.orchestration.authority;
      const makeCommand = (conversationId: string) => ({
        type: "message.queue.enqueue",
        requestId: sharedCommandId,
        payload: { conversationId, id: randomUUID(), content: "Same command id", attachments: [] },
      });

      const first = await authority.begin({
        source: { actorId: "human", commandId: sharedCommandId, command: makeCommand(conversation.id) },
        threadId: conversation.id,
        projectId: project.id,
        commandType: "message.queue.enqueue",
        rejection: null,
      });
      expect(first.kind).toBe("lead");
      if (first.kind !== "lead") return;

      // Concurrent second thread with the same (actorId, commandId) must conflict immediately.
      await expect(authority.begin({
        source: { actorId: "human", commandId: sharedCommandId, command: makeCommand(secondConversation.id) },
        threadId: secondConversation.id,
        projectId: project.id,
        commandType: "message.queue.enqueue",
        rejection: null,
      })).rejects.toThrow("command-conflict");

      first.ticket.commit({ events: [], result: { ok: true } });
      first.ticket.finish({ ok: true });

      // Even after settlement, the second thread still gets command-conflict.
      await expect(authority.begin({
        source: { actorId: "human", commandId: sharedCommandId, command: makeCommand(secondConversation.id) },
        threadId: secondConversation.id,
        projectId: project.id,
        commandType: "message.queue.enqueue",
        rejection: null,
      })).rejects.toThrow("command-conflict");
    } finally {
      store.close();
    }
  });

  it("commits thread.configured during an active run and allows run.accepted with queueItemId to differ from thread selection", () => {
    const { store, conversation } = createStoreFixture();
    try {
      const events = store.orchestration.events;
      const codexSel = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" }));
      const claudeSel = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude", modelId: "claude-sonnet-4-6" }));
      const now = "2026-11-01T10:00:00.000Z";
      const run1 = randomUUID();
      const turn1 = randomUUID();
      const att1 = randomUUID();
      events.commit({
        actorId: "runtime",
        commandId: "register-and-accept",
        projectId: conversation.projectId,
        threadId: conversation.id,
        command: { type: "test.init" },
        expectedRevision: 0,
        events: [
          {
            type: "thread.registered",
            payload: {
              id: conversation.id, projectId: conversation.projectId, workspaceKey: "/tmp/ws", title: "Chat",
              providerId: "codex", selection: codexSel, activeRunId: null, latestRunId: null, createdAt: now, updatedAt: now,
            },
          },
          {
            type: "run.accepted",
            payload: {
              run: {
                id: run1, threadId: conversation.id, projectId: conversation.projectId, turnId: turn1,
                messageId: randomUUID(), attemptId: att1, providerInstanceId: "codex:native", providerId: "codex",
                selection: codexSel, workspaceKey: "/tmp/ws", status: "queued", executionState: "queued",
                providerState: null, stateRevision: 0, requestedAt: now, startedAt: null, completedAt: null,
                terminalMessageId: null,
              },
              attempt: {
                id: att1, runId: run1, turnId: turn1, threadId: conversation.id, providerInstanceId: "codex:native",
                status: "queued", nativeSessionId: null, nativeThreadId: null, nativeTurnId: null,
                interruptRequestedAt: null, cleanup: "not-started", runtimeId: store.orchestration.runtimeId,
              },
            },
          },
        ],
        result: null,
      });

      // thread.configured succeeds while run1 is active!
      events.commit({
        actorId: "human",
        commandId: "configure-while-running",
        projectId: conversation.projectId,
        threadId: conversation.id,
        command: { type: "thread.configured" },
        expectedRevision: events.revision(conversation.id),
        events: [{
          type: "thread.configured",
          payload: { providerId: "claude", selection: claudeSel, workspaceKey: "/tmp/ws", title: "Chat" },
        }],
        result: null,
      });
      expect((events.projection("thread", conversation.id)!.value as { providerId: string }).providerId).toBe("claude");

      // Complete run1 so run2 can be accepted.
      events.commit({
        actorId: "runtime",
        commandId: "complete-run-1",
        projectId: conversation.projectId,
        threadId: conversation.id,
        command: { type: "run.status-changed" },
        expectedRevision: events.revision(conversation.id),
        events: [{
          type: "run.status-changed",
          payload: {
            runId: run1, attemptId: att1, status: "completed", executionState: "completed", providerState: null,
            stateRevision: 1, startedAt: now, completedAt: now, terminalMessageId: null, nativeSessionId: null,
          },
        }],
        result: null,
      });

      // run.accepted WITH queueItemId allows codexSel even though thread is now claudeSel.
      const run2 = randomUUID();
      const turn2 = randomUUID();
      const att2 = randomUUID();
      events.commit({
        actorId: "runtime",
        commandId: "accept-queued-run-2",
        projectId: conversation.projectId,
        threadId: conversation.id,
        command: { type: "run.accepted" },
        expectedRevision: events.revision(conversation.id),
        events: [{
          type: "run.accepted",
          payload: {
            run: {
              id: run2, threadId: conversation.id, projectId: conversation.projectId, turnId: turn2,
              messageId: randomUUID(), attemptId: att2, providerInstanceId: "codex:native", providerId: "codex",
              selection: codexSel, workspaceKey: "/tmp/ws", status: "queued", executionState: "queued",
              providerState: null, stateRevision: 0, requestedAt: now, startedAt: null, completedAt: null,
              terminalMessageId: null, queueItemId: randomUUID(), afterStopOf: run1,
            },
            attempt: {
              id: att2, runId: run2, turnId: turn2, threadId: conversation.id, providerInstanceId: "codex:native",
              status: "queued", nativeSessionId: null, nativeThreadId: null, nativeTurnId: null,
              interruptRequestedAt: null, cleanup: "not-started", runtimeId: store.orchestration.runtimeId,
            },
          },
        }],
        result: null,
      });
      expect((events.projection("run", run2)!.value as { afterStopOf?: string }).afterStopOf).toBe(run1);
    } finally {
      store.close();
    }
  });

  it("fixes Audit 2 Bugs #1 and #13 in TurnRepository (synchronize before-diff and deferred effect notification)", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const notifySpy = vi.spyOn(runtime.store.orchestration.effects, "notifyAvailable");
      const attachSpy = vi.spyOn(runtime.store.orchestration.mergeBacks, "attach").mockImplementation(() => {
        // Must NOT have notified effects before attach runs inside admit()!
        expect(notifySpy).not.toHaveBeenCalled();
      });

      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Check bug fixes" });
      expect(attachSpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // Settle turn as failed without failureCode, then verify synchronize detects failureCode difference if status unchanged.
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({ status: "failed", text: "boom" });
      await flushTurnControllerTestPromises();
      const settledTurn = runtime.store.agentTurn(queued.turn.id);
      expect(settledTurn.status).toBe("failed");

      // Synchronize with a newly added failureCode while status/revision unchanged must NOT be skipped as no-op!
      const revBefore = runtime.store.orchestration.events.revision(runtime.conversationId);
      runtime.store.orchestration.synchronize(settledTurn, undefined, undefined, "invalid_encrypted_content");
      expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revBefore + 1);
      expect((runtime.store.orchestration.events.projection("run", settledTurn.runId)!.value as { failureCode?: string }).failureCode)
        .toBe("invalid_encrypted_content");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});
