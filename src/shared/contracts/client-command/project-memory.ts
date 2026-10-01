import { z } from "zod";
import { projectMemoryDraftSchema } from "../../project-memory";
import { requestBase } from "./common";

const scope = { projectId: z.string().uuid(), conversationId: z.string().uuid().optional() };
const mutation = { ...scope, expectedRevision: z.number().int().nonnegative() };
export const projectMemoryCommandSchemas = [
  z.strictObject({ ...requestBase, type: z.literal("project.memory.load"), payload: z.strictObject(scope) }),
  z.strictObject({ ...requestBase, type: z.literal("project.memory.save"), payload: z.strictObject({
    ...mutation, id: z.string().uuid(), mode: z.enum(["create", "update"]), entry: projectMemoryDraftSchema,
    source: z.strictObject({ conversationId: z.string().uuid(), messageId: z.string().uuid() }).optional(),
  }) }),
  z.strictObject({ ...requestBase, type: z.literal("project.memory.delete"), payload: z.strictObject({ ...mutation, id: z.string().uuid() }) }),
  z.strictObject({ ...requestBase, type: z.literal("project.memory.toggle"), payload: z.strictObject({
    ...mutation, conversationId: z.string().uuid(), expectedChatRevision: z.number().int().nonnegative(),
    id: z.string().uuid(), enabled: z.boolean(),
  }) }),
  z.strictObject({ ...requestBase, type: z.literal("project.memory.context"), payload: z.strictObject({
    projectId: z.string().uuid(), conversationId: z.string().uuid(), turnId: z.string().uuid(),
  }) }),
  z.strictObject({ ...requestBase, type: z.literal("project.memory.source"), payload: z.strictObject({
    projectId: z.string().uuid(), id: z.string().uuid(),
  }) }),
] as const;
