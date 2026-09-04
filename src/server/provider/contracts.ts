import type { ZodType } from "zod";

import type {
  AgentGoalStatus,
  ContinuationIdentity,
  HarnessBackendCompatibility,
  KnownHarnessId,
  ModelBackendProfile,
  ModelSelection,
  ProviderModel,
  ProviderRateLimit,
  ProviderSkillInput,
  SubagentTraceStatus,
  ThreadUsageSnapshot,
} from "../../shared/contracts";
import type { BackendCompatibilityProbeResult } from "../../shared/backend-probe";
import type {
  AgentApprovalDecision,
  AgentApprovalPermissionRoot,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "./interactions";

export const PROVIDER_IDS = ["codex", "claude", "cursor", "kimi", "opencode"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderInteractionMode = "build" | "plan";
export type ProviderAccessMode = "full" | "supervised" | "auto-edit";
export type ProviderInstallState = "checking" | "installed" | "not-installed" | "error";
export type ProviderAuthState = "checking" | "authenticated" | "unauthenticated" | "configured" | "unknown" | "error";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  command: string;
}

export interface ProviderDetection {
  provider: ProviderInfo;
  available: boolean;
  version?: string;
  executable?: string;
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  /** Exact executable/version protocol probes succeeded independently of auth. */
  protocolVerified?: boolean;
  /** Fixed probe owner completion; false poisons clean runtime shutdown. */
  cleanupConfirmed: boolean;
  statusMessage?: string;
}

export interface ProviderDetectionOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  refreshEnvironment?: boolean;
  /** Installation/protocol readiness only; never probes or forwards credentials. */
  probeAuthentication?: boolean;
  /** Cancels owned discovery processes and resolves only after their cleanup settles. */
  signal?: AbortSignal;
}

interface ProviderRunRequest {
  /** Native discovery/event compatibility projection; never used for routing. */
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  backendCompatibility: HarnessBackendCompatibility;
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  /** Caller-owned immutable run identity. */
  runId: string;
  /** Caller-owned immutable turn or control-operation identity. */
  turnId: string;
  cwd: string;
  prompt: string;
  /** @deprecated Compatibility projections of modelSelection. */
  model?: string;
  reasoningEffort?: string;
  interactionMode: ProviderInteractionMode;
  access: ProviderAccessMode;
  sessionId?: string;
  /**
   * Exact native Fast value advertised for the selected model. Presence means
   * both Fast and Standard can be requested explicitly and must be attested by
   * the provider. Omitted for older or unsupported routes.
   */
  supportedFastMode?: "priority" | "fast";
  /** Explicit native-session speed change; absent on first sessions. */
  performanceModeTransition?: "to-fast" | "to-standard";
  imagePaths?: readonly string[];
  skills?: readonly ProviderSkillInput[];
  /**
   * Privileged Codex-only launch mode for a user-authored native goal. The
   * App Server owns the automatic turns started by this mutation; `prompt`
   * remains the durable visible request label and is not sent as a turn.
   */
  goalStart?: {
    objective?: string;
    tokenBudget?: number | null;
  };
  /** Saved evidence used only to keep a resumed Codex run alive long enough
   * for an active goal's provider-authored continuation to start. */
  goalContinuationExpected?: boolean;
  /** Provider-owned control operation that must never become a durable turn. */
  operation?: {
    kind: "compact";
    instruction?: string;
  };
}

export type ProviderRunInput = ProviderRunRequest & { conversationId: string };

/**
 * Privileged input for one parent-turn follow-up. Local image paths never
 * cross the runtime/renderer boundary and are valid only for the exact live
 * provider run that admitted them.
 */
export interface ProviderSteerInput {
  content: string;
  imagePaths: readonly string[];
}

export type ProviderRunStatus =
  | "starting"
  | "running"
  | "delegated"
  | "retrying"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export const PROVIDER_FAILURE_REASONS = [
  "protocol-overflow",
  "malformed-protocol",
  "process-exit",
  "process-signal",
  "rpc-timeout",
  "goal-continuation-timeout",
  "provider-error",
  "codex-error",
  "transport-closed",
] as const;

export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

export interface ProviderRunFailure {
  reason: ProviderFailureReason;
  /** Safe user-facing summary. */
  message: string;
  /** Bounded, scrubbed diagnostic exposed only through Technical details. */
  technicalDetail?: string;
  phase?: string;
  terminalEvent?: string;
  activityId?: string;
}

export interface ProviderEventBase {
  providerId: ProviderId;
  /** The caller's exact conversation identifier. */
  conversationId: string;
  /** Exact caller-owned run identity. */
  runId: string;
  /** Exact caller-owned turn or control-operation identity. */
  turnId: string;
}

export interface ProviderTextEvent extends ProviderEventBase {
  type: "text";
  text: string;
  /** Stable provider-owned identity for text that may later be corrected. */
  itemId?: string;
}

/**
 * Authoritative replacement for all assistant text emitted by this active
 * turn so far. Providers emit this only after applying an identified item
 * correction/removal to their own bounded ordered projection.
 */
export interface ProviderTextSnapshotEvent extends ProviderEventBase {
  type: "text-snapshot";
  itemId: string;
  text: string;
}

export type ProviderActivityKind = "system" | "turn" | "tool" | "command" | "reasoning";
export type ProviderActivityPhase = "started" | "completed" | "failed" | "info";

export interface ProviderActivityEvent extends ProviderEventBase {
  type: "activity";
  kind: ProviderActivityKind;
  phase: ProviderActivityPhase;
  label: string;
  /** Official provider item/call identity when the transport exposes one. */
  activityId?: string;
  /** Bounded, scrubbed technical input/output; never assistant prose. */
  detail?: string;
}

export interface ProviderStatusEvent extends ProviderEventBase {
  type: "status";
  status: ProviderRunStatus;
  /** Bounded provider-native phase; never used as a cross-provider synonym. */
  providerState?: string;
  message?: string;
}

export interface ProviderSessionEvent extends ProviderEventBase {
  type: "session";
  sessionId: string;
}

export interface ProviderApprovalEvent extends ProviderEventBase {
  type: "approval";
  request: AgentApprovalRequest;
}

export interface ProviderApprovalResolvedEvent extends ProviderEventBase {
  type: "approval-resolved";
  requestId: string;
  decision: AgentApprovalDecision | "cancelled";
}

export interface ProviderInputEvent extends ProviderEventBase {
  type: "input";
  request: AgentInputRequest;
}

export interface ProviderInputResolvedEvent extends ProviderEventBase {
  type: "input-resolved";
  requestId: string;
}

export interface ProviderPlanEvent extends ProviderEventBase {
  type: "plan";
  explanation: string | null;
  steps: AgentPlanStep[];
}

export interface ProviderGoalSnapshot {
  objective: string;
  status: AgentGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderGoalMutation {
  objective?: string;
  status: AgentGoalStatus;
  tokenBudget?: number | null;
}

/** A provider-authored update to the current goal for one native session. */
export interface ProviderGoalUpdatedEvent extends ProviderEventBase {
  type: "goal-updated";
  sessionId: string;
  goal: ProviderGoalSnapshot;
}

/** A provider-authored removal of the current goal for one native session. */
export interface ProviderGoalClearedEvent extends ProviderEventBase {
  type: "goal-cleared";
  sessionId: string;
}

export interface ProviderReasoningEvent extends ProviderEventBase {
  type: "reasoning-summary";
  text: string;
}

export interface ProviderUsageEvent extends ProviderEventBase {
  type: "usage";
  usage: Omit<ThreadUsageSnapshot, "conversationId" | "turnId" | "updatedAt">;
}

export interface ProviderMetadataEvent extends ProviderEventBase {
  type: "metadata";
  metadata: {
    models?: ProviderModel[];
    rateLimits?: ProviderRateLimit[];
  };
  source: "provider" | "session";
  /** False denotes a sparse update that must merge by stable item id. */
  complete: boolean;
}

/**
 * A provider-authored delegated-agent state transition. Adapters only emit
 * allowlisted fields with exact transport identities; raw provider payloads
 * never cross this boundary.
 */
export interface ProviderSubagentEvent extends ProviderEventBase {
  type: "subagent";
  sequence: number;
  providerTaskId: string | null;
  providerAgentId: string | null;
  parentProviderAgentId: string | null;
  parentProviderToolUseId: string | null;
  providerToolUseId: string | null;
  providerRole: string | null;
  providerName: string | null;
  /** Exact provider-authored state; absent for activity-derived updates. */
  providerStatus?: string | null;
  status: SubagentTraceStatus;
  /** Whether the provider still considers this delegated work live. */
  isLive: boolean;
  description: string | null;
  progress: string | null;
  result: string | null;
}

export type ProviderEvent =
  | ProviderTextEvent
  | ProviderTextSnapshotEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent
  | ProviderApprovalEvent
  | ProviderApprovalResolvedEvent
  | ProviderInputEvent
  | ProviderInputResolvedEvent
  | ProviderPlanEvent
  | ProviderGoalUpdatedEvent
  | ProviderGoalClearedEvent
  | ProviderReasoningEvent
  | ProviderUsageEvent
  | ProviderMetadataEvent
  | ProviderSubagentEvent;

export interface ProviderRunCallbacks {
  /** Fires only after the selected harness has synchronously accepted the run. */
  onStarted?: () => void;
  onEvent?: (event: ProviderEvent) => void;
  onText?: (event: ProviderTextEvent) => void;
  onTextSnapshot?: (event: ProviderTextSnapshotEvent) => void;
  onActivity?: (event: ProviderActivityEvent) => void;
  onStatus?: (event: ProviderStatusEvent) => void;
  onSession?: (event: ProviderSessionEvent) => void;
  onApproval?: (event: ProviderApprovalEvent) => void;
  onApprovalResolved?: (event: ProviderApprovalResolvedEvent) => void;
  onInput?: (event: ProviderInputEvent) => void;
  onInputResolved?: (event: ProviderInputResolvedEvent) => void;
  onPlan?: (event: ProviderPlanEvent) => void;
  onGoalUpdated?: (event: ProviderGoalUpdatedEvent) => void;
  onGoalCleared?: (event: ProviderGoalClearedEvent) => void;
  onReasoning?: (event: ProviderReasoningEvent) => void;
  onUsage?: (event: ProviderUsageEvent) => void;
  onMetadata?: (event: ProviderMetadataEvent) => void;
  onSubagent?: (event: ProviderSubagentEvent) => void;
  /** Process-local, exact-turn authority for audited Inertia host tools. */
  hostTools?: ProviderHostToolBridge;
}

export interface ProviderHostToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Process-local validator used by in-process provider tool transports. */
  inputValidator?: ZodType<Record<string, unknown>>;
  readOnly: boolean;
}

export interface ProviderHostToolApprovalRequest {
  title: string;
  detail: string;
  reason: string;
  permissionRoots: AgentApprovalPermissionRoot[];
}

export interface ProviderHostToolCall {
  providerThreadId: string;
  providerTurnId: string;
  toolCallId: string;
  tool: string;
  arguments: unknown;
  signal: AbortSignal;
  requestApproval(
    request: ProviderHostToolApprovalRequest,
  ): Promise<AgentApprovalDecision>;
}

export interface ProviderHostToolResult {
  success: boolean;
  /** Bounded model-visible JSON or plain text. */
  text: string;
  /** Optional bounded host-owned visual evidence returned directly to the model. */
  image?: {
    mimeType: "image/png";
    data: string;
  };
}

/** Owned by one exact active Inertia run; never persisted or provider-authored. */
export interface ProviderHostToolBridge {
  readonly definitions: readonly ProviderHostToolDefinition[];
  invoke(call: ProviderHostToolCall): Promise<ProviderHostToolResult>;
}

export type ProviderTerminalOutcome =
  | { outcome: "completed"; reason: "provider-completed" }
  | { outcome: "cancelled"; reason: "provider-cancelled" }
  | { outcome: "failed"; reason: ProviderFailureReason };

export interface ProviderRunIdentity {
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  turnId: string;
}

export interface ProviderRunResult extends ProviderRunIdentity {
  status: "completed" | "failed" | "cancelled";
  /** Structured terminal truth. Its outcome must equal status. */
  terminalReason: ProviderTerminalOutcome;
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  failure?: ProviderRunFailure;
  /** True only after authoritative complete process-tree cleanup. */
  cleanupConfirmed: boolean;
}

export function providerRunIdentity(
  input: Pick<ProviderRunInput, "providerId" | "conversationId" | "runId" | "turnId">,
): ProviderRunIdentity {
  return {
    providerId: input.providerId,
    conversationId: input.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  };
}

export function providerTerminalOutcome(
  status: ProviderRunResult["status"],
  failure?: ProviderRunFailure,
): ProviderTerminalOutcome {
  if (status === "completed") {
    return { outcome: "completed", reason: "provider-completed" };
  }
  if (status === "cancelled") {
    return { outcome: "cancelled", reason: "provider-cancelled" };
  }
  return { outcome: "failed", reason: failure?.reason ?? "provider-error" };
}

export function providerRunTerminal(
  input: Pick<ProviderRunInput, "providerId" | "conversationId" | "runId" | "turnId">,
  status: ProviderRunResult["status"],
  failure?: ProviderRunFailure,
): Pick<
  ProviderRunResult,
  "providerId" | "conversationId" | "runId" | "turnId" | "status" | "terminalReason"
> {
  return {
    ...providerRunIdentity(input),
    status,
    terminalReason: providerTerminalOutcome(status, failure),
  };
}

export function hasExactProviderRunIdentity(
  value: unknown,
  expected: ProviderRunIdentity,
): value is ProviderRunIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.providerId === expected.providerId
    && candidate.conversationId === expected.conversationId
    && candidate.runId === expected.runId
    && candidate.turnId === expected.turnId;
}

export function hasConsistentProviderTerminalOutcome(
  result: unknown,
): boolean {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Record<string, unknown>;
  const terminalReason = candidate.terminalReason;
  if (typeof terminalReason !== "object" || terminalReason === null) return false;
  const terminal = terminalReason as Record<string, unknown>;
  if (candidate.status === "completed") {
    return terminal.outcome === "completed"
      && terminal.reason === "provider-completed";
  }
  if (candidate.status === "cancelled") {
    return terminal.outcome === "cancelled"
      && terminal.reason === "provider-cancelled";
  }
  if (candidate.status !== "failed") return false;
  if (
    typeof terminal.reason !== "string"
    || !PROVIDER_FAILURE_REASONS.includes(
      terminal.reason as ProviderFailureReason,
    )
    || terminal.outcome !== "failed"
  ) return false;
  if (candidate.failure === undefined) return true;
  if (typeof candidate.failure !== "object" || candidate.failure === null) {
    return false;
  }
  return (candidate.failure as Record<string, unknown>).reason
    === terminal.reason;
}

export interface ProviderCompactionResult {
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled";
  terminalReason: ProviderTerminalOutcome;
  instructionForwarded: boolean;
  message: string;
  error?: string;
  cleanupConfirmed: boolean;
}

export type ProviderRuntimeErrorCode =
  | "invalid_input"
  | "already_running"
  | "lifecycle_corruption";

export class ProviderRuntimeError extends Error {
  readonly code: ProviderRuntimeErrorCode;

  constructor(code: ProviderRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ProviderRuntimeError";
    this.code = code;
  }
}

export interface ProviderManagerOptions {
  commands?: Partial<Record<ProviderId, string>>;
  cancelGraceMs?: number;
  /** Runtime-owned cancellation authority shared by passive provider operations. */
  lifetimeSignal?: AbortSignal;
  backendProfiles?: readonly ModelBackendProfile[];
  backendCompatibilities?: readonly HarnessBackendCompatibility[];
  /** Latest safe compatibility evidence, keyed to an exact profile revision and model. */
  backendProbeResults?: readonly BackendCompatibilityProbeResult[];
  /**
   * Privileged, process-local launch boundary for backend-specific routing.
   * Implementations may materialize a secret into the owned child environment,
   * but must never add it to ProviderRunInput or another shared contract.
   */
  resolveBackendLaunchOptions?: (
    input: ProviderRunInput,
    baseEnvironment: NodeJS.ProcessEnv,
    context: ProviderBackendLaunchContext,
  ) => ProviderBackendLaunchOptions | Promise<ProviderBackendLaunchOptions>;
}

export interface ProviderBackendLaunchContext {
  signal: AbortSignal;
}

export interface ProviderBackendLaunchOptions {
  /** Complete environment owned by this launch; never mutate process.env. */
  environment: NodeJS.ProcessEnv;
  /** Optional harness-specific spelling of the already selected model. */
  modelArgument?: string | null;
  /** Safe provider configuration consumed only by the matching owned harness. */
  harnessConfiguration?: ProviderHarnessLaunchConfiguration;
  /**
   * Clears credential material from the resolver-owned temporary object after
   * the harness has synchronously copied its launch configuration.
   */
  releaseAfterStart?: () => void;
  /** Releases any remaining non-secret resources after the run has stopped. */
  dispose?: () => void;
}

export interface CodexResponsesHarnessConfiguration {
  kind: "codex-responses";
  /** Codex config key, not a user-facing backend profile id. */
  providerId: string;
  displayName: string;
  baseUrl: string;
  /** Name of an environment variable present only in the owned App Server. */
  credentialEnvironmentKey: string | null;
}

export type ProviderHarnessLaunchConfiguration =
  | CodexResponsesHarnessConfiguration;

export interface ProviderAuthLaunch {
  executable: string;
  args: readonly string[] | string;
  env: NodeJS.ProcessEnv;
  installationUse: ProviderInstallationUseTransfer;
}

/** Settlement authority available only after a downstream owner accepts it. */
export interface ProviderInstallationTransferredUse {
  release(receipt: { cleanupConfirmed: true }): boolean;
  quarantine(reason: string): boolean;
}

/**
 * One-shot, path-free handoff from descriptor construction to the component
 * that actually spawns and proves cleanup of the owned process tree.
 */
export interface ProviderInstallationUseTransfer {
  accept(): ProviderInstallationTransferredUse | null;
  abandonBeforeSpawn(): boolean;
}
