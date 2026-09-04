import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "./interactions";
import type { KnownHarnessId } from "../../shared/model-routing";
import type {
  ProviderActivityEvent,
  ProviderGoalClearedEvent,
  ProviderGoalSnapshot,
  ProviderGoalMutation,
  ProviderGoalUpdatedEvent,
  ProviderId,
  ProviderMetadataEvent,
  ProviderRunInput,
  ProviderRunResult,
  ProviderHostToolBridge,
  ProviderSteerInput,
  ProviderSessionEvent,
  ProviderStatusEvent,
  ProviderSubagentEvent,
  ProviderTextEvent,
  ProviderTextSnapshotEvent,
  ProviderUsageEvent,
  ProviderHarnessLaunchConfiguration,
  ProviderEventBase,
} from "./contracts";
import type { ProviderCapabilityId } from "./capability-manifest";
import { sanitizeProviderActivityDetail } from "./activity-detail";
import { contractActivityPhase } from "./activity-lifecycle";

/** @deprecated Prefer the shared harness identity contract. */
export type AgentHarnessId = KnownHarnessId;

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
    forceFallback: "process-tree-kill" | "sdk-abort-close";
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

export interface KimiAcpHarnessCapabilities extends AgentHarnessCoreCapabilities {
  extension: {
    kind: "kimi-acp";
    protocol: "acp-v1-json-rpc";
    approvals: "native";
    questions: "native-over-permission";
    plans: "native";
    reasoning: "native";
    usage: "optional-acp-v1";
    images: "capability-negotiated";
    authentication: "kimi-cli";
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
  | KimiAcpHarnessCapabilities
  | OpenCodeSdkHarnessCapabilities;

export type AgentHarnessCoreEvent =
  | ProviderTextEvent
  | ProviderTextSnapshotEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent
  | ProviderGoalUpdatedEvent
  | ProviderGoalClearedEvent
  | ProviderSubagentEvent;

export type AgentInteractiveHarnessEvent =
  | { type: "approval"; request: AgentApprovalRequest }
  | { type: "approval-resolved"; requestId: string; decision: AgentApprovalDecision | "cancelled" }
  | { type: "input"; request: AgentInputRequest }
  | { type: "input-resolved"; requestId: string }
  | { type: "plan"; explanation: string | null; steps: AgentPlanStep[] }
  | { type: "reasoning-summary"; text: string }
  | { type: "usage"; usage: ProviderUsageEvent["usage"] }
  | Omit<ProviderMetadataEvent, "providerId" | "conversationId" | "runId" | "turnId">;

/** Canonical interactive event surface shared by rich provider transports. */
export type ProviderInteractiveHarnessEvent = AgentInteractiveHarnessEvent;

/**
 * Internal run-scoped evidence emitted only after a transport has observed an
 * optional protocol feature on the exact live connection. It is deliberately
 * not part of ProviderEvent: capability negotiation is runtime authority, not
 * a UI event.
 */
interface AgentHarnessCapabilityObservationEvent
  extends ProviderEventBase {
  type: "capability-observation";
  capabilityId: ProviderCapabilityId;
  available: boolean;
}

export interface CodexAppServerHarnessExtensionEvent {
  providerId: "codex";
  conversationId: string;
  runId: string;
  turnId: string;
  type: "extension";
  extension: "codex-app-server";
  event: AgentInteractiveHarnessEvent;
}

interface ProviderInteractiveHarnessExtensionEventBase {
  conversationId: string;
  runId: string;
  turnId: string;
  type: "extension";
  event: ProviderInteractiveHarnessEvent;
}

export type ProviderInteractiveHarnessExtensionEvent =
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "claude"; extension: "claude-agent-sdk" })
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "cursor"; extension: "cursor-acp" })
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "kimi"; extension: "kimi-acp" })
  | (ProviderInteractiveHarnessExtensionEventBase & { providerId: "opencode"; extension: "opencode-sdk" });

export type AgentHarnessEvent =
  | AgentHarnessCoreEvent
  | CodexAppServerHarnessExtensionEvent
  | ProviderInteractiveHarnessExtensionEvent
  | AgentHarnessCapabilityObservationEvent;

export interface AgentHarnessCallbacks {
  onEvent?: (event: AgentHarnessEvent) => void;
}

export interface AgentHarnessStartOptions {
  input: ProviderRunInput;
  executable: string;
  environment: NodeJS.ProcessEnv;
  harnessConfiguration?: ProviderHarnessLaunchConfiguration;
  callbacks?: AgentHarnessCallbacks;
  hostTools?: ProviderHostToolBridge;
}

export interface CodexAppServerRunExtension {
  kind: "codex-app-server";
  respondToApproval: (requestId: string, decision: AgentApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
  /** Parent-turn steering; Codex exposes no truthful direct-child messaging. */
  steer?: (input: ProviderSteerInput) => Promise<boolean>;
  setGoal: (input: ProviderGoalMutation) => Promise<ProviderGoalSnapshot>;
  clearGoal: () => Promise<boolean>;
}

export interface ProviderInteractiveRunExtension {
  kind: "claude-agent-sdk" | "cursor-acp" | "kimi-acp" | "opencode-sdk";
  respondToApproval: (requestId: string, decision: AgentApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
  /** Present only for transports with a persistent parent-session input stream. */
  steer?: (input: ProviderSteerInput) => Promise<boolean>;
  /** Present only when the transport can stop an exact live delegated task. */
  stopSubagent?: (providerTaskId: string) => Promise<boolean>;
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
  capability: (
    capabilityId: ProviderCapabilityId,
    available: boolean,
  ) => void;
  text: (text: string, itemId?: string) => void;
  textSnapshot: (itemId: string, text: string) => void;
  activity: (
    kind: ProviderActivityEvent["kind"],
    phase: ProviderActivityEvent["phase"],
    label: string,
    detail?: Pick<ProviderActivityEvent, "activityId" | "detail">,
  ) => void;
  status: (
    status: ProviderStatusEvent["status"],
    message?: string,
    providerState?: string,
  ) => void;
  session: (sessionId: string) => void;
  goalUpdated: (sessionId: string, goal: ProviderGoalSnapshot) => void;
  goalCleared: (sessionId: string) => void;
  subagent: (event: Omit<ProviderSubagentEvent, "providerId" | "conversationId" | "runId" | "turnId" | "type">) => void;
  codex: (event: AgentInteractiveHarnessEvent) => void;
  rich: (event: ProviderInteractiveHarnessEvent) => void;
}

export function createAgentHarnessEmitter(
  providerId: ProviderId,
  conversationId: string,
  callbacks: AgentHarnessCallbacks | undefined,
  runId: string,
  turnId: string,
  workspaceRoot?: string,
): AgentHarnessEmitter {
  const emit = (event: AgentHarnessEvent): void => {
    try {
      callbacks?.onEvent?.(event);
    } catch {
      // A UI callback must not interrupt provider execution.
    }
  };
  const base = { providerId, conversationId, runId, turnId };
  return {
    capability: (capabilityId, available) => emit({
      ...base,
      type: "capability-observation",
      capabilityId,
      available,
    }),
    text: (text, itemId) => emit({
      ...base,
      type: "text",
      text,
      ...(itemId ? { itemId } : {}),
    }),
    textSnapshot: (itemId, text) => emit({
      ...base,
      type: "text-snapshot",
      itemId,
      text,
    }),
    activity: (kind, phase, label, detail = {}) => {
      const safeLabel = label
        .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 240) || "Activity";
      const activityId = detail.activityId
        ?.replace(/\0/gu, "")
        .trim()
        .slice(0, 1_000);
      const safePhase = contractActivityPhase(phase, activityId);
      const safeDetail = sanitizeProviderActivityDetail(detail.detail, {
        workspaceRoot,
      });
      emit({
        ...base,
        type: "activity",
        kind,
        phase: safePhase,
        label: safeLabel,
        ...(activityId ? { activityId } : {}),
        ...(safeDetail ? { detail: safeDetail } : {}),
      });
    },
    status: (status, message, providerState) => emit({
      ...base,
      type: "status",
      status,
      ...(message ? { message } : {}),
      ...(providerState ? { providerState } : {}),
    }),
    session: (sessionId) => emit({ ...base, type: "session", sessionId }),
    goalUpdated: (sessionId, goal) => emit({
      ...base,
      type: "goal-updated",
      sessionId,
      goal,
    }),
    goalCleared: (sessionId) => emit({
      ...base,
      type: "goal-cleared",
      sessionId,
    }),
    subagent: (event) => emit({ ...event, ...base, type: "subagent" }),
    codex: (event) => {
      if (providerId !== "codex") return;
      emit({
        providerId: "codex",
        conversationId,
        runId,
        turnId,
        type: "extension",
        extension: "codex-app-server",
        event,
      });
    },
    rich: (event) => {
      if (providerId === "claude") emit({ ...base, providerId, type: "extension", extension: "claude-agent-sdk", event });
      else if (providerId === "cursor") emit({ ...base, providerId, type: "extension", extension: "cursor-acp", event });
      else if (providerId === "kimi") emit({ ...base, providerId, type: "extension", extension: "kimi-acp", event });
      else if (providerId === "opencode") emit({ ...base, providerId, type: "extension", extension: "opencode-sdk", event });
    },
  };
}
