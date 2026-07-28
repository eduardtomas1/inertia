import * as acp from "@agentclientprotocol/sdk";
import {
  query as claudeQuery,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createOpencodeClient,
  type Agent,
  type Event,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type Provider,
  type QuestionInfo,
} from "@opencode-ai/sdk/v2";

export const cursorClient: acp.ClientApp = acp.client({ name: "Inertia provider drift" });
export const cursorPermissionMethod: "session/request_permission" =
  acp.methods.client.session.requestPermission;

export type ClaudeQueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeOptions;
}) => Query;
export const createClaudeQuery: ClaudeQueryFactory = claudeQuery;
export const claudeCanUseTool: CanUseTool = async (
  toolName,
  input,
  callbackOptions,
) => {
  const productApprovalSurface = {
    toolName,
    input,
    signal: callbackOptions.signal,
    toolUseID: callbackOptions.toolUseID,
    title: callbackOptions.title,
    description: callbackOptions.description,
    decisionReason: callbackOptions.decisionReason,
    blockedPath: callbackOptions.blockedPath,
  };
  void productApprovalSurface;
  return {
    behavior: "allow",
    updatedInput: input,
  } satisfies PermissionResult;
};
export const claudeProductOptions = {
  abortController: new AbortController(),
  cwd: ".",
  env: {},
  pathToClaudeCodeExecutable: "claude",
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  canUseTool: claudeCanUseTool,
  resume: "provider-session-id",
  model: "provider-model-id",
  effort: "high",
} satisfies ClaudeOptions;
export type ClaudeMetadataSurface = Pick<
  Query,
  "supportedModels" | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
>;

export const openCodeClient: OpencodeClient = createOpencodeClient({
  baseUrl: "http://127.0.0.1:9",
  directory: ".",
  throwOnError: true,
});
export type OpenCodeSurface =
  | Agent
  | Event
  | Model
  | PermissionRuleset
  | Provider
  | QuestionInfo;
