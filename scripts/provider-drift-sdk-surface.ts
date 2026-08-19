import * as acp from "@agentclientprotocol/sdk";
import {
  query as claudeQuery,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskStartedMessage,
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
export const cursorCriticalMethods = {
  initialize: acp.methods.agent.initialize,
  authenticate: acp.methods.agent.authenticate,
  sessionNew: acp.methods.agent.session.new,
  sessionLoad: acp.methods.agent.session.load,
  sessionPrompt: acp.methods.agent.session.prompt,
  sessionCancel: acp.methods.agent.session.cancel,
  sessionSetMode: acp.methods.agent.session.setMode,
  sessionSetConfigOption: acp.methods.agent.session.setConfigOption,
  sessionUpdate: acp.methods.client.session.update,
} as const;
export type CursorSessionUpdateSurface = acp.SessionNotification["update"];
export type CursorPromptTerminalSurface = Pick<
  acp.PromptResponse,
  "stopReason" | "usage"
>;

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
  | "close"
  | "interrupt"
  | "stopTask"
  | "supportedModels"
  | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
>;
export type ClaudeUserMessageToolResultSurface = Pick<
  SDKUserMessage,
  "tool_use_result"
>;
export type ClaudeLifecycleMessageSurface =
  | SDKMessage
  | SDKAssistantMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage
  | SDKTaskStartedMessage
  | SDKTaskNotificationMessage;

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
export const openCodeCriticalMethods = {
  subscribe: openCodeClient.event.subscribe,
  promptAsync: openCodeClient.session.promptAsync,
  abort: openCodeClient.session.abort,
  permissionReply: openCodeClient.permission.reply,
  questionReply: openCodeClient.question.reply,
  questionReject: openCodeClient.question.reject,
} as const;
export type OpenCodeLifecycleEventSurface = Extract<
  Event,
  {
    type:
      | "message.updated"
      | "message.part.updated"
      | "message.part.delta"
      | "message.part.removed"
      | "session.next.prompt.admitted"
      | "session.status"
      | "session.idle"
      | "session.error"
      | "permission.asked"
      | "permission.v2.asked"
      | "question.asked"
      | "question.v2.asked"
      | "todo.updated";
  }
>;
