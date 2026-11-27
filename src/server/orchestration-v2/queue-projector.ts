import {
  MAX_QUEUED_DELEGATED_ITEMS,
  MAX_QUEUED_UNREAD_FOLLOW_UPS,
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  MAX_QUEUED_WATCHER_NOTES,
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
  SUPERSEDED_TURN_PROJECTION,
  queueItemProjectionSchema,
  queueStateProjectionSchema,
  supersededTurnProjectionSchema,
  type QueueEnqueuePlacement,
  type QueueEvent,
  type QueueItemProjection,
  type QueueStateProjection,
} from "../../shared/orchestration-queue";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export { QUEUE_ITEM_PROJECTION, QUEUE_STATE_PROJECTION, SUPERSEDED_TURN_PROJECTION };

export function isQueueEvent<T extends { type: string }>(event: T): event is Extract<T, QueueEvent> {
  return event.type.startsWith("queue.");
}

function readState(read: ProjectionReader, envelope: OrchestrationEvent): QueueStateProjection {
  const row = read(QUEUE_STATE_PROJECTION, envelope.threadId);
  if (!row) {
    return {
      threadId: envelope.threadId,
      projectId: envelope.projectId,
      activeItemIds: [],
      pendingSendIntent: null,
      updatedAt: envelope.createdAt,
    };
  }
  if (row.threadId !== envelope.threadId || row.projectId !== envelope.projectId) {
    throw new OrchestrationConflict("scope-conflict");
  }
  return queueStateProjectionSchema.parse(row.value);
}

function readItem(read: ProjectionReader, envelope: OrchestrationEvent, itemId: string): QueueItemProjection {
  const row = read(QUEUE_ITEM_PROJECTION, itemId);
  if (!row || row.threadId !== envelope.threadId || row.projectId !== envelope.projectId) {
    throw new OrchestrationConflict("scope-conflict");
  }
  return queueItemProjectionSchema.parse(row.value);
}

function readActiveItems(
  read: ProjectionReader,
  envelope: OrchestrationEvent,
  activeItemIds: readonly string[],
): Map<string, QueueItemProjection> {
  const items = new Map<string, QueueItemProjection>();
  for (const itemId of activeItemIds) {
    items.set(itemId, readItem(read, envelope, itemId));
  }
  return items;
}

function isUserOrAgentCappedItem(
  item: Pick<QueueItemProjection, "kind" | "steerFollowUpOfRunId" | "requeuedFromRunId">,
): boolean {
  return item.kind === "message"
    && item.steerFollowUpOfRunId === undefined
    && item.requeuedFromRunId === undefined;
}

function insertWithPlacement(
  activeItemIds: readonly string[],
  itemId: string,
  placement: QueueEnqueuePlacement | undefined,
): string[] {
  if (placement === undefined || placement === "end") {
    return [...activeItemIds, itemId];
  }
  if (placement === "front") {
    return [itemId, ...activeItemIds];
  }
  const afterSet = new Set(placement.afterItemIds);
  let insertAt = 0;
  for (let index = 0; index < activeItemIds.length; index += 1) {
    if (afterSet.has(activeItemIds[index]!)) insertAt = index + 1;
  }
  const next = [...activeItemIds];
  next.splice(insertAt, 0, itemId);
  return next;
}

function positionWrites(
  activeItemIds: readonly string[],
  itemsById: Map<string, QueueItemProjection>,
  alwaysWriteIds: ReadonlySet<string>,
): ProjectionWrite[] {
  const writes: ProjectionWrite[] = [];
  let nextPosition = 1;
  for (const itemId of activeItemIds) {
    const item = itemsById.get(itemId);
    if (!item) continue;
    const assigned = item.kind === "delegated-results" ? null : nextPosition++;
    if (assigned !== item.queuePosition || alwaysWriteIds.has(itemId)) {
      const updated = queueItemProjectionSchema.parse({ ...item, queuePosition: assigned });
      itemsById.set(itemId, updated);
      writes.push({ kind: QUEUE_ITEM_PROJECTION, id: itemId, value: updated });
    }
  }
  return writes;
}

function stateWrite(state: QueueStateProjection, envelope: OrchestrationEvent): ProjectionWrite {
  return {
    kind: QUEUE_STATE_PROJECTION,
    id: envelope.threadId,
    value: queueStateProjectionSchema.parse({ ...state, updatedAt: envelope.createdAt }),
  };
}

function withoutBlockedFields(item: QueueItemProjection): QueueItemProjection {
  const { blockedReason: _blockedReason, detail: _detail, ...rest } = item;
  return rest;
}

export function projectQueueEvent(
  event: QueueEvent,
  envelope: OrchestrationEvent,
  read: ProjectionReader,
): ProjectionWrite[] {
  const state = readState(read, envelope);
  switch (event.type) {
    case "queue.item-enqueued": {
      const payload = event.payload;
      if (read(QUEUE_ITEM_PROJECTION, payload.itemId)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      if (payload.kind === "watcher-note" && !(payload.attribution && "watcherNote" in payload.attribution)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      if (payload.kind === "delegated-results"
        && !(payload.attribution && "delegatedCompletion" in payload.attribution)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      if (payload.kind === "message" && payload.attribution !== undefined
        && !("scheduledTask" in payload.attribution) && !("childQuestionWake" in payload.attribution)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      const activeItems = readActiveItems(read, envelope, state.activeItemIds);
      const activeList = [...activeItems.values()];
      if (isUserOrAgentCappedItem(payload)) {
        const cappedCount = activeList.filter(isUserOrAgentCappedItem).length;
        if (cappedCount >= MAX_QUEUED_USER_AND_AGENT_ITEMS) {
          throw new OrchestrationConflict("revision-conflict");
        }
      } else if (payload.kind === "message" && payload.steerFollowUpOfRunId !== undefined) {
        const unreadCount = activeList.filter((item) => item.steerFollowUpOfRunId !== undefined).length;
        if (unreadCount >= MAX_QUEUED_UNREAD_FOLLOW_UPS) {
          throw new OrchestrationConflict("revision-conflict");
        }
      } else if (payload.kind === "delegated-results") {
        const delegatedCount = activeList.filter((item) => item.kind === "delegated-results").length;
        if (delegatedCount >= MAX_QUEUED_DELEGATED_ITEMS) {
          throw new OrchestrationConflict("revision-conflict");
        }
      } else if (payload.kind === "watcher-note") {
        const watcherNotes = activeList.filter((item) => item.kind === "watcher-note");
        if (watcherNotes.length >= MAX_QUEUED_WATCHER_NOTES) {
          throw new OrchestrationConflict("revision-conflict");
        }
        const linkId = (payload.attribution as { watcherNote: { linkId: string } }).watcherNote.linkId;
        const hasWaitingForLink = watcherNotes.some(
          (item) => item.state === "waiting"
            && item.attribution !== undefined
            && "watcherNote" in item.attribution
            && item.attribution.watcherNote.linkId === linkId,
        );
        if (hasWaitingForLink) {
          throw new OrchestrationConflict("revision-conflict");
        }
      }
      const anyHeld = activeList.some((item) => item.queueHeld);
      const queueHeld = payload.queueHeld !== undefined
        ? payload.queueHeld
        : payload.skipHoldInheritance
          ? false
          : anyHeld;
      const initialState = payload.initialState ?? "waiting";
      const created = queueItemProjectionSchema.parse({
        id: payload.itemId,
        threadId: envelope.threadId,
        projectId: envelope.projectId,
        kind: payload.kind,
        userMessageId: payload.userMessageId,
        createdBy: payload.createdBy,
        creationSource: payload.creationSource,
        ...(payload.deviceId !== undefined ? { deviceId: payload.deviceId } : {}),
        ...(payload.steerFollowUpOfRunId !== undefined ? { steerFollowUpOfRunId: payload.steerFollowUpOfRunId } : {}),
        ...(payload.requeuedFromRunId !== undefined ? { requeuedFromRunId: payload.requeuedFromRunId } : {}),
        ...(payload.requeuedFromTurnId !== undefined ? { requeuedFromTurnId: payload.requeuedFromTurnId } : {}),
        contentRef: payload.contentRef,
        attachmentIds: payload.attachmentIds,
        ...(payload.routeIdentity !== undefined ? { routeIdentity: payload.routeIdentity } : {}),
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.followsThreadSelection !== undefined ? { followsThreadSelection: payload.followsThreadSelection } : {}),
        queuePosition: null,
        queueHeld,
        ...(payload.steerWhenReadyRunId !== undefined ? { steerWhenReadyRunId: payload.steerWhenReadyRunId } : {}),
        ...(payload.freshContext !== undefined ? { freshContext: payload.freshContext } : {}),
        ...(payload.bootAutoResend !== undefined ? { bootAutoResend: payload.bootAutoResend } : {}),
        requestedAt: payload.requestedAt,
        editedAt: null,
        state: initialState,
        ...(initialState === "blocked" && payload.blockedReason !== undefined ? { blockedReason: payload.blockedReason } : {}),
        ...(initialState === "blocked" && payload.detail !== undefined ? { detail: payload.detail } : {}),
        dispatchOrdinal: 0,
        ...(payload.attribution !== undefined ? { attribution: payload.attribution } : {}),
      });
      const nextActiveIds = insertWithPlacement(state.activeItemIds, created.id, payload.placement);
      activeItems.set(created.id, created);
      const itemWrites = positionWrites(nextActiveIds, activeItems, new Set([created.id]));
      return [
        ...itemWrites,
        stateWrite({ ...state, activeItemIds: nextActiveIds }, envelope),
      ];
    }

    case "queue.item-edited": {
      const payload = event.payload;
      const item = readItem(read, envelope, payload.itemId);
      if (item.kind !== "message" || (item.state !== "waiting" && item.state !== "blocked")) {
        throw new OrchestrationConflict("revision-conflict");
      }
      if (payload.expectedRevision !== item.contentRef.editRevision
        || payload.contentRef.editRevision !== item.contentRef.editRevision + 1) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const cleared = withoutBlockedFields(item);
      const updated = queueItemProjectionSchema.parse({
        ...cleared,
        contentRef: payload.contentRef,
        attachmentIds: payload.attachmentIds ?? cleared.attachmentIds,
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.routeIdentity !== undefined ? { routeIdentity: payload.routeIdentity } : {}),
        editedAt: payload.editedAt,
        state: "waiting",
      });
      return [
        { kind: QUEUE_ITEM_PROJECTION, id: updated.id, value: updated },
        stateWrite(state, envelope),
      ];
    }

    case "queue.reordered": {
      const { movedItemId, orderedItemIds } = event.payload;
      if (orderedItemIds.length !== state.activeItemIds.length) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const activeSet = new Set(state.activeItemIds);
      if (!activeSet.has(movedItemId) || orderedItemIds.some((itemId) => !activeSet.has(itemId))) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const activeItems = readActiveItems(read, envelope, state.activeItemIds);
      const moved = activeItems.get(movedItemId)!;
      if (moved.kind !== "message" || moved.state === "dispatching") {
        throw new OrchestrationConflict("revision-conflict");
      }
      const oldIndex = new Map(state.activeItemIds.map((itemId, index) => [itemId, index]));
      const newIndex = new Map(orderedItemIds.map((itemId, index) => [itemId, index]));
      for (const [itemId, item] of activeItems) {
        if (item.state === "dispatching" && oldIndex.get(itemId) !== newIndex.get(itemId)) {
          throw new OrchestrationConflict("revision-conflict");
        }
        if (item.kind === "delegated-results") {
          const delegatedOld = oldIndex.get(itemId)!;
          const delegatedNew = newIndex.get(itemId)!;
          for (const [otherId, other] of activeItems) {
            if (other.kind === "delegated-results") continue;
            if (oldIndex.get(otherId)! > delegatedOld && newIndex.get(otherId)! < delegatedNew) {
              throw new OrchestrationConflict("revision-conflict");
            }
          }
        }
      }
      const itemWrites = positionWrites(orderedItemIds, activeItems, new Set());
      return [
        ...itemWrites,
        stateWrite({ ...state, activeItemIds: [...orderedItemIds] }, envelope),
      ];
    }

    case "queue.item-cancelled": {
      const payload = event.payload;
      const item = readItem(read, envelope, payload.itemId);
      if (item.state !== "waiting" && item.state !== "blocked") {
        throw new OrchestrationConflict("revision-conflict");
      }
      const cleared = withoutBlockedFields(item);
      const cancelled = queueItemProjectionSchema.parse({
        ...cleared,
        state: "cancelled",
        cancelReason: payload.reason,
        queuePosition: null,
        queueHeld: false,
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      });
      const nextActiveIds = state.activeItemIds.filter((itemId) => itemId !== item.id);
      const remainingItems = readActiveItems(read, envelope, nextActiveIds);
      const shiftedWrites = positionWrites(nextActiveIds, remainingItems, new Set());
      const nextIntent = state.pendingSendIntent?.itemId === item.id ? null : state.pendingSendIntent;
      return [
        { kind: QUEUE_ITEM_PROJECTION, id: cancelled.id, value: cancelled },
        ...shiftedWrites,
        stateWrite({ ...state, activeItemIds: nextActiveIds, pendingSendIntent: nextIntent }, envelope),
      ];
    }

    case "queue.items-held": {
      const { itemIds, cause } = event.payload;
      const activeSet = new Set(state.activeItemIds);
      const writes: ProjectionWrite[] = [];
      let transitioned = 0;
      for (const itemId of itemIds) {
        if (!activeSet.has(itemId)) throw new OrchestrationConflict("revision-conflict");
        const item = readItem(read, envelope, itemId);
        if (!item.queueHeld || (cause === "H1-stop" && item.bootAutoResend)) {
          transitioned += 1;
          const { bootAutoResend: _clearedResend, ...withoutResend } = item;
          writes.push({
            kind: QUEUE_ITEM_PROJECTION,
            id: item.id,
            value: queueItemProjectionSchema.parse({
              ...(cause === "H1-stop" ? withoutResend : item),
              queueHeld: true,
            }),
          });
        }
      }
      if (transitioned === 0) throw new OrchestrationConflict("revision-conflict");
      const nextIntent = cause === "H1-stop" ? null : state.pendingSendIntent;
      return [
        ...writes,
        stateWrite({ ...state, pendingSendIntent: nextIntent }, envelope),
      ];
    }

    case "queue.items-released": {
      const { itemIds, bootAutoResend } = event.payload;
      const activeSet = new Set(state.activeItemIds);
      const writes: ProjectionWrite[] = [];
      let transitioned = 0;
      for (const itemId of itemIds) {
        if (!activeSet.has(itemId)) throw new OrchestrationConflict("revision-conflict");
        const item = readItem(read, envelope, itemId);
        if (item.queueHeld || (bootAutoResend === true && item.bootAutoResend !== true)) {
          transitioned += 1;
          writes.push({
            kind: QUEUE_ITEM_PROJECTION,
            id: item.id,
            value: queueItemProjectionSchema.parse({
              ...item,
              queueHeld: false,
              ...(bootAutoResend === true ? { bootAutoResend: true } : {}),
            }),
          });
        }
      }
      if (transitioned === 0) throw new OrchestrationConflict("revision-conflict");
      return [
        ...writes,
        stateWrite(state, envelope),
      ];
    }

    case "queue.send-requested": {
      const payload = event.payload;
      if (payload.itemId !== null) {
        if (!state.activeItemIds.includes(payload.itemId)) {
          throw new OrchestrationConflict("revision-conflict");
        }
        const item = readItem(read, envelope, payload.itemId);
        if (item.state === "delivered" || item.state === "cancelled") {
          throw new OrchestrationConflict("revision-conflict");
        }
      }
      return [stateWrite({ ...state, pendingSendIntent: payload }, envelope)];
    }

    case "queue.item-claimed": {
      const payload = event.payload;
      if (!state.activeItemIds.includes(payload.itemId)) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const item = readItem(read, envelope, payload.itemId);
      if ((item.state !== "waiting" && item.state !== "blocked")
        || payload.dispatchOrdinal !== item.dispatchOrdinal + 1) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const cleared = withoutBlockedFields(item);
      const claimed = queueItemProjectionSchema.parse({
        ...cleared,
        state: "dispatching",
        dispatchOrdinal: payload.dispatchOrdinal,
      });
      return [
        { kind: QUEUE_ITEM_PROJECTION, id: claimed.id, value: claimed },
        stateWrite(state, envelope),
      ];
    }

    case "queue.item-released": {
      const payload = event.payload;
      const item = readItem(read, envelope, payload.itemId);
      if (item.state !== "dispatching") {
        throw new OrchestrationConflict("revision-conflict");
      }
      const cleared = withoutBlockedFields(item);
      const released = queueItemProjectionSchema.parse({
        ...cleared,
        state: "waiting",
      });
      return [
        { kind: QUEUE_ITEM_PROJECTION, id: released.id, value: released },
        stateWrite(state, envelope),
      ];
    }

    case "queue.item-blocked": {
      const payload = event.payload;
      const item = readItem(read, envelope, payload.itemId);
      if (item.state !== "waiting" && item.state !== "dispatching" && item.state !== "blocked") {
        throw new OrchestrationConflict("revision-conflict");
      }
      const blocked = queueItemProjectionSchema.parse({
        ...item,
        state: "blocked",
        blockedReason: payload.blockedReason,
        detail: payload.detail,
      });
      const nextIntent = state.pendingSendIntent?.itemId === item.id ? null : state.pendingSendIntent;
      return [
        { kind: QUEUE_ITEM_PROJECTION, id: blocked.id, value: blocked },
        stateWrite({ ...state, pendingSendIntent: nextIntent }, envelope),
      ];
    }

    case "queue.item-delivered": {
      const payload = event.payload;
      const item = readItem(read, envelope, payload.itemId);
      if (item.state !== "dispatching" && item.state !== "waiting") {
        throw new OrchestrationConflict("revision-conflict");
      }
      const cleared = withoutBlockedFields(item);
      const delivered = queueItemProjectionSchema.parse({
        ...cleared,
        state: "delivered",
        delivery: payload.delivery,
        queuePosition: null,
        queueHeld: false,
      });
      const nextActiveIds = state.activeItemIds.filter((itemId) => itemId !== item.id);
      const remainingItems = readActiveItems(read, envelope, nextActiveIds);
      const shiftedWrites = positionWrites(nextActiveIds, remainingItems, new Set());
      const nextIntent = state.pendingSendIntent !== null
        && (state.pendingSendIntent.itemId === null || state.pendingSendIntent.itemId === item.id)
        ? null
        : state.pendingSendIntent;
      const writes: ProjectionWrite[] = [
        { kind: QUEUE_ITEM_PROJECTION, id: delivered.id, value: delivered },
        ...shiftedWrites,
        stateWrite({ ...state, activeItemIds: nextActiveIds, pendingSendIntent: nextIntent }, envelope),
      ];
      if (item.requeuedFromTurnId !== undefined) {
        writes.push({
          kind: SUPERSEDED_TURN_PROJECTION,
          id: item.requeuedFromTurnId,
          value: supersededTurnProjectionSchema.parse({
            threadId: envelope.threadId,
            supersededByRunId: payload.delivery.runId,
            supersededByTurnId: payload.delivery.turnId,
            queueItemId: item.id,
          }),
        });
      }
      return writes;
    }

    case "queue.item-requeued": {
      const payload = event.payload;
      if (state.activeItemIds.includes(payload.itemId)) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const existingRow = read(QUEUE_ITEM_PROJECTION, payload.itemId);
      let existing: QueueItemProjection | null = null;
      if (existingRow) {
        if (existingRow.threadId !== envelope.threadId || existingRow.projectId !== envelope.projectId) {
          throw new OrchestrationConflict("scope-conflict");
        }
        existing = queueItemProjectionSchema.parse(existingRow.value);
        if (existing.state !== "delivered") {
          throw new OrchestrationConflict("revision-conflict");
        }
      }
      const activeItems = readActiveItems(read, envelope, state.activeItemIds);
      const requeued = queueItemProjectionSchema.parse({
        id: payload.itemId,
        threadId: envelope.threadId,
        projectId: envelope.projectId,
        kind: "message",
        userMessageId: payload.userMessageId,
        createdBy: payload.createdBy,
        creationSource: payload.creationSource,
        ...(payload.deviceId !== undefined ? { deviceId: payload.deviceId } : {}),
        requeuedFromRunId: payload.fromRunId,
        requeuedFromTurnId: payload.fromTurnId,
        contentRef: payload.contentRef,
        attachmentIds: payload.attachmentIds,
        ...(payload.routeIdentity !== undefined ? { routeIdentity: payload.routeIdentity } : {}),
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        queuePosition: null,
        queueHeld: payload.queueHeld,
        ...(payload.bootAutoResend !== undefined ? { bootAutoResend: payload.bootAutoResend } : {}),
        requestedAt: payload.requestedAt,
        editedAt: existing?.editedAt ?? null,
        state: "waiting",
        dispatchOrdinal: existing?.dispatchOrdinal ?? 0,
      });
      const nextActiveIds = insertWithPlacement(state.activeItemIds, requeued.id, payload.placement ?? "front");
      activeItems.set(requeued.id, requeued);
      const itemWrites = positionWrites(nextActiveIds, activeItems, new Set([requeued.id]));
      return [
        ...itemWrites,
        stateWrite({ ...state, activeItemIds: nextActiveIds }, envelope),
      ];
    }
  }
}
