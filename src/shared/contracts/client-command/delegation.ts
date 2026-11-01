import { z } from "zod";

import {
  DELEGATED_TASK_RESULT_STATUSES,
  MAX_DELEGATED_EVENT_TASKS,
  delegatedTaskIdSchema,
  delegatedTaskViewSchema,
} from "../../orchestration-delegation";
import { requestBase } from "./common";

export const DELEGATION_COMMAND_TYPES = [
  "delegation.task.read",
  "delegation.task.cancel",
  "delegation.delivery.dismiss",
  "delegation.delivery.send",
  "delegation.wake.set",
] as const;

const taskPayload = z.object({ taskId: delegatedTaskIdSchema }).strict();
const taskIdList = z.array(delegatedTaskIdSchema).min(1).max(MAX_DELEGATED_EVENT_TASKS)
  .refine((ids) => new Set(ids).size === ids.length, "Delegated task ids must be unique.");

export const delegationCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("delegation.task.read"), payload: taskPayload }).strict(),
  z.object({ ...requestBase, type: z.literal("delegation.task.cancel"), payload: taskPayload }).strict(),
  z.object({ ...requestBase, type: z.literal("delegation.delivery.dismiss"), payload: z.object({
    parentConversationId: z.string().uuid(), taskIds: taskIdList.optional(),
  }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("delegation.delivery.send"), payload: z.object({
    parentConversationId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("delegation.wake.set"), payload: z.object({
    taskId: delegatedTaskIdSchema, armed: z.boolean(),
  }).strict() }).strict(),
] as const;

export const DELEGATED_TASK_CANCEL_STATUSES = ["cancel_requested", ...DELEGATED_TASK_RESULT_STATUSES] as const;

export const delegationTaskResultSchema = z.strictObject({
  kind: z.literal("delegation.task"),
  task: delegatedTaskViewSchema,
});

export const delegationCancelResultSchema = z.strictObject({
  kind: z.literal("delegation.task.cancel"),
  taskId: delegatedTaskIdSchema,
  status: z.enum(DELEGATED_TASK_CANCEL_STATUSES),
});

export const delegationDeliveryResultSchema = z.strictObject({
  kind: z.literal("delegation.delivery"),
  parentConversationId: z.string().uuid(),
  action: z.enum(["dismissed", "sent"]),
  taskIds: z.array(delegatedTaskIdSchema).max(MAX_DELEGATED_EVENT_TASKS),
  generation: z.number().int().positive().nullable(),
});

export type DelegationTaskResult = z.infer<typeof delegationTaskResultSchema>;
export type DelegationCancelResult = z.infer<typeof delegationCancelResultSchema>;
export type DelegationDeliveryResult = z.infer<typeof delegationDeliveryResultSchema>;
export type DelegatedTaskCancelStatus = (typeof DELEGATED_TASK_CANCEL_STATUSES)[number];
