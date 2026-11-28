import { z } from "zod";

import { MAX_ATTACHMENT_COUNT } from "./attachments";
import { modelSelectionSchema } from "./model-routing";
import { delegatedCompletionAttributionSchema } from "./orchestration-delegation";
import { orchestrationIdSchema as id } from "./orchestration-identities";
import { watcherNoteAttributionSchema } from "./watcher";

export const QUEUE_ITEM_PROJECTION = "queue-item";
export const QUEUE_STATE_PROJECTION = "queue-state";
export const SUPERSEDED_TURN_PROJECTION = "superseded-turn";

export const MAX_QUEUED_USER_AND_AGENT_ITEMS = 20;
export const MAX_QUEUED_DELEGATED_ITEMS = 1;
export const MAX_QUEUED_WATCHER_NOTES = 5;
export const MAX_QUEUED_WATCHER_NOTES_PER_LINK = 1;
export const MAX_QUEUED_UNREAD_FOLLOW_UPS = 64;
export const MAX_QUEUED_DETAIL_CHARS = 1_000;
export const MAX_QUEUED_CONTENT_CHARS = 20_000;
export const MAX_QUEUED_ACTIVE_ITEMS = 256;

export const QUEUE_ITEM_KINDS = ["message", "watcher-note", "delegated-results"] as const;
export const QUEUE_CREATED_BY = ["user", "agent", "system"] as const;
export const QUEUE_CREATION_SOURCES = ["web", "mobile", "mcp", "server"] as const;
export const QUEUE_ITEM_STATES = ["waiting", "dispatching", "blocked", "delivered", "cancelled"] as const;
export const QUEUE_CANCEL_REASONS = ["user", "withdrawn", "superseded", "stale"] as const;
export const QUEUE_DELIVERY_MODES = ["run", "steer", "after-stop"] as const;
export const QUEUE_HOLD_CAUSES = [
  "H1-stop",
  "H2-inherited",
  "H3-created-held",
  "H4-start-failure",
  "H5-restart",
  "H6-busy-session",
] as const;
export const QUEUE_RELEASE_CAUSES = [
  "R1-user-send",
  "R2-run-completed",
  "R3-resume",
  "R4-preparation-retry",
] as const;
export const QUEUE_CLAIM_RELEASE_REASONS = [
  "transient",
  "runtime-lost",
  "steer-declined",
  "turn-ended",
] as const;
export const QUEUE_SEND_INTENT_KINDS = ["send-now", "resume"] as const;
export const QUEUE_ITEM_ORIGINS = ["command", "legacy", "requeue", "automatic"] as const;
export const QUEUE_HOLD_REASONS = [
  "stopped",
  "provider-failed",
  "restart",
  "usage-limit",
  "workspace-setup",
  "busy-session",
] as const;
export const QUEUE_BLOCKED_REASONS = [
  "route-changed",
  "text-lost",
  "steer-unconfirmed",
  "steer-unavailable",
  "missing-follow-up",
  "provider-disabled",
  "workspace-missing",
  "dispatch-failed",
] as const;

export type QueueItemKind = (typeof QUEUE_ITEM_KINDS)[number];
export type QueueCreatedBy = (typeof QUEUE_CREATED_BY)[number];
export type QueueCreationSource = (typeof QUEUE_CREATION_SOURCES)[number];
export type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];
export type QueueCancelReason = (typeof QUEUE_CANCEL_REASONS)[number];
export type QueueDeliveryMode = (typeof QUEUE_DELIVERY_MODES)[number];
export type QueueHoldCause = (typeof QUEUE_HOLD_CAUSES)[number];
export type QueueReleaseCause = (typeof QUEUE_RELEASE_CAUSES)[number];
export type QueueClaimReleaseReason = (typeof QUEUE_CLAIM_RELEASE_REASONS)[number];
export type QueueSendIntentKind = (typeof QUEUE_SEND_INTENT_KINDS)[number];
export type QueueItemOrigin = (typeof QUEUE_ITEM_ORIGINS)[number];
export type QueueHoldReason = (typeof QUEUE_HOLD_REASONS)[number];
export type QueueBlockedReason = (typeof QUEUE_BLOCKED_REASONS)[number];

const timestamp = z.iso.datetime();
const routeIdentitySchema = z.string().max(16_384);
const detailSchema = z.string().max(MAX_QUEUED_DETAIL_CHARS);
const uniqueIdList = (min: number, max: number) => z.array(id).min(min).max(max)
  .refine((ids) => new Set(ids).size === ids.length, "Queue item ids must be unique.");

export function queueContentCharCount(content: string): number {
  return Array.from(content).length;
}

export function queueDispatchCommandId(itemId: string, dispatchOrdinal: number): string {
  return `queue:${itemId}:${dispatchOrdinal}`;
}

export function queueDeferredSteerCommandId(itemId: string, runId: string, attemptId: string): string {
  return `queue:${itemId}:steer-when-ready:${runId}:${attemptId}`;
}

export function queueAgentCommandId(operationId: string): string {
  return `agent-queue:${operationId}`;
}

export function queueUnreadFollowUpCommandId(turnId: string, messageId: string): string {
  return `unread-follow-up:${turnId}:${messageId}`;
}

export function queueAdoptCommandId(itemId: string): string {
  return `queue-adopt:${itemId}`;
}

/** N17: content by reference only. Never carries text or any digest of text. */
export const queueContentRefSchema = z.strictObject({
  chars: z.number().int().min(0).max(MAX_QUEUED_CONTENT_CHARS),
  editRevision: z.number().int().min(0),
});

export const queueItemDeliverySchema = z.strictObject({
  mode: z.enum(QUEUE_DELIVERY_MODES),
  outcome: z.literal("restarted").optional(),
  runId: id,
  attemptId: id,
  turnId: id,
  messageId: id,
  steerEffectId: id.optional(),
  deliveredAt: timestamp,
});

export const scheduledTaskQueueAttributionSchema = z.strictObject({
  taskId: id,
  runId: id,
  title: z.string().trim().min(1).max(160),
  interactionMode: z.enum(["build", "plan"]),
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
  requirePrivateConnectPromptSafety: z.literal(true).optional(),
});
export type ScheduledTaskQueueAttribution = z.infer<typeof scheduledTaskQueueAttributionSchema>;

export const childQuestionWakeAttributionSchema = z.strictObject({
  childConversationId: id,
  childRunId: id,
  requestId: id,
});
export type ChildQuestionWakeAttribution = z.infer<typeof childQuestionWakeAttributionSchema>;

export const queueItemAttributionSchema = z.union([
  z.strictObject({ watcherNote: watcherNoteAttributionSchema }),
  z.strictObject({ delegatedCompletion: delegatedCompletionAttributionSchema }),
  z.strictObject({ scheduledTask: scheduledTaskQueueAttributionSchema }),
  z.strictObject({ childQuestionWake: childQuestionWakeAttributionSchema }),
]);

export const queueItemProjectionSchema = z.strictObject({
  id,
  threadId: id,
  projectId: id,
  kind: z.enum(QUEUE_ITEM_KINDS),
  userMessageId: id.nullable(),
  createdBy: z.enum(QUEUE_CREATED_BY),
  creationSource: z.enum(QUEUE_CREATION_SOURCES),
  deviceId: id.optional(),
  steerFollowUpOfRunId: id.optional(),
  requeuedFromRunId: id.optional(),
  requeuedFromTurnId: id.optional(),
  contentRef: queueContentRefSchema,
  attachmentIds: z.array(id).max(MAX_ATTACHMENT_COUNT),
  routeIdentity: routeIdentitySchema.optional(),
  modelSelection: modelSelectionSchema.nullable().optional(),
  followsThreadSelection: z.literal(true).optional(),
  queuePosition: z.number().int().positive().nullable(),
  queueHeld: z.boolean(),
  steerWhenReadyRunId: id.optional(),
  freshContext: z.literal(true).optional(),
  bootAutoResend: z.literal(true).optional(),
  requestedAt: timestamp,
  editedAt: timestamp.nullable(),
  state: z.enum(QUEUE_ITEM_STATES),
  blockedReason: id.optional(),
  detail: detailSchema.optional(),
  cancelReason: z.enum(QUEUE_CANCEL_REASONS).optional(),
  dispatchOrdinal: z.number().int().min(0),
  delivery: queueItemDeliverySchema.optional(),
  attribution: queueItemAttributionSchema.optional(),
});

export const queuePendingSendIntentSchema = z.strictObject({
  itemId: id.nullable(),
  kind: z.enum(QUEUE_SEND_INTENT_KINDS),
  requestedAt: timestamp,
  requestId: id,
});

export const queueStateProjectionSchema = z.strictObject({
  threadId: id,
  projectId: id,
  activeItemIds: uniqueIdList(0, MAX_QUEUED_ACTIVE_ITEMS),
  pendingSendIntent: queuePendingSendIntentSchema.nullable(),
  updatedAt: timestamp,
});

export const supersededTurnProjectionSchema = z.strictObject({
  threadId: id,
  supersededByRunId: id,
  supersededByTurnId: id,
  queueItemId: id,
});

export const queueEnqueuePlacementSchema = z.union([
  z.literal("end"),
  z.literal("front"),
  z.strictObject({ afterItemIds: uniqueIdList(0, MAX_QUEUED_ACTIVE_ITEMS) }),
]);

export const queueEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("queue.item-enqueued"),
    payload: z.strictObject({
      itemId: id,
      kind: z.enum(QUEUE_ITEM_KINDS),
      userMessageId: id.nullable(),
      createdBy: z.enum(QUEUE_CREATED_BY),
      creationSource: z.enum(QUEUE_CREATION_SOURCES),
      deviceId: id.optional(),
      steerFollowUpOfRunId: id.optional(),
      requeuedFromRunId: id.optional(),
      requeuedFromTurnId: id.optional(),
      contentRef: queueContentRefSchema,
      attachmentIds: z.array(id).max(MAX_ATTACHMENT_COUNT),
      routeIdentity: routeIdentitySchema.optional(),
      modelSelection: modelSelectionSchema.nullable().optional(),
      followsThreadSelection: z.literal(true).optional(),
      placement: queueEnqueuePlacementSchema.optional(),
      queueHeld: z.boolean().optional(),
      skipHoldInheritance: z.literal(true).optional(),
      steerWhenReadyRunId: id.optional(),
      freshContext: z.literal(true).optional(),
      bootAutoResend: z.literal(true).optional(),
      requestedAt: timestamp,
      attribution: queueItemAttributionSchema.optional(),
      origin: z.enum(QUEUE_ITEM_ORIGINS).optional(),
      initialState: z.enum(["waiting", "blocked"]).optional(),
      blockedReason: id.optional(),
      detail: detailSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-edited"),
    payload: z.strictObject({
      itemId: id,
      expectedRevision: z.number().int().min(0),
      contentRef: queueContentRefSchema,
      attachmentIds: z.array(id).max(MAX_ATTACHMENT_COUNT).optional(),
      modelSelection: modelSelectionSchema.nullable().optional(),
      routeIdentity: routeIdentitySchema.optional(),
      clearSteerWhenReady: z.literal(true).optional(),
      editedAt: timestamp,
    }),
  }),
  z.strictObject({
    type: z.literal("queue.steer-when-ready-cleared"),
    payload: z.strictObject({
      itemIds: uniqueIdList(1, MAX_QUEUED_ACTIVE_ITEMS),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.reordered"),
    payload: z.strictObject({
      movedItemId: id,
      orderedItemIds: uniqueIdList(1, MAX_QUEUED_ACTIVE_ITEMS),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-cancelled"),
    payload: z.strictObject({
      itemId: id,
      reason: z.enum(QUEUE_CANCEL_REASONS),
      detail: detailSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.items-held"),
    payload: z.strictObject({
      itemIds: uniqueIdList(1, MAX_QUEUED_ACTIVE_ITEMS),
      cause: z.enum(QUEUE_HOLD_CAUSES),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.items-released"),
    payload: z.strictObject({
      itemIds: uniqueIdList(1, MAX_QUEUED_ACTIVE_ITEMS),
      cause: z.enum(QUEUE_RELEASE_CAUSES),
      bootAutoResend: z.literal(true).optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.send-requested"),
    payload: queuePendingSendIntentSchema,
  }),
  z.strictObject({
    type: z.literal("queue.item-claimed"),
    payload: z.strictObject({
      itemId: id,
      mode: z.enum(QUEUE_DELIVERY_MODES),
      dispatchOrdinal: z.number().int().positive(),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-released"),
    payload: z.strictObject({
      itemId: id,
      reason: z.enum(QUEUE_CLAIM_RELEASE_REASONS),
      detail: detailSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-blocked"),
    payload: z.strictObject({
      itemId: id,
      blockedReason: id,
      detail: detailSchema,
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-delivered"),
    payload: z.strictObject({
      itemId: id,
      delivery: queueItemDeliverySchema,
    }),
  }),
  z.strictObject({
    type: z.literal("queue.item-requeued"),
    payload: z.strictObject({
      itemId: id,
      fromRunId: id,
      fromTurnId: id,
      userMessageId: id,
      contentRef: queueContentRefSchema,
      attachmentIds: z.array(id).max(MAX_ATTACHMENT_COUNT),
      routeIdentity: routeIdentitySchema.optional(),
      modelSelection: modelSelectionSchema.nullable().optional(),
      followsThreadSelection: z.literal(true).optional(),
      freshContext: z.literal(true).optional(),
      attribution: queueItemAttributionSchema.optional(),
      createdBy: z.enum(QUEUE_CREATED_BY),
      creationSource: z.enum(QUEUE_CREATION_SOURCES),
      deviceId: id.optional(),
      requestedAt: timestamp,
      queueHeld: z.boolean(),
      bootAutoResend: z.literal(true).optional(),
      placement: queueEnqueuePlacementSchema.optional(),
    }),
  }),
]);

export type QueueContentRef = z.infer<typeof queueContentRefSchema>;
export type QueueItemDelivery = z.infer<typeof queueItemDeliverySchema>;
export type QueueItemAttribution = z.infer<typeof queueItemAttributionSchema>;
export type QueueItemProjection = z.infer<typeof queueItemProjectionSchema>;
export type QueuePendingSendIntent = z.infer<typeof queuePendingSendIntentSchema>;
export type QueueStateProjection = z.infer<typeof queueStateProjectionSchema>;
export type SupersededTurnProjection = z.infer<typeof supersededTurnProjectionSchema>;
export type QueueEnqueuePlacement = z.infer<typeof queueEnqueuePlacementSchema>;
export type QueueEvent = z.infer<typeof queueEventSchema>;

export interface QueueOrderableItem {
  readonly id: string;
  readonly kind: QueueItemKind;
  readonly queuePosition: number | null;
  readonly requestedAt: string;
}

export interface QueueDispatchableItem {
  readonly kind: QueueItemKind;
  readonly state: QueueItemState;
  readonly queueHeld: boolean;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRequestedAt(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  return compareString(left, right);
}

/**
 * Pure delivery order (T3 `QueuedRunOrder.ts:13-50`, Decision 4.2):
 * - `delegated-results` sorted by `requestedAt ASC, id ASC`;
 * - all other items (user, agent, unread follow-ups, requeues, watcher notes)
 *   sorted by `(queuePosition ?? Infinity) ASC, requestedAt ASC, id ASC`;
 * - two-pointer merge by `requestedAt` where delegated results win ties.
 */
export function queuedItemsInDeliveryOrder<T extends QueueOrderableItem>(items: readonly T[]): T[] {
  const delegated: T[] = [];
  const others: T[] = [];
  for (const item of items) {
    if (item.kind === "delegated-results") delegated.push(item);
    else others.push(item);
  }
  delegated.sort((left, right) => compareRequestedAt(left.requestedAt, right.requestedAt)
    || compareString(left.id, right.id));
  others.sort((left, right) => {
    const leftPos = left.queuePosition ?? Number.POSITIVE_INFINITY;
    const rightPos = right.queuePosition ?? Number.POSITIVE_INFINITY;
    if (leftPos !== rightPos) return leftPos - rightPos;
    return compareRequestedAt(left.requestedAt, right.requestedAt) || compareString(left.id, right.id);
  });
  const merged: T[] = [];
  let delegatedIndex = 0;
  let otherIndex = 0;
  while (delegatedIndex < delegated.length && otherIndex < others.length) {
    if (compareRequestedAt(delegated[delegatedIndex]!.requestedAt, others[otherIndex]!.requestedAt) <= 0) {
      merged.push(delegated[delegatedIndex]!);
      delegatedIndex += 1;
    } else {
      merged.push(others[otherIndex]!);
      otherIndex += 1;
    }
  }
  while (delegatedIndex < delegated.length) {
    merged.push(delegated[delegatedIndex]!);
    delegatedIndex += 1;
  }
  while (otherIndex < others.length) {
    merged.push(others[otherIndex]!);
    otherIndex += 1;
  }
  return merged;
}

/**
 * Selects the next automatically dispatchable item from a delivery-ordered list:
 * - skips terminal items (`delivered`, `cancelled`);
 * - stops (returns `null`) on any `dispatching` item so active work is never bypassed;
 * - skips held items (`queueHeld === true`);
 * - skips blocked `watcher-note` and blocked `delegated-results` items;
 * - stops (returns `null`) on a blocked `message` item (including unread follow-ups).
 */
export function nextAutoDispatchItem<T extends QueueDispatchableItem>(ordered: readonly T[]): T | null {
  for (const item of ordered) {
    if (item.state === "delivered" || item.state === "cancelled") continue;
    if (item.state === "dispatching") return null;
    if (item.queueHeld) continue;
    if (item.state === "blocked") {
      if (item.kind === "message") return null;
      continue;
    }
    return item;
  }
  return null;
}
