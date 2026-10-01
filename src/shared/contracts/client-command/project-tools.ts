import { z } from "zod";
import { requestBase } from "./common";
import { projectToolDraftSchema } from "../../project-tools";

export const projectToolCommandSchemas = [
  z.strictObject({ ...requestBase, type: z.literal("project.tools.load"), payload: z.strictObject({ projectId: z.uuid(), conversationId: z.uuid().optional() }) }),
  z.strictObject({ ...requestBase, type: z.literal("project.tools.save"), payload: z.strictObject({
    projectId: z.uuid(), connection: projectToolDraftSchema,
    id: z.uuid().optional(), revision: z.number().int().positive().optional(),
  }).refine((value) => (value.id === undefined) === (value.revision === undefined)) }),
  z.strictObject({ ...requestBase, type: z.literal("project.tools.remove"), payload: z.strictObject({ projectId: z.uuid(), id: z.uuid(), revision: z.number().int().positive() }) }),
] as const;
