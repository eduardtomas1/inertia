import { z } from "zod";

import { modelSelectionSchema } from "./model-routing";
import { agentTurnStatusSchema } from "./turn-lifecycle";
import { AGENT_RUN_STATES } from "./run-state";
import { orchestrationIdSchema } from "./orchestration-identities";
import { orchestrationBackingEventSchema } from "./orchestration-backings";
import { nativeBoundaryEventSchema } from "./orchestration-native-boundary";
import { orchestrationForkEventSchema } from "./orchestration-forks";
import { nativeControlEventSchema } from "./orchestration-native-control";
import { historyEventSchema } from "./orchestration-history";
import { mergeBackEventSchema } from "./orchestration-merge-back";
import { delegationEventSchema } from "./orchestration-delegation";
import { runControlEventSchema } from "./orchestration-run-control";

export { orchestrationIdSchema } from "./orchestration-identities";
const timestamp = z.iso.datetime();
const nativeId = z.string().min(1).max(1_000);
const ordinal = z.number().int().positive();

const orchestrationAttemptStatusSchema = agentTurnStatusSchema.or(z.literal("superseded"));
const orchestrationAttemptReasonSchema = z.enum(["initial", "retry", "provider_recovery", "steering_restart"]);
const orchestrationAttemptReplacementReasonSchema = z.enum(["retry", "provider_recovery"]);

export const orchestrationThreadSchema = z.object({
  id: orchestrationIdSchema,
  projectId: orchestrationIdSchema,
  workspaceKey: z.string().min(1).max(4_096),
  title: z.string().max(1_000),
  providerId: orchestrationIdSchema,
  selection: modelSelectionSchema,
  activeRunId: orchestrationIdSchema.nullable(),
  latestRunId: orchestrationIdSchema.nullable(),
  lastRunOrdinal: z.number().int().nonnegative().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const orchestrationRunDeliverySchema = z.enum(["not-delivered", "prompt-not-delivered"]);
/**
 * A provider failure code a later run acts on (T3 keeps the code on the run's error item).
 * `invalid_encrypted_content`: Codex rejected the native thread's encrypted history, so the next
 * run on that thread starts a fresh one with the portable history (T3 `rejected_native_history`).
 */
export const orchestrationRunFailureCodeSchema = z.enum(["invalid_encrypted_content"]);

export const orchestrationRunSchema = z.object({
  id: orchestrationIdSchema,
  threadId: orchestrationIdSchema,
  projectId: orchestrationIdSchema,
  ordinal: ordinal.optional(),
  /** Compatibility transcript boundary, separate from run and provider attempt identity. */
  turnId: orchestrationIdSchema,
  messageId: orchestrationIdSchema,
  attemptId: orchestrationIdSchema,
  providerInstanceId: orchestrationIdSchema,
  providerId: orchestrationIdSchema,
  selection: modelSelectionSchema,
  workspaceKey: z.string().min(1).max(4_096),
  status: agentTurnStatusSchema,
  executionState: z.enum(AGENT_RUN_STATES),
  providerState: z.string().min(1).max(200).nullable(),
  stateRevision: z.number().int().nonnegative(),
  requestedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  terminalMessageId: orchestrationIdSchema.nullable(),
  /**
   * Set on a terminal run whose prompt never reached its provider. `not-delivered`: the provider received nothing.
   * `prompt-not-delivered`: its restored history was injected into the session, but the provider never accepted
   * the turn, so the prompt and its images were not delivered (the route was still reached).
   */
  delivery: orchestrationRunDeliverySchema.optional(),
  /**
   * With `delivery` only: the provider itself reported that it dropped the prompt before keeping it in its native
   * history (T3 `promptDropped`; Cursor SDK: the run saved no checkpoint), whatever output it streamed. It tells a
   * run the provider dropped from one the user stopped before its provider accepted it: a cancelled run is missed
   * (its images ride on the next prompt) only with it. Absent on runs settled before it was recorded.
   */
  promptDropped: z.literal(true).optional(),
  /** Set on a failed run only; absent on runs settled before failure codes were recorded. */
  failureCode: orchestrationRunFailureCodeSchema.optional(),
}).strict();

export const orchestrationCleanupReleaseSchema = z.object({
  stopOutcome: z.enum(["force-detached", "expired", "failed", "missing", "identity-mismatch"]),
  runtimeGenerationId: orchestrationIdSchema,
  systemBootId: orchestrationIdSchema,
  stopBudgetMs: z.number().int().nonnegative(),
  releasedAt: timestamp,
}).strict();

export const orchestrationAttemptSchema = z.object({
  id: orchestrationIdSchema,
  runId: orchestrationIdSchema,
  turnId: orchestrationIdSchema,
  threadId: orchestrationIdSchema,
  providerInstanceId: orchestrationIdSchema,
  ordinal: ordinal.optional(),
  reason: orchestrationAttemptReasonSchema.optional(),
  status: orchestrationAttemptStatusSchema,
  supersededAt: timestamp.optional(),
  nativeSessionId: nativeId.nullable(),
  nativeThreadId: nativeId.nullable(),
  nativeTurnId: nativeId.nullable(),
  interruptRequestedAt: timestamp.nullable(),
  cleanup: z.enum(["not-started", "pending", "confirmed", "unconfirmed", "unconfirmed-released"]),
  cleanupRelease: orchestrationCleanupReleaseSchema.optional(),
  runtimeId: orchestrationIdSchema,
}).strict();

export const orchestrationDomainEventSchema = z.discriminatedUnion("type", [
  ...nativeControlEventSchema.options,
  ...historyEventSchema.options,
  ...mergeBackEventSchema.options,
  ...delegationEventSchema.options,
  ...runControlEventSchema.options,
  nativeBoundaryEventSchema,
  ...orchestrationForkEventSchema.options,
  ...orchestrationBackingEventSchema.options,
  z.object({ type: z.literal("thread.registered"), payload: orchestrationThreadSchema }).strict(),
  z.object({ type: z.literal("thread.configured"), payload: z.object({
    providerId: orchestrationIdSchema,
    selection: modelSelectionSchema,
    workspaceKey: z.string().min(1).max(4_096),
    title: z.string().max(1_000),
  }).strict() }).strict(),
  z.object({ type: z.literal("run.accepted"), payload: z.object({
    run: orchestrationRunSchema,
    attempt: orchestrationAttemptSchema,
  }).strict() }).strict(),
  z.object({ type: z.literal("run.status-changed"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
    status: agentTurnStatusSchema,
    executionState: z.enum(AGENT_RUN_STATES),
    providerState: z.string().min(1).max(200).nullable(),
    stateRevision: z.number().int().nonnegative(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    terminalMessageId: orchestrationIdSchema.nullable(),
    nativeSessionId: nativeId.nullable(),
    delivery: orchestrationRunDeliverySchema.optional(),
    /** With `delivery` only (see the run's `promptDropped`); absent on events written before it was recorded. */
    promptDropped: z.literal(true).optional(),
    /** Failed status only; absent on events written before failure codes were recorded. */
    failureCode: orchestrationRunFailureCodeSchema.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal("run.attempt-replaced"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
    replacement: orchestrationAttemptSchema,
    reason: orchestrationAttemptReplacementReasonSchema.optional(),
    priorCleanup: z.literal("confirmed").optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal("attempt.interrupt-requested"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
  }).strict() }).strict(),
  z.object({ type: z.literal("attempt.cleanup-changed"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
    cleanup: z.enum(["pending", "confirmed", "unconfirmed"]),
  }).strict() }).strict(),
  z.object({ type: z.literal("attempt.cleanup-released"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
    release: orchestrationCleanupReleaseSchema,
  }).strict() }).strict(),
]);

export type OrchestrationThread = z.infer<typeof orchestrationThreadSchema>;
export type OrchestrationRun = z.infer<typeof orchestrationRunSchema>;
export type OrchestrationAttempt = z.infer<typeof orchestrationAttemptSchema>;
export type OrchestrationAttemptReplacementReason = z.infer<typeof orchestrationAttemptReplacementReasonSchema>;
export type OrchestrationCleanupRelease = z.infer<typeof orchestrationCleanupReleaseSchema>;
export type OrchestrationDomainEvent = z.infer<typeof orchestrationDomainEventSchema>;
export type OrchestrationRunFailureCode = z.infer<typeof orchestrationRunFailureCodeSchema>;
