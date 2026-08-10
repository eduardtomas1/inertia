import { z } from "zod";

import {
  MAX_PROMPT_PRESETS,
  promptPresetDraftSchema,
  promptPresetRouteSchema,
} from "../../prompt-presets";
import { requestBase } from "./common";

const presetIdsSchema = z.array(z.string().uuid()).max(MAX_PROMPT_PRESETS)
  .refine(
    (values) => new Set(values).size === values.length,
    "Preset order cannot contain duplicate identities.",
  );

export const promptPresetCommandSchema = z.discriminatedUnion("type", [
  z.object({
    ...requestBase,
    type: z.literal("prompt-preset.create"),
    payload: promptPresetDraftSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("prompt-preset.update"),
    payload: z.object({
      presetId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      name: promptPresetDraftSchema.shape.name.optional(),
      body: promptPresetDraftSchema.shape.body.optional(),
      route: promptPresetRouteSchema.nullable().optional(),
    }).strict().refine(
      ({ name, body, route }) => (
        name !== undefined || body !== undefined || route !== undefined
      ),
      "A preset update must change at least one field.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("prompt-preset.duplicate"),
    payload: z.object({
      presetId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("prompt-preset.delete"),
    payload: z.object({
      presetId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("prompt-preset.reorder"),
    payload: z.object({
      expectedPresetIds: presetIdsSchema,
      presetIds: presetIdsSchema,
    }).strict(),
  }).strict(),
]);
