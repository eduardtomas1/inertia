import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentHarnessEmitter,
} from "./agent-harness";
import {
  boundedSubagentIdentifier,
  boundedSubagentText,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
} from "./subagent-trace";

type SubagentUpdate = Parameters<AgentHarnessEmitter["subagent"]>[0];

interface ClaudeAgentTool {
  toolUseId: string;
  parentToolUseId: string | null;
  role: string | null;
  name: string | null;
  description: string | null;
}

interface ClaudeTaskState extends ClaudeAgentTool {
  taskId: string;
  agentId: string | null;
  live: boolean;
}

const SUBAGENT_TASK_TYPES = new Set([
  "agent",
  "local_agent",
  "subagent",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentBlocks(message: unknown): unknown[] {
  const content = objectValue(message)?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Exact, allowlisted projection of Claude's typed task/Agent events. The
 * background-task roster is deliberately ignored here: its documented level
 * semantics are useful for lifecycle gating, but it cannot be correlated with
 * the edge stream without inventing ownership.
 */
export class ClaudeSubagentTraceTracker {
  private sequence = 0;
  private readonly tools = new Map<string, ClaudeAgentTool>();
  private readonly tasks = new Map<string, ClaudeTaskState>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly ignoredTaskIds = new Set<string>();

  constructor(
    private readonly emit: AgentHarnessEmitter["subagent"],
  ) {}

  observe(message: SDKMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (message.type === "assistant") {
      this.observeAssistant(record);
      return;
    }
    if (message.type === "user") {
      this.observeUser(record);
      return;
    }
    if (message.type !== "system") return;
    const subtype = record.subtype;
    if (subtype === "task_started") this.observeTaskStarted(record);
    else if (subtype === "task_progress") this.observeTaskProgress(record);
    else if (subtype === "task_updated") this.observeTaskUpdated(record);
    else if (subtype === "task_notification") {
      this.observeTaskNotification(record);
    }
  }

  isLiveTask(taskId: string): boolean {
    return this.tasks.get(taskId)?.live === true;
  }

  private observeAssistant(record: Record<string, unknown>): void {
    const parentToolUseId = boundedSubagentIdentifier(
      record.parent_tool_use_id,
    );
    for (const block of contentBlocks(record.message)) {
      const item = objectValue(block);
      if (
        item?.type !== "tool_use"
        || (item.name !== "Agent" && item.name !== "Task")
      ) continue;
      const toolUseId = boundedSubagentIdentifier(item.id);
      if (!toolUseId) continue;
      const input = objectValue(item.input) ?? {};
      this.tools.set(toolUseId, {
        toolUseId,
        parentToolUseId,
        role: boundedSubagentIdentifier(
          input.subagent_type ?? input.agent_type,
          200,
        ),
        name: boundedSubagentIdentifier(input.name, 200),
        description: boundedSubagentText(
          input.description ?? input.prompt,
          MAX_SUBAGENT_DESCRIPTION_CHARS,
        ),
      });
    }
  }

  private observeTaskStarted(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    const toolUseId = boundedSubagentIdentifier(record.tool_use_id);
    if (!taskId) return;
    const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
    const subagentType = boundedSubagentIdentifier(record.subagent_type, 200);
    const taskType = boundedSubagentIdentifier(record.task_type, 200);
    const isSubagent = Boolean(
      metadata
      || subagentType
      || (taskType && SUBAGENT_TASK_TYPES.has(taskType)),
    );
    if (!isSubagent || record.skip_transcript === true) {
      this.ignoredTaskIds.add(taskId);
      return;
    }
    const state: ClaudeTaskState = {
      taskId,
      toolUseId: toolUseId ?? metadata?.toolUseId ?? "",
      parentToolUseId: metadata?.parentToolUseId ?? null,
      role: subagentType ?? metadata?.role ?? null,
      name: boundedSubagentIdentifier(record.workflow_name, 200)
        ?? metadata?.name
        ?? null,
      description: boundedSubagentText(
        record.description ?? record.prompt,
        MAX_SUBAGENT_DESCRIPTION_CHARS,
      ) ?? metadata?.description ?? null,
      agentId: null,
      live: true,
    };
    this.tasks.set(taskId, state);
    if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
    this.emitState(state, "spawned");
  }

  private observeTaskProgress(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    let state = this.tasks.get(taskId);
    const toolUseId = boundedSubagentIdentifier(record.tool_use_id);
    const subagentType = boundedSubagentIdentifier(record.subagent_type, 200);
    if (!state && (subagentType || (toolUseId && this.tools.has(toolUseId)))) {
      const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
      state = {
        taskId,
        toolUseId: toolUseId ?? "",
        parentToolUseId: metadata?.parentToolUseId ?? null,
        role: subagentType ?? metadata?.role ?? null,
        name: metadata?.name ?? null,
        description: boundedSubagentText(
          record.description,
          MAX_SUBAGENT_DESCRIPTION_CHARS,
        ) ?? metadata?.description ?? null,
        agentId: null,
        live: true,
      };
      this.tasks.set(taskId, state);
      if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
    }
    if (!state) return;
    state.description = boundedSubagentText(
      record.description,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? state.description;
    this.emitState(
      state,
      "running",
      boundedSubagentText(
        record.summary ?? record.last_tool_name,
        MAX_SUBAGENT_PROGRESS_CHARS,
      ),
    );
  }

  private observeTaskUpdated(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    const state = this.tasks.get(taskId);
    const patch = objectValue(record.patch);
    if (!state || !patch) return;
    state.description = boundedSubagentText(
      patch.description,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? state.description;
    const status = patch.status === "pending"
      ? "spawned"
      : patch.status === "running"
        ? "running"
        : patch.status === "paused"
          ? "waiting"
          : patch.status === "completed"
            ? "completed"
            : patch.status === "failed"
              ? "failed"
              : patch.status === "killed"
                ? "cancelled"
                : null;
    if (!status) return;
    state.live = status === "spawned"
      || status === "running"
      || status === "waiting";
    this.emitState(
      state,
      status,
      null,
      boundedSubagentText(patch.error, MAX_SUBAGENT_RESULT_CHARS),
    );
  }

  private observeTaskNotification(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    const state = this.tasks.get(taskId);
    if (!state) return;
    const status = record.status === "completed"
      ? "completed"
      : record.status === "failed"
        ? "failed"
        : record.status === "stopped"
          ? "cancelled"
          : null;
    if (!status) return;
    state.live = false;
    this.emitState(
      state,
      status,
      null,
      boundedSubagentText(record.summary, MAX_SUBAGENT_RESULT_CHARS),
    );
  }

  private observeUser(record: Record<string, unknown>): void {
    const output = objectValue(record.tool_use_result);
    const agentId = boundedSubagentIdentifier(output?.agentId);
    if (
      !output
      || !agentId
      || (output.status !== "completed" && output.status !== "async_launched")
    ) return;
    const toolResult = contentBlocks(record.message)
      .map(objectValue)
      .find((block) => block?.type === "tool_result");
    const toolUseId = boundedSubagentIdentifier(toolResult?.tool_use_id);
    const taskId = toolUseId ? this.taskByToolUse.get(toolUseId) : undefined;
    let state = taskId ? this.tasks.get(taskId) : undefined;
    const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
    if (!state) {
      state = {
        taskId: taskId ?? "",
        toolUseId: toolUseId ?? "",
        parentToolUseId: metadata?.parentToolUseId ?? null,
        role: boundedSubagentIdentifier(output.agentType, 200)
          ?? metadata?.role
          ?? null,
        name: metadata?.name ?? null,
        description: boundedSubagentText(
          output.description,
          MAX_SUBAGENT_DESCRIPTION_CHARS,
        ) ?? metadata?.description ?? null,
        agentId,
        live: output.status === "async_launched",
      };
    } else {
      state.agentId = agentId;
      state.live = output.status === "async_launched";
    }
    const result = Array.isArray(output.content)
      ? output.content.flatMap((value) => {
          const block = objectValue(value);
          return block?.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [];
        }).join("\n")
      : null;
    this.emitState(
      state,
      output.status === "completed" ? "completed" : "running",
      null,
      boundedSubagentText(result, MAX_SUBAGENT_RESULT_CHARS),
    );
  }

  private emitState(
    state: ClaudeTaskState,
    status: SubagentUpdate["status"],
    progress: string | null = null,
    result: string | null = null,
  ): void {
    this.sequence += 1;
    this.emit({
      sequence: this.sequence,
      providerTaskId: state.taskId || null,
      providerAgentId: state.agentId,
      parentProviderAgentId: null,
      parentProviderToolUseId: state.parentToolUseId,
      providerToolUseId: state.toolUseId || null,
      providerRole: state.role,
      providerName: state.name,
      status,
      description: state.description,
      progress,
      result,
    });
  }
}
