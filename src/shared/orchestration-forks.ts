import { z } from "zod";

import { modelSelectionSchema, versionedContinuationIdentitySchema } from "./model-routing";
import { orchestrationIdSchema as id } from "./orchestration-identities";
import { orchestrationNativeBoundarySchema } from "./orchestration-native-boundary";

export const FORK_HISTORY_PART_CHARACTERS = 65_536;
export const forkHistoryPartSchema = z.object({
  id, threadId: id, sourceThreadId: id, sourceRunId: id.nullable(), sourceTurnId: id.nullable(), sourceItemId: id,
  ordinal: z.number().int().nonnegative(), part: z.number().int().nonnegative(),
  parts: z.number().int().positive(),
  kind: z.enum(["user-message", "assistant-message", "system-message", "command", "file", "plan", "error", "status", "tool"]),
  status: z.enum(["completed", "partial", "failed", "cancelled", "interrupted"]),
  text: z.string().max(FORK_HISTORY_PART_CHARACTERS * 2),
  createdAt: z.iso.datetime(),
}).strict();

export const forkLineageSchema = z.object({
  threadId: id, projectId: id, parentThreadId: id, rootThreadId: id,
  sourceRunId: id, sourceTurnId: id, sourceWorkspaceKey: z.string().min(1).max(4_096),
  sourceProviderId: id, sourceSelection: modelSelectionSchema,
  sourceIdentity: versionedContinuationIdentitySchema,
  nativeBoundary: orchestrationNativeBoundarySchema.nullable(),
  inheritedItems: z.number().int().nonnegative(), inheritedParts: z.number().int().nonnegative(),
  transfer: z.enum(["pending", "native", "portable"]),
  createdAt: z.iso.datetime(),
}).strict();

export const orchestrationForkEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.forked"), payload: forkLineageSchema }).strict(),
  z.object({ type: z.literal("fork.history-part"), payload: forkHistoryPartSchema }).strict(),
  z.object({ type: z.literal("fork.history-sealed"), payload: z.object({
    inheritedItems: z.number().int().nonnegative(), inheritedParts: z.number().int().nonnegative(),
  }).strict() }).strict(),
]);

export type ForkHistoryPart = z.infer<typeof forkHistoryPartSchema>;
export type ForkLineage = z.infer<typeof forkLineageSchema>;
export type OrchestrationForkEvent = z.infer<typeof orchestrationForkEventSchema>;

export const forkHistoryResultSchema = z.object({
  kind: z.literal("conversation.fork.history"), conversationId: id,
  lineage: forkLineageSchema.nullable(), parts: z.array(forkHistoryPartSchema).max(100),
  next: z.number().int().nonnegative().nullable(),
}).strict().refine((value) => (value.lineage === null || value.lineage.threadId === value.conversationId)
  && value.parts.every(({ threadId }) => threadId === value.conversationId)
  && new Set(value.parts.map(({ id }) => id)).size === value.parts.length, "Fork history scope conflicts.");
export type ForkHistoryResult = z.infer<typeof forkHistoryResultSchema>;
