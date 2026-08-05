import { z } from "zod";

import {
  privateConnectQuestionAnswersSchema,
  privateConnectSafeQuestionsSchema,
} from "./questions";
import {
  PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS,
  privateConnectRuntimeGrantSchema,
  type PrivateConnectRuntimeGrant,
} from "./runtime-grants";

export const PRIVATE_CONNECT_RUNTIME_LIMITS = Object.freeze({
  plaintextBytes: 96 * 1024,
  promptCharacters: 8_000,
  transcriptMessages: 200,
  activities: 200,
  subagents: 64,
  sessions: 8,
  inFlightRequestsPerSession: 8,
  deliveryReceipts: 512,
});

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().min(1).max(200);
const safeLabel = z.string().max(240);
const safeContent = z.string().max(64 * 1024);
const projectionValidator = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const privateConnectRuntimeScopeSchema = z.enum(["view", "prompt"]);
export type PrivateConnectRuntimeScope = z.infer<typeof privateConnectRuntimeScopeSchema>;

export const privateConnectRuntimeGrantsSchema = z.array(
  privateConnectRuntimeGrantSchema,
).max(PRIVATE_CONNECT_RUNTIME_GRANT_LIMITS.projects);

export const privateConnectRuntimeSafeProjectSchema = z.object({
  id: entityId,
  name: safeLabel,
}).strict();
export type PrivateConnectRuntimeProject = z.infer<
  typeof privateConnectRuntimeSafeProjectSchema
>;

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

export const privateConnectRuntimeSafeConversationDetailSchema = z.object({
  generatedAt: timestamp,
  conversation: privateConnectRuntimeSafeConversationSchema,
  messages: z.array(privateConnectRuntimeSafeMessageSchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages),
  activities: z.array(privateConnectRuntimeSafeActivitySchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.activities),
  subagents: z.array(privateConnectRuntimeSafeSubagentSchema).max(PRIVATE_CONNECT_RUNTIME_LIMITS.subagents),
  plan: z.object({
    steps: z.array(z.object({
      label: safeLabel,
      status: z.enum(["pending", "inProgress", "completed"]),
    }).strict()).max(100),
  }).strict().nullable().optional(),
  inputRequestId: uuid.nullable().optional(),
  questions: privateConnectSafeQuestionsSchema.optional(),
  waitingForLocalAction: z.boolean(),
}).strict();

export const privateConnectRuntimeRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.get"), requestId: uuid, ifNoneMatch: projectionValidator.nullable().optional() }).strict(),
  z.object({ type: z.literal("conversation.get"), requestId: uuid, conversationId: uuid, ifNoneMatch: projectionValidator.nullable().optional() }).strict(),
  z.object({ type: z.literal("prompt.send"), requestId: uuid, deliveryId: uuid, conversationId: uuid, content: z.string().trim().min(1).max(PRIVATE_CONNECT_RUNTIME_LIMITS.promptCharacters) }).strict(),
  z.object({ type: z.literal("input.respond"), requestId: uuid, inputRequestId: uuid, conversationId: uuid, answers: privateConnectQuestionAnswersSchema }).strict(),
  z.object({ type: z.literal("run.stop"), requestId: uuid, runId: entityId, conversationId: uuid }).strict(),
]);
export type PrivateConnectRuntimeRequest = z.infer<typeof privateConnectRuntimeRequestSchema>;

export const privateConnectRuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"), requestId: uuid, ok: z.literal(true),
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("state"), validator: projectionValidator.optional(), state: privateConnectRuntimeSafeShellSchema }).strict(),
      z.object({ kind: z.literal("conversation"), validator: projectionValidator.optional(), detail: privateConnectRuntimeSafeConversationDetailSchema }).strict(),
      z.object({ kind: z.literal("not-modified"), validator: projectionValidator, checkedAt: timestamp, resource: z.discriminatedUnion("kind", [z.object({ kind: z.literal("state") }).strict(), z.object({ kind: z.literal("conversation"), conversationId: uuid }).strict()]) }).strict(),
      z.object({ kind: z.literal("prompt.accepted"), deliveryId: uuid, turnId: entityId }).strict(),
      z.object({ kind: z.literal("input.accepted"), conversationId: uuid, inputRequestId: uuid }).strict(),
      z.object({ kind: z.literal("run.stopped"), conversationId: uuid, runId: entityId, alreadyStopped: z.boolean() }).strict(),
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

export type { PrivateConnectRuntimeGrant };
