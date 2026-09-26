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
import type { ConversationContextPacketSummary } from "../conversation-context";

export interface ConversationHistoryRequest {
  cursor?: string;
  anchorMessageId?: string;
}

export interface ConversationDeferredContent {
  kind: "message" | "reasoning" | "activity";
  id: string;
  label: string;
  cursor: string;
  totalBytes: number;
}

export interface ConversationContentResult {
  kind: "conversation.content";
  conversationId: string;
  text: string;
  offsetBytes: number;
  totalBytes: number;
  nextCursor: string | null;
}
import type { QueuedMessage } from "../message-queue";

/**
 * Heavy state for one conversation. This is loaded independently from the
 * app shell so transcript growth does not inflate navigation snapshots.
 */
export interface ConversationDetail {
  /** A bounded transcript window; navigation replaces, rather than accumulates, it. */
  history?: { olderCursor: string | null; newerCursor: string | null; recordCount: number };
  /** Explicit previews whose complete stored text remains available in bounded segments. */
  deferredContent?: ConversationDeferredContent[];
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
  /** Present on current local-runtime details; absent from legacy projections. */
  contextPackets?: ConversationContextPacketSummary[];
  queuedMessages?: QueuedMessage[];
}

export type ConversationDetailResult =
  | { kind: "conversation.detail"; conversationId: string; state: "ready"; detail: ConversationDetail; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "missing"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "deleted"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "failed"; message: string; sync?: RuntimeSyncCursor };

export type ConversationDetailViewState =
  | { conversationId: string; state: "loading" }
  | ConversationDetailResult;
