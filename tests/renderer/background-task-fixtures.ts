import type {
  AgentTurn,
  SubagentTaskUsage,
  SubagentTrace,
  WorkspaceRun,
} from "../../src/shared/contracts";

export const harnessByProvider = {
  codex: "codex-app-server",
  claude: "claude-agent-sdk",
  opencode: "opencode-sdk",
  cursor: "cursor-acp",
  kimi: "kimi-acp",
  antigravity: "antigravity-cli",
} as const;

export function taskUsage(
  update: Partial<SubagentTaskUsage> = {},
): SubagentTaskUsage {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    contextTokens: null,
    maxContextTokens: null,
    ...update,
  };
}

export function taskTrace(update: Partial<SubagentTrace> = {}): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: "trace-1",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "claude",
    providerTaskId: "task-1",
    providerAgentId: "agent-1",
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-1",
    providerRole: null,
    providerName: "Evidence scout",
    providerStatus: null,
    status,
    isLive: update.isLive ?? ["queued", "spawned", "running", "waiting"].includes(status),
    description: "Inspect the provider lifecycle.",
    progress: null,
    result: null,
    model: null,
    activity: null,
    usage: null,
    toolUseCount: null,
    durationMs: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:30.000Z",
    ...update,
  };
}

export function taskTurn(update: Partial<AgentTurn> = {}): AgentTurn {
  const providerId = update.providerId ?? "claude";
  const harnessId = update.harnessId ?? harnessByProvider[providerId];
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId,
    modelSelection: {
      harnessId,
      backendProfileId: `builtin:${providerId}`,
      backendProfileDisplayName: providerId,
      backendConfigurationRevision: 0,
      modelId: "model",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId,
      backendProfileId: `builtin:${providerId}`,
      backendConfigurationRevision: 0,
      endpointIdentity: `native:${providerId}`,
      modelIdentity: null,
    },
    harnessId,
    backendProfileId: `builtin:${providerId}`,
    model: "model",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2030-01-01T00:00:00.000Z",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  } as AgentTurn;
}

export function workspaceRun(update: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "command-1",
    kind: "check",
    projectId: "project-1",
    conversationId: "conversation-1",
    actionId: null,
    label: "npm test",
    detail: "Vitest watch mode",
    status: "running",
    attentionState: "seen",
    canStop: true,
    port: null,
    startedAt: "2030-01-01T00:00:10.000Z",
    finishedAt: null,
    ...update,
  };
}
