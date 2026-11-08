import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { MAX_AGENT_PLAN_STEPS } from "../../shared/agent-plan";
import type {
  AgentActivity,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  CheckpointSummary,
  SubagentTaskKind,
  SubagentTaskUsage,
  SubagentTrace,
  SubagentTraceStatus,
  ThreadUsageSnapshot,
} from "../../shared/contracts";
import { SERVER_EVENT_OPTIONS } from "../../shared/contracts/server-event-discriminants";
import {
  mergeSubagentTaskUsage,
  validateProviderUsage,
  validateSubagentTaskUsage,
} from "../provider/usage-values";
import {
  boundedSubagentCount,
  boundedSubagentIdentifier,
  boundedSubagentLabel,
  boundedSubagentSteps,
  isTerminalSubagentStatus,
  MAX_SUBAGENT_ACTIVITY_ID_CHARS,
  MAX_SUBAGENT_COMMAND_CHARS,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_DURATION_MS,
  MAX_SUBAGENT_NON_AGENT_TRACES_PER_TURN,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TOOL_USE_COUNT,
  MAX_SUBAGENT_TRACES_PER_TURN,
} from "../provider/subagent-trace";
import { scrubCommandSecrets } from "../provider/command-secrets";
import {
  activityFromRow,
  agentTurnFromRow,
  checkpointFromRow,
  reasoningFromRow,
  requireTimestamp,
  subagentTraceFromRow,
  usageFromRow,
} from "./codecs";
import { RecordNotFoundError } from "./errors";
import { cachedStatement } from "./statement-cache";
import type {
  ActivityRow,
  AgentReasoningRow,
  AgentTurnRow,
  CheckpointRow,
  ConversationRow,
  SubagentTraceRow,
  ThreadUsageRow,
} from "./rows";
import type {
  UpsertSubagentTraceInput,
  UpsertSubagentTraceResult,
} from "./types";
import { sanitizeProviderActivityDetail } from "../provider/activity-detail";
import {
  appendReasoningContentChunks,
  REASONING_PROJECTION_COLUMNS,
  replaceReasoningContent,
} from "./stream-text-storage";

interface ExecutionLedgerPersistenceContext {
  assertAgentTurnIdentity(
    conversationId: string,
    runId: string,
    turnId: string,
  ): AgentTurn;
  database: Database.Database;
  conversationPath(conversationId: string): string;
  requireAgentTurn(turnId: string): AgentTurnRow;
  requireConversation(conversationId: string): ConversationRow;
}

function safeSubagentLabel(
  value: unknown,
  workspaceRoot: string,
): string | null {
  return sanitizeProviderActivityDetail(value, {
    workspaceRoot,
    maxChars: 200,
  })?.replace(/\s+/gu, " ").trim() || null;
}

function safeSubagentTelemetryLabel(
  value: unknown,
  workspaceRoot: string,
): string | null {
  return boundedSubagentLabel(sanitizeProviderActivityDetail(value, {
    workspaceRoot,
  })?.replace(/\s+/gu, " "));
}

/**
 * A step label or current activity can carry a command line or URL, so it is
 * scrubbed as a command before the label bound cuts it.
 */
function safeSubagentStepLabel(
  value: unknown,
  workspaceRoot: string,
): string | null {
  return typeof value === "string"
    ? safeSubagentTelemetryLabel(scrubCommandSecrets(value), workspaceRoot)
    : null;
}

function safeSubagentProviderStatus(
  value: unknown,
  workspaceRoot: string,
): string | null {
  const bounded = boundedSubagentIdentifier(value, 200);
  if (!bounded) return null;
  return sanitizeProviderActivityDetail(bounded, {
    workspaceRoot,
    maxChars: 200,
  })?.replace(/\s+/gu, " ").trim() || "[redacted]";
}

function subagentTaskUsageJson(usage: SubagentTaskUsage | null): string | null {
  return usage ? JSON.stringify(usage) : null;
}

const NON_AGENT_TASK_KINDS: readonly SubagentTaskKind[] = ["shell", "monitor", "mcp"];
export const SUBAGENT_STOP_REQUESTED_PROGRESS = "Stop requested.";
/** What a background command still live at turn end is doing when cleanup was not confirmed. */
export const UNCONFIRMED_BACKGROUND_PROGRESS = "May still be running: the provider did not confirm it stopped.";
/** What a remote agent still live at turn end is doing, as far as Inertia knows. */
export const REMOTE_SETTLED_PROGRESS = "Running in the cloud.";

function subagentTaskKind(value: unknown): SubagentTaskKind | null {
  return SERVER_EVENT_OPTIONS.subagentTaskKinds.includes(value as SubagentTaskKind)
    ? value as SubagentTaskKind
    : null;
}

function safeSubagentCommand(
  value: unknown,
  workspaceRoot: string,
): string | null {
  if (typeof value !== "string") return null;
  return sanitizeProviderActivityDetail(scrubCommandSecrets(value), {
    workspaceRoot,
    maxChars: MAX_SUBAGENT_COMMAND_CHARS,
  });
}

function safeSubagentActivityId(value: unknown): string | null {
  const identifier = boundedSubagentIdentifier(value, MAX_SUBAGENT_ACTIVITY_ID_CHARS + 1);
  return identifier && identifier.length <= MAX_SUBAGENT_ACTIVITY_ID_CHARS
    ? identifier
    : null;
}

export class ExecutionLedgerRepository {
  constructor(private readonly context: ExecutionLedgerPersistenceContext) {}

  upsertAgentPlan(plan: AgentPlan): void {
    this.context.requireConversation(plan.conversationId);
    if (plan.turnId) this.context.assertAgentTurnIdentity(plan.conversationId, plan.runId, plan.turnId);
    this.context.database.prepare(`
      INSERT INTO agent_plans (conversation_id, run_id, turn_id, explanation, steps_json, updated_at)
      VALUES (@conversationId, @runId, @turnId, @explanation, @stepsJson, @updatedAt)
      ON CONFLICT(conversation_id, run_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        explanation = excluded.explanation,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `).run({
      conversationId: plan.conversationId,
      runId: plan.runId,
      turnId: plan.turnId,
      explanation: plan.explanation,
      stepsJson: JSON.stringify(plan.steps.slice(0, MAX_AGENT_PLAN_STEPS)),
      updatedAt: new Date().toISOString(),
    });
  }

  clearAgentPlan(conversationId: string, runId: string, turnId: string | null): void {
    this.context.requireConversation(conversationId);
    if (turnId) this.context.assertAgentTurnIdentity(conversationId, runId, turnId);
    this.context.database.prepare(`
      DELETE FROM agent_plans
      WHERE conversation_id = ? AND run_id = ? AND turn_id IS ?
    `).run(conversationId, runId, turnId);
  }

  addActivity(
    activity: Omit<AgentActivity, "id" | "createdAt" | "turnId"> & {
      turnId?: string | null;
      createdAt?: string;
    },
  ): AgentActivity {
    this.context.requireConversation(activity.conversationId);
    const turnId = activity.turnId ?? null;
    if (turnId) this.context.assertAgentTurnIdentity(activity.conversationId, activity.runId, turnId);
    const record: AgentActivity = {
      ...activity,
      turnId,
      id: randomUUID(),
      createdAt: activity.createdAt ?? new Date().toISOString(),
    };
    cachedStatement(this.context.database, `INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @kind, @title, @detail, @status, @createdAt)`).run(record);
    return record;
  }

  updateActivity(id: string, update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>): AgentActivity {
    const row = cachedStatement(this.context.database, "SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) throw new RecordNotFoundError("Activity not found.");
    const next = { ...activityFromRow(row), ...update };
    cachedStatement(this.context.database, "UPDATE activities SET title = ?, detail = ?, status = ? WHERE id = ?").run(next.title, next.detail, next.status, id);
    return next;
  }

  subagentTrace(traceId: string): SubagentTrace {
    const row = this.context.database.prepare(
      "SELECT * FROM subagent_traces WHERE id = ?",
    ).get(traceId) as SubagentTraceRow | undefined;
    if (!row) throw new RecordNotFoundError("Delegated task not found.");
    return subagentTraceFromRow(row);
  }

  acknowledgeSubagentStop(
    traceId: string,
    updatedAt = new Date().toISOString(),
  ): UpsertSubagentTraceResult | null {
    const now = requireTimestamp(updatedAt, "Delegated task stop time");
    const result = this.context.database.prepare(`
      UPDATE subagent_traces
      SET status = 'cancelled',
          is_live = 0,
          progress = 'Stopped by the user.',
          activity = NULL,
          updated_at = MAX(updated_at, @updatedAt)
      WHERE id = @id AND is_live = 1
    `).run({ id: traceId, updatedAt: now });
    const trace = this.subagentTrace(traceId);
    if (result.changes > 0) return { trace, changed: true };
    return trace.status === "cancelled" && !trace.isLive
      ? { trace, changed: false }
      : null;
  }

  /**
   * Marks a live task whose Stop is held until the provider issues its task
   * id. The task stays live: only the provider's answer settles it.
   */
  requestSubagentStop(
    traceId: string,
    updatedAt = new Date().toISOString(),
  ): UpsertSubagentTraceResult | null {
    const now = requireTimestamp(updatedAt, "Delegated task stop request time");
    const result = this.context.database.prepare(`
      UPDATE subagent_traces
      SET progress = @progress,
          updated_at = MAX(updated_at, @updatedAt)
      WHERE id = @id AND is_live = 1 AND progress IS NOT @progress
    `).run({ id: traceId, progress: SUBAGENT_STOP_REQUESTED_PROGRESS, updatedAt: now });
    const trace = this.subagentTrace(traceId);
    if (result.changes > 0) return { trace, changed: true };
    return trace.isLive ? { trace, changed: false } : null;
  }

  upsertSubagentTrace(
    input: UpsertSubagentTraceInput,
  ): UpsertSubagentTraceResult | null {
    this.context.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
    const workspaceRoot = this.context.conversationPath(input.conversationId);
    const providerTaskId = boundedSubagentIdentifier(input.providerTaskId);
    const providerAgentId = boundedSubagentIdentifier(input.providerAgentId);
    if (!providerTaskId && !providerAgentId) return null;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return null;
    const identityParams = [
      input.conversationId,
      input.runId,
      input.providerId,
    ] as const;
    const byTask = providerTaskId
      ? this.context.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_task_id = ?
        `).get(...identityParams, providerTaskId) as SubagentTraceRow | undefined
      : undefined;
    const byAgent = providerAgentId
      ? this.context.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
        `).get(...identityParams, providerAgentId) as SubagentTraceRow | undefined
      : undefined;
    if (byTask && byAgent && byTask.id !== byAgent.id) return null;
    const providerToolUseId = boundedSubagentIdentifier(input.providerToolUseId);
    const byToolUse = !byTask && !byAgent && providerToolUseId
      ? this.context.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, providerToolUseId) as SubagentTraceRow | undefined
      : undefined;
    const existing = byTask ?? byAgent ?? byToolUse;
    if (existing && input.sequence <= existing.sequence) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }
    const revived = input.revived === true
      && input.isLive
      && !isTerminalSubagentStatus(input.status);
    if (
      existing
      && existing.is_live === 0
      && !revived
      && (
        input.isLive
        || (
          existing.status !== "unknown"
          && input.status !== existing.status
        )
      )
    ) {
      // A known terminal outcome is durable historical truth. Later matching
      // patches may enrich its detail, terminal unknown may be clarified, and
      // only a provider-authored new turn may revive it.
      return { trace: subagentTraceFromRow(existing), changed: false };
    }
    if (
      input.status === "unknown"
        ? typeof input.isLive !== "boolean"
        : input.isLive === isTerminalSubagentStatus(input.status)
    ) return null;

    const parentProviderAgentId = boundedSubagentIdentifier(
      input.parentProviderAgentId,
    );
    const parentProviderToolUseId = boundedSubagentIdentifier(
      input.parentProviderToolUseId,
    );
    const parentByAgent = parentProviderAgentId
      ? this.context.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderAgentId) as { id: string } | undefined
      : undefined;
    const parentByToolUse = !parentByAgent && parentProviderToolUseId
      ? this.context.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderToolUseId) as { id: string } | undefined
      : undefined;
    const parent = parentByAgent ?? parentByToolUse;
    const now = input.updatedAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.updatedAt, "Delegated task update time");
    const normalized = {
      providerTaskId,
      providerAgentId,
      parentTraceId: parent?.id ?? null,
      parentProviderAgentId,
      parentProviderToolUseId,
      providerToolUseId,
      providerRole: safeSubagentLabel(input.providerRole, workspaceRoot),
      providerName: safeSubagentLabel(input.providerName, workspaceRoot),
      providerStatus: safeSubagentProviderStatus(
        input.providerStatus,
        workspaceRoot,
      ),
      description: sanitizeProviderActivityDetail(
        input.description,
        { workspaceRoot, maxChars: MAX_SUBAGENT_DESCRIPTION_CHARS },
      ),
      progress: sanitizeProviderActivityDetail(
        input.progress,
        { workspaceRoot, maxChars: MAX_SUBAGENT_PROGRESS_CHARS },
      ),
      result: sanitizeProviderActivityDetail(input.result, {
        workspaceRoot,
        maxChars: MAX_SUBAGENT_RESULT_CHARS,
      }),
      model: input.model === "<synthetic>"
        ? null
        : safeSubagentTelemetryLabel(input.model, workspaceRoot),
      activity: input.isLive
        ? safeSubagentStepLabel(input.activity, workspaceRoot)
        : null,
      toolUseCount: boundedSubagentCount(
        input.toolUseCount,
        MAX_SUBAGENT_TOOL_USE_COUNT,
      ),
      durationMs: boundedSubagentCount(
        input.durationMs,
        MAX_SUBAGENT_DURATION_MS,
      ),
    };
    const usage = validateSubagentTaskUsage(input.usage);
    const customAgentId = typeof input.customAgentId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.customAgentId)
      ? input.customAgentId
      : null;
    const reportedTaskKind = subagentTaskKind(input.taskKind);
    const taskKind = reportedTaskKind ?? existing?.task_kind ?? "agent";
    const steps = boundedSubagentSteps(
      input.steps,
      (text) => safeSubagentStepLabel(text, workspaceRoot),
    );
    const shape = {
      modelSource: normalized.model
        && SERVER_EVENT_OPTIONS.subagentModelSources.includes(
          input.modelSource as NonNullable<SubagentTrace["modelSource"]>,
        )
        ? input.modelSource as NonNullable<SubagentTrace["modelSource"]>
        : null,
      taskKind: reportedTaskKind,
      background: typeof input.background === "boolean"
        ? input.background ? 1 : 0
        : null,
      command: NON_AGENT_TASK_KINDS.includes(taskKind)
        ? safeSubagentCommand(input.command, workspaceRoot)
        : null,
      effort: SERVER_EVENT_OPTIONS.subagentTaskEfforts.includes(
        input.effort as NonNullable<SubagentTrace["effort"]>,
      )
        ? input.effort as NonNullable<SubagentTrace["effort"]>
        : null,
      activityId: safeSubagentActivityId(input.activityId),
      stepsJson: steps ? JSON.stringify(steps) : null,
    };

    if (existing) {
      this.context.database.prepare(`
        UPDATE subagent_traces
        SET provider_task_id = COALESCE(@providerTaskId, provider_task_id),
            provider_agent_id = COALESCE(@providerAgentId, provider_agent_id),
            parent_trace_id = COALESCE(@parentTraceId, parent_trace_id),
            parent_provider_agent_id = COALESCE(
              @parentProviderAgentId,
              parent_provider_agent_id
            ),
            parent_provider_tool_use_id = COALESCE(
              @parentProviderToolUseId,
              parent_provider_tool_use_id
            ),
            provider_tool_use_id = COALESCE(
              @providerToolUseId,
              provider_tool_use_id
            ),
            provider_role = COALESCE(@providerRole, provider_role),
            provider_name = COALESCE(@providerName, provider_name),
            custom_agent_id = COALESCE(@customAgentId, custom_agent_id),
            provider_status = COALESCE(@providerStatus, provider_status),
            status = @status,
            is_live = @isLive,
            description = COALESCE(@description, description),
            progress = CASE WHEN @revived = 1 THEN @progress ELSE COALESCE(@progress, progress) END,
            result = CASE WHEN @revived = 1 THEN @result ELSE COALESCE(@result, result) END,
            model = CASE
              WHEN @model IS NULL THEN model
              WHEN @modelSource IS NOT 'observed' AND model_source = 'observed' THEN model
              ELSE @model
            END,
            model_source = CASE
              WHEN @model IS NULL THEN model_source
              WHEN @modelSource IS NOT 'observed' AND model_source = 'observed' THEN model_source
              ELSE @modelSource
            END,
            activity = CASE
              WHEN @isLive = 1 AND @status = status THEN COALESCE(@activity, activity)
              WHEN @isLive = 1 THEN @activity
              ELSE NULL
            END,
            usage_json = @usageJson,
            tool_use_count = COALESCE(@toolUseCount, tool_use_count),
            duration_ms = COALESCE(@durationMs, duration_ms),
            task_kind = COALESCE(@taskKind, task_kind),
            background = COALESCE(@background, background),
            command = CASE
              WHEN COALESCE(@taskKind, task_kind) IN ('shell', 'monitor', 'mcp')
                THEN COALESCE(@command, command)
              ELSE NULL
            END,
            effort = COALESCE(@effort, effort),
            activity_id = COALESCE(@activityId, activity_id),
            steps_json = COALESCE(@stepsJson, steps_json),
            sequence = @sequence,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        ...normalized,
        customAgentId,
        ...shape,
        usageJson: subagentTaskUsageJson(mergeSubagentTaskUsage(
          subagentTraceFromRow(existing).usage,
          usage,
        )),
        status: input.status,
        isLive: input.isLive ? 1 : 0,
        revived: revived ? 1 : 0,
        sequence: input.sequence,
        updatedAt: now < existing.updated_at ? existing.updated_at : now,
      });
      this.linkSubagentChildren(existing.id);
      return {
        trace: this.subagentTrace(existing.id),
        changed: true,
      };
    }

    const count = (this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM subagent_traces
      WHERE turn_id = ?
    `).get(input.turnId) as { count: number }).count;
    if (count >= MAX_SUBAGENT_TRACES_PER_TURN) return null;
    if (NON_AGENT_TASK_KINDS.includes(taskKind)) {
      const nonAgentCount = (this.context.database.prepare(`
        SELECT COUNT(*) AS count
        FROM subagent_traces
        WHERE turn_id = ? AND task_kind IN ('shell', 'monitor', 'mcp')
      `).get(input.turnId) as { count: number }).count;
      if (nonAgentCount >= MAX_SUBAGENT_NON_AGENT_TRACES_PER_TURN) return null;
    }
    const trace: SubagentTrace = {
      id: randomUUID(),
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
      providerId: input.providerId,
      ...normalized,
      ...(customAgentId ? { customAgentId } : {}),
      usage,
      modelSource: shape.modelSource,
      taskKind,
      background: shape.background === null ? null : shape.background === 1,
      command: shape.command,
      effort: shape.effort,
      activityId: shape.activityId,
      steps,
      status: input.status,
      isLive: input.isLive,
      sequence: input.sequence,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role,
        provider_name, provider_status, status, is_live,
        description, progress, result, model, activity,
        usage_json, tool_use_count, duration_ms,
        task_kind, background, command, effort, activity_id, model_source,
        steps_json, sequence, created_at, updated_at, custom_agent_id
      ) VALUES (
        @id, @conversationId, @runId, @turnId, @providerId,
        @providerTaskId, @providerAgentId, @parentTraceId,
        @parentProviderAgentId, @parentProviderToolUseId,
        @providerToolUseId, @providerRole,
        @providerName, @providerStatus, @status, @isLive,
        @description, @progress, @result, @model, @activity,
        @usageJson, @toolUseCount, @durationMs,
        @taskKind, @background, @command, @effort, @activityId, @modelSource,
        @stepsJson, @sequence, @createdAt, @updatedAt, @customAgentId
      )
    `).run({
      ...normalized,
      ...shape,
      taskKind,
      customAgentId,
      id: trace.id,
      conversationId: trace.conversationId,
      runId: trace.runId,
      turnId: trace.turnId,
      providerId: trace.providerId,
      status: trace.status,
      isLive: trace.isLive ? 1 : 0,
      usageJson: subagentTaskUsageJson(usage),
      sequence: trace.sequence,
      createdAt: trace.createdAt,
      updatedAt: trace.updatedAt,
    });
    this.linkSubagentChildren(trace.id);
    return { trace, changed: true };
  }

  settleLiveSubagents(
    turnId: string,
    status: Extract<SubagentTraceStatus, "cancelled" | "lost">,
    updatedAt = new Date().toISOString(),
    providerCleanupUnconfirmed = false,
  ): SubagentTrace[] {
    const now = requireTimestamp(updatedAt, "Delegated task settlement time");
    const rows = this.context.database.prepare(`
      SELECT * FROM subagent_traces
      WHERE turn_id = ?
        AND is_live = 1
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all(turnId) as SubagentTraceRow[];
    if (rows.length === 0) return [];
    // The provider process ends with the turn, and background commands,
    // monitors and MCP tasks end with it: they were stopped, not lost. When
    // the provider's process tree was not confirmed gone, they may still be
    // running, so their outcome is unknown. A remote agent keeps running in
    // its cloud session, so its outcome is unknown here rather than lost.
    const update = this.context.database.prepare(`
      UPDATE subagent_traces
      SET status = CASE
            WHEN task_kind = 'remote' THEN 'unknown'
            WHEN task_kind IN ('shell', 'monitor', 'mcp') AND @unconfirmed = 1 THEN 'unknown'
            WHEN task_kind IN ('shell', 'monitor', 'mcp') THEN 'cancelled'
            ELSE @status
          END,
          progress = CASE
            WHEN task_kind = 'remote' THEN @remoteProgress
            WHEN task_kind IN ('shell', 'monitor', 'mcp') AND @unconfirmed = 1 THEN @unconfirmedProgress
            WHEN task_kind IN ('shell', 'monitor', 'mcp') AND @status = 'lost'
              THEN 'Stopped when the turn ended.'
            ELSE progress
          END,
          is_live = 0, activity = NULL,
          sequence = sequence + 1, updated_at = @updatedAt
      WHERE id = @id
        AND is_live = 1
    `);
    this.context.database.transaction(() => {
      for (const row of rows) {
        update.run({
          status,
          remoteProgress: REMOTE_SETTLED_PROGRESS,
          unconfirmed: providerCleanupUnconfirmed ? 1 : 0,
          unconfirmedProgress: UNCONFIRMED_BACKGROUND_PROGRESS,
          updatedAt: now,
          id: row.id,
        });
      }
    })();
    return rows.map(({ id }) => this.subagentTrace(id));
  }

  createReasoning(conversationId: string, runId: string, turnId: string | null = null): AgentReasoning {
    this.context.requireConversation(conversationId);
    if (turnId) this.context.assertAgentTurnIdentity(conversationId, runId, turnId);
    const reasoning: AgentReasoning = {
      id: randomUUID(),
      conversationId,
      runId,
      turnId,
      content: "",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.context.database.prepare(`INSERT INTO agent_reasonings (id, conversation_id, run_id, turn_id, content, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @content, @status, @createdAt)`).run(reasoning);
    return reasoning;
  }

  updateReasoning(id: string, update: Partial<Pick<AgentReasoning, "content" | "status">>): AgentReasoning {
    const row = this.context.database.prepare(`
      SELECT ${REASONING_PROJECTION_COLUMNS}
      FROM agent_reasonings
      WHERE agent_reasonings.id = ?
    `).get(id) as AgentReasoningRow | undefined;
    if (!row) throw new RecordNotFoundError("Reasoning summary not found.");
    const next = { ...reasoningFromRow(row), ...update };
    replaceReasoningContent(
      this.context.database,
      id,
      next.content,
      next.status,
    );
    return next;
  }

  appendReasoningContent(id: string, delta: string): void {
    if (!delta) return;
    if (!appendReasoningContentChunks(this.context.database, id, delta)) {
      throw new RecordNotFoundError("Reasoning summary not found.");
    }
  }

  upsertUsage(
    usage: Omit<ThreadUsageSnapshot, "updatedAt" | "turnId"> & { turnId?: string | null },
  ): ThreadUsageSnapshot {
    this.context.requireConversation(usage.conversationId);
    const turnId = usage.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
      if (turn.conversationId !== usage.conversationId) {
        throw new Error("The usage snapshot turn belongs to a different conversation.");
      }
    }
    const validated = validateProviderUsage(usage);
    const promptCache = validated.promptCache ?? this.usageForConversation(usage.conversationId)?.promptCache;
    const next: ThreadUsageSnapshot = {
      conversationId: usage.conversationId,
      turnId,
      ...validated,
      ...(promptCache ? { promptCache } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.context.database.prepare(`
      INSERT INTO thread_usage (conversation_id, turn_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, last_request_started_at, prompt_cache_lifetime_ms, prompt_cache_source, updated_at)
      VALUES (@conversationId, @turnId, @usedTokens, @totalProcessedTokens, @totalProcessedScope, @maxTokens, @inputTokens, @cachedInputTokens, @cacheWriteInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @lastRequestStartedAt, @promptCacheLifetimeMs, @promptCacheSource, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        used_tokens = excluded.used_tokens,
        total_processed_tokens = excluded.total_processed_tokens,
        total_processed_scope = excluded.total_processed_scope,
        max_tokens = excluded.max_tokens,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        compacts_automatically = excluded.compacts_automatically,
        last_request_started_at = excluded.last_request_started_at,
        prompt_cache_lifetime_ms = excluded.prompt_cache_lifetime_ms,
        prompt_cache_source = excluded.prompt_cache_source,
        updated_at = excluded.updated_at
    `).run({
      conversationId: next.conversationId,
      turnId: next.turnId,
      usedTokens: next.usedTokens,
      totalProcessedTokens: next.totalProcessedTokens,
      totalProcessedScope: next.totalProcessedScope,
      maxTokens: next.maxTokens,
      inputTokens: next.inputTokens,
      cachedInputTokens: next.cachedInputTokens,
      cacheWriteInputTokens: next.cacheWriteInputTokens,
      outputTokens: next.outputTokens,
      reasoningOutputTokens: next.reasoningOutputTokens,
      compactsAutomatically: next.compactsAutomatically === null ? null : Number(next.compactsAutomatically),
      lastRequestStartedAt: promptCache?.lastRequestStartedAt ?? null,
      promptCacheLifetimeMs: promptCache?.lifetimeMs ?? null,
      promptCacheSource: promptCache?.source ?? null,
      updatedAt: next.updatedAt,
    });
    return next;
  }

  usageForConversation(conversationId: string): ThreadUsageSnapshot | null {
    this.context.requireConversation(conversationId);
    const row = this.context.database.prepare(
      "SELECT * FROM thread_usage WHERE conversation_id = ?",
    ).get(conversationId) as ThreadUsageRow | undefined;
    return row ? usageFromRow(row) : null;
  }

  checkpointCount(conversationId: string): number {
    this.context.requireConversation(conversationId);
    const row = this.context.database.prepare(
      "SELECT COUNT(*) AS count FROM checkpoints WHERE conversation_id = ?",
    ).get(conversationId) as { count: number };
    return row.count;
  }

  addCheckpoint(
    input: Omit<CheckpointSummary, "id" | "createdAt" | "turnId"> & { turnId?: string | null },
  ): CheckpointSummary {
    this.context.requireConversation(input.conversationId);
    const turnId = input.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
      if (turn.conversationId !== input.conversationId) {
        throw new Error("The checkpoint turn belongs to a different conversation.");
      }
    }
    const checkpoint: CheckpointSummary = { ...input, turnId, id: randomUUID(), createdAt: new Date().toISOString() };
    this.context.database.prepare(`INSERT INTO checkpoints (id, conversation_id, turn_id, ref, label, turn_index, files_changed, insertions, deletions, created_at) VALUES (@id, @conversationId, @turnId, @ref, @label, @turnIndex, @filesChanged, @insertions, @deletions, @createdAt)`).run(checkpoint);
    return checkpoint;
  }

  removeUnassociatedCheckpoint(
    checkpointId: string,
    conversationId: string,
  ): boolean {
    this.context.requireConversation(conversationId);
    const result = this.context.database.prepare(`
      DELETE FROM checkpoints
      WHERE id = ? AND conversation_id = ? AND turn_id IS NULL
    `).run(checkpointId, conversationId);
    return result.changes === 1;
  }

  associateCheckpointWithTurn(checkpointId: string, conversationId: string, runId: string, turnId: string): CheckpointSummary {
    this.context.assertAgentTurnIdentity(conversationId, runId, turnId);
    const row = this.context.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row || row.conversation_id !== conversationId) throw new RecordNotFoundError("Checkpoint not found.");
    if (row.turn_id !== null && row.turn_id !== turnId) {
      throw new Error("The checkpoint is already owned by a different turn.");
    }
    if (row.turn_id === null) this.context.database.prepare("UPDATE checkpoints SET turn_id = ? WHERE id = ?").run(turnId, checkpointId);
    return { ...checkpointFromRow(row), turnId };
  }

  checkpoint(checkpointId: string): CheckpointSummary {
    const row = this.context.database.prepare(
      "SELECT * FROM checkpoints WHERE id = ?",
    ).get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new RecordNotFoundError("Checkpoint not found.");
    return checkpointFromRow(row);
  }

  private linkSubagentChildren(parentTraceId: string): void {
    const parent = this.context.database.prepare(`
      SELECT conversation_id, run_id, provider_id, provider_agent_id,
             provider_tool_use_id
      FROM subagent_traces
      WHERE id = ?
    `).get(parentTraceId) as Pick<
      SubagentTraceRow,
      | "conversation_id"
      | "run_id"
      | "provider_id"
      | "provider_agent_id"
      | "provider_tool_use_id"
    > | undefined;
    if (!parent) return;
    this.context.database.prepare(`
      UPDATE subagent_traces
      SET parent_trace_id = ?
      WHERE id <> ?
        AND conversation_id = ?
        AND run_id = ?
        AND provider_id = ?
        AND parent_trace_id IS NULL
        AND (
          (
            ? IS NOT NULL
            AND parent_provider_agent_id = ?
          )
          OR
          (
            ? IS NOT NULL
            AND parent_provider_tool_use_id = ?
          )
        )
    `).run(
      parentTraceId,
      parentTraceId,
      parent.conversation_id,
      parent.run_id,
      parent.provider_id,
      parent.provider_agent_id,
      parent.provider_agent_id,
      parent.provider_tool_use_id,
      parent.provider_tool_use_id,
    );
  }

}
