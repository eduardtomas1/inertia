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
  terminal: boolean;
  terminalStatus: SubagentUpdate["status"] | null;
}

const SUBAGENT_TASK_TYPES = new Set([
  "agent",
  "local_agent",
  "local_workflow",
  "remote_agent",
  "subagent",
]);
export const MAX_CLAUDE_LIVE_SUBAGENT_TASKS = 1_024;
export const MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS = 256;
export const MAX_CLAUDE_PENDING_SUBAGENT_TOOLS = 1_024;
export const MAX_CLAUDE_IGNORED_TASK_IDS = 1_024;

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
  private readonly pendingTasksByToolUse = new Map<string, ClaudeTaskState>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly ignoredTaskIds = new Set<string>();
  private readonly terminalTaskIds: string[] = [];
  private readonly terminalTaskIdSet = new Set<string>();

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
    if (message.type === "tool_progress") {
      this.observeToolProgress(record);
      return;
    }
    if (message.type !== "system") return;
    const subtype = record.subtype;
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (taskId && this.ignoredTaskIds.has(taskId)) {
      if (
        subtype === "task_notification"
        || (subtype === "task_updated"
          && terminalTaskStatus(objectValue(record.patch)?.status))
      ) this.ignoredTaskIds.delete(taskId);
      return;
    }
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

  hasLiveTasks(): boolean {
    for (const task of this.pendingTasksByToolUse.values()) {
      if (task.live) return true;
    }
    for (const task of this.tasks.values()) {
      if (task.live) return true;
    }
    return false;
  }

  retainedStateCounts(): {
    tools: number;
    tasks: number;
    pendingTasksByToolUse: number;
    taskByToolUse: number;
    ignoredTaskIds: number;
  } {
    return {
      tools: this.tools.size,
      tasks: this.tasks.size,
      pendingTasksByToolUse: this.pendingTasksByToolUse.size,
      taskByToolUse: this.taskByToolUse.size,
      ignoredTaskIds: this.ignoredTaskIds.size,
    };
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
      this.rememberTool({
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
    if (this.tasks.get(taskId)?.terminal) return;
    const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
    const pending = toolUseId
      ? this.pendingTasksByToolUse.get(toolUseId)
      : undefined;
    const subagentType = boundedSubagentIdentifier(record.subagent_type, 200);
    const taskType = boundedSubagentIdentifier(record.task_type, 200);
    const isSubagent = Boolean(
      metadata
      || pending
      || subagentType
      || (taskType && SUBAGENT_TASK_TYPES.has(taskType)),
    );
    if (!isSubagent || record.skip_transcript === true) {
      if (
        !this.ignoredTaskIds.has(taskId)
        && this.ignoredTaskIds.size >= MAX_CLAUDE_IGNORED_TASK_IDS
      ) {
        throw new Error(
          "Claude exceeded the bounded ignored-task trace state.",
        );
      }
      this.ignoredTaskIds.add(taskId);
      if (toolUseId) {
        this.pendingTasksByToolUse.delete(toolUseId);
        this.tools.delete(toolUseId);
      }
      return;
    }
    const state: ClaudeTaskState = {
      taskId,
      toolUseId: toolUseId ?? metadata?.toolUseId ?? "",
      parentToolUseId: pending?.parentToolUseId
        ?? metadata?.parentToolUseId
        ?? null,
      role: subagentType ?? pending?.role ?? metadata?.role ?? null,
      name: boundedSubagentIdentifier(record.workflow_name, 200)
        ?? pending?.name
        ?? metadata?.name
        ?? null,
      description: boundedSubagentText(
        record.description ?? record.prompt,
        MAX_SUBAGENT_DESCRIPTION_CHARS,
      ) ?? pending?.description ?? metadata?.description ?? null,
      agentId: pending?.agentId ?? null,
      live: true,
      terminal: false,
      terminalStatus: null,
    };
    if (toolUseId) this.pendingTasksByToolUse.delete(toolUseId);
    this.rememberLiveTask(state);
    if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
    if (toolUseId) this.tools.delete(toolUseId);
    this.emitState(state, "spawned");
  }

  private observeTaskProgress(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    let state = this.tasks.get(taskId);
    const toolUseId = boundedSubagentIdentifier(record.tool_use_id);
    const subagentType = boundedSubagentIdentifier(record.subagent_type, 200);
    const pending = toolUseId
      ? this.pendingTasksByToolUse.get(toolUseId)
      : undefined;
    if (
      !state
      && (pending || subagentType || (toolUseId && this.tools.has(toolUseId)))
    ) {
      const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
      state = {
        taskId,
        toolUseId: toolUseId ?? "",
        parentToolUseId: pending?.parentToolUseId
          ?? metadata?.parentToolUseId
          ?? null,
        role: subagentType ?? pending?.role ?? metadata?.role ?? null,
        name: pending?.name ?? metadata?.name ?? null,
        description: boundedSubagentText(
          record.description,
          MAX_SUBAGENT_DESCRIPTION_CHARS,
        ) ?? pending?.description ?? metadata?.description ?? null,
        agentId: pending?.agentId ?? null,
        live: true,
        terminal: false,
        terminalStatus: null,
      };
      if (toolUseId) this.pendingTasksByToolUse.delete(toolUseId);
      this.rememberLiveTask(state);
      if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
      if (toolUseId) this.tools.delete(toolUseId);
    }
    if (!state) return;
    if (state.terminal) return;
    state.description = boundedSubagentText(
      record.description,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? state.description;
    this.emitState(
      state,
      "running",
      boundedSubagentText(
        progressWithUsage(
          record.summary ?? record.last_tool_name,
          record.usage,
        ),
        MAX_SUBAGENT_PROGRESS_CHARS,
      ),
    );
  }

  private observeToolProgress(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    const state = this.tasks.get(taskId);
    if (!state || state.terminal) return;
    const retry = objectValue(record.subagent_retry);
    const toolName = boundedSubagentIdentifier(record.tool_name, 200);
    const elapsedSeconds = nonNegativeNumber(record.elapsed_time_seconds);
    const attempt = positiveInteger(retry?.attempt);
    const maxRetries = positiveInteger(retry?.max_retries);
    const retryDelayMs = nonNegativeNumber(retry?.retry_delay_ms);
    const retryCategory = boundedSubagentIdentifier(
      retry?.error_category,
      200,
    );
    const progress = retry
      ? [
          toolName ? `Retrying ${toolName}` : "Retrying delegated work",
          attempt !== null && maxRetries !== null
            ? `attempt ${attempt}/${maxRetries}`
            : null,
          retryDelayMs !== null ? `in ${retryDelayMs} ms` : null,
          retryCategory ? `after ${retryCategory}` : null,
        ].filter((value): value is string => Boolean(value)).join(" · ")
      : [
          toolName,
          elapsedSeconds !== null ? `${elapsedSeconds} seconds elapsed` : null,
        ].filter((value): value is string => Boolean(value)).join(" · ");
    this.emitState(
      state,
      "running",
      boundedSubagentText(progress, MAX_SUBAGENT_PROGRESS_CHARS),
    );
  }

  private observeTaskUpdated(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    const state = this.tasks.get(taskId);
    const patch = objectValue(record.patch);
    if (!state || !patch || state.terminal) return;
    state.description = boundedSubagentText(
      patch.description,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? state.description;
    const providerStatus = boundedSubagentIdentifier(patch.status, 200);
    const status = providerStatus === "pending"
      ? "queued"
      : providerStatus === "running"
        ? "running"
        : providerStatus === "paused"
          ? "waiting"
          : providerStatus === "completed"
            ? "completed"
            : providerStatus === "failed"
              ? "failed"
              : providerStatus === "killed"
                ? "cancelled"
                : providerStatus
                  ? "unknown"
                  : null;
    if (!status) return;
    state.live = status === "queued"
      || status === "running"
      || status === "waiting"
      || status === "unknown";
    state.terminal = !state.live;
    state.terminalStatus = state.terminal ? status : null;
    if (state.terminal) this.rememberTerminalTask(state);
    this.emitState(
      state,
      status,
      null,
      boundedSubagentText(patch.error, MAX_SUBAGENT_RESULT_CHARS),
      providerStatus,
    );
  }

  private observeTaskNotification(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    if (!taskId || this.ignoredTaskIds.has(taskId)) return;
    let state = this.tasks.get(taskId);
    const toolUseId = boundedSubagentIdentifier(record.tool_use_id);
    const pending = toolUseId
      ? this.pendingTasksByToolUse.get(toolUseId)
      : undefined;
    if (!state && pending && toolUseId) {
      this.pendingTasksByToolUse.delete(toolUseId);
      pending.taskId = taskId;
      state = pending;
      this.rememberLiveTask(state);
      this.taskByToolUse.set(toolUseId, taskId);
    }
    if (!state) return;
    const providerStatus = boundedSubagentIdentifier(record.status, 200);
    const status = providerStatus === "completed"
      ? "completed"
      : providerStatus === "failed"
        ? "failed"
        : providerStatus === "stopped"
          ? "cancelled"
          : providerStatus
            ? "unknown"
            : null;
    if (!status) return;
    if (
      state.terminal
      && state.terminalStatus !== "unknown"
      && state.terminalStatus !== status
    ) return;
    state.live = false;
    state.terminal = true;
    state.terminalStatus = status;
    this.rememberTerminalTask(state);
    this.emitState(
      state,
      status,
      null,
      boundedSubagentText(record.summary, MAX_SUBAGENT_RESULT_CHARS),
      providerStatus,
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
    const status: SubagentUpdate["status"] = output.status === "completed"
      ? "completed"
      : "running";
    const toolResult = contentBlocks(record.message)
      .map(objectValue)
      .find((block) => block?.type === "tool_result");
    const toolUseId = boundedSubagentIdentifier(toolResult?.tool_use_id);
    const taskId = toolUseId ? this.taskByToolUse.get(toolUseId) : undefined;
    let state = taskId ? this.tasks.get(taskId) : undefined;
    if (!state && toolUseId) {
      state = this.pendingTasksByToolUse.get(toolUseId);
    }
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
        terminal: output.status === "completed",
        terminalStatus: output.status === "completed" ? "completed" : null,
      };
    } else {
      if (
        state.terminal
        && state.terminalStatus !== "unknown"
        && state.terminalStatus !== status
      ) return;
      state.agentId = agentId;
      state.live = output.status === "async_launched";
      state.terminal = output.status === "completed";
      state.terminalStatus = state.terminal ? status : null;
    }
    if (state.live && !state.taskId && toolUseId) {
      this.rememberPendingTask(toolUseId, state);
    }
    if (state.terminal) {
      if (toolUseId) this.pendingTasksByToolUse.delete(toolUseId);
      if (state.taskId) this.rememberTerminalTask(state);
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
      status,
      null,
      boundedSubagentText(result, MAX_SUBAGENT_RESULT_CHARS),
      output.status,
    );
    if (output.status === "completed" && toolUseId) {
      this.tools.delete(toolUseId);
    }
  }

  private emitState(
    state: ClaudeTaskState,
    status: SubagentUpdate["status"],
    progress: string | null = null,
    result: string | null = null,
    providerStatus: string | null = null,
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
      providerStatus,
      status,
      isLive: state.live,
      description: state.description,
      progress,
      result,
    });
  }

  private rememberTool(tool: ClaudeAgentTool): void {
    if (
      !this.tools.has(tool.toolUseId)
      && this.tools.size >= MAX_CLAUDE_PENDING_SUBAGENT_TOOLS
    ) {
      throw new Error(
        "Claude exceeded the bounded pending-subagent trace state.",
      );
    }
    this.tools.set(tool.toolUseId, tool);
  }

  private rememberLiveTask(state: ClaudeTaskState): void {
    if (!this.tasks.has(state.taskId)) {
      let liveTasks = this.pendingTasksByToolUse.size;
      for (const task of this.tasks.values()) {
        if (task.live) liveTasks += 1;
      }
      if (liveTasks >= MAX_CLAUDE_LIVE_SUBAGENT_TASKS) {
        throw new Error("Claude exceeded the bounded live-subagent trace state.");
      }
    }
    this.tasks.set(state.taskId, state);
  }

  private rememberPendingTask(
    toolUseId: string,
    state: ClaudeTaskState,
  ): void {
    if (!this.pendingTasksByToolUse.has(toolUseId)) {
      let liveTasks = this.pendingTasksByToolUse.size;
      for (const task of this.tasks.values()) {
        if (task.live) liveTasks += 1;
      }
      if (liveTasks >= MAX_CLAUDE_LIVE_SUBAGENT_TASKS) {
        throw new Error("Claude exceeded the bounded live-subagent trace state.");
      }
    }
    this.pendingTasksByToolUse.set(toolUseId, state);
  }

  private rememberTerminalTask(state: ClaudeTaskState): void {
    if (state.toolUseId) this.tools.delete(state.toolUseId);
    if (this.terminalTaskIdSet.has(state.taskId)) return;
    this.terminalTaskIdSet.add(state.taskId);
    this.terminalTaskIds.push(state.taskId);
    while (
      this.terminalTaskIds.length > MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS
    ) {
      const oldest = this.terminalTaskIds.shift();
      if (!oldest) break;
      this.terminalTaskIdSet.delete(oldest);
      const evicted = this.tasks.get(oldest);
      if (!evicted || evicted.live) continue;
      this.tasks.delete(oldest);
      if (evicted.toolUseId) {
        this.taskByToolUse.delete(evicted.toolUseId);
        this.tools.delete(evicted.toolUseId);
      }
    }
  }
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function progressWithUsage(progress: unknown, usageValue: unknown): unknown {
  const text = boundedSubagentText(progress, MAX_SUBAGENT_PROGRESS_CHARS);
  const usage = objectValue(usageValue);
  if (!usage) return text;
  const totalTokens = nonNegativeNumber(usage.total_tokens);
  const toolUses = nonNegativeNumber(usage.tool_uses);
  const durationMs = nonNegativeNumber(usage.duration_ms);
  const details = [
    totalTokens !== null ? `${totalTokens} tokens` : null,
    toolUses !== null ? `${toolUses} tool ${toolUses === 1 ? "use" : "uses"}` : null,
    durationMs !== null ? `${durationMs} ms` : null,
  ].filter((value): value is string => Boolean(value));
  return [text, details.join(" · ")].filter(Boolean).join(" · ");
}

function terminalTaskStatus(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "killed";
}
