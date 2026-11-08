import { z } from "zod";

export const MAX_MANAGED_PROMPT_CHARS = 32_768;
export const SINGLE_LINE_PATTERN = "^[^\\S\\x00-\\x1f\\x7f]*[^\\s\\x00-\\x1f\\x7f][^\\x00-\\x1f\\x7f]*$";
export const MULTILINE_PATTERN = "^\\s*[^\\s\\x00][^\\x00]*$";
export const tokenPattern = (maximum: number) => `^[^\\s\\x00-\\x1f\\x7f]{1,${maximum}}$`;
export const PROVIDER_ROUTE_IDS = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity", "pi"] as const;

export const idSchema = z.string().uuid();
export const safeSingleLineSchema = (maximum: number) => z.string()
  .max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must be one line without control characters")
  .trim()
  .min(1);
export const safeMultilineSchema = (maximum: number) => z.string()
  .max(maximum)
  .refine((value) => !value.includes("\0"), "must not contain NUL characters")
  .trim()
  .min(1);
export const tokenSchema = (maximum: number) => z.string()
  .max(maximum)
  .regex(new RegExp(tokenPattern(maximum), "u"), "must be one word without spaces or control characters");
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
