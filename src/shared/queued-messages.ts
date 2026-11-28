import { z } from "zod";
import { ACCEPTED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_BYTES } from "./attachments";
import { modelSelectionSchema } from "./model-routing";
import { snapshotSourceSchema } from "./snapshots";
import { previewAnnotationSchema } from "./preview-annotation";
import { watcherNoteAttributionSchema } from "./watcher";
import { delegatedCompletionAttributionSchema } from "./orchestration-delegation";
import { orchestrationIdSchema } from "./orchestration-identities";
import {
  MAX_QUEUED_DELEGATED_ITEMS,
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  MAX_QUEUED_WATCHER_NOTES,
  QUEUE_CREATED_BY,
  QUEUE_CREATION_SOURCES,
  QUEUE_DELIVERY_MODES,
  QUEUE_HOLD_REASONS,
  QUEUE_ITEM_KINDS,
} from "./orchestration-queue";

export {
  MAX_QUEUED_DELEGATED_ITEMS,
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  MAX_QUEUED_WATCHER_NOTES,
};
export const MAX_QUEUED_MESSAGES = 3;
/**
 * Rows that name a follow-up its provider accepted but never read (`userMessageId` on an active row). They wait
 * outside the cap of three, bounded per chat.
 */
export const MAX_UNREAD_FOLLOW_UP_ROWS = 64;
export const QUEUED_ROUTE_CHANGED_ERROR = "This chat's model, access or workspace changed. Send it with the current settings, edit it, or remove it.";
export const queuedMessageStateSchema = z.enum(["waiting", "dispatching", "blocked", "accepted", "cancelled"]);
const queuedAttachmentSchema = z.strictObject({
  id: z.uuid(), name: z.string().min(1).max(255), path: z.string().min(1).max(4096),
  mimeType: z.enum(ACCEPTED_ATTACHMENT_MIME_TYPES), size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  snapshot: snapshotSourceSchema.optional(),
  previewAnnotation: previewAnnotationSchema.optional(),
});
export const queuedMessageSchema = z.strictObject({
  id: z.uuid(), conversationId: z.uuid(), content: z.string().max(20_000),
  attachments: z.array(queuedAttachmentSchema).max(MAX_ATTACHMENT_COUNT),
  state: queuedMessageStateSchema, createdAt: z.string().datetime(),
  error: z.string().max(1000).nullable(), turnId: z.string().nullable(), userMessageId: z.string().nullable(),
  watcherNote: watcherNoteAttributionSchema.optional(),
  delegatedCompletion: delegatedCompletionAttributionSchema.optional(),
  kind: z.enum(QUEUE_ITEM_KINDS).optional(),
  queuePosition: z.number().int().positive().nullable().optional(),
  queueHeld: z.boolean().optional(),
  editRevision: z.number().int().min(0).optional(),
  editedAt: z.string().datetime().nullable().optional(),
  createdBy: z.enum(QUEUE_CREATED_BY).optional(),
  creationSource: z.enum(QUEUE_CREATION_SOURCES).optional(),
  deviceId: orchestrationIdSchema.nullable().optional(),
  steerWhenReadyRunId: orchestrationIdSchema.nullable().optional(),
  steerFollowUpOfRunId: orchestrationIdSchema.nullable().optional(),
  modelSelection: modelSelectionSchema.nullable().optional(),
  followsThreadSelection: z.boolean().optional(),
  dispatchOrdinal: z.number().int().min(0).optional(),
  runId: orchestrationIdSchema.nullable().optional(),
  deliveryMode: z.enum(QUEUE_DELIVERY_MODES).nullable().optional(),
  editable: z.boolean().optional(),
}).refine((value) => !(value.watcherNote && value.delegatedCompletion), "A queued message has one automatic attribution.");
export const queuedAccessSchema = z.strictObject({
  interactionMode: z.enum(["build", "plan"]),
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
});
export const messageQueueResultSchema = z.strictObject({
  kind: z.literal("message.queue"), conversationId: z.uuid(),
  entries: z.array(queuedMessageSchema).max(MAX_QUEUED_USER_AND_AGENT_ITEMS + MAX_QUEUED_WATCHER_NOTES + MAX_QUEUED_DELEGATED_ITEMS + MAX_UNREAD_FOLLOW_UP_ROWS)
    .refine((entries) => entries.filter(({ delegatedCompletion }) => delegatedCompletion).length <= MAX_QUEUED_DELEGATED_ITEMS
      && entries.filter(({ delegatedCompletion, watcherNote, userMessageId }) => !delegatedCompletion && !watcherNote && userMessageId === null).length <= MAX_QUEUED_USER_AND_AGENT_ITEMS
      && entries.filter(({ watcherNote }) => watcherNote).length <= MAX_QUEUED_WATCHER_NOTES
      && entries.filter(({ userMessageId }) => userMessageId !== null).length <= MAX_UNREAD_FOLLOW_UP_ROWS,
    "A queue exceeds its bounded message limits."),
  receipt: queuedMessageSchema.nullable(),
  edited: queuedMessageSchema.optional(),
  confirmation: z.strictObject({ id: z.uuid(), queued: queuedAccessSchema, current: queuedAccessSchema }).optional(),
  revision: z.number().int().nonnegative().optional(),
  held: z.boolean().optional(),
  holdReason: z.enum(QUEUE_HOLD_REASONS).nullable().optional(),
  canResume: z.boolean().optional(),
  resumePrompted: z.boolean().optional(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedAccess = z.infer<typeof queuedAccessSchema>;
export type MessageQueueResult = z.infer<typeof messageQueueResultSchema>;
