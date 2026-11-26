import { z } from "zod";
import { ACCEPTED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_BYTES } from "./attachments";
import { snapshotSourceSchema } from "./snapshots";
import { previewAnnotationSchema } from "./preview-annotation";
import { watcherNoteAttributionSchema } from "./watcher";
import { delegatedCompletionAttributionSchema } from "./orchestration-delegation";

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
}).refine((value) => !(value.watcherNote && value.delegatedCompletion), "A queued message has one automatic attribution.");
export const queuedAccessSchema = z.strictObject({
  interactionMode: z.enum(["build", "plan"]),
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
});
export const messageQueueResultSchema = z.strictObject({
  kind: z.literal("message.queue"), conversationId: z.uuid(),
  entries: z.array(queuedMessageSchema).max(MAX_QUEUED_MESSAGES + 1 + MAX_UNREAD_FOLLOW_UP_ROWS)
    .refine((entries) => entries.filter(({ delegatedCompletion }) => delegatedCompletion).length <= 1
      && entries.filter(({ delegatedCompletion, userMessageId }) => !delegatedCompletion && userMessageId === null).length <= MAX_QUEUED_MESSAGES
      && entries.filter(({ userMessageId }) => userMessageId !== null).length <= MAX_UNREAD_FOLLOW_UP_ROWS,
    "A queue holds at most three messages plus one delegated result delivery, and the follow-ups the agent did not read."),
  receipt: queuedMessageSchema.nullable(),
  edited: queuedMessageSchema.optional(),
  confirmation: z.strictObject({ id: z.uuid(), queued: queuedAccessSchema, current: queuedAccessSchema }).optional(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedAccess = z.infer<typeof queuedAccessSchema>;
export type MessageQueueResult = z.infer<typeof messageQueueResultSchema>;
