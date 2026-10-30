import { z } from "zod";

import { orchestrationIdSchema as id } from "./orchestration-identities";

const nativeId = z.string().min(1).max(512).regex(/^[^\u0000-\u0020\u007f]+$/u);

/** Provider-authored references, distinct from application run/turn identities. */
export const nativeBoundarySchema = z.object({
  nativeConversationId: nativeId,
  nativeSessionId: nativeId.nullable(),
  nativeTurnId: nativeId.nullable(),
  persistedHeadId: nativeId.nullable(),
  phase: z.enum(["started", "settled"]),
}).strict();

export const orchestrationNativeBoundarySchema = nativeBoundarySchema.extend({
  threadId: id, projectId: id, runId: id, attemptId: id,
  providerInstanceId: id, workspaceKey: z.string().min(1).max(4_096),
  updatedAt: z.iso.datetime(),
}).strict();

export const nativeBoundaryEventSchema = z.object({
  type: z.literal("provider.native-boundary"),
  payload: z.object({ runId: id, attemptId: id, boundary: nativeBoundarySchema }).strict(),
}).strict();

export type NativeBoundary = z.infer<typeof nativeBoundarySchema>;
export type OrchestrationNativeBoundary = z.infer<typeof orchestrationNativeBoundarySchema>;
