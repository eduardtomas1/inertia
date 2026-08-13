import type { RefObject } from "react";
import type {
  AgentActivity,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
  ConversationLatestTurnSummary,
  SubagentTrace,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type {
  StreamingAgentChannel,
  TurnGitArtifactSummary,
} from "../../utils/responseTimeline";

export interface ResponseTimelineProps {
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents?: SubagentTrace[];
  reasonings: AgentReasoning[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  gitArtifacts?: TurnGitArtifactSummary[];
  projectRoot: string;
  projectId: string;
  conversationId: string;
  latestTurnSummary?: {
    conversationId: string;
    turn: ConversationLatestTurnSummary;
  } | null;
  streamingText: string;
  streamingReasoning: string;
  streamingChannel?: StreamingAgentChannel;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  providerIdentityLabels?: ProviderIdentityLabels;
  showTimestamps: boolean;
  showThinking: boolean;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  autoScrollToFinalAnswer?: boolean;
  detailLoading?: boolean;
  checkpointRestoreDisabled: boolean;
  turnAnchorId?: string | null;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  timelineElementRef?: RefObject<HTMLDivElement | null>;
  onTurnAnchorSettled?: (turnId: string) => void;
  onTurnAnchorCancelled?: (turnId: string) => void;
  onFinalAnswerAutoScroll?: (event: FinalAnswerAutoScrollEvent) => void;
  onRespondToApproval: (
    request: AgentApprovalRequest,
    decision: AgentApprovalDecision,
  ) => Promise<void>;
  onRespondToInput: (
    request: AgentInputRequest,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
  onOpenTurnDiff: (turnId: string, path?: string) => void;
  onCompareTurnArtifacts: (earlierTurnId: string, laterTurnId: string) => void;
  onOpenTurnFile: (path: string) => void;
  onStop: () => void;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
}

export type FinalAnswerAutoScrollEvent = {
  conversationId: string;
  answerId: string;
} & (
  | { status: "started" }
  | { status: "positioned"; followsLatest: boolean }
  | { status: "cancelled" }
);
