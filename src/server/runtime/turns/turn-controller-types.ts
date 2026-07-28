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
  ProviderId,
  ProviderInfo,
  RuntimeMutationEvent,
  TurnRequestContext,
} from "../../../shared/contracts";
import type {
  ProviderActivityEvent,
  ProviderMetadataEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../provider/contracts";
import type { HiddenProviderInstruction, SanitizedTurnExecutionManifest } from "./request-context";
import type { DeltaTimerScheduler, TurnStreamCoalescer } from "./turn-stream-coalescer";

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
  providerInfo(): readonly ProviderInfo[];
  applyProviderMetadata?(event: ProviderMetadataEvent): void;
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
  releaseTurnAttachments?(input: TurnAttachmentReleaseHookInput): void | Promise<void>;
  onTurnSettled?(turn: AgentTurn): void | Promise<void>;
}

export interface QueueTurnRequest {
  conversationId: string;
  content: string;
  attachments?: readonly ChatAttachment[];
  imagePaths?: readonly string[];
  context?: TurnRequestContext;
  activateConversation?: boolean;
  /** Server-constructed only. Renderer command schemas never accept this. */
  internalInstructions?: readonly HiddenProviderInstruction[];
  checkpointId?: string | null;
  rendererOwnerId?: string | null;
  onSettled?: (
    status: AgentTurnTerminalStatus,
    turnId: string,
  ) => void | Promise<void>;
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

export interface ActiveTurn {
  turn: AgentTurn;
  conversation: Conversation;
  providerInput: ProviderRunInput;
  attachmentIds: readonly string[];
  checkpointId: string | null;
  rendererOwnerId: string | null;
  structuredContext: unknown;
  gitBeforeCapture: Promise<void> | null;
  runStartedAt: number;
  workspaceRunCreated: boolean;
  providerRunStarted: boolean;
  attachmentsReleased: boolean;
  attachmentRelease: Promise<void> | null;
  acceptingProviderEvents: boolean;
  settled: boolean;
  sessionAfter: string | null;
  lastUsage: AgentTurnUsageSnapshot | null;
  assistantText: string;
  assistantSegmentText: string;
  assistantMessageId: string | null;
  latestAssistantMessageId: string | null;
  assistantStream: TurnStreamCoalescer;
  reasoningText: string;
  reasoningId: string | null;
  reasoningStream: TurnStreamCoalescer;
  timeoutTimer: unknown;
  runningActivities: Map<ProviderActivityEvent["kind"], AgentActivity[]>;
  providerActivitiesById: Map<string, AgentActivity>;
  providerActivityDetailChars: number;
  providerCommandRuns: Map<string, string>;
  approvalIds: Set<string>;
  inputIds: Set<string>;
  onSettled?: QueueTurnRequest["onSettled"];
}
