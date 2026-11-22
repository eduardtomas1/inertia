import { z } from "zod";

import {
  MAX_PROMPT_CHARS, MULTILINE_PATTERN, SINGLE_LINE_PATTERN, idSchema, safeMultilineSchema, safeSingleLineSchema,
  tokenPattern, tokenSchema,
} from "./managed-chat-schemas";

export {
  MULTILINE_PATTERN, SINGLE_LINE_PATTERN, idSchema, safeMultilineSchema, safeSingleLineSchema, tokenPattern, tokenSchema,
};
export const MAX_MANAGED_PROMPT_CHARS = MAX_PROMPT_CHARS;
export const PROVIDER_ROUTE_IDS = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity", "grok", "pi"] as const;

export const routeSchema = z.object({
  providerId: z.enum(PROVIDER_ROUTE_IDS).optional(),
  backendProfileId: tokenSchema(200).optional(),
  modelId: safeSingleLineSchema(300).optional(),
  reasoningEffort: tokenSchema(100).nullable().optional(),
}).strict();
export const workspaceSchema = z.object({
  kind: z.enum(["project", "reuse-current", "isolated"]),
  sourceBranch: tokenSchema(255).optional(),
}).strict();

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
