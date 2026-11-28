import { z } from "zod";

import {
  MAX_PROMPT_CHARS, MULTILINE_PATTERN, SINGLE_LINE_PATTERN, idSchema, safeMultilineSchema, safeSingleLineSchema,
  tokenPattern, tokenSchema,
} from "./managed-chat-schemas";

export {
  MULTILINE_PATTERN, SINGLE_LINE_PATTERN, idSchema, safeMultilineSchema, safeSingleLineSchema, tokenPattern, tokenSchema,
};
export const MAX_MANAGED_PROMPT_CHARS = MAX_PROMPT_CHARS;
export const MAX_JSON_OBJECT_STRING_BYTES = 4_096;
export const PROVIDER_ROUTE_IDS = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity", "grok", "pi"] as const;

/**
 * Accepts models that serialize nested object tool arguments (`route`, `workspace`)
 * as a JSON string (`5b6f7c81c`). Bounded to `MAX_JSON_OBJECT_STRING_BYTES`, only
 * parses plain JSON objects, and leaves invalid or oversized values untouched so
 * Zod reports a clean validation error.
 */
export function jsonObjectPreprocess<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_OBJECT_STRING_BYTES) return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return value;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Leave the original string so the inner object schema rejects cleanly via Zod.
    }
    return value;
  }, schema);
}

const routeObjectSchema = z.object({
  providerId: z.enum(PROVIDER_ROUTE_IDS).optional(),
  backendProfileId: tokenSchema(200).optional(),
  modelId: safeSingleLineSchema(300).optional(),
  reasoningEffort: tokenSchema(100).nullable().optional(),
}).strict();

const workspaceObjectSchema = z.object({
  kind: z.enum(["project", "reuse-current", "isolated"]),
  sourceBranch: tokenSchema(255).optional(),
}).strict();

export const routeSchema = jsonObjectPreprocess(routeObjectSchema);
export const workspaceSchema = jsonObjectPreprocess(workspaceObjectSchema);

export const ROUTE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    providerId: { enum: [...PROVIDER_ROUTE_IDS] },
    backendProfileId: { type: "string", pattern: tokenPattern(200) },
    modelId: { type: "string", maxLength: 300, pattern: SINGLE_LINE_PATTERN },
    reasoningEffort: { type: ["string", "null"], pattern: tokenPattern(100) },
  },
} as const;
export const WORKSPACE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { enum: ["project", "reuse-current", "isolated"] },
    sourceBranch: { type: "string", pattern: tokenPattern(255) },
  },
  required: ["kind"],
} as const;

export type ManagedRouteInput = z.infer<typeof routeSchema>;
export type ManagedWorkspaceInput = z.infer<typeof workspaceSchema>;
