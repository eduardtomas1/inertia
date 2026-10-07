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
  conversationDetailFromRow,
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
import { CONVERSATION_HAS_HISTORY_SQL } from "./conversation-provider-policy";
import { MAX_CONVERSATION_HISTORY_BYTES, type ConversationHistoryRequest } from "../../shared/conversation-history";
import {
  conversationStoredBytes,
  CONVERSATION_RECORDS_TOO_LARGE_MESSAGE,
  historyPredicate,
  historyStoredBytes,
  selectConversationHistory,
  HISTORY_TOO_LARGE_MESSAGE,
  type ConversationHistoryScope,
} from "./conversation-history";
import { ConversationHistoryTooLargeError } from "./errors";
import { PromptPresetRepository } from "./prompt-preset-repository";
import { conversationAttachmentGallery } from "./conversation-attachment-gallery";
import {
  MESSAGE_PROJECTION_COLUMNS,
  REASONING_PROJECTION_COLUMNS,
} from "./stream-text-storage";

type ConversationShellRow = ConversationRow & { has_history: number };
type UsageLimitedTurnRow = AgentTurnRow & { usage_limited: number };
const TURN_USAGE_LIMITED_SQL = "EXISTS (SELECT 1 FROM usage_limited_turns WHERE usage_limited_turns.turn_id = agent_turns.id)";
type ConversationRecords = Pick<ConversationDetail, "usage" | "goals" | "reviewSummaries" | "reviewStates" | "reviewNotes">;
type HistoryPageRecords = Omit<ConversationDetail, "conversation" | "history" | "attachmentGallery" | keyof ConversationRecords>;
const EMPTY_CONVERSATION_RECORDS: ConversationRecords = { usage: [], goals: [], reviewSummaries: [], reviewStates: [], reviewNotes: [] };
const EMPTY_HISTORY_RECORDS: HistoryPageRecords = { agentTurns: [], turnGitArtifacts: [], messages: [], activities: [],
  subagents: [], reasonings: [], plans: [], checkpoints: [], contextPackets: [] };

export interface RecentConversationLimits {
  messages: number;
  activities: number;
  subagents: number;
  contentCharacters: number;
}

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
        SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited
        FROM conversations
        JOIN agent_turns ON agent_turns.id = (
          SELECT id
          FROM agent_turns AS latest
          WHERE latest.conversation_id = conversations.id
          ORDER BY latest.requested_at DESC, latest.id DESC
          LIMIT 1
        )
      `).all() as UsageLimitedTurnRow[])
        .map((row) => [row.conversation_id, { turn: agentTurnFromRow(row), usageLimited: row.usage_limited === 1 }] as const),
    );
    return {
      projects: (this.context.database.prepare(
        "SELECT * FROM projects ORDER BY updated_at DESC, id ASC",
      ).all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.context.database.prepare(`
        SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
        FROM conversations ORDER BY updated_at DESC, id ASC
      `).all() as ConversationShellRow[]).map((row) => {
        const latest = latestTurns.get(row.id);
        return conversationShellFromRow(row, latest?.turn ?? null, latest?.usageLimited);
      }),
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

  private conversationRow(conversationId: string): ConversationShellRow | undefined {
    return this.context.database.prepare(`
      SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
      FROM conversations WHERE id = ?
    `).get(conversationId) as ConversationShellRow | undefined;
  }

  conversationShell(conversationId: string): ConversationShell | null {
    const row = this.conversationRow(conversationId);
    if (!row) return null;
    const latestTurn = this.context.database.prepare(`
      SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as UsageLimitedTurnRow | undefined;
    return conversationShellFromRow(
      row,
      latestTurn ? agentTurnFromRow(latestTurn) : null,
      latestTurn?.usage_limited === 1,
    );
  }

  conversationHistory(conversationId: string, request: ConversationHistoryRequest = {}): ConversationDetail | null {
    const conversationRow = this.conversationRow(conversationId);
    if (!conversationRow) return null;
    const scope = selectConversationHistory(this.context.database, conversationId, request);
    const latest = !request.before && !request.messageId && !request.turnId;
    if (latest && conversationStoredBytes(this.context.database, conversationId) > MAX_CONVERSATION_HISTORY_BYTES / 2) {
      throw new ConversationHistoryTooLargeError(CONVERSATION_RECORDS_TOO_LARGE_MESSAGE);
    }
    const shared = {
      conversation: conversationDetailFromRow(conversationRow),
      attachmentGallery: conversationAttachmentGallery(this.context.database, conversationId),
      ...(latest ? this.conversationRecords(conversationId) : EMPTY_CONVERSATION_RECORDS),
    };
    const page = (records: HistoryPageRecords, omittedTurnIds: string[] = []): ConversationDetail | null => {
      const detail: ConversationDetail = { ...shared, ...records,
        history: { older: scope.older, ...(omittedTurnIds.length ? { omittedTurnIds } : {}) } };
      return Buffer.byteLength(JSON.stringify(detail), "utf8") <= MAX_CONVERSATION_HISTORY_BYTES ? detail : null;
    };
    while (true) {
      const bytes = historyStoredBytes(this.context.database, conversationId, scope);
      if (bytes > MAX_CONVERSATION_HISTORY_BYTES / 4 && scope.units.length > 1) {
        scope.units = scope.units.slice(0, Math.max(1, Math.floor(scope.units.length / 2)));
        scope.older = scope.units.at(-1)!;
        continue;
      }
      const detail = bytes <= MAX_CONVERSATION_HISTORY_BYTES ? page(this.historyRecords(conversationId, scope)) : null;
      if (detail) return detail;
      if (scope.units.length > 1) {
        scope.units = scope.units.slice(0, Math.max(1, Math.floor(scope.units.length / 2)));
        scope.older = scope.units.at(-1)!;
        continue;
      }
      const unit = scope.units[0];
      const omitted = unit?.kind === "turn"
        ? page(this.omittedTurnRecords(conversationId, unit.id), [unit.id])
        : page(EMPTY_HISTORY_RECORDS);
      if (omitted) return omitted;
      throw new ConversationHistoryTooLargeError(HISTORY_TOO_LARGE_MESSAGE);
    }
  }

  conversationDetail(conversationId: string): ConversationDetail | null {
    const conversationRow = this.conversationRow(conversationId);
    if (!conversationRow) return null;
    return {
      conversation: conversationDetailFromRow(conversationRow),
      ...this.historyRecords(conversationId),
      ...this.conversationRecords(conversationId),
    };
  }

  recentConversationDetail(conversationId: string, limits: RecentConversationLimits): ConversationDetail | null {
    const conversationRow = this.conversationRow(conversationId);
    if (!conversationRow) return null;
    const newest = <T>(sql: string, ...parameters: (string | number)[]) =>
      (this.context.database.prepare(sql).all(...parameters) as T[]).reverse();
    return {
      ...EMPTY_HISTORY_RECORDS,
      ...EMPTY_CONVERSATION_RECORDS,
      conversation: conversationDetailFromRow(conversationRow),
      messages: newest<MessageRow>(`SELECT id, conversation_id, turn_id, role, substr(content, 1, ?) AS content,
          attachments_json, compaction_json, private_connect_device_id, created_at
        FROM (SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages
          WHERE messages.conversation_id = ? AND messages.role IN ('user', 'assistant')
          ORDER BY messages.created_at DESC, messages.id DESC LIMIT ?)`,
      limits.contentCharacters, conversationId, limits.messages).map(messageFromRow),
      activities: newest<ActivityRow>(`SELECT id, conversation_id, run_id, turn_id, kind, title, NULL AS detail,
          status, created_at FROM activities WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`, conversationId, limits.activities).map(activityFromRow),
      subagents: newest<SubagentTraceRow>(`SELECT id, conversation_id, run_id, turn_id, provider_id, provider_task_id,
          provider_agent_id, parent_trace_id, parent_provider_agent_id, parent_provider_tool_use_id,
          provider_tool_use_id, provider_role, provider_name, provider_status, status, is_live,
          NULL AS description, NULL AS progress, NULL AS result, NULL AS model, NULL AS activity,
          NULL AS usage_json, NULL AS tool_use_count, NULL AS duration_ms, sequence, created_at, updated_at
        FROM subagent_traces WHERE conversation_id = ?
        ORDER BY created_at DESC, sequence DESC, id DESC LIMIT ?`, conversationId, limits.subagents).map(subagentTraceFromRow),
      plans: newest<AgentPlanRow>(`SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans WHERE conversation_id = ? ORDER BY updated_at DESC, run_id DESC LIMIT 1`, conversationId).map(planFromRow),
    };
  }

  private historyRecords(conversationId: string, scope?: ConversationHistoryScope): HistoryPageRecords {
    const query = <T>(table: Parameters<typeof historyPredicate>[0], columns: string, order: string): T[] => {
      const where = scope ? historyPredicate(table, scope) : { sql: "1", parameters: [] };
      return this.context.database.prepare(`SELECT ${columns} FROM ${table}
        WHERE ${table}.conversation_id = ? AND (${where.sql}) ORDER BY ${order}`)
        .all(conversationId, ...where.parameters) as T[];
    };
    const messages = query<MessageRow>("messages", MESSAGE_PROJECTION_COLUMNS, "messages.created_at ASC, messages.id ASC").map(messageFromRow);
    return {
      agentTurns: query<UsageLimitedTurnRow>("agent_turns", `agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited`, "requested_at ASC, id ASC").map(agentTurnFromRow),
      turnGitArtifacts: query<TurnGitArtifactRow>("turn_git_artifacts", "*", "created_at ASC, id ASC").map(turnGitArtifactFromRow),
      messages,
      activities: query<ActivityRow>("activities", "*", "created_at ASC, id ASC").map(activityFromRow),
      subagents: query<SubagentTraceRow>("subagent_traces", "*", "created_at ASC, sequence ASC, id ASC").map(subagentTraceFromRow),
      reasonings: query<AgentReasoningRow>("agent_reasonings", REASONING_PROJECTION_COLUMNS, "agent_reasonings.created_at ASC, agent_reasonings.id ASC").map(reasoningFromRow),
      plans: query<AgentPlanRow>("agent_plans", "conversation_id, run_id, turn_id, explanation, steps_json", "updated_at ASC, conversation_id ASC, run_id ASC").map(planFromRow),
      checkpoints: query<CheckpointRow>("checkpoints", "*", "created_at ASC, id ASC").map(checkpointFromRow),
      contextPackets: this.context.contextPackets(conversationId, scope ? messages.map(({ id }) => id) : undefined),
    };
  }

  private omittedTurnRecords(conversationId: string, turnId: string): HistoryPageRecords {
    const turn = this.context.database.prepare(`SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited
      FROM agent_turns WHERE conversation_id = ? AND id = ?`).get(conversationId, turnId) as UsageLimitedTurnRow;
    const messages = (this.context.database.prepare(`SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages
      WHERE messages.conversation_id = ? AND messages.id = ?`)
      .all(conversationId, turn.user_message_id) as MessageRow[]).map(messageFromRow);
    return { ...EMPTY_HISTORY_RECORDS, agentTurns: [agentTurnFromRow(turn)], messages,
      contextPackets: this.context.contextPackets(conversationId, messages.map(({ id }) => id)) };
  }

  private conversationRecords(conversationId: string): ConversationRecords {
    const all = <T>(sql: string) => this.context.database.prepare(sql).all(conversationId) as T[];
    return {
      usage: all<ThreadUsageRow>("SELECT * FROM thread_usage WHERE conversation_id = ? ORDER BY updated_at ASC").map(usageFromRow),
      goals: all<AgentGoalRow>("SELECT * FROM agent_goals WHERE conversation_id = ? ORDER BY updated_at ASC, source ASC").map(agentGoalFromRow),
      reviewSummaries: all<DiffReviewSummaryRow>("SELECT * FROM diff_review_summaries WHERE conversation_id = ? ORDER BY generated_at ASC")
        .flatMap((row) => {
          const summary = reviewSummaryFromRow(row);
          return summary ? [summary] : [];
        }),
      reviewStates: all<DiffReviewStateRow>("SELECT * FROM diff_review_states WHERE conversation_id = ? ORDER BY updated_at ASC").map(reviewStateFromRow),
      reviewNotes: all<DiffReviewNoteRow>("SELECT * FROM diff_review_notes WHERE conversation_id = ? ORDER BY created_at ASC").map(reviewNoteFromRow),
    };
  }

  private state(): StateRow {
    const state = this.context.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }
}
