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
  SubagentTrace,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
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
  streamingText: string;
  streamingReasoning: string;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  providerIdentityLabels?: ProviderIdentityLabels;
  showTimestamps: boolean;
  showThinking: boolean;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  checkpointRestoreDisabled: boolean;
  turnAnchorId?: string | null;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  timelineElementRef?: RefObject<HTMLDivElement | null>;
  onTurnAnchorSettled?: (turnId: string) => void;
  onTurnAnchorCancelled?: (turnId: string) => void;
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
