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
  omittedItemIds: z.array(id).max(256).optional(),
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
    /** Set by dispatch: the backing as it was before this run took it over. */
    beforeDispatch: providerBackingSchema.optional(),
  }).strict() }).strict(),
  /** A run the provider never received hands the backing back as dispatch found it. */
  z.object({ type: z.literal("provider.backing-restored"), payload: z.object({
    backing: providerBackingSchema, runId: id,
  }).strict() }).strict(),
  /**
   * The chat's native session continues in the run's checkout (T3 `restart_and_resume`
   * on a workspace change). Projected from the source row: a new backing for
   * `workspaceKey` with the source's session, coverage and status, and the
   * source retired, in one write. Committed with the run, before its handoff.
   */
  z.object({ type: z.literal("provider.backing-relocated"), payload: z.object({
    runId: id, attemptId: id, fromBackingId: id, backingId: id,
    workspaceKey: z.string().min(1).max(4_096),
  }).strict() }).strict(),
  /**
   * The run's harness continues a copy of the resumed session made in the run's checkout (Pi `--fork`;
   * T3 repoints the provider thread's `nativeThreadRef` and keeps its coverage). The backing the run works on
   * now names the copy: same row, coverage and status; the attempt and the run's handoff follow it.
   */
  z.object({ type: z.literal("provider.backing-forked"), payload: z.object({
    runId: id, attemptId: id, backingId: id, fromNativeSessionId: nativeId, nativeSessionId: nativeId,
    handoffId: id.nullable(),
  }).strict() }).strict(),
  /** `rejected-native-history`: Codex rejected the session's encrypted history (T3 `rejected_native_history`). */
  z.object({ type: z.literal("provider.backing-invalidated"), payload: z.object({
    backingId: id, reason: z.enum(["uncertain-delivery", "native-resume-failed", "workspace-changed", "rolled-back",
      "context-exhausted", "rejected-native-history"]),
  }).strict() }).strict(),
  z.object({ type: z.literal("provider.backing-rewound"), payload: z.object({
    rollbackId: id, backingId: id, nativeSessionId: nativeId,
    coveredItemIds: z.array(id).max(MAX_BACKING_COVERAGE_ITEMS), coverageComplete: z.boolean(),
  }).strict() }).strict(),
  z.object({ type: z.literal("context.handoff-prepared"), payload: contextHandoffSchema }).strict(),
  /**
   * `method` (optional; absent on events written before native history injection) changes how
   * the handoff reaches the session: `native` before `thread/inject_items` is sent, back to
   * `inline` when the provider does not know the method. Absent keeps the handoff's method.
   */
  z.object({ type: z.literal("context.handoff-state-changed"), payload: z.object({
    handoffId: id, runId: id, attemptId: id,
    state: z.enum(["dispatching", "delivered", "uncertain", "abandoned"]),
    targetBackingId: id.nullable(), nativeSessionId: nativeId.nullable(),
    method: z.enum(["inline", "native"]).optional(),
  }).strict() }).strict(),
]);

export type ProviderBacking = z.infer<typeof providerBackingSchema>;
export type ContextHandoff = z.infer<typeof contextHandoffSchema>;
export type OrchestrationBackingEvent = z.infer<typeof orchestrationBackingEventSchema>;

/** Privileged preparation output: resume the source backing's native session in the run's checkout. */
export interface PreparedBackingRelocation {
  fromBackingId: string;
}

/** Privileged preparation output; never accepted directly from renderer/provider input. */
export interface PreparedContextHandoff {
  itemIds: readonly string[];
  omittedItemIds?: readonly string[];
  targetBackingId: string | null;
}
