import { z } from "zod";

import { modelSelectionSchema } from "../../model-routing";
import { MAX_CONVERSATION_CONTEXT_MESSAGES } from "../../conversation-context";
import {
  accessModeSchema,
  interactionModeSchema,
  providerIdSchema,
  requestBase,
} from "./common";

export const conversationCreateBasePayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    draftConversationId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(120),
    providerId: providerIdSchema.optional(),
    modelSelection: modelSelectionSchema.optional(),
    model: z.string().trim().max(160).optional(),
    reasoningEffort: z.string().trim().max(40).optional(),
    interactionMode: interactionModeSchema.optional(),
    accessMode: accessModeSchema.optional(),
    activate: z.boolean().optional(),
    useWorktree: z.boolean().optional(),
    branch: z.string().trim().min(1).max(255).nullable().optional(),
    worktreePath: z.string().min(1).max(4096).nullable().optional(),
    continuation: z.strictObject({
      sourceConversationId: z.string().uuid(),
      expectedUpdatedAt: z.string().datetime({ offset: true }),
      sourceMessageIds: z.array(z.string().uuid()).min(1).max(MAX_CONVERSATION_CONTEXT_MESSAGES)
        .refine((ids) => new Set(ids).size === ids.length),
    }).optional(),
  })
  .strict();

export const conversationCreatePayloadSchema = conversationCreateBasePayloadSchema.superRefine((payload, context) => {
  if (payload.continuation && (!payload.draftConversationId || payload.useWorktree !== undefined
    || payload.branch !== undefined || payload.worktreePath !== undefined)) {
    context.addIssue({ code: "custom", message: "A continuation requires its own chat ID and inherits its source checkout." });
  }
});

export const conversationCreateCommandSchema = z
  .object({
    ...requestBase,
    type: z.literal("conversation.create"),
    payload: conversationCreatePayloadSchema,
  })
  .strict();
