import type {
  AgentGoal,
} from "./agent-workflows";
import type {
  AgentActivity,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
  SubagentTrace,
  ThreadUsageSnapshot,
} from "./agent";
import type {
  Conversation,
  RuntimeSyncCursor,
} from "./app";
import type {
  DiffReviewNote,
  DiffReviewState,
  DiffReviewSummary,
  TurnGitArtifact,
} from "./git";

/**
 * Heavy state for one conversation. This is loaded independently from the
 * app shell so transcript growth does not inflate navigation snapshots.
 */
export interface ConversationDetail {
  conversation: Conversation;
  agentTurns: AgentTurn[];
  turnGitArtifacts: TurnGitArtifact[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  usage: ThreadUsageSnapshot[];
  plans: AgentPlan[];
  goals: AgentGoal[];
  checkpoints: CheckpointSummary[];
  reviewSummaries: DiffReviewSummary[];
  reviewStates: DiffReviewState[];
  reviewNotes: DiffReviewNote[];
}

export type ConversationDetailResult =
  | { kind: "conversation.detail"; conversationId: string; state: "ready"; detail: ConversationDetail; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "missing"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "deleted"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "failed"; message: string; sync?: RuntimeSyncCursor };

export type ConversationDetailViewState =
  | { conversationId: string; state: "loading" }
  | ConversationDetailResult;
