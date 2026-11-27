import type {
  AppSnapshot,
  ArchivedConversationRef,
  ConversationShell,
  Project,
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
  latestTurnSummaryFromRow,
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
import { CONVERSATION_CONTEXT_MESSAGE_SQL } from "./conversation-context-source";
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
  estimateJsonUtf8BytesBound,
  historyPredicate,
  historyStoredBytes,
  selectConversationHistory,
  HISTORY_TOO_LARGE_MESSAGE,
  type ConversationHistoryScope,
} from "./conversation-history";
import { ConversationHistoryTooLargeError } from "./errors";
import { PromptPresetRepository } from "./prompt-preset-repository";
import { TodoRepository } from "./todo-repository";
import { CustomAgentRepository } from "./custom-agent-repository";
import { LibraryRepository } from "./library-repository";
import { cachedStatement } from "./statement-cache";
import { withLatestPlanDocument } from "./latest-plan-document";
import { conversationAttachmentGallery } from "./conversation-attachment-gallery";
import {
  MESSAGE_PROJECTION_COLUMNS,
  REASONING_PROJECTION_COLUMNS,
} from "./stream-text-storage";
import { agentContextReadSummaries } from "./conversation-context-turn-reads";
import { watcherLinkViews, watcherWakeSummaries } from "./watcher-link-codecs";
import { DelegationReads, defaultLiveNativeChildren } from "../orchestration-v2/delegation-reads";
import {
  ARCHIVED_CONVERSATIONS_PAGE_SIZE,
  type ArchivedConversationsPage,
  type ArchivedConversationsRequest,
} from "../../shared/archived-conversations";
import { MAX_ACTIVITY_DETAIL_READ_CHARS, type ActivityDetailReadResult } from "../../shared/activity-detail";
import {
  activityPreviewFromProjectedRow,
  buildActivityPreviewQuery,
  type ProjectedActivityRow,
} from "./activity-detail-preview";

type ConversationShellRow = ConversationRow & { has_history: number };
type UsageLimitedTurnRow = AgentTurnRow & { usage_limited: number; failure_kind: string | null };
const TURN_USAGE_LIMITED_SQL = "EXISTS (SELECT 1 FROM usage_limited_turns WHERE usage_limited_turns.turn_id = agent_turns.id)";
const TURN_FAILURE_KIND_SQL = "(SELECT failure_kind FROM turn_failure_kinds WHERE turn_failure_kinds.turn_id = agent_turns.id)";
type ConversationRecords = Pick<ConversationDetail, "usage" | "goals" | "reviewSummaries" | "reviewStates" | "reviewNotes">;
type HistoryPageRecords = Omit<ConversationDetail, "conversation" | "history" | "attachmentGallery" | keyof ConversationRecords>;
const EMPTY_CONVERSATION_RECORDS: ConversationRecords = { usage: [], goals: [], reviewSummaries: [], reviewStates: [], reviewNotes: [] };
const EMPTY_HISTORY_RECORDS: HistoryPageRecords = { agentTurns: [], turnGitArtifacts: [], messages: [], activities: [],
  subagents: [], reasonings: [], plans: [], checkpoints: [], contextPackets: [], contextReads: [], rolledBackTurnIds: [] };

function rollbackRevision(database: PersistenceContext["database"], conversationId: string): number {
  return (database.prepare(`SELECT count(*) AS count FROM orchestration_v2_entities
    WHERE kind = 'rolled-back-turn' AND thread_id = ?`).get(conversationId) as { count: number }).count;
}

function rolledBackTurnIds(database: PersistenceContext["database"], conversationId: string, turnIds: readonly string[]): string[] {
  return (database.prepare(`SELECT id FROM orchestration_v2_entities WHERE kind = 'rolled-back-turn' AND thread_id = ?
    AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(conversationId, JSON.stringify(turnIds)) as { id: string }[])
    .map(({ id }) => id);
}

function delegationField(database: PersistenceContext["database"], conversationId: string): Pick<ConversationDetail, "delegation"> {
  const delegation = new DelegationReads(database, defaultLiveNativeChildren(database)).detail(conversationId);
  return delegation ? { delegation } : {};
}

function watcherWakeField(
  database: PersistenceContext["database"],
  conversationId: string,
  turnIds: readonly string[] | undefined,
): Pick<ConversationDetail, "watcherWakes"> {
  const watcherWakes = watcherWakeSummaries(database, conversationId, turnIds);
  return watcherWakes ? { watcherWakes } : {};
}

export interface RecentConversationLimits {
  messages: number;
  activities: number;
  subagents: number;
  contentCharacters: number;
}

type SnapshotPersistenceContext = Pick<PersistenceContext, "database"> & {
  contextPackets(conversationId: string, messageIds?: string[]): ConversationContextPacketSummary[];
};

const unicodeLowerRegistered = new WeakSet<PersistenceContext["database"]>();

function foldUnicodeSearchText(value: string): string {
  return value.toLocaleLowerCase("en").replaceAll("\u03c2", "\u03c3");
}

function ensureUnicodeLowerFunction(database: PersistenceContext["database"]): void {
  if (unicodeLowerRegistered.has(database)) return;
  database.function("inertia_unicode_lower", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? foldUnicodeSearchText(value) : null);
  unicodeLowerRegistered.add(database);
}

export class SnapshotRepository {
  readonly promptPresets: PromptPresetRepository;
  readonly todos: TodoRepository;
  readonly customAgents: CustomAgentRepository;
  readonly library: LibraryRepository;

  constructor(private readonly context: SnapshotPersistenceContext) {
    this.promptPresets = new PromptPresetRepository(context.database);
    this.todos = new TodoRepository(context.database);
    this.customAgents = new CustomAgentRepository(context.database);
    this.library = new LibraryRepository(context.database);
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
      customAgents: this.customAgents.list(),
      todos: this.todos.list(),
      library: this.library.snapshot(),
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    const state = this.state();
    return {
      projects: this.projects(),
      conversations: this.conversationShells("conversations.archived_at IS NULL OR conversations.id = ?", [state.active_conversation_id ?? ""]),
      archivedConversationRefs: this.referencedArchivedConversations(state.active_conversation_id),
      archivedConversationCount: this.archivedConversationCount(),
      runs: (cachedStatement(
        this.context.database,
        "SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200",
      ).all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      promptPresets: this.promptPresets.list(),
      customAgents: this.customAgents.list(),
      todos: this.todos.list(),
      library: this.library.snapshot(),
      watchers: watcherLinkViews(this.context.database),
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  projects(): Project[] {
    return (cachedStatement(this.context.database,
      "SELECT * FROM projects ORDER BY updated_at DESC, id ASC",
    ).all() as ProjectRow[]).map(projectFromRow);
  }

  conversationIds(): string[] {
    return (cachedStatement(this.context.database,
      "SELECT id FROM conversations ORDER BY updated_at DESC, id ASC",
    ).all() as { id: string }[]).map(({ id }) => id);
  }

  projectConversations(projectId: string): ConversationShell[] {
    return this.conversationShells("conversations.project_id = ?", [projectId]);
  }

  archivedConversations(request: ArchivedConversationsRequest): ArchivedConversationsPage {
    const filters: string[] = ["conversations.archived_at IS NOT NULL"];
    const parameters: string[] = [];
    const query = request.query?.trim() ?? "";
    if (query) {
      ensureUnicodeLowerFunction(this.context.database);
      const providers = request.providerIds ?? [];
      filters.push(`(instr(inertia_unicode_lower(conversations.title), ?) > 0${providers.length
        ? ` OR conversations.provider_id IN (${providers.map(() => "?").join(", ")})` : ""})`);
      parameters.push(foldUnicodeSearchText(query), ...providers);
    }
    const where = filters.join(" AND ");
    const total = (this.context.database.prepare(
      `SELECT COUNT(*) AS count FROM conversations WHERE ${where}`,
    ).get(...parameters) as { count: number }).count;
    const after = request.after
      ? { sql: " AND (conversations.archived_at < ? OR (conversations.archived_at = ? AND conversations.id > ?))",
        parameters: [request.after.archivedAt, request.after.archivedAt, request.after.id] }
      : { sql: "", parameters: [] };
    const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? ARCHIVED_CONVERSATIONS_PAGE_SIZE)), ARCHIVED_CONVERSATIONS_PAGE_SIZE);
    const rows = (this.context.database.prepare(`
      SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
      FROM conversations WHERE ${where}${after.sql}
      ORDER BY conversations.archived_at DESC, conversations.id ASC
      LIMIT ?
    `).all(...parameters, ...after.parameters, limit + 1) as ConversationShellRow[]);
    const conversations = rows.slice(0, limit).map(conversationDetailFromRow);
    const last = conversations.at(-1);
    return {
      kind: "conversation.archived",
      conversations,
      total,
      next: rows.length > limit && last ? { archivedAt: last.archivedAt!, id: last.id } : null,
    };
  }

  activityDetail(conversationId: string, activityId: string): ActivityDetailReadResult | null {
    const row = cachedStatement(this.context.database,
      "SELECT id, conversation_id, turn_id, detail FROM activities WHERE id = ? AND conversation_id = ?",
    ).get(activityId, conversationId) as Pick<ActivityRow, "id" | "conversation_id" | "turn_id" | "detail"> | undefined;
    if (!row) return null;
    return { kind: "activity.detail", conversationId: row.conversation_id, activityId: row.id, turnId: row.turn_id,
      detail: row.detail === null ? null : row.detail.slice(0, MAX_ACTIVITY_DETAIL_READ_CHARS) };
  }

  private archivedConversationCount(): number {
    return (cachedStatement(this.context.database,
      "SELECT COUNT(*) AS count FROM conversations WHERE archived_at IS NOT NULL",
    ).get() as { count: number }).count;
  }

  private referencedArchivedConversations(activeConversationId: string | null): ArchivedConversationRef[] {
    return (cachedStatement(this.context.database, `
      SELECT id, project_id, title, provider_id, archived_at FROM conversations
      WHERE archived_at IS NOT NULL AND id <> ? AND (
        EXISTS (SELECT 1 FROM saved_answers WHERE saved_answers.conversation_id = conversations.id)
        OR EXISTS (SELECT 1 FROM todos WHERE todos.conversation_id = conversations.id OR todos.source_conversation_id = conversations.id)
        OR EXISTS (SELECT 1 FROM watcher_links WHERE watcher_links.watcher_conversation_id = conversations.id)
        OR EXISTS (SELECT 1 FROM watcher_links WHERE watcher_links.watched_conversation_id = conversations.id
          AND watcher_links.status <> 'detached')
        OR EXISTS (SELECT 1 FROM html_renders WHERE html_renders.conversation_id = conversations.id)
        OR id IN (SELECT conversation_id FROM workspace_runs WHERE conversation_id IS NOT NULL ORDER BY started_at DESC LIMIT 200)
      )
      ORDER BY archived_at DESC, id ASC
    `).all(activeConversationId ?? "") as Pick<ConversationRow, "id" | "project_id" | "title" | "provider_id" | "archived_at">[])
      .map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, providerId: row.provider_id, archivedAt: row.archived_at! }));
  }

  private conversationShells(where: string, parameters: readonly string[]): ConversationShell[] {
    const latestTurns = new Map(
      (cachedStatement(this.context.database, `
        SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited, ${TURN_FAILURE_KIND_SQL} AS failure_kind
        FROM conversations
        JOIN agent_turns ON agent_turns.id = (
          SELECT id
          FROM agent_turns AS latest
          WHERE latest.conversation_id = conversations.id
          ORDER BY latest.requested_at DESC, latest.id DESC
          LIMIT 1
        )
        WHERE ${where}
      `).all(...parameters) as UsageLimitedTurnRow[])
        .map((row) => [row.conversation_id, latestTurnSummaryFromRow(row)] as const),
    );
    return (cachedStatement(this.context.database, `
      SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
      FROM conversations WHERE ${where} ORDER BY updated_at DESC, id ASC
    `).all(...parameters) as ConversationShellRow[]).map((row) =>
      conversationShellFromRow(row, latestTurns.get(row.id) ?? null));
  }

  private conversationRow(conversationId: string): ConversationShellRow | undefined {
    return cachedStatement(this.context.database, `
      SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
      FROM conversations WHERE id = ?
    `).get(conversationId) as ConversationShellRow | undefined;
  }

  conversationShell(conversationId: string): ConversationShell | null {
    const row = this.conversationRow(conversationId);
    if (!row) return null;
    const latestTurn = cachedStatement(this.context.database, `
      SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited, ${TURN_FAILURE_KIND_SQL} AS failure_kind FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as UsageLimitedTurnRow | undefined;
    return conversationShellFromRow(
      row,
      latestTurn ? latestTurnSummaryFromRow(latestTurn) : null,
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
      rollbackRevision: rollbackRevision(this.context.database, conversationId),
      ...(latest ? this.conversationRecords(conversationId) : EMPTY_CONVERSATION_RECORDS),
      ...(latest ? delegationField(this.context.database, conversationId) : {}),
    };
    const fastByteBudget = Math.floor(MAX_CONVERSATION_HISTORY_BYTES * 0.9);
    const page = (records: HistoryPageRecords, omittedTurnIds: string[] = []): ConversationDetail | null => {
      const detail: ConversationDetail = { ...shared, ...records,
        ...(latest ? { plans: withLatestPlanDocument(this.context.database, conversationId, records.plans) } : {}),
        history: { older: scope.older, ...(omittedTurnIds.length ? { omittedTurnIds } : {}) } };
      if (estimateJsonUtf8BytesBound(detail, fastByteBudget) <= fastByteBudget) return detail;
      return Buffer.byteLength(JSON.stringify(detail), "utf8") <= MAX_CONVERSATION_HISTORY_BYTES ? detail : null;
    };
    while (true) {
      const bytes = historyStoredBytes(this.context.database, conversationId, scope);
      if (bytes > MAX_CONVERSATION_HISTORY_BYTES / 4 && scope.units.length > 1) {
        scope.units = scope.units.slice(0, Math.max(1, Math.floor(scope.units.length / 2)));
        scope.older = scope.units.at(-1)!;
        continue;
      }
      const detail = bytes <= MAX_CONVERSATION_HISTORY_BYTES ? page(this.historyRecords(conversationId, scope, true)) : null;
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
      rollbackRevision: rollbackRevision(this.context.database, conversationId),
      ...this.historyRecords(conversationId),
      ...this.conversationRecords(conversationId),
      ...delegationField(this.context.database, conversationId),
    };
  }

  recentConversationDetail(conversationId: string, limits: RecentConversationLimits): ConversationDetail | null {
    const conversationRow = this.conversationRow(conversationId);
    if (!conversationRow) return null;
    const newest = <T>(sql: string, ...parameters: (string | number)[]) =>
      (cachedStatement(this.context.database, sql).all(...parameters) as T[]).reverse();
    return {
      ...EMPTY_HISTORY_RECORDS,
      ...EMPTY_CONVERSATION_RECORDS,
      conversation: conversationDetailFromRow(conversationRow),
      messages: newest<MessageRow>(`SELECT id, conversation_id, turn_id, role, substr(content, 1, ?) AS content,
          attachments_json, compaction_json, html_render_json, secret_request_json, sent_to_user, private_connect_device_id, watcher_note_json,
          delegated_completion_json, created_at
        FROM (SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages
          WHERE messages.conversation_id = ? AND (${CONVERSATION_CONTEXT_MESSAGE_SQL}
            OR (messages.role = 'system' AND messages.secret_request_json IS NOT NULL AND messages.turn_id IS NOT NULL))
          ORDER BY messages.created_at DESC, messages.id DESC LIMIT ?)`,
      limits.contentCharacters, conversationId, limits.messages).map(messageFromRow),
      activities: newest<ActivityRow>(`SELECT id, conversation_id, run_id, turn_id, kind, title, NULL AS detail,
          status, created_at FROM activities WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`, conversationId, limits.activities).map(activityFromRow),
      subagents: newest<SubagentTraceRow>(`SELECT id, conversation_id, run_id, turn_id, provider_id, provider_task_id,
          provider_agent_id, parent_trace_id, parent_provider_agent_id, parent_provider_tool_use_id,
          provider_tool_use_id, provider_role, provider_name, custom_agent_id, provider_status, status, is_live,
          NULL AS description, NULL AS progress, NULL AS result, NULL AS model, NULL AS activity,
          NULL AS usage_json, NULL AS tool_use_count, NULL AS duration_ms, sequence, created_at, updated_at
        FROM subagent_traces WHERE conversation_id = ?
        ORDER BY created_at DESC, sequence DESC, id DESC LIMIT ?`, conversationId, limits.subagents).map(subagentTraceFromRow),
      plans: newest<AgentPlanRow>(`SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans WHERE conversation_id = ? ORDER BY updated_at DESC, run_id DESC LIMIT 1`, conversationId).map(planFromRow),
    };
  }

  private historyRecords(conversationId: string, scope?: ConversationHistoryScope, previewActivities = false): HistoryPageRecords {
    const query = <T>(table: Parameters<typeof historyPredicate>[0], columns: string, order: string): T[] => {
      const where = scope
        ? historyPredicate(table, scope, conversationId)
        : { sql: `${table}.conversation_id = ?`, parameters: [conversationId] };
      return cachedStatement(this.context.database, `SELECT ${columns} FROM ${table}
        WHERE ${where.sql} ORDER BY ${order}`)
        .all(...where.parameters) as T[];
    };
    const messages = query<MessageRow>("messages", MESSAGE_PROJECTION_COLUMNS, "messages.created_at ASC, messages.id ASC").map(messageFromRow);
    const turns = query<UsageLimitedTurnRow>("agent_turns", `agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited`, "requested_at ASC, id ASC").map(agentTurnFromRow);
    const activities = previewActivities
      ? (() => {
          const where = scope
            ? historyPredicate("activities", scope, conversationId)
            : { sql: "activities.conversation_id = ?", parameters: [conversationId] };
          return (cachedStatement(
            this.context.database,
            buildActivityPreviewQuery(where.sql, "created_at ASC, id ASC"),
          ).all(...where.parameters) as ProjectedActivityRow[]).map((row) => ({
            ...activityFromRow(row),
            ...activityPreviewFromProjectedRow(row),
          }));
        })()
      : query<ActivityRow>("activities", "*", "created_at ASC, id ASC").map(activityFromRow);
    return {
      agentTurns: turns,
      turnGitArtifacts: query<TurnGitArtifactRow>("turn_git_artifacts", "*", "created_at ASC, id ASC").map(turnGitArtifactFromRow),
      messages,
      activities,
      subagents: query<SubagentTraceRow>("subagent_traces", "*", "created_at ASC, sequence ASC, id ASC").map(subagentTraceFromRow),
      reasonings: query<AgentReasoningRow>("agent_reasonings", REASONING_PROJECTION_COLUMNS, "agent_reasonings.created_at ASC, agent_reasonings.id ASC").map(reasoningFromRow),
      plans: query<AgentPlanRow>("agent_plans", "conversation_id, run_id, turn_id, explanation, steps_json", "updated_at ASC, conversation_id ASC, run_id ASC").map(planFromRow),
      checkpoints: query<CheckpointRow>("checkpoints", "*", "created_at ASC, id ASC").map(checkpointFromRow),
      contextPackets: this.context.contextPackets(conversationId, scope ? messages.map(({ id }) => id) : undefined),
      contextReads: agentContextReadSummaries(this.context.database, conversationId, scope ? messages.map(({ id }) => id) : undefined),
      rolledBackTurnIds: rolledBackTurnIds(this.context.database, conversationId, turns.map(({ id }) => id)),
      ...watcherWakeField(this.context.database, conversationId, scope ? turns.map(({ id }) => id) : undefined),
    };
  }

  private omittedTurnRecords(conversationId: string, turnId: string): HistoryPageRecords {
    const turn = cachedStatement(this.context.database, `SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited
      FROM agent_turns WHERE conversation_id = ? AND id = ?`).get(conversationId, turnId) as UsageLimitedTurnRow;
    const messages = (cachedStatement(this.context.database, `SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages
      WHERE messages.conversation_id = ? AND messages.id = ?`)
      .all(conversationId, turn.user_message_id) as MessageRow[]).map(messageFromRow);
    return { ...EMPTY_HISTORY_RECORDS, agentTurns: [agentTurnFromRow(turn)], messages,
      contextPackets: this.context.contextPackets(conversationId, messages.map(({ id }) => id)),
      contextReads: agentContextReadSummaries(this.context.database, conversationId, messages.map(({ id }) => id)),
      rolledBackTurnIds: rolledBackTurnIds(this.context.database, conversationId, [turnId]),
      ...watcherWakeField(this.context.database, conversationId, [turnId]) };
  }

  private conversationRecords(conversationId: string): ConversationRecords {
    const all = <T>(sql: string) => cachedStatement(this.context.database, sql).all(conversationId) as T[];
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
    const state = cachedStatement(this.context.database, "SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }
}
