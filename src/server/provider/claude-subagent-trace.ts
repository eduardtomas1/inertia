import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  SubagentTaskEffort,
  SubagentTaskKind,
} from "../../shared/contracts";
import { subagentTaskHoldsTurn } from "../../shared/subagent-task-limits";
import type {
  AgentHarnessEmitter,
} from "./agent-harness";
import {
  SubagentStepRing,
  subagentActivityLabel,
  subagentStepKeyInput,
  subagentStepLabel,
} from "./subagent-steps";
import {
  boundedSubagentCount,
  boundedSubagentIdentifier,
  boundedSubagentText,
  MAX_SUBAGENT_COMMAND_CHARS,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_DURATION_MS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TOOL_USE_COUNT,
} from "./subagent-trace";
import { validateSubagentTaskUsage } from "./usage-values";

type SubagentUpdate = Parameters<AgentHarnessEmitter["subagent"]>[0];
type ClaudeTaskTelemetry = Pick<
  SubagentUpdate,
  "activity" | "usage" | "toolUseCount" | "durationMs"
>;

const MAX_SUBAGENT_LABEL_CHARS = 200;

interface ClaudeAgentTool {
  toolUseId: string;
  parentToolUseId: string | null;
  role: string | null;
  name: string | null;
  description: string | null;
  /** The model alias Claude requested; Claude ignores it for forks. */
  model: string | null;
  effort: SubagentTaskEffort | null;
  background: boolean | null;
  remote: boolean;
  /** The model on the subagent's first forwarded assistant frame. */
  observedModel: string | null;
}

interface ClaudeShellCall {
  command: string | null;
  description: string | null;
  background: boolean | null;
}

interface ClaudeTaskState extends ClaudeAgentTool {
  taskId: string;
  agentId: string | null;
  kind: SubagentTaskKind;
  /**
   * Local agents and workflows gate the turn; background commands and remote
   * agents running in the cloud never do.
   */
  gatesTurn: boolean;
  /** The model Claude reported on the Agent tool result. */
  resolvedModel: string | null;
  command: string | null;
  /** Foreground shells stay private until Claude moves them to the background. */
  surfaced: boolean;
  status: SubagentUpdate["status"] | null;
  steps: SubagentStepRing;
  live: boolean;
  terminal: boolean;
  terminalStatus: SubagentUpdate["status"] | null;
}

/** Claude's raw task types, mapped to what Inertia shows. */
const TASK_KINDS: ReadonlyMap<string, SubagentTaskKind> = new Map([
  ["agent", "agent"],
  ["in_process_teammate", "agent"],
  ["local_agent", "agent"],
  ["subagent", "agent"],
  ["local_workflow", "workflow"],
  ["workflow", "workflow"],
  ["remote_agent", "remote"],
  ["local_bash", "shell"],
  ["shell", "shell"],
  ["monitor", "monitor"],
  ["mcp_task", "mcp"],
]);
/** Kinds an Agent call can start; only local agents and workflows hold the turn. */
const DELEGATED_KINDS = new Set<SubagentTaskKind>(["agent", "workflow", "remote"]);
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell"]);
const EFFORTS = new Set<SubagentTaskEffort>(["low", "medium", "high", "xhigh", "max"]);

export const MAX_CLAUDE_LIVE_SUBAGENT_TASKS = 1_024;
export const MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS = 256;
/** Foreground shells Claude registered as tasks but Inertia does not show. */
export const MAX_CLAUDE_PRIVATE_SHELL_TASKS = 1_024;
export const MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS = 256;
export const MAX_CLAUDE_PENDING_SUBAGENT_TOOLS = 1_024;
export const MAX_CLAUDE_REMEMBERED_SHELL_CALLS = 1_024;
export const MAX_CLAUDE_TRACKED_SUBAGENT_STEPS = 4_096;
export const MAX_CLAUDE_IGNORED_TASK_IDS = 1_024;
export const MAX_CLAUDE_QUEUED_TASK_STOPS = 64;

/** Progress while a held Stop waits for Claude, and once Claude answered it. */
export const CLAUDE_STOP_REQUESTED_PROGRESS = "Stop requested.";
export const CLAUDE_STOPPED_BY_USER_PROGRESS = "Stopped by the user.";
export const CLAUDE_STOP_FAILED_PROGRESS = "Claude could not stop this task.";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentBlocks(message: unknown): unknown[] {
  const content = objectValue(message)?.content;
  return Array.isArray(content) ? content : [];
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function effortValue(value: unknown): SubagentTaskEffort | null {
  return EFFORTS.has(value as SubagentTaskEffort) ? value as SubagentTaskEffort : null;
}

/** Claude marks locally generated turns with this placeholder, not a model. */
const SYNTHETIC_MODEL = "<synthetic>";

function modelLabel(value: unknown): string | null {
  const model = boundedSubagentText(value, MAX_SUBAGENT_LABEL_CHARS);
  return model === SYNTHETIC_MODEL ? null : model;
}

function rememberBounded<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  maximum: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
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
  private readonly shellCalls = new Map<string, ClaudeShellCall>();
  private readonly tasks = new Map<string, ClaudeTaskState>();
  private readonly pendingTasksByToolUse = new Map<string, ClaudeTaskState>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly stepOwners = new Map<string, string>();
  private readonly ignoredTaskIds = new Set<string>();
  private readonly terminalTaskIds: string[] = [];
  private readonly terminalTaskIdSet = new Set<string>();
  private readonly queuedStops = new Set<string>();
  /** Tool calls with a held Stop that Claude has not answered yet. */
  private readonly stopping = new Set<string>();
  private readyStops: string[] = [];

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
    const task = this.tasks.get(taskId);
    return task?.live === true && task.surfaced;
  }

  /** The live task Claude started for this tool call, once it has a task id. */
  liveTaskForToolUse(toolUseId: string): string | null {
    const taskId = this.taskByToolUse.get(toolUseId);
    return taskId && this.isLiveTask(taskId) ? taskId : null;
  }

  /** A live delegated agent its parent is still waiting on. */
  isForegroundAgent(toolUseId: string): boolean {
    const taskId = this.taskByToolUse.get(toolUseId);
    const task = taskId ? this.tasks.get(taskId) : undefined;
    return Boolean(task?.live && task.surfaced && task.kind === "agent" && task.background === false);
  }

  /**
   * Holds a Stop for delegated work Claude has not given a task id yet; it is
   * released when task_started names that tool call.
   */
  queueStop(toolUseId: string): boolean {
    const pending = this.pendingTasksByToolUse.get(toolUseId);
    if (!pending?.live && !this.tools.has(toolUseId)) return false;
    if (
      !this.queuedStops.has(toolUseId)
      && (this.queuedStops.size >= MAX_CLAUDE_QUEUED_TASK_STOPS
        || this.stopping.size >= MAX_CLAUDE_QUEUED_TASK_STOPS)
    ) return false;
    this.queuedStops.add(toolUseId);
    this.stopping.add(toolUseId);
    return true;
  }

  /**
   * Records Claude's answer to a held Stop. Only an accepted stopTask settles
   * the task; a refusal or timeout leaves it live and says so.
   */
  settleQueuedStop(taskId: string, stopped: boolean): void {
    const state = this.tasks.get(taskId);
    if (!state?.toolUseId || !this.stopping.delete(state.toolUseId) || state.terminal) return;
    if (stopped) {
      state.live = false;
      state.terminal = true;
      state.terminalStatus = "cancelled";
      this.rememberTerminalTask(state);
      this.emitState(state, "cancelled", CLAUDE_STOPPED_BY_USER_PROGRESS, null, "stopped");
      return;
    }
    if (!state.live) return;
    this.emitState(
      state,
      state.status && state.status !== "spawned" ? state.status : "running",
      CLAUDE_STOP_FAILED_PROGRESS,
    );
  }

  /** Task ids whose queued Stop can now be sent to Claude. */
  takeReadyStops(): string[] {
    const ready = this.readyStops;
    this.readyStops = [];
    return ready;
  }

  /** Live delegated agents only; background commands never hold a turn open. */
  hasLiveTasks(): boolean {
    for (const task of this.pendingTasksByToolUse.values()) {
      if (task.live && task.gatesTurn) return true;
    }
    for (const task of this.tasks.values()) {
      if (task.live && task.gatesTurn) return true;
    }
    return false;
  }

  retainedStateCounts(): {
    tools: number;
    tasks: number;
    pendingTasksByToolUse: number;
    taskByToolUse: number;
    ignoredTaskIds: number;
    shellCalls: number;
    stepOwners: number;
  } {
    return {
      tools: this.tools.size,
      tasks: this.tasks.size,
      pendingTasksByToolUse: this.pendingTasksByToolUse.size,
      taskByToolUse: this.taskByToolUse.size,
      ignoredTaskIds: this.ignoredTaskIds.size,
      shellCalls: this.shellCalls.size,
      stepOwners: this.stepOwners.size,
    };
  }

  private observeAssistant(record: Record<string, unknown>): void {
    const parentToolUseId = boundedSubagentIdentifier(
      record.parent_tool_use_id,
    );
    if (parentToolUseId) this.observeChildAssistant(parentToolUseId, record);
    for (const block of contentBlocks(record.message)) {
      const item = objectValue(block);
      if (item?.type !== "tool_use") continue;
      const toolUseId = boundedSubagentIdentifier(item.id);
      if (!toolUseId) continue;
      const input = objectValue(item.input) ?? {};
      if (typeof item.name === "string" && SHELL_TOOL_NAMES.has(item.name)) {
        rememberBounded(this.shellCalls, toolUseId, {
          command: boundedSubagentText(input.command, MAX_SUBAGENT_COMMAND_CHARS),
          description: boundedSubagentText(input.description, MAX_SUBAGENT_DESCRIPTION_CHARS),
          background: booleanValue(input.run_in_background),
        }, MAX_CLAUDE_REMEMBERED_SHELL_CALLS);
        continue;
      }
      if (item.name !== "Agent" && item.name !== "Task") continue;
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
        model: modelLabel(input.model),
        effort: effortValue(input.effort),
        background: booleanValue(input.run_in_background),
        remote: input.isolation === "remote",
        observedModel: null,
      });
    }
  }

  /**
   * A forwarded subagent frame names the Agent call that owns it. Its model is
   * the model the subagent really runs on, and each tool call it makes becomes
   * a step labelled by tool name and one key input, never contents or output.
   */
  private observeChildAssistant(
    parentToolUseId: string,
    record: Record<string, unknown>,
  ): void {
    const owner = this.ownerOf(parentToolUseId);
    if (!owner) return;
    const message = objectValue(record.message);
    let changed = false;
    const model = modelLabel(message?.model);
    if (model && !owner.observedModel) {
      owner.observedModel = model;
      changed = "taskId" in owner && !owner.resolvedModel;
    }
    if (!("taskId" in owner) || owner.terminal) return;
    let activity: string | null = null;
    for (const block of contentBlocks(message)) {
      const item = objectValue(block);
      const stepId = item?.type === "tool_use" ? boundedSubagentIdentifier(item.id) : null;
      const label = stepId ? subagentStepLabel(item?.name, subagentStepKeyInput(item?.input)) : null;
      if (!stepId || !label) continue;
      if (owner.steps.start(stepId, label)) {
        changed = true;
        activity = label;
      }
      // Keyed by the owning Agent call, so a step started before Claude issued
      // the task id still settles once it has one.
      rememberBounded(this.stepOwners, stepId, parentToolUseId, MAX_CLAUDE_TRACKED_SUBAGENT_STEPS);
    }
    if (changed && owner.live) {
      this.emitState(owner, "running", null, null, null, activity ? { activity } : {});
    }
  }

  private observeChildResults(record: Record<string, unknown>): void {
    const touched = new Set<ClaudeTaskState>();
    for (const block of contentBlocks(record.message)) {
      const item = objectValue(block);
      const stepId = item?.type === "tool_result"
        ? boundedSubagentIdentifier(item.tool_use_id)
        : null;
      const ownerToolUseId = stepId ? this.stepOwners.get(stepId) : undefined;
      if (!stepId || !ownerToolUseId) continue;
      const owner = this.ownerOf(ownerToolUseId);
      if (!owner || !("taskId" in owner) || owner.terminal) continue;
      if (owner.steps.settle(stepId, item?.is_error === true)) touched.add(owner);
      this.stepOwners.delete(stepId);
    }
    for (const owner of touched) {
      if (owner.live) this.emitState(owner, "running");
    }
  }

  private ownerOf(toolUseId: string): ClaudeTaskState | ClaudeAgentTool | undefined {
    const taskId = this.taskByToolUse.get(toolUseId);
    return (taskId ? this.tasks.get(taskId) : undefined)
      ?? this.pendingTasksByToolUse.get(toolUseId)
      ?? this.tools.get(toolUseId);
  }

  private parentToolUseOfTask(value: unknown): string | null {
    const parentTaskId = boundedSubagentIdentifier(value);
    const parent = parentTaskId ? this.tasks.get(parentTaskId) : undefined;
    return parent?.toolUseId || null;
  }

  private observeTaskStarted(record: Record<string, unknown>): void {
    const taskId = boundedSubagentIdentifier(record.task_id);
    const toolUseId = boundedSubagentIdentifier(record.tool_use_id);
    if (!taskId) return;
    const existing = this.tasks.get(taskId);
    if (existing?.terminal) return;
    const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
    const pending = toolUseId
      ? this.pendingTasksByToolUse.get(toolUseId)
      : undefined;
    const base = existing ?? pending;
    const subagentType = boundedSubagentIdentifier(record.subagent_type, 200);
    const taskType = boundedSubagentIdentifier(record.task_type, 200);
    const typedKind = taskType ? TASK_KINDS.get(taskType) : undefined;
    const delegated = Boolean(metadata || base?.gatesTurn || base?.remote || subagentType);
    const kind: SubagentTaskKind | null = delegated
      ? typedKind && DELEGATED_KINDS.has(typedKind)
        ? typedKind
        : metadata?.remote || base?.remote ? "remote" : "agent"
      : typedKind ?? null;
    if (!kind || record.skip_transcript === true || record.ambient === true) {
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
        this.shellCalls.delete(toolUseId);
      }
      return;
    }
    const shell = kind === "shell" && toolUseId
      ? this.shellCalls.get(toolUseId)
      : undefined;
    const state: ClaudeTaskState = {
      taskId,
      toolUseId: toolUseId ?? base?.toolUseId ?? metadata?.toolUseId ?? "",
      parentToolUseId: base?.parentToolUseId
        ?? metadata?.parentToolUseId
        ?? this.parentToolUseOfTask(record.parent_task_id),
      role: subagentType ?? base?.role ?? metadata?.role ?? null,
      name: boundedSubagentIdentifier(record.workflow_name, 200)
        ?? base?.name
        ?? metadata?.name
        ?? null,
      description: boundedSubagentText(
        record.description ?? record.prompt,
        MAX_SUBAGENT_DESCRIPTION_CHARS,
      ) ?? base?.description ?? metadata?.description ?? shell?.description ?? null,
      model: base?.model ?? metadata?.model ?? null,
      effort: base?.effort ?? metadata?.effort ?? null,
      background: kind === "remote" ? true : booleanValue(record.is_backgrounded)
        ?? base?.background
        ?? metadata?.background
        ?? shell?.background
        ?? null,
      remote: kind === "remote",
      observedModel: base?.observedModel ?? metadata?.observedModel ?? null,
      agentId: base?.agentId ?? null,
      kind,
      gatesTurn: subagentTaskHoldsTurn(kind),
      resolvedModel: base?.resolvedModel ?? null,
      command: shell?.command ?? base?.command ?? null,
      surfaced: base?.surfaced ?? false,
      status: base?.status ?? null,
      steps: base?.steps ?? new SubagentStepRing(),
      live: true,
      terminal: false,
      terminalStatus: null,
    };
    if (toolUseId) this.pendingTasksByToolUse.delete(toolUseId);
    if (!this.rememberLiveTask(state)) return;
    if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
    if (toolUseId) {
      this.tools.delete(toolUseId);
      this.shellCalls.delete(toolUseId);
    }
    if (state.toolUseId && this.queuedStops.delete(state.toolUseId)) {
      this.readyStops.push(taskId);
    }
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
      const remote = Boolean(metadata?.remote || pending?.remote);
      const candidate: ClaudeTaskState = {
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
        model: pending?.model ?? metadata?.model ?? null,
        effort: pending?.effort ?? metadata?.effort ?? null,
        background: remote ? true : pending?.background ?? metadata?.background ?? null,
        remote,
        observedModel: pending?.observedModel ?? metadata?.observedModel ?? null,
        agentId: pending?.agentId ?? null,
        kind: remote ? "remote" : "agent",
        gatesTurn: !remote,
        resolvedModel: pending?.resolvedModel ?? null,
        command: null,
        surfaced: pending?.surfaced ?? false,
        status: pending?.status ?? null,
        steps: pending?.steps ?? new SubagentStepRing(),
        live: true,
        terminal: false,
        terminalStatus: null,
      };
      if (toolUseId) this.pendingTasksByToolUse.delete(toolUseId);
      if (this.rememberLiveTask(candidate)) {
        state = candidate;
        if (state.toolUseId) this.taskByToolUse.set(state.toolUseId, taskId);
        if (toolUseId) this.tools.delete(toolUseId);
      }
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
        record.summary ?? record.last_tool_name,
        MAX_SUBAGENT_PROGRESS_CHARS,
      ),
      null,
      null,
      {
        ...taskUsageTelemetry(record.usage),
        ...optionalText(
          "activity",
          subagentActivityLabel(record.summary)
            ?? subagentActivityLabel(record.last_tool_name),
        ),
      },
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
      null,
      null,
      optionalText("activity", subagentActivityLabel(record.tool_name)),
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
    const backgrounded = booleanValue(patch.is_backgrounded);
    const movedToBackground = backgrounded !== null
      && backgrounded !== state.background;
    if (backgrounded !== null) state.background = backgrounded;
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
    if (!status) {
      if (movedToBackground) {
        this.emitState(state, state.status && state.status !== "spawned" ? state.status : "running");
      }
      return;
    }
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
      this.tasks.set(taskId, state);
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
      taskUsageTelemetry(record.usage),
    );
  }

  private observeUser(record: Record<string, unknown>): void {
    if (boundedSubagentIdentifier(record.parent_tool_use_id)) {
      this.observeChildResults(record);
    }
    const output = objectValue(record.tool_use_result);
    const toolResult = contentBlocks(record.message)
      .map(objectValue)
      .find((block) => block?.type === "tool_result");
    const toolUseId = boundedSubagentIdentifier(toolResult?.tool_use_id);
    if (toolUseId) this.observeShellResult(toolUseId, output);
    if (!output) return;
    if (output.status === "remote_launched") {
      this.observeRemoteLaunch(output, toolUseId);
      return;
    }
    const agentId = boundedSubagentIdentifier(output.agentId);
    if (
      !agentId
      || (output.status !== "completed" && output.status !== "async_launched")
    ) return;
    const status: SubagentUpdate["status"] = output.status === "completed"
      ? "completed"
      : "running";
    const taskId = toolUseId ? this.taskByToolUse.get(toolUseId) : undefined;
    let state = taskId ? this.tasks.get(taskId) : undefined;
    if (!state && toolUseId) {
      state = this.pendingTasksByToolUse.get(toolUseId);
    }
    const metadata = toolUseId ? this.tools.get(toolUseId) : undefined;
    const resolvedModel = modelLabel(output.resolvedModel)
      ?? lastModel(output.modelsUsed);
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
        model: metadata?.model ?? null,
        effort: metadata?.effort ?? null,
        background: metadata?.background
          ?? (output.status === "async_launched" ? true : null),
        remote: false,
        observedModel: metadata?.observedModel ?? null,
        agentId,
        kind: "agent",
        gatesTurn: true,
        resolvedModel,
        command: null,
        surfaced: false,
        status: null,
        steps: new SubagentStepRing(),
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
      state.role ??= boundedSubagentIdentifier(output.agentType, 200);
      state.resolvedModel = resolvedModel ?? state.resolvedModel;
      if (output.status === "async_launched") state.background = true;
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
      output.status === "completed" ? agentResultTelemetry(output) : {},
    );
    if (output.status === "completed" && toolUseId) {
      this.tools.delete(toolUseId);
      this.queuedStops.delete(toolUseId);
    }
  }

  /**
   * A foreground shell's result ends the command unless Claude moved it to
   * the background on the way, so its private task state is released then.
   */
  private observeShellResult(
    toolUseId: string,
    output: Record<string, unknown> | null,
  ): void {
    const taskId = this.taskByToolUse.get(toolUseId);
    const state = taskId ? this.tasks.get(taskId) : undefined;
    if (!taskId || !state || state.kind !== "shell" || state.surfaced || state.background === true) {
      if (!taskId) this.shellCalls.delete(toolUseId);
      return;
    }
    if (boundedSubagentIdentifier(output?.backgroundTaskId) === taskId) {
      state.background = true;
      this.emitState(state, "running");
      return;
    }
    this.tasks.delete(taskId);
    this.taskByToolUse.delete(toolUseId);
    this.shellCalls.delete(toolUseId);
  }

  /**
   * Claude launched the agent in a cloud session. Only the task identity is
   * kept: the session link and any output file never leave the adapter.
   */
  private observeRemoteLaunch(
    output: Record<string, unknown>,
    toolUseId: string | null,
  ): void {
    const taskId = boundedSubagentIdentifier(output.taskId);
    if (!taskId || !toolUseId) return;
    const known = this.tasks.get(taskId)
      ?? this.tasks.get(this.taskByToolUse.get(toolUseId) ?? "")
      ?? this.pendingTasksByToolUse.get(toolUseId);
    const metadata = this.tools.get(toolUseId);
    if (known?.terminal || (!known && !metadata)) return;
    let state = known;
    if (state) {
      state.kind = "remote";
      state.remote = true;
      state.gatesTurn = false;
      state.background = true;
      if (!state.taskId) {
        state.taskId = taskId;
        this.pendingTasksByToolUse.delete(toolUseId);
        if (!this.rememberLiveTask(state)) return;
      }
    } else {
      const candidate: ClaudeTaskState = {
        taskId,
        toolUseId,
        parentToolUseId: metadata?.parentToolUseId ?? null,
        role: metadata?.role ?? null,
        name: metadata?.name ?? null,
        description: metadata?.description ?? null,
        model: metadata?.model ?? null,
        effort: metadata?.effort ?? null,
        background: true,
        remote: true,
        observedModel: metadata?.observedModel ?? null,
        agentId: null,
        kind: "remote",
        gatesTurn: false,
        resolvedModel: null,
        command: null,
        surfaced: false,
        status: null,
        steps: new SubagentStepRing(),
        live: true,
        terminal: false,
        terminalStatus: null,
      };
      if (!this.rememberLiveTask(candidate)) return;
      state = candidate;
    }
    this.taskByToolUse.set(toolUseId, taskId);
    this.tools.delete(toolUseId);
    this.emitState(state, "running", null, null, "remote_launched");
  }

  private emitState(
    state: ClaudeTaskState,
    status: SubagentUpdate["status"],
    progress: string | null = null,
    result: string | null = null,
    providerStatus: string | null = null,
    telemetry: ClaudeTaskTelemetry = {},
  ): void {
    if (state.toolUseId && this.stopping.has(state.toolUseId)) {
      if (state.live) progress = CLAUDE_STOP_REQUESTED_PROGRESS;
      else {
        this.stopping.delete(state.toolUseId);
        if (status === "cancelled") progress = CLAUDE_STOPPED_BY_USER_PROGRESS;
      }
    }
    state.status = status;
    if (!state.surfaced) {
      if (this.isPrivateShell(state)) return;
      if (
        !state.gatesTurn
        && state.live
        && this.liveTaskCount(false) >= MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS
      ) {
        if (this.tasks.get(state.taskId) === state) {
          this.tasks.delete(state.taskId);
          if (state.toolUseId) this.taskByToolUse.delete(state.toolUseId);
        }
        return;
      }
    }
    state.surfaced = true;
    this.sequence += 1;
    const fork = state.role === "fork";
    const observedModel = state.resolvedModel ?? state.observedModel;
    const model = observedModel ?? (fork ? null : state.model);
    const steps = state.steps.snapshot();
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
      taskKind: state.kind,
      ...optionalText("model", model),
      ...(model ? { modelSource: observedModel ? "observed" as const : "requested" as const } : {}),
      ...(state.background !== null ? { background: state.background } : {}),
      ...(state.command && !state.gatesTurn ? { command: state.command } : {}),
      ...(state.effort && !fork ? { effort: state.effort } : {}),
      ...(steps ? { steps } : {}),
      ...telemetry,
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

  /**
   * Delegated agents fail closed when their state floods. Background commands
   * are only shown, never waited on, so their overflow drops the update. A
   * foreground shell is private until it moves to the background: it does not
   * count toward the shown commands, and the oldest one is forgotten instead.
   */
  private rememberLiveTask(state: ClaudeTaskState): boolean {
    if (!this.tasks.has(state.taskId)) {
      if (state.gatesTurn) {
        if (this.liveTaskCount(true) >= MAX_CLAUDE_LIVE_SUBAGENT_TASKS) {
          throw new Error("Claude exceeded the bounded live-subagent trace state.");
        }
      } else if (this.isPrivateShell(state)) {
        this.forgetOldestPrivateShells(MAX_CLAUDE_PRIVATE_SHELL_TASKS - 1);
      } else if (this.liveTaskCount(false) >= MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS) {
        return false;
      }
    }
    this.tasks.set(state.taskId, state);
    return true;
  }

  private isPrivateShell(state: ClaudeTaskState): boolean {
    return !state.surfaced && state.kind === "shell" && state.background !== true;
  }

  private forgetOldestPrivateShells(keep: number): void {
    const privateShells = [...this.tasks.values()].filter((task) => task.live && this.isPrivateShell(task));
    for (const task of privateShells.slice(0, Math.max(0, privateShells.length - keep))) {
      this.tasks.delete(task.taskId);
      if (task.toolUseId) this.taskByToolUse.delete(task.toolUseId);
    }
  }

  /** Live delegated agents, or live background work that is shown. */
  private liveTaskCount(gatesTurn: boolean): number {
    let count = 0;
    if (gatesTurn) {
      for (const task of this.pendingTasksByToolUse.values()) {
        if (task.gatesTurn) count += 1;
      }
    }
    for (const task of this.tasks.values()) {
      if (task.live && task.gatesTurn === gatesTurn && (gatesTurn || task.surfaced)) count += 1;
    }
    return count;
  }

  private rememberPendingTask(
    toolUseId: string,
    state: ClaudeTaskState,
  ): void {
    if (
      !this.pendingTasksByToolUse.has(toolUseId)
      && this.liveTaskCount(true) >= MAX_CLAUDE_LIVE_SUBAGENT_TASKS
    ) {
      throw new Error("Claude exceeded the bounded live-subagent trace state.");
    }
    this.pendingTasksByToolUse.set(toolUseId, state);
  }

  private rememberTerminalTask(state: ClaudeTaskState): void {
    if (state.toolUseId) {
      this.tools.delete(state.toolUseId);
      this.queuedStops.delete(state.toolUseId);
    }
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

function lastModel(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const model = modelLabel(value[index]);
    if (model) return model;
  }
  return null;
}

function optionalText<Key extends "activity" | "model">(
  key: Key,
  value: string | null,
): Partial<Record<Key, string>> {
  return value === null ? {} : { [key]: value } as Record<Key, string>;
}

function taskTelemetry(
  totalTokens: unknown,
  toolUses: unknown,
  durationMs: unknown,
): ClaudeTaskTelemetry {
  const totals = validateSubagentTaskUsage({ totalTokens });
  const toolUseCount = boundedSubagentCount(
    toolUses,
    MAX_SUBAGENT_TOOL_USE_COUNT,
  );
  const duration = boundedSubagentCount(
    durationMs,
    MAX_SUBAGENT_DURATION_MS,
  );
  return {
    ...(totals ? { usage: totals } : {}),
    ...(toolUseCount !== null ? { toolUseCount } : {}),
    ...(duration !== null ? { durationMs: duration } : {}),
  };
}

function taskUsageTelemetry(value: unknown): ClaudeTaskTelemetry {
  const usage = objectValue(value);
  if (!usage) return {};
  return taskTelemetry(usage.total_tokens, usage.tool_uses, usage.duration_ms);
}

function agentResultTelemetry(output: Record<string, unknown>): ClaudeTaskTelemetry {
  return taskTelemetry(
    output.totalTokens,
    output.totalToolUseCount,
    output.totalDurationMs,
  );
}

function terminalTaskStatus(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "killed";
}
