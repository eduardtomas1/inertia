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
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "./interactions";

export const PROVIDER_IDS = ["codex", "claude", "cursor", "opencode"] as const;

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
}

interface ProviderRunRequest {
  /** Native discovery/event compatibility projection; never used for routing. */
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  backendCompatibility: HarnessBackendCompatibility;
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  /** Caller-owned run identity. Omitted only by legacy direct harness consumers. */
  runId?: string;
  /** Durable authoritative turn identity. Omitted only by legacy direct harness consumers. */
  turnId?: string;
  cwd: string;
  prompt: string;
  /** @deprecated Compatibility projections of modelSelection. */
  model?: string;
  reasoningEffort?: string;
  interactionMode: ProviderInteractionMode;
  access: ProviderAccessMode;
  sessionId?: string;
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
}

export type ProviderRunInput = ProviderRunRequest &
  (
    | { conversationId: string; threadId?: never }
    | { threadId: string; conversationId?: never }
  );

export type ProviderRunStatus =
  | "starting"
  | "running"
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
  /** The caller's thread or conversation identifier, normalized to one key. */
  conversationId: string;
  /** Always present on callbacks; legacy direct runs fall back to conversationId. */
  runId: string;
  /** Null only for legacy direct runs that do not own a durable turn. */
  turnId: string | null;
}

export interface ProviderTextEvent extends ProviderEventBase {
  type: "text";
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
}

export interface ProviderRunResult {
  providerId: ProviderId;
  conversationId: string;
  status: "completed" | "failed" | "cancelled";
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

export type ProviderRuntimeErrorCode = "invalid_input" | "already_running";

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
}
