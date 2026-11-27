import { z } from "zod";
import { PRIVATE_CONNECT_LIMITS } from "./limits";

import {
  privateConnectQuestionAnswersSchema,
  privateConnectSafeQuestionsSchema,
} from "./questions";
import {
  PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS,
  privateConnectRuntimeGrantSchema,
} from "./runtime-grants";

export const PRIVATE_CONNECT_RUNTIME_LIMITS = Object.freeze({
  plaintextBytes: 96 * 1024,
  promptCharacters: PRIVATE_CONNECT_LIMITS.promptCharacters,
  transcriptMessages: 200,
  activities: 200,
  subagents: 64,
  sessions: PRIVATE_CONNECT_LIMITS.sessions,
  inFlightRequestsPerSession: PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession,
  deliveryReceipts: PRIVATE_CONNECT_LIMITS.deliveryReceipts,
});

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().min(1).max(200);
const safeLabel = z.string().max(240);
const safeContent = z.string().max(64 * 1024);
const projectionValidator = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const privateConnectRuntimeScopeSchema = z.enum(["view", "prompt"]);

export const privateConnectRuntimeGrantsSchema = z.array(
  privateConnectRuntimeGrantSchema,
).max(PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS.projects);

export const privateConnectRuntimeSafeProjectSchema = z.object({
  id: entityId,
  name: safeLabel,
}).strict();

export const privateConnectRuntimeSafeConversationSchema = z.object({
  id: entityId,
  projectId: entityId,
  title: safeLabel,
  providerLabel: safeLabel,
  runId: entityId.nullable(),
  status: z.enum(["idle", "running", "needs-input", "completed", "failed"]),
  pendingLocalApproval: z.boolean(),
  promptSafety: z.object({
    supported: z.boolean(),
    headline: safeLabel,
    explanation: z.string().max(600),
  }).strict(),
  updatedAt: timestamp,
}).strict();
export type PrivateConnectRuntimeConversation = z.infer<
  typeof privateConnectRuntimeSafeConversationSchema
>;

export const privateConnectRuntimeSafeRunSchema = z.object({
  id: entityId,
  conversationId: entityId.nullable(),
  label: safeLabel,
  status: z.enum(["running", "waiting", "succeeded", "failed", "cancelled"]),
}).strict();

export const privateConnectRuntimeSafeShellSchema = z.object({
  generatedAt: timestamp,
  projects: z.array(privateConnectRuntimeSafeProjectSchema).max(1_000),
  conversations: z.array(privateConnectRuntimeSafeConversationSchema).max(5_000),
  runs: z.array(privateConnectRuntimeSafeRunSchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.activities),
}).strict();

export const privateConnectRuntimeSafeMessageSchema = z.object({
  id: entityId,
  turnId: entityId.nullable(),
  role: z.enum(["user", "assistant"]),
  content: safeContent,
  createdAt: timestamp,
}).strict();

export const privateConnectRuntimeSafeActivitySchema = z.object({
  id: entityId,
  turnId: entityId.nullable(),
  kind: z.enum(["status", "tool", "command", "file", "reasoning", "error"]),
  title: safeLabel,
  status: z.enum(["running", "completed", "failed"]),
  createdAt: timestamp,
}).strict();

export const privateConnectRuntimeSafeSubagentSchema = z.object({
  id: entityId,
  turnId: entityId,
  providerLabel: safeLabel,
  name: safeLabel.nullable(),
  status: safeLabel,
  description: safeContent.nullable(),
  progress: safeContent.nullable(),
  updatedAt: timestamp,
}).strict();

export const privateConnectQueueHoldReasonSchema = z.enum([
  "stopped", "failed", "restart", "usage-limit", "workspace-setup", "busy-session",
]);
export type PrivateConnectQueueHoldReason = z.infer<
  typeof privateConnectQueueHoldReasonSchema
>;

export const privateConnectQueueItemSchema = z.object({
  id: uuid,
  content: z.string().max(20_000),
  attachmentCount: z.number().int().min(0).max(20),
  state: z.enum(["waiting", "dispatching", "blocked"]),
  queueHeld: z.boolean(),
  editRevision: z.number().int().min(0),
  editable: z.boolean(),
  sendLabel: z.enum(["send-now", "stop-and-send", "queue", "none"]),
  attribution: z.enum(["user", "watcher", "delegated", "device", "agent"]),
  modelLabel: z.string().max(120).nullable(),
  steerWaiting: z.boolean().optional(),
  error: z.string().max(300).nullable(),
}).strict();
export type PrivateConnectQueueItem = z.infer<
  typeof privateConnectQueueItemSchema
>;

export const privateConnectQueueProjectionSchema = z.object({
  revision: z.number().int().min(0),
  held: z.boolean(),
  holdReason: privateConnectQueueHoldReasonSchema.nullable(),
  canResume: z.boolean(),
  items: z.array(privateConnectQueueItemSchema).max(30),
}).strict();
export type PrivateConnectQueueProjection = z.infer<
  typeof privateConnectQueueProjectionSchema
>;

export const privateConnectScheduledTaskSchema = z.object({
  id: uuid,
  projectId: entityId,
  projectName: safeLabel,
  title: safeLabel,
  scheduleLabel: safeLabel,
  enabled: z.boolean(),
  nextRunAt: timestamp.nullable(),
  lastRunAt: timestamp.nullable(),
  lastRunStatus: z.enum(["claimed", "queued", "running", "completed", "failed", "skipped"]).nullable(),
  lastError: z.string().max(300).nullable(),
  consecutiveFailures: z.number().int().min(0),
  boundConversationId: uuid.nullable(),
}).strict();
export type PrivateConnectScheduledTask = z.infer<
  typeof privateConnectScheduledTaskSchema
>;

export const privateConnectRuntimeSafeConversationDetailSchema = z.object({
  generatedAt: timestamp,
  conversation: privateConnectRuntimeSafeConversationSchema,
  messages: z.array(privateConnectRuntimeSafeMessageSchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages),
  activities: z.array(privateConnectRuntimeSafeActivitySchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.activities),
  subagents: z.array(privateConnectRuntimeSafeSubagentSchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.subagents),
  plan: z.object({
    steps: z.array(z.object({
      label: safeLabel,
      status: z.enum(["pending", "inProgress", "completed", "cancelled"]),
    }).strict()).max(100),
  }).strict().nullable().optional(),
  inputRequestId: uuid.nullable().optional(),
  questions: privateConnectSafeQuestionsSchema.optional(),
  waitingForLocalAction: z.boolean(),
  queue: privateConnectQueueProjectionSchema.optional(),
}).strict();

export const privateConnectRuntimeRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.get"), requestId: uuid, ifNoneMatch: projectionValidator.nullable().optional() }).strict(),
  z.object({ type: z.literal("conversation.get"), requestId: uuid, conversationId: uuid, ifNoneMatch: projectionValidator.nullable().optional() }).strict(),
  z.object({ type: z.literal("prompt.send"), requestId: uuid, deliveryId: uuid, conversationId: uuid, content: z.string().trim().min(1).max(PRIVATE_CONNECT_RUNTIME_LIMITS.promptCharacters) }).strict(),
  z.object({ type: z.literal("input.respond"), requestId: uuid, inputRequestId: uuid, conversationId: uuid, answers: privateConnectQuestionAnswersSchema }).strict(),
  z.object({ type: z.literal("run.stop"), requestId: uuid, runId: entityId, conversationId: uuid }).strict(),
  z.object({ type: z.literal("queue.send"), requestId: uuid, conversationId: uuid, id: uuid }).strict(),
  z.object({ type: z.literal("queue.edit"), requestId: uuid, conversationId: uuid, id: uuid, expectedRevision: z.number().int().min(0), content: z.string().trim().min(1).max(PRIVATE_CONNECT_RUNTIME_LIMITS.promptCharacters) }).strict(),
  z.object({ type: z.literal("queue.remove"), requestId: uuid, conversationId: uuid, id: uuid }).strict(),
  z.object({ type: z.literal("queue.resume"), requestId: uuid, conversationId: uuid }).strict(),
  z.object({ type: z.literal("scheduled-tasks.list"), requestId: uuid, projectId: entityId.optional() }).strict(),
  z.object({ type: z.literal("scheduled-task.toggle"), requestId: uuid, taskId: uuid, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("scheduled-task.run-now"), requestId: uuid, taskId: uuid }).strict(),
  z.object({ type: z.literal("scheduled-task.delete"), requestId: uuid, taskId: uuid }).strict(),
]);
export type PrivateConnectRuntimeRequest = z.infer<typeof privateConnectRuntimeRequestSchema>;

export const privateConnectRuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"), requestId: uuid, ok: z.literal(true),
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("state"), validator: projectionValidator.optional(), state: privateConnectRuntimeSafeShellSchema }).strict(),
      z.object({ kind: z.literal("conversation"), validator: projectionValidator.optional(), detail: privateConnectRuntimeSafeConversationDetailSchema }).strict(),
      z.object({ kind: z.literal("not-modified"), validator: projectionValidator, checkedAt: timestamp, resource: z.discriminatedUnion("kind", [z.object({ kind: z.literal("state") }).strict(), z.object({ kind: z.literal("conversation"), conversationId: uuid }).strict()]) }).strict(),
      z.object({ kind: z.literal("prompt.accepted"), deliveryId: uuid, turnId: entityId.nullable(), queuedMessageId: uuid.optional() }).strict(),
      z.object({ kind: z.literal("input.accepted"), conversationId: uuid, inputRequestId: uuid }).strict(),
      z.object({ kind: z.literal("run.stopped"), conversationId: uuid, runId: entityId, alreadyStopped: z.boolean() }).strict(),
      z.object({ kind: z.literal("queue.updated"), conversationId: uuid, revision: z.number().int().min(0) }).strict(),
      z.object({ kind: z.literal("scheduled-tasks"), tasks: z.array(privateConnectScheduledTaskSchema).max(200) }).strict(),
      z.object({ kind: z.literal("scheduled-task.updated"), task: privateConnectScheduledTaskSchema }).strict(),
      z.object({ kind: z.literal("scheduled-task.ran"), task: privateConnectScheduledTaskSchema, conversationId: uuid.nullable() }).strict(),
      z.object({ kind: z.literal("scheduled-task.deleted"), taskId: uuid }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("response"), requestId: uuid, ok: z.literal(false),
    code: z.enum(["forbidden", "not-found", "busy", "stale", "rate-limited", "invalid", "unavailable", "uncertain"]),
    message: z.string().trim().min(1).max(300),
  }).strict(),
]);
export type PrivateConnectRuntimeResponse = z.infer<typeof privateConnectRuntimeResponseSchema>;

export const privateConnectRuntimeAuthorizationSchema = z.object({
  deviceId: uuid,
  sessionId: uuid,
  scopes: z.array(privateConnectRuntimeScopeSchema).min(1).max(2),
  projectIds: z.array(entityId).min(1).max(64),
  grants: privateConnectRuntimeGrantsSchema,
  grantVersion: z.number().int().positive(),
  expiresAt: timestamp,
}).strict();
export type PrivateConnectRuntimeAuthorization = z.infer<
  typeof privateConnectRuntimeAuthorizationSchema
>;

export const privateConnectRuntimeProjectionValidatorSchema = projectionValidator;
export type PrivateConnectRuntimeProjectionValidator = z.infer<
  typeof privateConnectRuntimeProjectionValidatorSchema
>;
