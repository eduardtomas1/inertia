import type {
  AppSnapshot,
  ConversationShell,
  ConversationDetail,
  ConversationContextPacketSummary,
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
import { MAX_CONVERSATION_HISTORY_BYTES, type ConversationHistoryRequest } from "../../shared/conversation-history";
import { historyPredicate, historyStoredBytes, selectConversationHistory, HISTORY_TOO_LARGE_MESSAGE, type ConversationHistoryScope } from "./conversation-history";
import { PromptPresetRepository } from "./prompt-preset-repository";
import {
  MESSAGE_PROJECTION_COLUMNS,
  REASONING_PROJECTION_COLUMNS,
} from "./stream-text-storage";

type SnapshotPersistenceContext = Pick<PersistenceContext, "database"> & {
  contextPackets(conversationId: string, messageIds?: string[]): ConversationContextPacketSummary[];
};

export class SnapshotRepository {
  readonly promptPresets: PromptPresetRepository;

  constructor(private readonly context: SnapshotPersistenceContext) {
    this.promptPresets = new PromptPresetRepository(context.database);
  }

  snapshot(providers: ProviderInfo[] = []): RuntimeStoreSnapshot {
    const state = this.state();
    return {
      projects: (this.context.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC").all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.context.database.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id ASC").all() as ConversationRow[]).map(conversationFromRow),
      agentTurns: (this.context.database.prepare("SELECT * FROM agent_turns ORDER BY requested_at ASC, id ASC").all() as AgentTurnRow[]).map(agentTurnFromRow),
      turnGitArtifacts: (this.context.database.prepare(
        "SELECT * FROM turn_git_artifacts ORDER BY created_at ASC, id ASC",
      ).all() as TurnGitArtifactRow[]).map(turnGitArtifactFromRow),
      messages: (this.context.database.prepare(`
        SELECT ${MESSAGE_PROJECTION_COLUMNS}
        FROM messages
        ORDER BY messages.created_at ASC, messages.id ASC
      `).all() as MessageRow[]).map(messageFromRow),
      activities: (this.context.database.prepare("SELECT * FROM activities ORDER BY created_at ASC, id ASC").all() as ActivityRow[]).map(activityFromRow),
      subagents: (this.context.database.prepare(
        "SELECT * FROM subagent_traces ORDER BY created_at ASC, sequence ASC, id ASC",
      ).all() as SubagentTraceRow[]).map(subagentTraceFromRow),
      reasonings: (this.context.database.prepare(`
        SELECT ${REASONING_PROJECTION_COLUMNS}
        FROM agent_reasonings
        ORDER BY agent_reasonings.created_at ASC, agent_reasonings.id ASC
      `).all() as AgentReasoningRow[]).map(reasoningFromRow),
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
      promptPresets: this.promptPresets.list(),
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    const state = this.state();
    // One index probe per conversation. The window-function form scanned and
    // decoded every turn ever recorded on each coalesced shell snapshot.
    const latestTurns = new Map(
      (this.context.database.prepare(`
        SELECT agent_turns.*
        FROM conversations
        JOIN agent_turns ON agent_turns.id = (
          SELECT id
          FROM agent_turns AS latest
          WHERE latest.conversation_id = conversations.id
          ORDER BY latest.requested_at DESC, latest.id DESC
          LIMIT 1
        )
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
      promptPresets: this.promptPresets.list(),
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

  conversationHistory(conversationId: string, request: ConversationHistoryRequest = {}): ConversationDetail | null {
    if (!this.context.database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) return null;
    const scope = selectConversationHistory(this.context.database, conversationId, request);
    while (true) {
      const bytes = historyStoredBytes(this.context.database, conversationId, scope);
      if (bytes > MAX_CONVERSATION_HISTORY_BYTES / 4 && scope.units.length > 1) {
        scope.units = scope.units.slice(0, Math.max(1, Math.floor(scope.units.length / 2)));
        scope.older = scope.units.at(-1)!;
        continue;
      }
      if (bytes > MAX_CONVERSATION_HISTORY_BYTES) throw new Error(HISTORY_TOO_LARGE_MESSAGE);
      const detail = this.conversationDetail(conversationId, scope);
      if (!detail) return null;
      detail.history = { older: scope.older };
      if (Buffer.byteLength(JSON.stringify(detail), "utf8") <= MAX_CONVERSATION_HISTORY_BYTES) return detail;
      if (scope.units.length <= 1) throw new Error(HISTORY_TOO_LARGE_MESSAGE);
      scope.units = scope.units.slice(0, Math.max(1, Math.floor(scope.units.length / 2)));
      scope.older = scope.units.at(-1)!;
    }
  }

  conversationDetail(conversationId: string, scope?: ConversationHistoryScope): ConversationDetail | null {
    const conversationRow = this.context.database.prepare(
      "SELECT * FROM conversations WHERE id = ?",
    ).get(conversationId) as ConversationRow | undefined;
    if (!conversationRow) return null;

    const query = <T>(table: string, columns: string, order: string): T[] => {
      const where = scope ? historyPredicate(table, scope) : { sql: "1", parameters: [] };
      return this.context.database.prepare(`SELECT ${columns} FROM ${table}
        WHERE ${table}.conversation_id = ? AND (${where.sql}) ORDER BY ${order}`)
        .all(conversationId, ...where.parameters) as T[];
    };
    const messages = query<MessageRow>("messages", MESSAGE_PROJECTION_COLUMNS, "messages.created_at ASC, messages.id ASC").map(messageFromRow);

    return {
      conversation: conversationFromRow(conversationRow),
      agentTurns: query<AgentTurnRow>("agent_turns", "*", "requested_at ASC, id ASC").map(agentTurnFromRow),
      turnGitArtifacts: query<TurnGitArtifactRow>("turn_git_artifacts", "*", "created_at ASC, id ASC").map(turnGitArtifactFromRow),
      messages,
      activities: query<ActivityRow>("activities", "*", "created_at ASC, id ASC").map(activityFromRow),
      subagents: query<SubagentTraceRow>("subagent_traces", "*", "created_at ASC, sequence ASC, id ASC").map(subagentTraceFromRow),
      reasonings: query<AgentReasoningRow>("agent_reasonings", REASONING_PROJECTION_COLUMNS, "agent_reasonings.created_at ASC, agent_reasonings.id ASC").map(reasoningFromRow),
      usage: (this.context.database.prepare(`
        SELECT * FROM thread_usage
        WHERE conversation_id = ?
        ORDER BY updated_at ASC
      `).all(conversationId) as ThreadUsageRow[]).map(usageFromRow),
      plans: query<AgentPlanRow>("agent_plans", "conversation_id, run_id, turn_id, explanation, steps_json", "updated_at ASC, conversation_id ASC, run_id ASC").map(planFromRow),
      goals: (this.context.database.prepare(`
        SELECT * FROM agent_goals
        WHERE conversation_id = ?
        ORDER BY updated_at ASC, source ASC
      `).all(conversationId) as AgentGoalRow[]).map(agentGoalFromRow),
      checkpoints: query<CheckpointRow>("checkpoints", "*", "created_at ASC, id ASC").map(checkpointFromRow),
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
      contextPackets: this.context.contextPackets(conversationId, scope ? messages.map(({ id }) => id) : undefined),
    };
  }

  private state(): StateRow {
    const state = this.context.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }
}
