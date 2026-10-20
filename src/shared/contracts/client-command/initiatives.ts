import { z } from "zod";

import {
  initiativeColorSchema,
  initiativeNameInputSchema,
  initiativeStatusSchema,
} from "../../initiatives";
import { requestBase } from "./common";

export const initiativeCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("initiative.create"),
    payload: z.object({
      /** Renderer-allocated identity so a new initiative can be selected at once. */
      id: z.string().uuid(),
      name: initiativeNameInputSchema,
      color: initiativeColorSchema.optional(),
      /** Optionally moves this chat into the new initiative in the same transaction. */
      conversationId: z.string().uuid().optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.update"),
    payload: z.object({
      id: z.string().uuid(),
      expectedRevision: z.number().int().min(0),
      name: initiativeNameInputSchema.optional(),
      color: initiativeColorSchema.optional(),
      status: initiativeStatusSchema.optional(),
    }).strict().refine(
      ({ name, color, status }) => name !== undefined || color !== undefined || status !== undefined,
      "An initiative update must change at least one field.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.delete"),
    payload: z.object({ id: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.assign"),
    payload: z.object({
      conversationId: z.string().uuid(),
      initiativeId: z.string().uuid().nullable(),
    }).strict(),
  }).strict(),
] as const;
