import { z } from "zod";

import { todoDraftSchema, todoPatchSchema } from "../../todos";
import { requestBase } from "./common";
import { conversationCreatePayloadSchema } from "./conversation-create";

export const todoStartConversationSchema = conversationCreatePayloadSchema.omit({
  title: true,
  draftConversationId: true,
  activate: true,
});

export const todoCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("todo.create"),
    payload: todoDraftSchema.extend({
      id: z.string().uuid(),
      /** The linked chat's project, required with `conversationId` so the runtime can check both identities. */
      projectId: z.string().uuid().optional(),
    }).strict().refine(
      ({ conversationId, projectId }) => (conversationId === undefined) === (projectId === undefined),
      "A task linked to a chat must name the chat's project.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("todo.update"),
    payload: z.object({ id: z.string().uuid(), patch: todoPatchSchema }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("todo.delete"),
    payload: z.object({ id: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("todo.start"),
    payload: z.object({
      id: z.string().uuid(),
      conversation: todoStartConversationSchema,
    }).strict(),
  }).strict(),
] as const;

export type TodoStartConversation = z.infer<typeof todoStartConversationSchema>;
