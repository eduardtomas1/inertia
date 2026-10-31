import { z } from "zod";

import { MAX_ROLLBACK_TURNS } from "./orchestration-history";
import { orchestrationIdSchema as id } from "./orchestration-identities";

export const MERGE_BACK_STATES = ["prepared", "attached", "dispatched", "delivered", "undelivered", "uncertain",
  "withdrawn", "superseded"] as const;

const count = z.number().int().nonnegative();

export const mergeBackSummarySchema = z.object({
  commandCount: count, fileCount: count, truncated: z.boolean(),
}).strict();

export const mergeBackSchema = z.object({
  id, forkThreadId: id, parentThreadId: id, projectId: id,
  forkSourceTurnId: id, baseTurnId: id.nullable(), throughTurnId: id, requestedThroughTurnId: id.nullable().default(null),
  turnIds: z.array(id).min(1).max(MAX_ROLLBACK_TURNS),
  messageCount: z.number().int().positive(), omittedMessageCount: count,
  summary: mergeBackSummarySchema.default(() => ({ commandCount: 0, fileCount: 0, truncated: false })),
  packetId: id, state: z.enum(MERGE_BACK_STATES),
  runId: id.nullable(), messageId: id.nullable(),
  createdBy: z.literal("human"), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().refine((value) => value.turnIds.at(-1) === value.throughTurnId
  && (value.requestedThroughTurnId === null || value.requestedThroughTurnId === value.throughTurnId)
  && new Set(value.turnIds).size === value.turnIds.length
  && value.forkThreadId !== value.parentThreadId, "Merge-back lineage conflicts.");

export const mergeBackEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("merge-back.prepared"), payload: mergeBackSchema }).strict(),
  z.object({ type: z.literal("merge-back.changed"), payload: z.object({
    id, state: z.enum(MERGE_BACK_STATES), runId: id.nullable(), messageId: id.nullable(),
  }).strict() }).strict(),
]);

export const mergeBackResultSchema = z.object({
  kind: z.literal("conversation.merge-back"), forkConversationId: id, parentConversationId: id,
  mergeBackId: id, packetId: id, messageCount: z.number().int().positive(),
  omittedMessageCount: count, turnCount: z.number().int().positive(),
  throughTurnId: id, requestedThroughTurnId: id.nullable(), summary: mergeBackSummarySchema,
}).strict();

export type MergeBack = z.infer<typeof mergeBackSchema>;
export type MergeBackEvent = z.infer<typeof mergeBackEventSchema>;
export type MergeBackResult = z.infer<typeof mergeBackResultSchema>;
export type MergeBackSummary = z.infer<typeof mergeBackSummarySchema>;
