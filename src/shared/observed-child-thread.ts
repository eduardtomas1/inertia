import { z } from "zod";

import type { SubagentTraceStatus } from "./contracts/agent";
import { orchestrationIdSchema as id } from "./orchestration-identities";
import type { ProviderId } from "./provider";

export const MAX_OBSERVED_CHILD_DEPTH = 8;
export const MAX_OBSERVED_CHILDREN = 256;
export const MAX_OBSERVED_CHILD_IDENTIFIER_CHARS = 1_000;
export const MAX_OBSERVED_CHILD_LABEL_CHARS = 200;
export const MAX_OBSERVED_CHILD_DESCRIPTION_BYTES = 4_096;
export const MAX_OBSERVED_CHILD_PROGRESS_BYTES = 4_096;
export const MAX_OBSERVED_CHILD_RESULT_BYTES = 16_384;
export const MAX_OBSERVED_CHILD_REASON_CHARS = 240;
export const MAX_OBSERVED_CHILD_TOKEN_COUNT = 1_000_000_000_000;
export const MAX_OBSERVED_CHILD_TOOL_USE_COUNT = 1_000_000;
export const MAX_OBSERVED_CHILD_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;

export const OBSERVED_CHILD_READ_ONLY_REASON = "Provider-managed agents are read-only";

const PROVIDER_OPTIONS = {
  codex: true,
  claude: true,
  cursor: true,
  kimi: true,
  opencode: true,
  antigravity: true,
  pi: true,
} as const satisfies Record<ProviderId, true>;

const STATUS_OPTIONS = {
  queued: true,
  spawned: true,
  running: true,
  waiting: true,
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
  unknown: true,
  lost: true,
} as const satisfies Record<SubagentTraceStatus, true>;

export const OBSERVED_CHILD_PROVIDER_IDS = Object.keys(PROVIDER_OPTIONS) as ProviderId[];
export const OBSERVED_CHILD_STATUSES = Object.keys(STATUS_OPTIONS) as SubagentTraceStatus[];

export const OBSERVED_CHILD_CONTROL_CODES = [
  "provider-unsupported",
  "not-live",
  "no-provider-task",
  "no-active-turn",
  "not-active-turn",
  "read-only",
  "transcript-unavailable",
  "not-a-conversation",
  "not-a-delegated-task",
] as const;

export const OBSERVED_CHILD_LINEAGES = [
  "complete",
  "detached",
  "cycle",
  "depth-bounded",
] as const;

const providerIdSchema = z.enum(OBSERVED_CHILD_PROVIDER_IDS);
const statusSchema = z.enum(OBSERVED_CHILD_STATUSES);
const controlCodeSchema = z.enum(OBSERVED_CHILD_CONTROL_CODES);
const timestampSchema = z.string().min(1).max(64);
const nativeIdentifierSchema = z.string()
  .min(1)
  .max(MAX_OBSERVED_CHILD_IDENTIFIER_CHARS)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const labelSchema = z.string()
  .min(1)
  .max(MAX_OBSERVED_CHILD_LABEL_CHARS * 2)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const boundedTextSchema = (maximumBytes: number) => z.string()
  .min(1)
  .max(maximumBytes)
  .refine((value) => !value.includes("\u0000"), "Observed text contains a NUL character.");
const tokenCountSchema = z.number().int().min(0).max(MAX_OBSERVED_CHILD_TOKEN_COUNT).nullable();

export const observedChildUsageSchema = z.object({
  totalTokens: tokenCountSchema,
  inputTokens: tokenCountSchema,
  cachedInputTokens: tokenCountSchema,
  cacheWriteInputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  reasoningOutputTokens: tokenCountSchema,
  contextTokens: tokenCountSchema,
  maxContextTokens: z.number().int().min(1).max(MAX_OBSERVED_CHILD_TOKEN_COUNT).nullable(),
}).strict();

export const observedChildSupportedControlSchema = z.object({
  supported: z.literal(true),
  code: z.null(),
  reason: z.null(),
}).strict();

export const observedChildUnsupportedControlSchema = z.object({
  supported: z.literal(false),
  code: controlCodeSchema,
  reason: z.string().min(1).max(MAX_OBSERVED_CHILD_REASON_CHARS),
}).strict();

export const observedChildControlSchema = z.union([
  observedChildSupportedControlSchema,
  observedChildUnsupportedControlSchema,
]);

export const observedChildControlSetSchema = z.object({
  stop: observedChildControlSchema,
  send: observedChildUnsupportedControlSchema.extend({
    code: z.literal("read-only"),
    reason: z.literal(OBSERVED_CHILD_READ_ONLY_REASON),
  }).strict(),
  transcript: observedChildUnsupportedControlSchema,
  pin: observedChildUnsupportedControlSchema,
  snooze: observedChildUnsupportedControlSchema,
  archive: observedChildUnsupportedControlSchema,
  settle: observedChildUnsupportedControlSchema,
  manage: observedChildUnsupportedControlSchema,
  wake: observedChildUnsupportedControlSchema,
}).strict();

export const observedChildThreadSchema = z.object({
  id,
  authority: z.literal("observed"),
  transcript: z.literal("unavailable"),
  parent: z.object({
    conversationId: id,
    runId: id,
    turnId: id,
    parentTraceId: id.nullable(),
  }).strict(),
  depth: z.number().int().min(1).max(MAX_OBSERVED_CHILD_DEPTH),
  lineage: z.enum(OBSERVED_CHILD_LINEAGES),
  providerId: providerIdSchema,
  nativeRef: z.object({
    taskId: nativeIdentifierSchema.nullable(),
    agentId: nativeIdentifierSchema.nullable(),
    toolUseId: nativeIdentifierSchema.nullable(),
    strongest: z.enum(["task", "agent", "tool-use"]).nullable(),
  }).strict(),
  role: labelSchema.nullable(),
  name: labelSchema.nullable(),
  description: boundedTextSchema(MAX_OBSERVED_CHILD_DESCRIPTION_BYTES).nullable(),
  model: labelSchema.nullable(),
  status: statusSchema,
  providerStatus: labelSchema.nullable(),
  isLive: z.boolean(),
  progress: boundedTextSchema(MAX_OBSERVED_CHILD_PROGRESS_BYTES).nullable(),
  result: boundedTextSchema(MAX_OBSERVED_CHILD_RESULT_BYTES).nullable(),
  truncated: z.object({
    description: z.boolean(),
    progress: z.boolean(),
    result: z.boolean(),
  }).strict(),
  usage: observedChildUsageSchema.nullable(),
  toolUseCount: z.number().int().min(0).max(MAX_OBSERVED_CHILD_TOOL_USE_COUNT).nullable(),
  durationMs: z.number().int().min(0).max(MAX_OBSERVED_CHILD_DURATION_MS).nullable(),
  controls: observedChildControlSetSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().refine((child) => {
  const strongest = child.nativeRef.strongest;
  const strongestPresent = strongest === null
    ? child.nativeRef.taskId === null && child.nativeRef.agentId === null && child.nativeRef.toolUseId === null
    : child.nativeRef[strongest === "task" ? "taskId" : strongest === "agent" ? "agentId" : "toolUseId"] !== null;
  const stopGrounded = !child.controls.stop.supported
    || (child.isLive && child.nativeRef.taskId !== null);
  const rootConsistent = child.parent.parentTraceId === null
    ? child.depth === 1 && child.lineage === "complete"
    : child.parent.parentTraceId !== child.id;
  return strongestPresent && stopGrounded && rootConsistent;
}, "Observed child identity or control conflicts with its trace.");

export const observedChildReadResultSchema = z.object({
  kind: z.literal("observed-child.read"),
  conversationId: id,
  turnId: id.nullable(),
  children: z.array(observedChildThreadSchema).max(MAX_OBSERVED_CHILDREN),
  controls: z.record(id, observedChildControlSetSchema),
  omitted: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().refine((value) => {
  const ids = value.children.map((child) => child.id);
  const controlIds = Object.keys(value.controls);
  return new Set(ids).size === ids.length
    && controlIds.length === ids.length
    && ids.every((childId) => Object.hasOwn(value.controls, childId))
    && value.children.every((child) =>
      child.parent.conversationId === value.conversationId
      && (value.turnId === null || child.parent.turnId === value.turnId));
}, "Observed child read scope conflicts.");

export type ObservedChildUsage = z.infer<typeof observedChildUsageSchema>;
export type ObservedChildControl = z.infer<typeof observedChildControlSchema>;
export type ObservedChildUnsupportedControl = z.infer<typeof observedChildUnsupportedControlSchema>;
export type ObservedChildControlCode = (typeof OBSERVED_CHILD_CONTROL_CODES)[number];
export type ObservedChildControlSet = z.infer<typeof observedChildControlSetSchema>;
export type ObservedChildLineage = (typeof OBSERVED_CHILD_LINEAGES)[number];
export type ObservedChildThread = z.infer<typeof observedChildThreadSchema>;
export type ObservedChildReadResult = z.infer<typeof observedChildReadResultSchema>;
