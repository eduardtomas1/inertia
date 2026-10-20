import { z } from "zod";

import {
  initiativeBriefSchema,
  initiativeColorSchema,
  initiativeNameInputSchema,
  initiativeNoteBodySchema,
  initiativeNoteTitleInputSchema,
  initiativePreferencesPatchSchema,
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
      /** Shared tool settings to change; omitted settings keep their value. */
      preferences: initiativePreferencesPatchSchema.optional(),
    }).strict().refine(
      ({ name, color, status, preferences }) => name !== undefined || color !== undefined
        || status !== undefined || preferences !== undefined,
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
  z.object({
    ...requestBase,
    type: z.literal("initiative.brief.update"),
    payload: z.object({
      id: z.string().uuid(),
      expectedBriefRevision: z.number().int().min(0),
      brief: initiativeBriefSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.notes.list"),
    payload: z.object({ initiativeId: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.note.create"),
    payload: z.object({
      initiativeId: z.string().uuid(),
      title: initiativeNoteTitleInputSchema,
      body: initiativeNoteBodySchema,
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.note.update"),
    payload: z.object({
      id: z.string().uuid(),
      expectedRevision: z.number().int().min(0),
      title: initiativeNoteTitleInputSchema.optional(),
      body: initiativeNoteBodySchema.optional(),
    }).strict().refine(
      ({ title, body }) => title !== undefined || body !== undefined,
      "A note update must change its title or body.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.note.resolve"),
    payload: z.object({
      id: z.string().uuid(),
      expectedRevision: z.number().int().min(0),
      decision: z.enum(["accept", "reject"]),
      title: initiativeNoteTitleInputSchema.optional(),
      body: initiativeNoteBodySchema.optional(),
    }).strict().refine(
      ({ decision, title, body }) => decision === "accept" || (title === undefined && body === undefined),
      "Only an accepted note can be edited.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("initiative.note.delete"),
    payload: z.object({ id: z.string().uuid() }).strict(),
  }).strict(),
] as const;
