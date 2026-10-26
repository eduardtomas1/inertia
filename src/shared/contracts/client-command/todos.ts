import { z } from "zod";

import {
  dueTimeRequiresDate,
  MAX_TODOS,
  TODO_TIME_WITHOUT_DATE_MESSAGE,
  todoDraftFieldsSchema,
  todoPatchSchema,
} from "../../todos";
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
    payload: todoDraftFieldsSchema.extend({ id: z.string().uuid() })
      .refine(dueTimeRequiresDate, TODO_TIME_WITHOUT_DATE_MESSAGE),
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
    type: z.literal("todo.clearDone"),
    payload: z.object({ ids: z.array(z.string().uuid()).max(MAX_TODOS) }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("todo.start"),
    payload: z.object({
      id: z.string().uuid(),
      conversation: todoStartConversationSchema,
      replaces: z.string().uuid().optional(),
    }).strict(),
  }).strict(),
] as const;
