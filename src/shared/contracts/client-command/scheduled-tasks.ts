import { z } from "zod";

import {
  scheduledTaskCreateInputSchema,
  scheduledTaskPatchSchema,
} from "../../scheduled-tasks";
import { requestBase } from "./common";

export const scheduledTaskCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("scheduled-task.list"),
    payload: z.object({
      projectId: z.string().min(1).max(200).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("scheduled-task.create"),
    payload: scheduledTaskCreateInputSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("scheduled-task.update"),
    payload: z.object({
      taskId: z.string().uuid(),
      patch: scheduledTaskPatchSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("scheduled-task.delete"),
    payload: z.object({
      taskId: z.string().uuid(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("scheduled-task.run-now"),
    payload: z.object({
      taskId: z.string().uuid(),
    }).strict(),
  }).strict(),
] as const;
