import type {
  AppSnapshot,
  ConversationShell,
  ConversationDetail,
  ProviderInfo,
} from "../../shared/contracts";
import {
  activityFromRow,
  agentGoalFromRow,
  agentTurnFromRow,
  checkpointFromRow,
  conversationFromRow,
  conversationShellFromRow,
  messageFromRow,
  planFromRow,
  projectFromRow,
  reasoningFromRow,
  settingsFromState,
  subagentTraceFromRow,
  usageFromRow,
  workspaceRunFromRow,
} from "./codecs";
import type { PersistenceContext } from "./context";
import { turnGitArtifactFromRow } from "./git-artifact-codecs";
import {
  reviewNoteFromRow,
  reviewStateFromRow,
  reviewSummaryFromRow,
} from "./review-codecs";
import type {
  ActivityRow,
  AgentGoalRow,
  AgentPlanRow,
  AgentReasoningRow,
  AgentTurnRow,
  CheckpointRow,
  ConversationRow,
  DiffReviewNoteRow,
  DiffReviewStateRow,
  DiffReviewSummaryRow,
  MessageRow,
  ProjectRow,
  StateRow,
  SubagentTraceRow,
  ThreadUsageRow,
  TurnGitArtifactRow,
  WorkspaceRunRow,
} from "./rows";
import type { RuntimeStoreSnapshot } from "./types";

type SnapshotPersistenceContext = Pick<PersistenceContext, "database">;

export class SnapshotRepository {
  constructor(private readonly context: SnapshotPersistenceContext) {}

  snapshot(providers: ProviderInfo[] = []): RuntimeStoreSnapshot {
    const state = this.state();
    return {
      projects: (this.context.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC").all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.context.database.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id ASC").all() as ConversationRow[]).map(conversationFromRow),
      agentTurns: (this.context.database.prepare("SELECT * FROM agent_turns ORDER BY requested_at ASC, id ASC").all() as AgentTurnRow[]).map(agentTurnFromRow),
      turnGitArtifacts: (this.context.database.prepare(
        "SELECT * FROM turn_git_artifacts ORDER BY created_at ASC, id ASC",
      ).all() as TurnGitArtifactRow[]).map(turnGitArtifactFromRow),
      messages: (this.context.database.prepare("SELECT * FROM messages ORDER BY created_at ASC, id ASC").all() as MessageRow[]).map(messageFromRow),
      activities: (this.context.database.prepare("SELECT * FROM activities ORDER BY created_at ASC, id ASC").all() as ActivityRow[]).map(activityFromRow),
      subagents: (this.context.database.prepare(
        "SELECT * FROM subagent_traces ORDER BY created_at ASC, sequence ASC, id ASC",
      ).all() as SubagentTraceRow[]).map(subagentTraceFromRow),
      reasonings: (this.context.database.prepare("SELECT * FROM agent_reasonings ORDER BY created_at ASC, id ASC").all() as AgentReasoningRow[]).map(reasoningFromRow),
      usage: (this.context.database.prepare("SELECT * FROM thread_usage ORDER BY updated_at ASC").all() as ThreadUsageRow[]).map(usageFromRow),
      plans: (this.context.database.prepare(`
        SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans
        ORDER BY updated_at ASC, conversation_id ASC, run_id ASC
      `).all() as AgentPlanRow[]).map(planFromRow),
      goals: (this.context.database.prepare(`
        SELECT * FROM agent_goals
        ORDER BY updated_at ASC, conversation_id ASC, source ASC
      `).all() as AgentGoalRow[]).map(agentGoalFromRow),
      checkpoints: (this.context.database.prepare("SELECT * FROM checkpoints ORDER BY created_at ASC, id ASC").all() as CheckpointRow[]).map(checkpointFromRow),
      reviewSummaries: (this.context.database.prepare("SELECT * FROM diff_review_summaries ORDER BY generated_at ASC").all() as DiffReviewSummaryRow[])
        .flatMap((row) => {
          const summary = reviewSummaryFromRow(row);
          return summary ? [summary] : [];
        }),
      reviewStates: (this.context.database.prepare("SELECT * FROM diff_review_states ORDER BY updated_at ASC").all() as DiffReviewStateRow[]).map(reviewStateFromRow),
      reviewNotes: (this.context.database.prepare("SELECT * FROM diff_review_notes ORDER BY created_at ASC").all() as DiffReviewNoteRow[]).map(reviewNoteFromRow),
      runs: (this.context.database.prepare("SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200").all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    const state = this.state();
    const latestTurns = new Map(
      (this.context.database.prepare(`
        SELECT *
        FROM (
          SELECT
            agent_turns.*,
            ROW_NUMBER() OVER (
              PARTITION BY conversation_id
              ORDER BY requested_at DESC, id DESC
            ) AS conversation_rank
          FROM agent_turns
        )
        WHERE conversation_rank = 1
      `).all() as AgentTurnRow[])
        .map(agentTurnFromRow)
        .map((turn) => [turn.conversationId, turn] as const),
    );
    return {
      projects: (this.context.database.prepare(
        "SELECT * FROM projects ORDER BY updated_at DESC, id ASC",
      ).all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.context.database.prepare(
        "SELECT * FROM conversations ORDER BY updated_at DESC, id ASC",
      ).all() as ConversationRow[]).map((row) =>
        conversationShellFromRow(row, latestTurns.get(row.id) ?? null)),
      runs: (this.context.database.prepare(
        "SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200",
      ).all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  conversationShell(conversationId: string): ConversationShell | null {
    const row = this.context.database.prepare(
      "SELECT * FROM conversations WHERE id = ?",
    ).get(conversationId) as ConversationRow | undefined;
    if (!row) return null;
    const latestTurn = this.context.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AgentTurnRow | undefined;
    return conversationShellFromRow(
      row,
      latestTurn ? agentTurnFromRow(latestTurn) : null,
    );
  }

  conversationDetail(conversationId: string): ConversationDetail | null {
    const conversationRow = this.context.database.prepare(
      "SELECT * FROM conversations WHERE id = ?",
    ).get(conversationId) as ConversationRow | undefined;
    if (!conversationRow) return null;

    return {
      conversation: conversationFromRow(conversationRow),
      agentTurns: (this.context.database.prepare(`
        SELECT * FROM agent_turns
        WHERE conversation_id = ?
        ORDER BY requested_at ASC, id ASC
      `).all(conversationId) as AgentTurnRow[]).map(agentTurnFromRow),
      turnGitArtifacts: (this.context.database.prepare(`
        SELECT * FROM turn_git_artifacts
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as TurnGitArtifactRow[]).map(turnGitArtifactFromRow),
      messages: (this.context.database.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as MessageRow[]).map(messageFromRow),
      activities: (this.context.database.prepare(`
        SELECT * FROM activities
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as ActivityRow[]).map(activityFromRow),
      subagents: (this.context.database.prepare(`
        SELECT * FROM subagent_traces
        WHERE conversation_id = ?
        ORDER BY created_at ASC, sequence ASC, id ASC
      `).all(conversationId) as SubagentTraceRow[]).map(subagentTraceFromRow),
      reasonings: (this.context.database.prepare(`
        SELECT * FROM agent_reasonings
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as AgentReasoningRow[]).map(reasoningFromRow),
      usage: (this.context.database.prepare(`
        SELECT * FROM thread_usage
        WHERE conversation_id = ?
        ORDER BY updated_at ASC
      `).all(conversationId) as ThreadUsageRow[]).map(usageFromRow),
      plans: (this.context.database.prepare(`
        SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans
        WHERE conversation_id = ?
        ORDER BY updated_at ASC, conversation_id ASC, run_id ASC
      `).all(conversationId) as AgentPlanRow[]).map(planFromRow),
      goals: (this.context.database.prepare(`
        SELECT * FROM agent_goals
        WHERE conversation_id = ?
        ORDER BY updated_at ASC, source ASC
      `).all(conversationId) as AgentGoalRow[]).map(agentGoalFromRow),
      checkpoints: (this.context.database.prepare(`
        SELECT * FROM checkpoints
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as CheckpointRow[]).map(checkpointFromRow),
      reviewSummaries: (this.context.database.prepare(`
        SELECT * FROM diff_review_summaries
        WHERE conversation_id = ?
        ORDER BY generated_at ASC
      `).all(conversationId) as DiffReviewSummaryRow[]).flatMap((row) => {
        const summary = reviewSummaryFromRow(row);
        return summary ? [summary] : [];
      }),
      reviewStates: (this.context.database.prepare(`
        SELECT * FROM diff_review_states
        WHERE conversation_id = ?
        ORDER BY updated_at ASC
      `).all(conversationId) as DiffReviewStateRow[]).map(reviewStateFromRow),
      reviewNotes: (this.context.database.prepare(`
        SELECT * FROM diff_review_notes
        WHERE conversation_id = ?
        ORDER BY created_at ASC
      `).all(conversationId) as DiffReviewNoteRow[]).map(reviewNoteFromRow),
    };
  }

  private state(): StateRow {
    const state = this.context.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }
}
