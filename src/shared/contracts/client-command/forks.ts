import { z } from "zod";
import { requestBase } from "./common";

export const forkCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("conversation.fork"), payload: z.object({
    projectId: z.string().uuid(), sourceConversationId: z.string().uuid(), sourceTurnId: z.string().uuid(),
    title: z.string().trim().min(1).max(120).optional(), activate: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.fork.history"), payload: z.object({
    conversationId: z.string().uuid(), afterRevision: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.merge-back"), payload: z.object({
    forkConversationId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.rollback"), payload: z.object({
    conversationId: z.string().uuid(), turnId: z.string().uuid().nullable(),
  }).strict() }).strict(),
] as const;
