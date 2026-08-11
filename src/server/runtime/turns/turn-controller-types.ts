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
  RuntimeMutationEvent,
  TurnRequestContext,
} from "../../../shared/contracts";
import type {
  ProviderActivityEvent,
  ProviderGoalMutation,
  ProviderGoalSnapshot,
  ProviderMetadataEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../provider/contracts";
import type { HiddenProviderInstruction, SanitizedTurnExecutionManifest } from "./request-context";
import type { DocumentAttachmentContext } from "../attachments/document-attachment-context";
import type { DeltaTimerScheduler } from "./turn-stream-coalescer";
import type { TurnStreamChannel } from "./turn-stream-channel";
import type { StreamingTrace } from "../test-streaming-trace";

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
  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult>;
  cancel(conversationId: string): boolean;
  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string | null },
  ): Promise<"missing" | "identity-mismatch" | "settled" | "force-detached">;
  isRunning(conversationId: string): boolean;
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
    content: string,
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
  ): Promise<boolean>;
  stopSubagent?(
    conversationId: string,
    providerTaskId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean>;
  disposeAll(): Promise<void>;
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

export interface TurnControllerHooks {
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  /**
   * Emits only the mutable shell rows owned by one conversation. Tests and
   * compatibility callers may omit this and retain the full-snapshot fallback.
   */
  broadcastConversationShell?(conversationId: string): void;
  providerInfo(): readonly ProviderInfo[];
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
  captureGitBefore?(input: TurnGitArtifactHookInput): void | Promise<void>;
  captureGitArtifacts?(input: TurnGitArtifactHookInput): void | Promise<void>;
  refreshProviderMetadata?(input: TurnMetadataRefreshHookInput): void | Promise<void>;
  validateModelSelection?(selection: ModelSelection): ModelSelection;
  releaseTurnAttachments?(input: TurnAttachmentReleaseHookInput): void | Promise<void>;
  releaseGeneratedAttachments?(paths: readonly string[]): void | Promise<void>;
  onTurnSettled?(turn: AgentTurn): void | Promise<void>;
  /** Benchmark-only stage attribution; absent in ordinary runtime instances. */
  testOnlyStreamingTrace?: StreamingTrace;
}

export interface QueueTurnRequest {
  conversationId: string;
  /** Server-only authorization for the exact locked Duo judge dispatch. */
  authorizedDuoComparisonLaunchId?: string;
  content: string;
  attachments?: readonly ChatAttachment[];
  imagePaths?: readonly string[];
  /** Private raster derivatives owned only until exact provider cleanup. */
  generatedAttachmentPaths?: readonly string[];
  /** Server-derived only. Renderer commands never provide extracted document text. */
  documentContexts?: readonly DocumentAttachmentContext[];
  context?: TurnRequestContext;
  activateConversation?: boolean;
  /** Server-constructed only. Renderer command schemas never accept this. */
  internalInstructions?: readonly HiddenProviderInstruction[];
  checkpointId?: string | null;
  /** Privileged provider-native skill references resolved from opaque IDs. */
  skills?: readonly ProviderSkillInput[];
  rendererOwnerId?: string | null;
  onSettled?: (
    status: AgentTurnTerminalStatus,
    turnId: string,
  ) => void | Promise<void>;
  /** Privileged runtime-only launch mode; never accepted from renderer IPC. */
  goalStart?: {
    objective?: string;
    tokenBudget?: number | null;
  };
}

export interface QueuedTurn {
  message: ChatMessage;
  turn: AgentTurn;
}

export type TurnTerminalCause =
  | "provider-completed"
  | "provider-error"
  | "provider-process-exit"
  | "provider-process-crash"
  | "user-cancelled"
  | "approval-cancelled"
  | "unsupported-interaction"
  | "runtime-shutdown"
  | "runtime-crash"
  | "runtime-restart"
  | "turn-timeout"
  | "renderer-disconnected"
  | "turn-start-failed"
  | "stream-persistence-failed"
  | "checkpoint-association-failed";

export interface NativeGoalStartAcknowledgement {
  objective?: string;
  tokenBudget?: number | null;
  resolve(goal: ProviderGoalSnapshot): void;
  reject(error: Error): void;
}

export interface ActiveTurn {
  turn: AgentTurn;
  conversation: Conversation;
  providerInput: ProviderRunInput;
  attachmentIds: readonly string[];
  generatedAttachmentPaths: readonly string[];
  checkpointId: string | null;
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
  acceptingProviderEvents: boolean;
  settled: boolean;
  sessionAfter: string | null;
  lastUsage: AgentTurnUsageSnapshot | null;
  assistantText: string;
  assistantPendingHighSurrogate: string;
  assistantSegmentText: string;
  assistantMessageId: string | null;
  latestAssistantMessageId: string | null;
  assistantStream: TurnStreamChannel;
  reasoningText: string;
  reasoningPendingHighSurrogate: string;
  reasoningId: string | null;
  reasoningStream: TurnStreamChannel;
  timeoutTimer: unknown;
  runningActivities: Map<ProviderActivityEvent["kind"], AgentActivity[]>;
  providerActivitiesById: Map<string, AgentActivity>;
  providerActivityDetailChars: number;
  providerCommandRuns: Map<string, string>;
  approvalIds: Set<string>;
  inputIds: Set<string>;
  onSettled?: QueueTurnRequest["onSettled"];
}
