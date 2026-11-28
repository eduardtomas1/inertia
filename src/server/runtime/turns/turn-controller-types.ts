import type {
  ProviderCapabilityId,
} from "../../provider/capability-manifest";
import type {
  AgentActivity,
  AgentApprovalDecision,
  AgentTurn,
  AgentTurnTerminalStatus,
  AgentTurnUsageSnapshot,
  ChatAttachment,
  ChatMessage,
  Conversation,
  ContinuationIdentity,
  HarnessBackendCompatibility,
  KnownHarnessId,
  ModelBackendProfile,
  ModelSelection,
  ProviderSkillInput,
  ProviderId,
  ProviderInfo,
  ProviderSlashCommand,
  RuntimeMutationEvent,
  TurnRequestContext,
} from "../../../shared/contracts";
import type {
  ProviderActivityEvent,
  ProviderGoalMutation,
  ProviderGoalSnapshot,
  ProviderMetadataEvent,
  ProviderHostToolBridge,
  ProviderRunCallbacks,
  ProviderRunFailure,
  ProviderRunInput,
  ProviderRunResult,
  ProviderSteerInput,
} from "../../provider/contracts";
import type { ProviderSteerReadCallback } from "../../provider/types";

declare module "../../provider/contracts" {
  interface ProviderRunCallbacks {
    onSteerRead?: ProviderSteerReadCallback;
  }
}
import type { SubagentBackgroundResult, SubagentStopOutcome } from "../../provider/agent-harness";
import type { AssembledTurnRequest, HiddenProviderInstruction, SanitizedTurnExecutionManifest } from "./request-context";
import type { HarnessCapabilityTurnOffer } from "../harness-capabilities";
import type { DocumentAttachmentContext } from "../attachments/document-attachment-context";
import type { DeltaTimerScheduler } from "./turn-stream-coalescer";
import type { TurnStreamChannel } from "./turn-stream-channel";
import type { TurnSubagentTelemetry } from "./turn-subagent-telemetry";
import type { CustomAgentTraceAttribution } from "./turn-custom-agent-traces";
import type { CustomAgentCallAttribution } from "../../../shared/custom-agents";
import type { StreamingTrace } from "../test-streaming-trace";
import type { TurnSecretOutputFilter } from "./turn-secret-output";
import type { AuthoritativeRunStateEngine } from "../run-state-engine";
import type { WatcherNoteAttribution } from "../../../shared/watcher";
import type { DuoComparisonBrief } from "../../../shared/duo-comparison-brief";
import type { CommandSource } from "../../orchestration-v2/types";

export interface TurnTimerScheduler extends DeltaTimerScheduler {}

export interface TurnProviderRuntime {
  resolveModelRoute(selection: ModelSelection): {
    providerId: ProviderId;
    harnessId: KnownHarnessId;
    backendProfile: ModelBackendProfile;
    compatibility: HarnessBackendCompatibility;
    continuationIdentity: ContinuationIdentity;
  };
  harnessIdFor(input: ProviderRunInput): string;
  providerCapabilityAvailable(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured?: readonly ProviderCapabilityId[],
  ): boolean;
  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult>;
  cancel(conversationId: string): boolean;
  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
    graceMs?: number,
    hooks?: { escalated?(): void },
  ): Promise<"missing" | "identity-mismatch" | "settled" | "force-detached">;
  isRunning(conversationId: string): boolean;
  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): boolean;
  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    identity: { runId: string; turnId: string },
  ): boolean;
  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
    identity: { runId: string; turnId: string },
  ): boolean;
  steer?(
    conversationId: string,
    input: ProviderSteerInput,
    identity: { runId: string; turnId: string },
  ): Promise<boolean>;
  setGoal?(
    conversationId: string,
    input: ProviderGoalMutation,
    identity: { runId: string; turnId: string },
  ): Promise<ProviderGoalSnapshot | null>;
  clearGoal?(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean | "superseded">;
  stopSubagent?(
    conversationId: string,
    providerTaskId: string | null,
    identity: { runId: string; turnId: string },
    providerToolUseId?: string | null,
  ): Promise<SubagentStopOutcome>;
  backgroundSubagent?(
    conversationId: string,
    providerToolUseId: string,
    identity: { runId: string; turnId: string },
  ): Promise<SubagentBackgroundResult>;
  reportedProviderCommands?(scope: { providerId: ProviderId; cwd: string; conversationId: string | null }): readonly ProviderSlashCommand[] | undefined;
  disposeAll(): Promise<void>;
}

export interface ProviderStartAttempt {
  readonly accepted: boolean;
  readonly started: Promise<boolean>;
}

export interface TurnStructuredContextCapture {
  conversation: Conversation;
  content: string;
  attachments: readonly ChatAttachment[];
  executionManifest: SanitizedTurnExecutionManifest;
}

export interface TurnStructuredContextRecord {
  turn: AgentTurn;
  context: unknown;
}

export interface TurnCheckpointCapture {
  checkpointId: string | null;
  failure: string | null;
}

export interface TurnGitArtifactHookInput {
  turn: AgentTurn;
  checkpointId: string | null;
  terminalAssistantMessageId: string | null;
}

export interface TurnMetadataRefreshHookInput {
  providerId: ProviderId;
  conversationId: string;
  turnId: string;
  runStartedAt: number;
  status: AgentTurnTerminalStatus;
}

export interface TurnAttachmentReleaseHookInput {
  turn: AgentTurn;
  attachmentIds: readonly string[];
}

/** One turn's capability offer and the private instructions it implies. */
export interface TurnCapabilityOffer {
  instructions: readonly HiddenProviderInstruction[];
  offer: HarnessCapabilityTurnOffer;
}

export interface TurnControllerHooks {
  reportIncident?(observation: import("../../../node/application-incidents").IncidentObservation): unknown;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void | Promise<void>;
  /**
   * Emits only the mutable shell rows owned by one conversation. Tests and
   * compatibility callers may omit this and retain the full-snapshot fallback.
   */
  broadcastConversationShell?(conversationId: string): void;
  providerInfo(): readonly ProviderInfo[];
  /**
   * Reviewed Inertia capability offer for the turn being prepared, read once.
   * Its instructions feed the once-per-provider-session instruction delivery,
   * and its offer is carried on the active turn to `hostToolsForTurn`.
   */
  capabilityOfferForTurn?(input: {
    conversation: Conversation;
  }): TurnCapabilityOffer;
  watcherInstructionsForTurn?(input: {
    conversation: Conversation;
    hostTools: boolean;
  }): readonly HiddenProviderInstruction[];
  /**
   * Exact-turn host authority for the offer snapshotted when the turn's prompt
   * was assembled; absent means the selected harness gets no tools.
   */
  hostToolsForTurn?(input: {
    conversation: Conversation;
    turn: AgentTurn;
    offer: HarnessCapabilityTurnOffer;
  }): ProviderHostToolBridge | undefined;
  applyProviderMetadata?(event: ProviderMetadataEvent): void;
  onNativeGoalSynchronized?(input: {
    conversationId: string;
    providerSessionId: string;
  }): boolean;
  captureStructuredContext?(input: TurnStructuredContextCapture): unknown;
  onStructuredContextCaptured?(record: TurnStructuredContextRecord): void | Promise<void>;
  onStreamingPersisted?(input: {
    turnId: string;
    kind: "assistant" | "reasoning";
    recordId: string;
  }): void;
  createTurnCheckpoint?(
    turn: AgentTurn,
    signal: AbortSignal,
  ): Promise<TurnCheckpointCapture>;
  captureGitBefore?(input: TurnGitArtifactHookInput): void | Promise<void>;
  captureGitArtifacts?(input: TurnGitArtifactHookInput): void | Promise<void>;
  /** Optional metadata; failure cannot change a committed provider outcome. */
  refreshProviderMetadata?(input: TurnMetadataRefreshHookInput): void | Promise<void>;
  validateModelSelection?(selection: ModelSelection): ModelSelection;
  releaseTurnAttachments?(input: TurnAttachmentReleaseHookInput): void | Promise<void>;
  attachmentReadRoots?(input: {
    conversationId: string;
    attachmentIds: readonly string[];
  }): readonly string[];
  /**
   * Opens a synchronous check of missed runs' retained images for one turn, before its prompt carries them to the
   * provider again (containment in the retained folder, a regular non-symlink file within the image limit). The
   * check returns null to skip an image. Without this hook, or when it returns null, no missed image is carried.
   */
  missedRunImageCheck?(): ((input: { attachment: ChatAttachment }) => { path: string; size: number } | null) | null;
  releaseGeneratedAttachments?(paths: readonly string[]): void | Promise<void>;
  /**
   * Required orchestration. Durable owners provide recovery; the controller
   * records failure independently and never blindly replays a callback against
   * a newer active turn.
   */
  onTurnSettled?(turn: AgentTurn, settlement: TurnSettledEvidence): void | Promise<void>;
  onReadOnlyViolation?(turn: AgentTurn, violation: ReadOnlyWatcherViolation): void;
  onPlanHandoff?(turn: AgentTurn, text: string): void;
  /** Benchmark-only stage attribution; absent in ordinary runtime instances. */
  testOnlyStreamingTrace?: StreamingTrace;
  secretOutput?(): TurnSecretOutputFilter | undefined;
}

export type ReadOnlyWatcherViolationKind =
  | "write-attempt"
  | "command-attempt"
  | "input"
  | "approval-limit";

export interface ReadOnlyWatcherViolation {
  linkId: string;
  wakeId: string | null;
  kind: ReadOnlyWatcherViolationKind;
  detail: string;
  stopped: boolean;
}

export interface ReadOnlyWatcherTurn {
  linkId: string;
  wakeId: string | null;
  deniedApprovals: number;
  editsGatedBeforeStart: boolean;
}

export interface FollowUpSteerOptions {
  providerContent?: string;
  watcherNote?: WatcherNoteAttribution;
  delegatedCompletion?: import("../../../shared/orchestration-delegation").DelegatedCompletionAttribution;
  queuedMessageId?: string;
}

export interface TurnSettledEvidence {
  providerSessionTitle: string | null;
}

export interface QueueTurnRequest {
  /** Original validated ingress command for durable acknowledgement replay. */
  orchestrationRequest?: CommandSource;
  queuedMessageId?: string;
  /**
   * Start the turn on this unread follow-up's persisted message instead of a new one (the queue row that names
   * it is `queuedMessageId`).
   */
  adoptedFollowUp?: { messageId: string };
  limitResetPlanId?: string;
  restartContinuationPlanId?: string;
  conversationId: string;
  /** Authenticated Private Connect origin, supplied only by the privileged gateway. */
  privateConnectDeviceId?: string;
  /** Server-only authorization for the exact locked Duo judge dispatch. */
  authorizedDuoComparisonLaunchId?: string;
  duoComparison?: DuoComparisonBrief;
  authorizedWatcherWakeId?: string;
  watcherNote?: WatcherNoteAttribution;
  delegatedCompletion?: import("../../../shared/orchestration-delegation").DelegatedCompletionAttribution;
  content: string;
  attachments?: readonly ChatAttachment[];
  imagePaths?: readonly string[];
  /** Private raster derivatives owned only until exact provider cleanup. */
  generatedAttachmentPaths?: readonly string[];
  /** Server-derived only. Renderer commands never provide extracted document text. */
  documentContexts?: readonly DocumentAttachmentContext[];
  context?: TurnRequestContext;
  /** Exact renderer request owning any context-packet claim. */
  contextRequestId?: string;
  activateConversation?: boolean;
  /** Server-constructed only. Renderer command schemas never accept this. */
  internalInstructions?: readonly HiddenProviderInstruction[];
  systemInstructions?: readonly HiddenProviderInstruction[];
  checkpointId?: string | null;
  checkpointFailure?: string | null;
  turnCheckpoint?: boolean;
  /** Privileged provider-native skill references resolved from opaque IDs. */
  skills?: readonly ProviderSkillInput[];
  rendererOwnerId?: string | null;
  /** Optional per-turn review/audit metadata; not an execution or cleanup owner. */
  onSettled?: (
    status: AgentTurnTerminalStatus,
    turnId: string,
  ) => void | Promise<void>;
  /** Privileged runtime-only launch mode; never accepted from renderer IPC. */
  goalStart?: {
    objective?: string;
    tokenBudget?: number | null;
  };
  /**
   * Explicit per-item model selection carried by a queued message (Phase 5 Pkg 3).
   * Resolved for this turn without mutating the user's live composer selection on
   * `conversations`.
   */
  modelSelectionOverride?: ModelSelection | null;
  /**
   * Explicit stopped-turn native session ID carried by Resume (Phase 5 N7) so
   * turn preparation validates and resumes the exact stopped session even after
   * a mid-chat provider switch without an existing backing row.
   */
  resumeSessionId?: string | null;
  /** Server-only scheduled task attribution, ceilings, and fresh-session flag. */
  scheduledDelivery?: {
    taskId: string;
    runId: string;
    title: string;
    accessMode: Conversation["accessMode"];
    interactionMode: Conversation["interactionMode"];
    freshContext?: boolean;
  };
}

export interface QueuedTurn {
  message: ChatMessage;
  turn: AgentTurn;
}

/**
 * Server-only ownership for one new-turn preparation window. The controller
 * consumes the exact lease when queue() commits the durable turn; callers may
 * always release it in finally because release becomes a no-op after handoff.
 */
export interface TurnAdmissionLease {
  readonly conversationId: string;
  readonly token: symbol;
  release(): void;
}

export type TurnTerminalCause =
  | "provider-completed"
  | "provider-error"
  | "provider-process-exit"
  | "provider-process-crash"
  | "goal-continuation-timeout"
  | "user-cancelled"
  | "approval-cancelled"
  | "unsupported-interaction"
  | "runtime-shutdown"
  | "runtime-crash"
  | "runtime-restart"
  | "app-update"
  | "turn-timeout"
  | "renderer-disconnected"
  | "turn-start-failed"
  | "turn-adoption-failed"
  | "stream-persistence-failed"
  | "checkpoint-association-failed";

export interface NativeGoalStartAcknowledgement {
  objective?: string;
  tokenBudget?: number | null;
  latestGoal: ProviderGoalSnapshot | null;
  cleared: boolean;
  settlementQueued: boolean;
  resolve(goal: ProviderGoalSnapshot): void;
  reject(error: Error): void;
}

export interface ActiveTurn {
  diagnosticFailureCode?: "turn.inactivity-timeout" | "turn.lifetime-timeout";
  turn: AgentTurn;
  /**
   * The run's current V2 attempt, read when the provider starts and replaced
   * by the in-run fresh-session fallback. Provider observations carry the
   * attempt they were started under and write nothing once it is replaced.
   * Null or absent for a run V2 never admitted.
   */
  attemptId?: string | null;
  conversation: Conversation;
  providerInput: ProviderRunInput;
  /**
   * The capability offer snapshotted when this turn's prompt was assembled.
   * Absent when the prompt was assembled without a trusted host bridge, in
   * which case the turn gets no host tools.
   */
  capabilityOffer?: HarnessCapabilityTurnOffer;
  attachmentIds: readonly string[];
  generatedAttachmentPaths: readonly string[];
  checkpointId: string | null;
  checkpointFailure: string | null;
  turnCheckpoint?: boolean;
  rendererOwnerId: string | null;
  structuredContext: unknown;
  gitBeforeCapture: Promise<void> | null;
  runStartedAt: number;
  workspaceRunCreated: boolean;
  providerRunStarted: boolean;
  providerStartAcknowledgement: ((started: boolean) => void) | null;
  nativeGoalStartAcknowledgement: NativeGoalStartAcknowledgement | null;
  attachmentsReleased: boolean;
  attachmentRelease: Promise<void> | null;
  /** Exact follow-up admissions that must drain before attachment cleanup. */
  followUpAdmissions: Set<Promise<void>>;
  /** FIFO admission tail for parent follow-ups on this exact active turn. */
  followUpAdmissionTail: Promise<void>;
  supportsFollowUpImages: boolean;
  /** Persisted follow-up message by the steer id its provider was given. */
  followUpMessagesBySteerId?: Map<string, string>;
  /**
   * Follow-ups the provider accepted but never read (`ProviderRunResult.unreadFollowUps`). Settlement leaves
   * them out of this run's coverage and queues each one by reference.
   */
  unreadFollowUpMessageIds?: readonly string[];
  /** Why the provider itself stopped this turn without failing it (`ProviderRunResult.providerStopReason`). */
  providerStopReason?: string;
  runState: AuthoritativeRunStateEngine;
  deferredSettlement: {
    status: AgentTurnTerminalStatus;
    cause: TurnTerminalCause;
    message?: string;
    failure?: ProviderRunFailure;
  } | null;
  providerStopStarted: boolean;
  /**
   * The provider reported, on its terminal status, that it dropped this turn's prompt before keeping it in its
   * native history (`ProviderStatusEvent.promptDropped`). Settlement records the turn as not delivered.
   */
  providerPromptDropped?: true;
  sessionAfter: string | null;
  providerSessionTitle?: string;
  /** This turn's restored history for native delivery; absent or null when it has none to deliver. */
  nativeHistory?: AssembledTurnRequest["nativeHistory"] | null;
  freshSessionRequest?: ((excludedMessageId: string) => AssembledTurnRequest) | null;
  /**
   * The native sessions this turn's fresh start replaced (a rejected resume, an exhausted or rejected-history
   * session, a session left in another checkout, a retired session). A fresh session that comes back under one of
   * them is the old session with the restored history added: the turn fails and never adopts it (T3 d32df2d34).
   */
  replacedSessionIds?: readonly string[];
  lastUsage: AgentTurnUsageSnapshot | null;
  assistantText: string;
  assistantPendingHighSurrogate: string;
  assistantSegmentText: string;
  /**
   * Where each closed assistant segment ends in `assistantText`, in order. The final result maps onto them, so a
   * harness that joins its messages with blank lines (Pi, Grok, OpenCode) corrects only the open segment.
   */
  closedAssistantSegmentEnds?: number[];
  assistantMessageId: string | null;
  latestAssistantMessageId: string | null;
  latestSecretCardAt?: string | null;
  followUpBoundary: { at: string; text: string; messageId: string | null } | null;
  pendingFollowUpBoundary: { at: string; messageId: string | null } | null;
  assistantStream: TurnStreamChannel;
  reasoningText: string;
  reasoningPendingHighSurrogate: string;
  reasoningId: string | null;
  reasoningStream: TurnStreamChannel;
  timeoutTimer: unknown;
  lifetimeTimer: unknown;
  runningActivities: Map<ProviderActivityEvent["kind"], AgentActivity[]>;
  providerActivitiesById: Map<string, AgentActivity>;
  /**
   * Provider activity id to Inertia timeline row id, kept after the row
   * settles so delegated-task traces can link to the tool call that began
   * them. Bounded first-in first-out.
   */
  providerActivityLinks?: Map<string, string>;
  providerActivityDetailChars: number;
  providerCommandRuns: Map<string, { id: string; label: string }>;
  providerOutputActivityIds: Set<string>;
  pendingActivityUpdates: Map<string, AgentActivity>;
  broadcastActivityDetails?: Map<string, string | null>;
  activityFlushTimer: unknown;
  approvalIds: Set<string>;
  inputIds: Set<string>;
  subagentTelemetry?: TurnSubagentTelemetry;
  customAgentCall?: CustomAgentCallAttribution;
  customAgentTraces?: CustomAgentTraceAttribution;
  onSettled?: QueueTurnRequest["onSettled"];
  readOnlyWatcher?: ReadOnlyWatcherTurn;
}

export interface FollowUpAdmissionLease {
  readonly conversationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly supportsImages: boolean;
  readonly submittedAt: string;
  readonly ready: Promise<void>;
  /** Idempotent; every acquired lease must be released. */
  release(): void;
}

export type FollowUpSteerResult =
  | { kind: "accepted"; message: ChatMessage }
  | { kind: "turn-ended" }
  | { kind: "unconfirmed"; message: string }
  | { kind: "refused" }
  | { kind: "unavailable" };
