import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexInputRequest,
  CodexPlanStep,
} from "../codex/types";
import type {
  ProviderActivityEvent,
  ProviderId,
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
  | "opencode-cli";

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

export type AgentHarnessCapabilities =
  | CodexAppServerHarnessCapabilities
  | CodexCliHarnessCapabilities
  | ClaudeCliHarnessCapabilities
  | CursorCliHarnessCapabilities
  | OpenCodeCliHarnessCapabilities;

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
  | { type: "usage"; usage: ProviderUsageEvent["usage"] };

export interface CodexAppServerHarnessExtensionEvent {
  providerId: "codex";
  conversationId: string;
  type: "extension";
  extension: "codex-app-server";
  event: CodexAppServerHarnessEvent;
}

export type AgentHarnessEvent = AgentHarnessCoreEvent | CodexAppServerHarnessExtensionEvent;

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

export interface CliAgentHarnessRunExtension {
  kind: "cli";
  providerId: ProviderId;
}

export type AgentHarnessRunExtension = CodexAppServerRunExtension | CliAgentHarnessRunExtension;

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
  };
}
