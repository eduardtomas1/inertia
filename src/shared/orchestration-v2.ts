import { z } from "zod";

import { modelSelectionSchema } from "./model-routing";
import { agentTurnStatusSchema } from "./turn-lifecycle";
import { AGENT_RUN_STATES } from "./run-state";

export const orchestrationIdSchema = z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/u);
const timestamp = z.iso.datetime();
const nativeId = z.string().min(1).max(1_000);

export const orchestrationThreadSchema = z.object({
  id: orchestrationIdSchema,
  projectId: orchestrationIdSchema,
  workspaceKey: z.string().min(1).max(4_096),
  title: z.string().max(1_000),
  providerId: orchestrationIdSchema,
  selection: modelSelectionSchema,
  activeRunId: orchestrationIdSchema.nullable(),
  latestRunId: orchestrationIdSchema.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const orchestrationRunSchema = z.object({
  id: orchestrationIdSchema,
  threadId: orchestrationIdSchema,
  projectId: orchestrationIdSchema,
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
}).strict();

export const orchestrationAttemptSchema = z.object({
  id: orchestrationIdSchema,
  runId: orchestrationIdSchema,
  turnId: orchestrationIdSchema,
  threadId: orchestrationIdSchema,
  providerInstanceId: orchestrationIdSchema,
  status: agentTurnStatusSchema,
  nativeSessionId: nativeId.nullable(),
  nativeThreadId: nativeId.nullable(),
  nativeTurnId: nativeId.nullable(),
  interruptRequestedAt: timestamp.nullable(),
  cleanup: z.enum(["not-started", "pending", "confirmed", "unconfirmed"]),
  runtimeId: orchestrationIdSchema,
}).strict();

export const orchestrationDomainEventSchema = z.discriminatedUnion("type", [
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
  }).strict() }).strict(),
  z.object({ type: z.literal("run.attempt-replaced"), payload: z.object({
    runId: orchestrationIdSchema,
    attemptId: orchestrationIdSchema,
    replacement: orchestrationAttemptSchema,
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
]);

export type OrchestrationThread = z.infer<typeof orchestrationThreadSchema>;
export type OrchestrationRun = z.infer<typeof orchestrationRunSchema>;
export type OrchestrationAttempt = z.infer<typeof orchestrationAttemptSchema>;
export type OrchestrationDomainEvent = z.infer<typeof orchestrationDomainEventSchema>;
