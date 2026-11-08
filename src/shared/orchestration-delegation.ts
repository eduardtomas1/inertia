import { z } from "zod";

import { orchestrationIdSchema as id } from "./orchestration-identities";

export const MAX_DELEGATED_TASK_TURN_IDS = 64;
export const MAX_DELEGATED_DELIVERY_TASKS = 16;
export const MAX_DELEGATED_EVENT_TASKS = 256;
export const MAX_DELEGATED_RESULT_BYTES = 8_000;
export const MAX_DELEGATED_WAKE_BYTES = 16_000;
export const MAX_DELEGATED_COMPLETION_JSON_BYTES = 1_024;
export const MAX_DELEGATED_TASK_SUMMARIES = 50;
export const MAX_DELEGATED_RESULT_PREVIEW_CHARS = 1_000;
export const MAX_DELEGATED_TASK_TITLE_CHARS = 120;
export const MAX_DELEGATED_FAILURE_SUMMARY_CHARS = 1_000;
export const DELEGATION_WAIT_DEFAULT_MS = 300_000;
export const DELEGATION_WAIT_MAX_MS = 1_800_000;

export const DELEGATED_TASK_KINDS = ["original", "follow-up"] as const;
export const DELEGATED_TASK_STATUSES = ["running", "completed", "failed", "cancelled", "interrupted"] as const;
export const DELEGATED_TASK_RESULT_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;
export const DELEGATED_WORK_STATES = ["working", "waiting_for_children", "result_available"] as const;
export const DELEGATED_COMPLETION_WAKES = ["always", "settled_only", "never"] as const;
export const DELEGATED_DELIVERY_STATES = ["pending", "claimed", "delivered", "acknowledged", "disposed"] as const;
export const DELEGATED_TERMINAL_DELIVERY_STATES = ["delivered", "acknowledged", "disposed"] as const;
export const DELEGATION_MAILBOX_PHASES = ["queued", "dispatched", "settled", "withdrawn"] as const;
export const DELEGATED_TASK_ROLES = ["implementation", "research", "review", "design", "test", "general"] as const;
export const DELEGATED_TASK_WORKSPACES = ["project", "reuse-current", "isolated"] as const;
export const DELEGATED_ATTACH_VIAS = ["send", "steer", "continuation"] as const;
export const DELEGATED_WAKE_POLICY_REASONS = ["wait-timeout", "wait-needs-action", "wait-aborted", "restart", "user", "disposed"] as const;
export const DELEGATION_DISARM_SCOPES = ["conversation", "source-turn"] as const;
export const DELEGATION_DISARM_REASONS = ["stop", "archive", "source-failed", "user-dismiss", "setting-off"] as const;
export const DELEGATED_DELIVERY_REASONS = ["planned", "merged", "deferred", "steered", "delivered", "requeued",
  "acknowledged", "cancelled", "user-dismiss", "user-send", "parent-gone", "recovered"] as const;
export const DELEGATED_TASK_CLEANUP_STATES = ["not-started", "pending", "confirmed", "unconfirmed"] as const;

export type DelegatedTaskKind = (typeof DELEGATED_TASK_KINDS)[number];
export type DelegatedTaskStatus = (typeof DELEGATED_TASK_STATUSES)[number];
export type DelegatedTaskResultStatus = (typeof DELEGATED_TASK_RESULT_STATUSES)[number];
export type DelegatedWorkState = (typeof DELEGATED_WORK_STATES)[number];
export type DelegatedCompletionWake = (typeof DELEGATED_COMPLETION_WAKES)[number];
export type DelegatedDeliveryState = (typeof DELEGATED_DELIVERY_STATES)[number];
export type DelegationMailboxPhase = (typeof DELEGATION_MAILBOX_PHASES)[number];
export type DelegatedAttachVia = (typeof DELEGATED_ATTACH_VIAS)[number];
export type DelegatedWakePolicyReason = (typeof DELEGATED_WAKE_POLICY_REASONS)[number];
export type DelegationDisarmScope = (typeof DELEGATION_DISARM_SCOPES)[number];
export type DelegationDisarmReason = (typeof DELEGATION_DISARM_REASONS)[number];
export type DelegatedDeliveryReason = (typeof DELEGATED_DELIVERY_REASONS)[number];

export const delegatedTaskIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestamp = z.iso.datetime();
const generation = z.number().int().positive().max(1_000_000_000);
const label = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/u);

export function isTerminalDelegatedDeliveryState(state: DelegatedDeliveryState | null): boolean {
  return state !== null && (DELEGATED_TERMINAL_DELIVERY_STATES as readonly string[]).includes(state);
}

export const delegatedTaskRouteSchema = z.strictObject({
  providerId: label(64),
  harnessId: label(64),
  modelId: label(256),
  reasoningEffort: label(64).nullable(),
});

export const delegatedTaskResultSchema = z.strictObject({
  turnId: id,
  runId: id,
  status: z.enum(DELEGATED_TASK_RESULT_STATUSES),
  messageId: id.nullable(),
  failureSummary: z.string().max(MAX_DELEGATED_FAILURE_SUMMARY_CHARS).nullable(),
  finalizedAt: timestamp,
});

export const delegatedTaskDeliverySchema = z.strictObject({
  state: z.enum(DELEGATED_DELIVERY_STATES).nullable(),
  generation: generation.nullable(),
  observedByTurnId: id.nullable(),
});

const creation = {
  taskId: delegatedTaskIdSchema,
  kind: z.enum(DELEGATED_TASK_KINDS),
  originalTaskId: delegatedTaskIdSchema.nullable(),
  parentConversationId: id,
  sourceTurnId: id,
  sourceRunId: id,
  childConversationId: id,
  operationId: delegatedTaskIdSchema,
  firstChildTurnId: id,
  firstChildRunId: id,
  title: label(MAX_DELEGATED_TASK_TITLE_CHARS),
  role: z.enum(DELEGATED_TASK_ROLES).nullable(),
  route: delegatedTaskRouteSchema,
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
  interactionMode: z.enum(["build", "plan"]),
  workspace: z.enum(DELEGATED_TASK_WORKSPACES),
  completionWake: z.enum(DELEGATED_COMPLETION_WAKES),
  createdAt: timestamp,
};

const createdRefinement = (value: { taskId: string; operationId: string; kind: DelegatedTaskKind;
  originalTaskId: string | null; parentConversationId: string; childConversationId: string }) =>
  value.parentConversationId !== value.childConversationId
  && (value.kind === "original" ? value.originalTaskId === null && value.taskId === value.operationId
    : value.originalTaskId !== null && value.originalTaskId !== value.taskId && value.taskId === value.operationId);

export const delegatedTaskCreatedSchema = z.strictObject(creation)
  .refine(createdRefinement, "Delegated task identity conflicts.");

export const delegatedTaskSchema = z.strictObject({
  ...creation,
  wakeArmed: z.boolean(),
  status: z.enum(DELEGATED_TASK_STATUSES),
  turnIds: z.array(id).min(1).max(MAX_DELEGATED_TASK_TURN_IDS),
  result: delegatedTaskResultSchema.nullable(),
  delivery: delegatedTaskDeliverySchema,
  updatedAt: timestamp,
}).refine((value) => createdRefinement(value)
  && (value.result === null) === (value.status === "running")
  && (value.result === null || value.result.status === value.status)
  && new Set(value.turnIds).size === value.turnIds.length
  && !(value.completionWake === "never" && value.wakeArmed), "Delegated task state conflicts.");

export const delegationMailboxSchema = z.strictObject({
  parentConversationId: id,
  generation: z.number().int().nonnegative().max(1_000_000_000),
  deliveryId: z.uuid().nullable(),
  taskIds: z.array(delegatedTaskIdSchema).max(MAX_DELEGATED_DELIVERY_TASKS),
  phase: z.enum(DELEGATION_MAILBOX_PHASES),
  wakeTurnId: id.nullable(),
  nextGeneration: generation,
  updatedAt: timestamp,
}).refine((value) => value.nextGeneration > value.generation
  && new Set(value.taskIds).size === value.taskIds.length
  && ((value.phase === "queued" || value.phase === "dispatched") ? value.deliveryId !== null && value.taskIds.length > 0 : true)
  && (value.phase === "queued" ? value.wakeTurnId === null : true), "Delegation mailbox state conflicts.");

const taskIdList = (min: number, max: number) => z.array(delegatedTaskIdSchema).min(min).max(max)
  .refine((ids) => new Set(ids).size === ids.length, "Delegated task ids must be unique.");

export const delegationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delegation.task-created"), payload: delegatedTaskCreatedSchema }),
  z.strictObject({ type: z.literal("delegation.task-turn-attached"), payload: z.strictObject({
    taskId: delegatedTaskIdSchema, childTurnId: id, childRunId: id, via: z.enum(DELEGATED_ATTACH_VIAS),
  }) }),
  z.strictObject({ type: z.literal("delegation.task-finalized"), payload: z.strictObject({
    taskId: delegatedTaskIdSchema, resultTurnId: id, resultRunId: id, status: z.enum(DELEGATED_TASK_RESULT_STATUSES),
    resultMessageId: id.nullable(), failureSummary: z.string().max(MAX_DELEGATED_FAILURE_SUMMARY_CHARS).nullable(),
    finalizedAt: timestamp,
  }) }),
  z.strictObject({ type: z.literal("delegation.wake-policy-changed"), payload: z.strictObject({
    taskId: delegatedTaskIdSchema, completionWake: z.enum(DELEGATED_COMPLETION_WAKES), armed: z.boolean(),
    reason: z.enum(DELEGATED_WAKE_POLICY_REASONS),
  }) }),
  z.strictObject({ type: z.literal("delegation.delivery-changed"), payload: z.strictObject({
    taskIds: taskIdList(1, MAX_DELEGATED_EVENT_TASKS), state: z.enum(DELEGATED_DELIVERY_STATES),
    generation: generation.nullable(), observedByTurnId: id.nullable(), reason: z.enum(DELEGATED_DELIVERY_REASONS),
  }) }),
  z.strictObject({ type: z.literal("delegation.mailbox-changed"), payload: z.strictObject({
    generation: z.number().int().nonnegative().max(1_000_000_000), deliveryId: z.uuid().nullable(),
    taskIds: taskIdList(0, MAX_DELEGATED_DELIVERY_TASKS), phase: z.enum(DELEGATION_MAILBOX_PHASES),
    wakeTurnId: id.nullable(), nextGeneration: generation,
  }) }),
  z.strictObject({ type: z.literal("delegation.wakes-disarmed"), payload: z.strictObject({
    scope: z.enum(DELEGATION_DISARM_SCOPES), sourceTurnId: id.nullable(), reason: z.enum(DELEGATION_DISARM_REASONS),
    taskIds: taskIdList(0, MAX_DELEGATED_EVENT_TASKS),
  }).refine((value) => (value.scope === "source-turn") === (value.sourceTurnId !== null), "Disarm scope conflicts.") }),
]);

export const delegatedCompletionAttributionSchema = z.strictObject({
  parentConversationId: z.uuid(),
  generation,
  taskIds: taskIdList(1, MAX_DELEGATED_DELIVERY_TASKS),
}).refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_DELEGATED_COMPLETION_JSON_BYTES,
  "Delegated completion attribution is too large.");

const neutralText = (max: number) => z.string().max(max);

export const delegatedTaskResultViewSchema = z.strictObject({
  turnId: id,
  status: z.enum(DELEGATED_TASK_RESULT_STATUSES),
  text: neutralText(MAX_DELEGATED_RESULT_BYTES).nullable(),
  truncated: z.boolean(),
  neutralized: z.boolean(),
});

export const delegatedTaskNeedsActionSchema = z.strictObject({ kind: z.enum(["question", "approval"]), turnId: id });

export const delegatedTaskViewSchema = z.strictObject({
  taskId: delegatedTaskIdSchema,
  kind: z.enum(DELEGATED_TASK_KINDS),
  originalTaskId: delegatedTaskIdSchema.nullable(),
  conversationId: id,
  firstTurnId: id,
  title: label(MAX_DELEGATED_TASK_TITLE_CHARS),
  status: z.enum(DELEGATED_TASK_STATUSES),
  workState: z.enum(DELEGATED_WORK_STATES),
  needsAction: delegatedTaskNeedsActionSchema.nullable(),
  hasPendingChildTurns: z.boolean(),
  result: delegatedTaskResultViewSchema.nullable(),
  latest: z.strictObject({ turnId: id, status: z.string().min(1).max(32) }).nullable(),
  route: delegatedTaskRouteSchema,
  accessMode: z.enum(["supervised", "auto-edit", "full"]),
  interactionMode: z.enum(["build", "plan"]),
  completionWake: z.enum(DELEGATED_COMPLETION_WAKES),
  wakeArmed: z.boolean(),
  delivery: z.strictObject({ state: z.enum(DELEGATED_DELIVERY_STATES).nullable(), generation: generation.nullable() }),
  cleanup: z.enum(DELEGATED_TASK_CLEANUP_STATES),
  waitTimedOut: z.boolean().optional(),
  next: z.string().max(1_000).optional(),
});

export const delegatedTaskSummarySchema = z.strictObject({
  taskId: delegatedTaskIdSchema,
  kind: z.enum(DELEGATED_TASK_KINDS),
  childConversationId: id,
  childTitle: z.string().max(1_000).nullable(),
  title: label(MAX_DELEGATED_TASK_TITLE_CHARS),
  role: z.enum(DELEGATED_TASK_ROLES).nullable(),
  route: delegatedTaskRouteSchema,
  sourceTurnId: id,
  status: z.enum(DELEGATED_TASK_STATUSES),
  workState: z.enum(DELEGATED_WORK_STATES),
  completionWake: z.enum(DELEGATED_COMPLETION_WAKES),
  wakeArmed: z.boolean(),
  delivery: z.strictObject({ state: z.enum(DELEGATED_DELIVERY_STATES).nullable(), generation: generation.nullable() }),
  resultTurnId: id.nullable(),
  resultPreview: neutralText(MAX_DELEGATED_RESULT_PREVIEW_CHARS).nullable(),
  needsAction: delegatedTaskNeedsActionSchema.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const conversationDelegationSchema = z.strictObject({
  asParent: z.strictObject({
    tasks: z.array(delegatedTaskSummarySchema).max(MAX_DELEGATED_TASK_SUMMARIES),
    totalTasks: z.number().int().nonnegative(),
    mailbox: z.strictObject({
      generation: z.number().int().nonnegative(),
      phase: z.enum(DELEGATION_MAILBOX_PHASES),
      taskIds: z.array(delegatedTaskIdSchema).max(MAX_DELEGATED_DELIVERY_TASKS),
    }).nullable(),
  }).nullable(),
  asChild: z.strictObject({
    taskId: delegatedTaskIdSchema,
    parentConversationId: id,
    parentTitle: z.string().max(1_000).nullable(),
    status: z.enum(DELEGATED_TASK_STATUSES),
    workState: z.enum(DELEGATED_WORK_STATES),
  }).nullable(),
});

export type DelegatedTaskRoute = z.infer<typeof delegatedTaskRouteSchema>;
export type DelegatedTaskResult = z.infer<typeof delegatedTaskResultSchema>;
export type DelegatedTaskCreated = z.infer<typeof delegatedTaskCreatedSchema>;
export type DelegatedTask = z.infer<typeof delegatedTaskSchema>;
export type DelegationMailbox = z.infer<typeof delegationMailboxSchema>;
export type DelegationEvent = z.infer<typeof delegationEventSchema>;
export type DelegatedCompletionAttribution = z.infer<typeof delegatedCompletionAttributionSchema>;
export type DelegatedTaskResultView = z.infer<typeof delegatedTaskResultViewSchema>;
export type DelegatedTaskNeedsAction = z.infer<typeof delegatedTaskNeedsActionSchema>;
export type DelegatedTaskView = z.infer<typeof delegatedTaskViewSchema>;
export type DelegatedTaskSummary = z.infer<typeof delegatedTaskSummarySchema>;
export type ConversationDelegation = z.infer<typeof conversationDelegationSchema>;
