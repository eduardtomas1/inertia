import { z } from "zod";

export const CURSOR_SDK_RUN_TIMEOUT_MS = 30 * 60_000;

const identity = z.string().min(1).max(512).refine((value) => !value.includes("\0"));
export const cursorSdkAuthoritySchema = z.object({
  conversationId: identity, turnId: identity, runId: identity, providerInstanceId: identity,
  workspace: z.string().min(1).max(4096),
}).strict();
export const cursorSdkStartSchema = z.object({
  authority: cursorSdkAuthoritySchema,
  apiKey: z.string().min(1).max(16_384),
  stateRoot: z.string().min(1).max(4096),
  prompt: z.string().min(1).max(256 * 1024),
  sessionId: identity.optional(),
  model: identity,
  nativeTools: z.enum(["none", "read", "full"]),
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), description: z.string().max(8192),
    inputSchema: z.record(z.string(), z.unknown()), readOnly: z.boolean() }).strict()).max(128).refine((tools) => new Set(tools.map(({ name }) => name)).size === tools.length),
}).strict();
export type CursorSdkStart = z.infer<typeof cursorSdkStartSchema>;
