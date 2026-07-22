import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexInputRequest,
  CodexPlanStep,
} from "../codex/types";
import type {
  ProviderActivityEvent,
  ProviderId,
  ProviderMetadataEvent,
  ProviderRunInput,
  ProviderRunResult,
  ProviderSessionEvent,
  ProviderStatusEvent,
  ProviderTextEvent,
  ProviderUsageEvent,
} from "./contracts";

export type AgentHarnessId =
  | "codex-app-server"
  | "codex-cli"
  | "claude-cli"
  | "cursor-cli"
  | "opencode-cli"
  | "claude-agent-sdk"
  | "cursor-acp"
  | "opencode-sdk";

export interface AgentHarnessCoreCapabilities {
  lifecycle: {
    events: "push";
    terminalStatuses: readonly ["completed", "failed", "cancelled"];
  };
  session: {
    resume: "native";
    identity: "thread" | "session";
  };
  cancellation: {
    graceful: "protocol-interrupt" | "process-tree-signal";
    forceFallback: "process-tree-kill";
  };
}

export interface CodexAppServerHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "codex-app-server";
    protocol: "json-rpc-jsonl";
    schema: "version-specific";
    approvals: "native";
    questions: "native";
    plans: "native";
    reasoning: "summary";
    usage: "token-usage";
    images: "local-image-input";
    authentication: "codex-cli";
    modelMetadata: "app-server";
  };
}

export interface CodexCliHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "codex-cli";
    protocol: "exec-jsonl";
    routing: "full-access-compatibility";
    approvals: "unavailable";
    questions: "unavailable";
    plans: "unavailable";
    reasoning: "unavailable";
    usage: "unavailable";
    images: "native-cli-path";
    authentication: "codex-cli";
    modelMetadata: "unavailable";
  };
}

export interface ClaudeCliHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "claude-cli";
    protocol: "stream-json";
    partialMessages: "enabled";
    permissionModes: "native-cli";
    planMode: "native-cli";
    approvals: "unavailable-in-current-harness";
    questions: "unavailable-in-current-harness";
    reasoning: "unavailable-in-current-harness";
    usage: "unavailable-in-current-harness";
    images: "prompt-path-reference";
    authentication: "claude-cli";
    modelMetadata: "unavailable-in-current-harness";
  };
}

export interface CursorCliHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "cursor-cli";
    protocol: "stream-json";
    approvals: "unavailable-in-current-harness";
    questions: "unavailable-in-current-harness";
    plans: "prompt-emulated";
    reasoning: "suppressed-by-print-mode";
    usage: "unavailable-in-current-harness";
    images: "prompt-path-reference";
    authentication: "cursor-cli";
    modelMetadata: "unavailable-in-current-harness";
  };
}

export interface OpenCodeCliHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "opencode-cli";
    protocol: "json-events";
    planMode: "native-agent-selection";
    approvals: "unavailable-in-current-harness";
    questions: "unavailable-in-current-harness";
    reasoning: "unavailable-in-current-harness";
    usage: "unavailable-in-current-harness";
    images: "native-cli-file";
    authentication: "opencode-cli";
    modelMetadata: "unavailable-in-current-harness";
  };
}

export interface ClaudeAgentSdkHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "claude-agent-sdk";
    protocol: "claude-agent-sdk";
    approvals: "native";
    questions: "native";
    plans: "native";
    reasoning: "streaming-thinking";
    usage: "result-usage";
    images: "structured-base64-input";
    authentication: "claude-cli";
    modelMetadata: "agent-sdk";
  };
}

export interface CursorAcpHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "cursor-acp";
    protocol: "acp-v1-json-rpc";
    approvals: "native";
    questions: "cursor-extension";
    plans: "native";
    reasoning: "native";
    usage: "optional-acp-v1";
    images: "capability-negotiated";
    authentication: "cursor-cli";
    modelMetadata: "session-config-options";
  };
}

export interface OpenCodeSdkHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "opencode-sdk";
    protocol: "owned-server-sse";
    approvals: "native";
    questions: "native";
    plans: "native";
    reasoning: "native";
    usage: "message-token-usage";
    images: "native-file-input";
    authentication: "opencode-cli";
    modelMetadata: "server-config";
  };
}

export type AgentHarnessCapabilities =
  | CodexAppServerHarnessCapabilities
  | CodexCliHarnessCapabilities
  | ClaudeCliHarnessCapabilities
  | CursorCliHarnessCapabilities
  | OpenCodeCliHarnessCapabilities
  | ClaudeAgentSdkHarnessCapabilities
  | CursorAcpHarnessCapabilities
  | OpenCodeSdkHarnessCapabilities;

export type AgentHarnessCoreEvent =
  | ProviderTextEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent;

export type CodexAppServerHarnessEvent =
  | { type: "approval"; request: CodexApprovalRequest }
  | { type: "approval-resolved"; requestId: string; decision: CodexApprovalDecision | "cancelled" }
  | { type: "input"; request: CodexInputRequest }
  | { type: "input-resolved"; requestId: string }
  | { type: "plan"; explanation: string | null; steps: CodexPlanStep[] }
  | { type: "reasoning-summary"; text: string }
  | { type: "usage"; usage: ProviderUsageEvent["usage"] }
  | Omit<ProviderMetadataEvent, "providerId" | "conversationId">;

/** Canonical interactive event surface shared by rich provider transports. */
export type ProviderInteractiveHarnessEvent = CodexAppServerHarnessEvent;

export interface CodexAppServerHarnessExtensionEvent {
  providerId: "codex";
  conversationId: string;
  type: "extension";
  extension: "codex-app-server";
  event: CodexAppServerHarnessEvent;
}

interface ProviderInteractiveHarnessExtensionEventBase {
  conversationId: string;
  type: "extension";
  event: ProviderInteractiveHarnessEvent;
}

export type ProviderInteractiveHarnessExtensionEvent =
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "claude"; extension: "claude-agent-sdk" })
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "cursor"; extension: "cursor-acp" })
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "opencode"; extension: "opencode-sdk" });

export type AgentHarnessEvent =
  | AgentHarnessCoreEvent
  | CodexAppServerHarnessExtensionEvent
  | ProviderInteractiveHarnessExtensionEvent;

export interface AgentHarnessCallbacks {
  onEvent?: (event: AgentHarnessEvent) => void;
}

export interface AgentHarnessStartOptions {
  input: ProviderRunInput;
  executable: string;
  environment: NodeJS.ProcessEnv;
  callbacks?: AgentHarnessCallbacks;
}

export interface CodexAppServerRunExtension {
  kind: "codex-app-server";
  respondToApproval: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
}

export interface ProviderInteractiveRunExtension {
  kind: "claude-agent-sdk" | "cursor-acp" | "opencode-sdk";
  respondToApproval: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
}

export interface CliAgentHarnessRunExtension {
  kind: "cli";
  providerId: ProviderId;
}

export type AgentHarnessRunExtension =
  | CodexAppServerRunExtension
  | ProviderInteractiveRunExtension
  | CliAgentHarnessRunExtension;

export interface AgentHarnessRun {
  harnessId: AgentHarnessId;
  providerId: ProviderId;
  result: Promise<ProviderRunResult>;
  cancel: (force: boolean) => void;
  extension: AgentHarnessRunExtension;
}

export interface AgentHarness {
  id: AgentHarnessId;
  providerId: ProviderId;
  capabilities: AgentHarnessCapabilities;
  supports: (input: ProviderRunInput) => boolean;
  start: (options: AgentHarnessStartOptions) => AgentHarnessRun;
}

export interface AgentHarnessEmitter {
  text: (text: string) => void;
  activity: (kind: ProviderActivityEvent["kind"], phase: ProviderActivityEvent["phase"], label: string) => void;
  status: (status: ProviderStatusEvent["status"], message?: string) => void;
  session: (sessionId: string) => void;
  codex: (event: CodexAppServerHarnessEvent) => void;
  rich: (event: ProviderInteractiveHarnessEvent) => void;
}

export function createAgentHarnessEmitter(
  providerId: ProviderId,
  conversationId: string,
  callbacks: AgentHarnessCallbacks = {},
): AgentHarnessEmitter {
  const emit = (event: AgentHarnessEvent): void => {
    try {
      callbacks.onEvent?.(event);
    } catch {
      // A UI callback must not interrupt provider execution.
    }
  };
  const base = { providerId, conversationId };
  return {
    text: (text) => emit({ ...base, type: "text", text }),
    activity: (kind, phase, label) => emit({ ...base, type: "activity", kind, phase, label }),
    status: (status, message) => emit({ ...base, type: "status", status, ...(message ? { message } : {}) }),
    session: (sessionId) => emit({ ...base, type: "session", sessionId }),
    codex: (event) => {
      if (providerId !== "codex") return;
      emit({ providerId, conversationId, type: "extension", extension: "codex-app-server", event });
    },
    rich: (event) => {
      if (providerId === "claude") emit({ providerId, conversationId, type: "extension", extension: "claude-agent-sdk", event });
      else if (providerId === "cursor") emit({ providerId, conversationId, type: "extension", extension: "cursor-acp", event });
      else if (providerId === "opencode") emit({ providerId, conversationId, type: "extension", extension: "opencode-sdk", event });
    },
  };
}
