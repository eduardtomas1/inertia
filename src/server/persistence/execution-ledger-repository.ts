import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  AgentActivity,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  CheckpointSummary,
  SubagentTrace,
  SubagentTraceStatus,
  ThreadUsageSnapshot,
} from "../../shared/contracts";
import { validateProviderUsage } from "../provider/usage-values";
import {
  boundedSubagentIdentifier,
  isTerminalSubagentStatus,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TRACES_PER_TURN,
} from "../provider/subagent-trace";
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
      stepsJson: JSON.stringify(plan.steps.slice(0, 50)),
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
    this.context.database.prepare(`INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @kind, @title, @detail, @status, @createdAt)`).run(record);
    return record;
  }

  updateActivity(id: string, update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>): AgentActivity {
    const row = this.context.database.prepare("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) throw new RecordNotFoundError("Activity not found.");
    const next = { ...activityFromRow(row), ...update };
    this.context.database.prepare("UPDATE activities SET title = ?, detail = ?, status = ? WHERE id = ?").run(next.title, next.detail, next.status, id);
    return next;
  }

  subagentTrace(traceId: string): SubagentTrace {
    const row = this.context.database.prepare(
      "SELECT * FROM subagent_traces WHERE id = ?",
    ).get(traceId) as SubagentTraceRow | undefined;
    if (!row) throw new RecordNotFoundError("Delegated task not found.");
    return subagentTraceFromRow(row);
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
    if (
      existing
      && isTerminalSubagentStatus(existing.status)
      && !isTerminalSubagentStatus(input.status)
    ) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }

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
            status = @status,
            description = COALESCE(@description, description),
            progress = COALESCE(@progress, progress),
            result = COALESCE(@result, result),
            sequence = @sequence,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        ...normalized,
        status: input.status,
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
    const trace: SubagentTrace = {
      id: randomUUID(),
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
      providerId: input.providerId,
      ...normalized,
      status: input.status,
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
        provider_name, status, description, progress, result, sequence,
        created_at, updated_at
      ) VALUES (
        @id, @conversationId, @runId, @turnId, @providerId,
        @providerTaskId, @providerAgentId, @parentTraceId,
        @parentProviderAgentId, @parentProviderToolUseId,
        @providerToolUseId, @providerRole,
        @providerName, @status, @description, @progress, @result, @sequence,
        @createdAt, @updatedAt
      )
    `).run(trace);
    this.linkSubagentChildren(trace.id);
    return { trace, changed: true };
  }

  settleLiveSubagents(
    turnId: string,
    status: Extract<SubagentTraceStatus, "cancelled" | "lost">,
    updatedAt = new Date().toISOString(),
  ): SubagentTrace[] {
    const now = requireTimestamp(updatedAt, "Delegated task settlement time");
    const rows = this.context.database.prepare(`
      SELECT * FROM subagent_traces
      WHERE turn_id = ?
        AND status IN ('spawned', 'running', 'waiting')
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all(turnId) as SubagentTraceRow[];
    if (rows.length === 0) return [];
    const update = this.context.database.prepare(`
      UPDATE subagent_traces
      SET status = ?, sequence = sequence + 1, updated_at = ?
      WHERE id = ?
        AND status IN ('spawned', 'running', 'waiting')
    `);
    this.context.database.transaction(() => {
      for (const row of rows) update.run(status, now, row.id);
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
    const row = this.context.database.prepare("SELECT * FROM agent_reasonings WHERE id = ?").get(id) as AgentReasoningRow | undefined;
    if (!row) throw new RecordNotFoundError("Reasoning summary not found.");
    const next = { ...reasoningFromRow(row), ...update };
    this.context.database.prepare("UPDATE agent_reasonings SET content = ?, status = ? WHERE id = ?").run(next.content, next.status, id);
    return next;
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
    const next: ThreadUsageSnapshot = {
      conversationId: usage.conversationId,
      turnId,
      ...validateProviderUsage(usage),
      updatedAt: new Date().toISOString(),
    };
    this.context.database.prepare(`
      INSERT INTO thread_usage (conversation_id, turn_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, updated_at)
      VALUES (@conversationId, @turnId, @usedTokens, @totalProcessedTokens, @totalProcessedScope, @maxTokens, @inputTokens, @cachedInputTokens, @cacheWriteInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @updatedAt)
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
        updated_at = excluded.updated_at
    `).run({ ...next, compactsAutomatically: next.compactsAutomatically === null ? null : Number(next.compactsAutomatically) });
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
