import { z } from "zod";

import { versionedContinuationIdentitySchema, modelSelectionSchema } from "./model-routing";
import { orchestrationIdSchema as id } from "./orchestration-identities";

export const MAX_BACKING_COVERAGE_ITEMS = 2_048;
const time = z.iso.datetime();
const nativeId = z.string().min(1).max(1_000);

export const providerBackingSchema = z.object({
  id, threadId: id, projectId: id, providerId: id, providerInstanceId: id,
  workspaceKey: z.string().min(1).max(4_096),
  nativeSessionId: nativeId,
  continuationIdentity: versionedContinuationIdentitySchema,
  selection: modelSelectionSchema,
  lastRunId: id, lastTurnId: id,
  status: z.enum(["ready", "uncertain", "retired"]),
  coveredItemIds: z.array(id).max(MAX_BACKING_COVERAGE_ITEMS),
  coverageComplete: z.boolean(),
  createdAt: time, updatedAt: time,
}).strict();

export const contextHandoffSchema = z.object({
  id, threadId: id, runId: id, attemptId: id,
  targetBackingId: id.nullable(),
  nativeSessionId: nativeId.nullable(),
  itemIds: z.array(id).max(256),
  method: z.enum(["inline", "native"]),
  state: z.enum(["prepared", "dispatching", "delivered", "uncertain", "abandoned"]),
  createdAt: time, updatedAt: time,
}).strict();

export const orchestrationBackingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider.session-cleared"), payload: z.object({
    runId: id, attemptId: id, expectedNativeSessionId: nativeId,
  }).strict() }).strict(),
  z.object({ type: z.literal("provider.backing-recorded"), payload: z.object({
    backing: providerBackingSchema, runId: id, attemptId: id,
  }).strict() }).strict(),
  z.object({ type: z.literal("provider.backing-invalidated"), payload: z.object({
    backingId: id, reason: z.enum(["uncertain-delivery", "native-resume-failed", "workspace-changed", "rolled-back"]),
  }).strict() }).strict(),
  z.object({ type: z.literal("context.handoff-prepared"), payload: contextHandoffSchema }).strict(),
  z.object({ type: z.literal("context.handoff-state-changed"), payload: z.object({
    handoffId: id, runId: id, attemptId: id,
    state: z.enum(["dispatching", "delivered", "uncertain", "abandoned"]),
    targetBackingId: id.nullable(), nativeSessionId: nativeId.nullable(),
  }).strict() }).strict(),
]);

export type ProviderBacking = z.infer<typeof providerBackingSchema>;
export type ContextHandoff = z.infer<typeof contextHandoffSchema>;
export type OrchestrationBackingEvent = z.infer<typeof orchestrationBackingEventSchema>;

/** Privileged preparation output; never accepted directly from renderer/provider input. */
export interface PreparedContextHandoff {
  itemIds: readonly string[];
  targetBackingId: string | null;
}
