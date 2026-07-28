import type {
  AccessMode,
  AgentActivity,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  AgentTurnAssociation,
  AgentTurnStatus,
  AgentTurnTerminalStatus,
  AgentTurnUsageSnapshot,
  AppSnapshot,
  ChatAttachment,
  ChatMessage,
  CheckpointSummary,
  ContinuationIdentity,
  Conversation,
  DiffReviewNote,
  DiffReviewState,
  DiffReviewSummary,
  InteractionMode,
  ModelSelection,
  ProviderId,
  SubagentTrace,
  SubagentTraceStatus,
  ThreadUsageSnapshot,
  TurnGitArtifact,
  TurnGitArtifactAbsenceReason,
  TurnGitArtifactCompleteness,
  TurnGitArtifactFile,
  TurnGitArtifactStatus,
  TurnGitPatchState,
} from "../../shared/contracts";
import type {
  ModelBackendDefault,
  PersistedModelBackendProfile,
} from "../../shared/backend-profile-settings";
import type { BackendCompatibilityProbeResult } from "../../shared/backend-probe";
import type { PersistedTurnExecutionContext } from "../runtime/turns/request-context";

export interface NewConversationOptions {
  providerId?: ProviderId;
  modelSelection?: ModelSelection;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: InteractionMode;
  accessMode?: AccessMode;
  activate?: boolean;
  branch?: string | null;
  worktreePath?: string | null;
}

export interface CreateAgentTurnInput {
  id?: string;
  conversationId: string;
  runId: string;
  userMessageId: string;
  providerId: ProviderId;
  modelSelection?: ModelSelection;
  continuationIdentity?: ContinuationIdentity;
  /** Legacy database-boundary fields accepted for V0.0.6 compatibility. */
  harnessId?: string;
  backendProfileId?: string;
  model?: string;
  modelAlias?: string | null;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  providerSessionBefore?: string | null;
  requestedAt?: string;
  usageAtStart?: AgentTurnUsageSnapshot | null;
  configurationRevision: number;
  association: AgentTurnAssociation;
}

export interface AgentTurnLifecycleUpdate {
  status: AgentTurnStatus;
  terminalAssistantMessageId?: string | null;
  providerSessionAfter?: string | null;
  terminalReason?: string | null;
  checkpointId?: string | null;
  usageAtCompletion?: AgentTurnUsageSnapshot | null;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface BeginAgentTurnInput
  extends Omit<CreateAgentTurnInput, "userMessageId" | "requestedAt"> {
  content: string;
  attachments?: ChatAttachment[];
  activateConversation?: boolean;
  executionContext?: PersistedTurnExecutionContext;
  requestedAt?: string;
}

export interface CreateMessageOptions {
  activateConversation?: boolean;
}

export interface AgentTurnSettlementUpdate
  extends Omit<AgentTurnLifecycleUpdate, "status"> {
  status: AgentTurnTerminalStatus;
}

export interface AgentTurnSettlementResult {
  settled: boolean;
  turn: AgentTurn;
}

export interface StoredTurnGitArtifact extends TurnGitArtifact {
  beforeRef: string | null;
  afterRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTurnGitArtifactInput {
  id?: string;
  turnId: string;
  repositoryIdentity?: string | null;
  worktreeIdentity?: string | null;
  branch?: string | null;
  beforeCheckpointId?: string | null;
  beforeRef?: string | null;
  beforeFingerprint?: string | null;
  status?: TurnGitArtifactStatus;
  completeness?: TurnGitArtifactCompleteness;
  failureReason?: string | null;
  absenceReason?: TurnGitArtifactAbsenceReason | null;
  createdAt?: string;
}

export interface CompleteTurnGitArtifactInput {
  afterRef?: string | null;
  afterFingerprint?: string | null;
  files?: TurnGitArtifactFile[];
  insertions?: number;
  deletions?: number;
  status: TurnGitArtifactStatus;
  completeness: TurnGitArtifactCompleteness;
  patchState?: TurnGitPatchState;
  patchDigest?: string | null;
  capturedAt?: string | null;
  terminalAssistantMessageId?: string | null;
  failureReason?: string | null;
  absenceReason?: TurnGitArtifactAbsenceReason | null;
  updatedAt?: string;
}

export interface RuntimeStoreSnapshot extends Omit<AppSnapshot, "conversations"> {
  conversations: Conversation[];
  agentTurns: AgentTurn[];
  turnGitArtifacts: TurnGitArtifact[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  usage: ThreadUsageSnapshot[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  reviewSummaries: DiffReviewSummary[];
  reviewStates: DiffReviewState[];
  reviewNotes: DiffReviewNote[];
}

export interface UpsertSubagentTraceInput {
  conversationId: string;
  runId: string;
  turnId: string;
  providerId: ProviderId;
  providerTaskId: string | null;
  providerAgentId: string | null;
  parentProviderAgentId: string | null;
  parentProviderToolUseId: string | null;
  providerToolUseId: string | null;
  providerRole: string | null;
  providerName: string | null;
  status: SubagentTraceStatus;
  description: string | null;
  progress: string | null;
  result: string | null;
  sequence: number;
  updatedAt?: string;
}

export interface UpsertSubagentTraceResult {
  trace: SubagentTrace;
  changed: boolean;
}

export interface StoredModelBackendProfile {
  profile: PersistedModelBackendProfile;
  latestProbe: BackendCompatibilityProbeResult | null;
}

export type { ModelBackendDefault };
