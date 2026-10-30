import { z } from "zod";

import { modelSelectionSchema, versionedContinuationIdentitySchema } from "./model-routing";
import { orchestrationIdSchema as id } from "./orchestration-identities";

const nativeId = z.string().min(1).max(512).regex(/^[^\u0000-\u0020\u007f]+$/u);
export const nativeConversationIdentitySchema = z.object({
  projectId: id, conversationId: id, workspaceId: id, repositoryId: id.nullable(), providerInstanceId: id,
}).strict();
export const nativeConversationBackingSchema = z.object({
  nativeConversationId: nativeId, nativeSessionId: nativeId.optional(),
  headId: nativeId.nullable(), persistedHeadId: nativeId.nullable(),
  continuation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("resume-cursor"), nativeConversationId: nativeId, resumeSessionAt: nativeId }).strict(),
    z.object({ kind: z.literal("new-session"), nativeConversationId: nativeId }).strict(),
  ]).optional(),
}).strict();
export const nativeForkRequestSchema = z.object({
  kind: z.literal("fork"), operationId: id, targetConversationId: id,
  source: z.object({ identity: nativeConversationIdentitySchema, nativeConversationId: nativeId,
    nativeSessionId: nativeId.optional(), expectedHeadId: nativeId.nullable() }).strict(),
  boundary: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("turn"), nativeTurnId: nativeId }).strict(),
    z.object({ kind: z.literal("start"), inheritedHeadId: nativeId.optional() }).strict(),
  ]),
}).strict();

export const nativeControlSchema = z.object({
  id, threadId: id, projectId: id, runtimeId: id,
  systemBootId: id.nullable(),
  request: nativeForkRequestSchema,
  sourceWorkspaceKey: z.string().min(1).max(4_096), targetWorkspaceKey: z.string().min(1).max(4_096),
  selection: modelSelectionSchema, continuationIdentity: versionedContinuationIdentitySchema,
  state: z.enum(["running", "completed", "portable", "uncertain"]),
  backing: nativeConversationBackingSchema.nullable(),
  reason: id.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();

export const nativeControlEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("native.control-started"), payload: nativeControlSchema }).strict(),
  z.object({ type: z.literal("native.control-settled"), payload: z.object({
    id, state: z.enum(["completed", "portable", "uncertain"]),
    backing: nativeConversationBackingSchema.nullable(), reason: id.nullable(),
  }).strict() }).strict(),
  z.object({ type: z.literal("fork.portable-selected"), payload: z.object({ reason: id }).strict() }).strict(),
]);

export type NativeControl = z.infer<typeof nativeControlSchema>;
export type NativeControlEvent = z.infer<typeof nativeControlEventSchema>;
