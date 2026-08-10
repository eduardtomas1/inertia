import { z } from "zod";

import {
  harnessIdSchema,
  modelBackendProfileIdSchema,
} from "./model-routing";

export const MAX_PROMPT_PRESETS = 30;
export const MAX_PROMPT_PRESET_NAME_CHARS = 80;
export const MAX_PROMPT_PRESET_BODY_CHARS = 20_000;
export const MAX_PROMPT_PRESET_ROUTE_JSON_CHARS = 1_024;
export const MAX_PROMPT_PRESETS_SERIALIZED_BYTES = 384 * 1_024;

const timestampSchema = z.string().datetime({ offset: true });
const promptPresetNameSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_PROMPT_PRESET_NAME_CHARS)
  .refine(
    (value) => !/[\0\r\n]/u.test(value),
    "Preset names must stay on one line.",
  );
const promptPresetBodySchema = z.string()
  .min(1)
  .max(MAX_PROMPT_PRESET_BODY_CHARS)
  .refine((value) => value.trim().length > 0, "Preset text cannot be blank.")
  .refine((value) => !value.includes("\0"), "Preset text cannot contain NUL bytes.");

/**
 * Deliberately narrower than ModelSelection: presets cannot retain endpoints,
 * provider options, capabilities, filesystem context, or continuation state.
 */
export const promptPresetRouteSchema = z.object({
  harnessId: harnessIdSchema,
  backendProfileId: modelBackendProfileIdSchema,
  modelId: z.string().min(1).max(300).refine(
    (value) => !/[\0\r\n]/u.test(value),
    "Preset model identities cannot contain control lines.",
  ),
  reasoningEffort: z.string().max(100).refine(
    (value) => !/[\0\r\n]/u.test(value),
    "Preset reasoning identities cannot contain control lines.",
  ).nullable(),
}).strict().superRefine((value, context) => {
  // Match SQLite's length(route_json) contract after JSON escaping. Checking
  // the individual fields is insufficient because permitted control
  // characters and lone surrogates expand when serialized.
  const serializedCharacters = Array.from(JSON.stringify(value)).length;
  if (serializedCharacters > MAX_PROMPT_PRESET_ROUTE_JSON_CHARS) {
    context.addIssue({
      code: "custom",
      message: `Preset routes cannot exceed ${MAX_PROMPT_PRESET_ROUTE_JSON_CHARS} stored characters.`,
    });
  }
});

export const promptPresetDraftSchema = z.object({
  name: promptPresetNameSchema,
  body: promptPresetBodySchema,
  route: promptPresetRouteSchema.nullable(),
}).strict();

export const promptPresetSchema = promptPresetDraftSchema.extend({
  id: z.string().uuid(),
  position: z.number().int().min(0).max(MAX_PROMPT_PRESETS - 1),
  revision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export type PromptPresetRoute = z.infer<typeof promptPresetRouteSchema>;
export type PromptPresetDraft = z.infer<typeof promptPresetDraftSchema>;
export type PromptPreset = z.infer<typeof promptPresetSchema>;

export function promptPresetRouteMatches(
  selection: PromptPresetRoute,
  route: PromptPresetRoute,
): boolean {
  return selection.harnessId === route.harnessId
    && selection.backendProfileId === route.backendProfileId
    && selection.modelId === route.modelId
    && selection.reasoningEffort === route.reasoningEffort;
}

export function promptPresetsSerializedBytes(
  presets: readonly PromptPreset[],
): number {
  return new TextEncoder().encode(JSON.stringify(presets)).byteLength;
}

export function promptPresetNameFromBody(body: string): string {
  const firstLine = body.split(/\r?\n/u, 1)[0]?.replace(/\s+/gu, " ").trim()
    ?? "";
  if (!firstLine) return "Untitled preset";
  return firstLine.length <= MAX_PROMPT_PRESET_NAME_CHARS
    ? firstLine
    : `${boundedNamePrefix(firstLine, MAX_PROMPT_PRESET_NAME_CHARS - 1)}…`;
}

export function duplicatePromptPresetName(name: string): string {
  const suffix = " copy";
  return `${boundedNamePrefix(
    name,
    MAX_PROMPT_PRESET_NAME_CHARS - suffix.length,
  )}${suffix}`;
}

function boundedNamePrefix(value: string, maximum: number): string {
  let prefix = value.slice(0, maximum);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix.trimEnd();
}
