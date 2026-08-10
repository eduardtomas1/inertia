import { z } from "zod";

import { modelSelectionSchema } from "../../model-routing";
import {
  accessModeSchema,
  interactionModeSchema,
  providerIdSchema,
  requestBase,
} from "./common";

export const conversationCreatePayloadSchema = z
  .object({
    projectId: z.string().uuid(),
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
  })
  .strict();

export const conversationCreateCommandSchema = z
  .object({
    ...requestBase,
    type: z.literal("conversation.create"),
    payload: conversationCreatePayloadSchema,
  })
  .strict();
