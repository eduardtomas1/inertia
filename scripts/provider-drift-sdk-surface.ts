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

// Native Kimi uses the same ACP v1 transport but additionally prefers the
// negotiated session/resume method before the legacy load fallback.
export const kimiClient: acp.ClientApp = acp.client({
  name: "Inertia Kimi provider drift",
});
export const kimiPermissionMethod: "session/request_permission" =
  acp.methods.client.session.requestPermission;
export const kimiCriticalMethods = {
  initialize: acp.methods.agent.initialize,
  authenticate: acp.methods.agent.authenticate,
  sessionNew: acp.methods.agent.session.new,
  sessionLoad: acp.methods.agent.session.load,
  sessionResume: acp.methods.agent.session.resume,
  sessionPrompt: acp.methods.agent.session.prompt,
  sessionCancel: acp.methods.agent.session.cancel,
  sessionSetMode: acp.methods.agent.session.setMode,
  sessionSetConfigOption: acp.methods.agent.session.setConfigOption,
  sessionUpdate: acp.methods.client.session.update,
} as const;
export type KimiSessionUpdateSurface = acp.SessionNotification["update"];
export type KimiPromptTerminalSurface = Pick<
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

/**
 * Compile-time drift fence for the message discriminants intentionally
 * projected by claude-message-projector.ts. A newly added SDK message or
 * system subtype must be reviewed instead of silently disappearing behind the
 * broad SDKMessage union import above.
 */
type ClaudeRuntimeMessageType = SDKMessage["type"] | "command_lifecycle";

export const claudeHandledMessageTypes = {
  assistant: true,
  user: true,
  result: true,
  system: true,
  stream_event: true,
  tool_progress: true,
  auth_status: true,
  prompt_suggestion: true,
  rate_limit_event: true,
  tool_use_summary: true,
  conversation_reset: true,
  command_lifecycle: true,
} as const satisfies Record<ClaudeRuntimeMessageType, true>;

type ClaudeSystemMessageSurface = Extract<SDKMessage, { type: "system" }>;

export const claudeHandledSystemSubtypes = {
  init: true,
  status: true,
  compact_boundary: true,
  api_retry: true,
  control_request_progress: true,
  model_refusal_fallback: true,
  model_refusal_no_fallback: true,
  local_command_output: true,
  hook_started: true,
  hook_progress: true,
  hook_response: true,
  plugin_install: true,
  task_started: true,
  task_progress: true,
  task_updated: true,
  task_notification: true,
  background_tasks_changed: true,
  thinking_tokens: true,
  session_state_changed: true,
  worker_shutting_down: true,
  commands_changed: true,
  notification: true,
  files_persisted: true,
  memory_recall: true,
  elicitation_complete: true,
  permission_denied: true,
  mirror_error: true,
  informational: true,
} as const satisfies Record<ClaudeSystemMessageSurface["subtype"], true>;

export type ClaudeAssistantRecoverySurface = Pick<
  SDKAssistantMessage,
  | "uuid"
  | "error"
  | "aborted"
  | "supersedes"
  | "resumed_from_incomplete_thinking"
  | "context_usage"
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
      | "message.removed"
      | "message.part.updated"
      | "message.part.delta"
      | "message.part.removed"
      | "session.deleted"
      | "session.next.agent.switched"
      | "session.next.model.switched"
      | "session.next.prompt.admitted"
      | "session.next.step.started"
      | "session.next.step.ended"
      | "session.next.step.failed"
      | "session.next.text.started"
      | "session.next.text.delta"
      | "session.next.text.ended"
      | "session.next.reasoning.started"
      | "session.next.reasoning.delta"
      | "session.next.reasoning.ended"
      | "session.next.shell.started"
      | "session.next.shell.ended"
      | "session.next.tool.called"
      | "session.next.tool.progress"
      | "session.next.tool.success"
      | "session.next.tool.failed"
      | "session.next.retried"
      | "session.next.compaction.started"
      | "session.next.compaction.ended"
      | "session.status"
      | "session.idle"
      | "session.error"
      | "permission.asked"
      | "permission.v2.asked"
      | "permission.replied"
      | "permission.v2.replied"
      | "question.asked"
      | "question.v2.asked"
      | "question.replied"
      | "question.v2.replied"
      | "question.rejected"
      | "question.v2.rejected"
      | "session.compacted"
      | "todo.updated";
  }
>;

/** Compile-time review fence for every installed OpenCode v2 event. */
export const openCodeEventDispositions = {
  "models-dev.refreshed": "ignored",
  "integration.updated": "ignored",
  "integration.connection.updated": "ignored",
  "catalog.updated": "ignored",
  "session.created": "ignored",
  "session.updated": "ignored",
  "session.deleted": "projected",
  "message.updated": "projected",
  "message.removed": "projected",
  "message.part.updated": "projected",
  "message.part.removed": "projected",
  "session.next.agent.switched": "projected",
  "session.next.model.switched": "projected",
  "session.next.moved": "ignored",
  "session.next.prompted": "projected",
  "session.next.prompt.admitted": "projected",
  "session.next.context.updated": "ignored",
  "session.next.synthetic": "ignored",
  "session.next.shell.started": "projected",
  "session.next.shell.ended": "projected",
  "session.next.step.started": "projected",
  "session.next.step.ended": "projected",
  "session.next.step.failed": "projected",
  "session.next.text.started": "projected",
  "session.next.text.delta": "projected",
  "session.next.text.ended": "projected",
  "session.next.reasoning.started": "projected",
  "session.next.reasoning.delta": "projected",
  "session.next.reasoning.ended": "projected",
  "session.next.tool.input.started": "ignored",
  "session.next.tool.input.delta": "ignored",
  "session.next.tool.input.ended": "ignored",
  "session.next.tool.called": "projected",
  "session.next.tool.progress": "projected",
  "session.next.tool.success": "projected",
  "session.next.tool.failed": "projected",
  "session.next.retried": "projected",
  "session.next.compaction.started": "projected",
  "session.next.compaction.delta": "ignored",
  "session.next.compaction.ended": "projected",
  "session.next.revert.staged": "ignored",
  "session.next.revert.cleared": "ignored",
  "session.next.revert.committed": "ignored",
  "message.part.delta": "projected",
  "session.diff": "ignored",
  "session.error": "projected",
  "installation.updated": "ignored",
  "installation.update-available": "ignored",
  "file.edited": "ignored",
  "reference.updated": "ignored",
  "permission.v2.asked": "projected",
  "permission.v2.replied": "projected",
  "plugin.added": "ignored",
  "project.directories.updated": "ignored",
  "file.watcher.updated": "ignored",
  "pty.created": "ignored",
  "pty.updated": "ignored",
  "pty.exited": "ignored",
  "pty.deleted": "ignored",
  "question.v2.asked": "projected",
  "question.v2.replied": "projected",
  "question.v2.rejected": "projected",
  "todo.updated": "projected",
  "lsp.updated": "ignored",
  "permission.asked": "projected",
  "permission.replied": "projected",
  "tui.prompt.append": "ignored",
  "tui.command.execute": "ignored",
  "tui.toast.show": "ignored",
  "tui.session.select": "ignored",
  "mcp.tools.changed": "ignored",
  "mcp.browser.open.failed": "ignored",
  "command.executed": "ignored",
  "project.updated": "ignored",
  "session.status": "projected",
  "session.idle": "projected",
  "question.asked": "projected",
  "question.replied": "projected",
  "question.rejected": "projected",
  "session.compacted": "projected",
  "vcs.branch.updated": "ignored",
  "workspace.ready": "ignored",
  "workspace.failed": "ignored",
  "workspace.status": "ignored",
  "worktree.ready": "ignored",
  "worktree.failed": "ignored",
  "server.connected": "ignored",
  "global.disposed": "ignored",
  "server.instance.disposed": "ignored",
} as const satisfies Record<Event["type"], "projected" | "ignored">;
