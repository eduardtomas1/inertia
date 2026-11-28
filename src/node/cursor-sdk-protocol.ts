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
  /**
   * The checkout whose store holds `sessionId` when the chat moved here with it. Cursor keys custom-store
   * lookups by cwd, so the agent is resumed through a platform scoped to this checkout and runs in
   * `authority.workspace` (T3 `cursorStoreCwd`). Never set without `sessionId`.
   */
  storeWorkspace: z.string().min(1).max(4096).refine((value) => !value.includes("\0")).optional(),
  /** The agent's own store (see `cursorSdkStorePlan`), when it has or may get one. */
  agentStateRoot: z.string().min(1).max(4096).refine((value) => !value.includes("\0")).optional(),
  /** The store of the checkout `storeWorkspace` names, to adopt the agent from when it has no store of its own yet. */
  adoptFrom: z.string().min(1).max(4096).refine((value) => !value.includes("\0")).optional(),
  model: identity,
  nativeTools: z.enum(["none", "read", "full"]),
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), description: z.string().max(8192),
    inputSchema: z.record(z.string(), z.unknown()), readOnly: z.boolean() }).strict()).max(128).refine((tools) => new Set(tools.map(({ name }) => name)).size === tools.length),
}).strict().refine((start) => (start.storeWorkspace === undefined
  || (start.sessionId !== undefined && start.storeWorkspace !== start.authority.workspace))
  && (start.agentStateRoot === undefined || start.sessionId !== undefined)
  && (start.adoptFrom === undefined || (start.agentStateRoot !== undefined && start.storeWorkspace !== undefined
    && start.adoptFrom !== start.agentStateRoot)));
export type CursorSdkStart = z.infer<typeof cursorSdkStartSchema>;

/**
 * The worker's answer to `start`. `runCheckpointed`: whether Cursor saved a checkpoint for the run (T3 c5fa33b27),
 * read in the worker from its store's records once the store was closed, so no write lands after it; absent when the
 * store could not tell. A run that ended without verified terminal evidence (an error, an output limit, a Stop) is
 * `unverified`: it is still a failure, and the checkpoint answer is all the worker reports about it.
 */
export const cursorSdkStartResultSchema = z.union([
  z.object({ unverified: z.literal(true), agentId: identity, id: identity, runCheckpointed: z.boolean() }).strict(),
  z.object({ agentId: identity, id: identity, status: z.enum(["finished", "cancelled", "error"]),
    runCheckpointed: z.boolean().optional(), unverified: z.undefined().optional() }).passthrough(),
]);
export type CursorSdkStartResult = z.infer<typeof cursorSdkStartResultSchema>;
