import { z } from "zod";

import { orchestrationIdSchema as id } from "./orchestration-identities";

export const MAX_ROLLBACK_TURNS = 2_048;
const nativeId = z.string().min(1).max(512).regex(/^[^\u0000- \u007f]+$/u);

export const nativeContinuationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resume-cursor"), nativeConversationId: nativeId, resumeSessionAt: nativeId }).strict(),
  z.object({ kind: z.literal("new-session"), nativeConversationId: nativeId }).strict(),
]);

export const historyRollbackPlanSchema = z.object({
  retainedTurnId: id.nullable(),
  rolledBackTurnIds: z.array(id).min(1).max(MAX_ROLLBACK_TURNS),
}).strict().refine(({ retainedTurnId, rolledBackTurnIds }) => new Set(rolledBackTurnIds).size === rolledBackTurnIds.length
  && (retainedTurnId === null || !rolledBackTurnIds.includes(retainedTurnId)), "Rollback plan conflicts.");

export const historyCursorSchema = z.object({
  threadId: id, rollbackId: id, retainedTurnId: id.nullable(),
  transfer: z.enum(["native", "portable"]),
  providerInstanceId: id.nullable(), workspaceKey: z.string().min(1).max(4_096).nullable(),
  nativeConversationId: nativeId.nullable(),
  physicalHeadId: nativeId.nullable(), effectiveHeadId: nativeId.nullable(),
  continuation: nativeContinuationSchema.nullable(),
  continuationState: z.enum(["none", "pending", "attached", "dispatched", "consumed", "uncertain"]),
  runId: id.nullable(),
  reason: id.nullable(),
  updatedAt: z.iso.datetime(),
}).strict();

export const historyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("history.rolled-back"), payload: z.object({
    id, plan: historyRollbackPlanSchema, reason: id,
  }).strict() }).strict(),
  z.object({ type: z.literal("history.continuation-changed"), payload: z.object({
    rollbackId: id, runId: id,
    state: z.enum(["pending", "attached", "dispatched", "consumed", "uncertain"]),
  }).strict() }).strict(),
]);

export const conversationRollbackResultSchema = z.object({
  kind: z.literal("conversation.rollback"), conversationId: id, rollbackId: id.nullable(),
  retainedTurnId: id.nullable(), rolledBackTurns: z.number().int().nonnegative(),
  transfer: z.enum(["native", "portable", "unchanged"]), reason: id.nullable(),
}).strict();

export function rolledBackTurnIdsCoherent(value: unknown, agentTurns: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !Array.isArray(agentTurns) || new Set(value).size !== value.length) return false;
  const turnIds = new Set(agentTurns.map((turn: { id?: unknown }) => turn.id));
  return value.every((id) => typeof id === "string" && turnIds.has(id));
}

export type HistoryRollbackPlan = z.infer<typeof historyRollbackPlanSchema>;
export type HistoryCursor = z.infer<typeof historyCursorSchema>;
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type ConversationRollbackResult = z.infer<typeof conversationRollbackResultSchema>;
