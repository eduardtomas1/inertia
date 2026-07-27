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
  ProviderInfo,
  SubagentTrace,
} from "@shared/contracts";
import type { TurnGitArtifactSummary } from "../../utils/responseTimeline";

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
  providers: ProviderInfo[];
  streamingText: string;
  streamingReasoning: string;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  showTimestamps: boolean;
  showThinking: boolean;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  checkpointRestoreDisabled: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  timelineElementRef?: RefObject<HTMLDivElement | null>;
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
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
}
