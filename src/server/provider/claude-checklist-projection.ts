import { MAX_AGENT_PLAN_STEPS } from "../../shared/agent-plan";
import type { AgentHarnessEmitter } from "./agent-harness";
import {
  boundedClaudeIdentifier as boundedIdentifier,
  claudeObjectValue as objectValue,
  MAX_CLAUDE_TRACKED_MESSAGE_IDS as MAX_TRACKED_MESSAGE_IDS,
} from "./claude-message-projector-support";
import type { AgentPlanStep } from "./interactions";

const MAX_CLAUDE_CHECKLIST_STEP_CHARS = 1_000;
const MAX_CLAUDE_CHECKLIST_SESSIONS = 64;
const CLAUDE_CHECKLIST_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);

type ClaudeChecklistStatus = Exclude<AgentPlanStep["status"], "cancelled">;
export type ClaudeChecklistTasks = Map<string, AgentPlanStep>;

interface ClaudeChecklistCall {
  name: string;
  input: Record<string, unknown>;
}

function checklistStatus(value: unknown): ClaudeChecklistStatus | null {
  if (value === "pending" || value === "completed") return value;
  return value === "in_progress" ? "inProgress" : null;
}

function checklistText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_CLAUDE_CHECKLIST_STEP_CHARS) : null;
}

function checklistTask(value: unknown): { id: string; step: AgentPlanStep } | null {
  const task = objectValue(value);
  const id = boundedIdentifier(task?.id);
  const step = checklistText(task?.subject);
  const status = checklistStatus(task?.status);
  return id && step && status ? { id, step: { step, status } } : null;
}

function checklistTodo(value: unknown): AgentPlanStep | null {
  const todo = objectValue(value);
  const step = checklistText(todo?.content);
  const status = checklistStatus(todo?.status);
  return step && status ? { step, status } : null;
}

export class ClaudeChecklistSessions {
  private readonly sessions = new Map<string, ClaudeChecklistTasks>();

  tasks(sessionId: string | undefined): ClaudeChecklistTasks {
    if (!sessionId) return new Map();
    const tasks = this.sessions.get(sessionId) ?? new Map<string, AgentPlanStep>();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, tasks);
    if (this.sessions.size > MAX_CLAUDE_CHECKLIST_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest === "string") this.sessions.delete(oldest);
    }
    return tasks;
  }
}

export class ClaudeChecklistProjection {
  private readonly calls = new Map<string, ClaudeChecklistCall>();

  constructor(
    private readonly emitter: AgentHarnessEmitter,
    private readonly tasks: () => ClaudeChecklistTasks,
  ) {}

  start(
    name: string,
    activityId: string | undefined,
    input: Record<string, unknown> | undefined,
  ): void {
    if (!activityId || !input || !CLAUDE_CHECKLIST_TOOLS.has(name)) return;
    this.calls.delete(activityId);
    this.calls.set(activityId, { name, input });
    if (this.calls.size <= MAX_TRACKED_MESSAGE_IDS) return;
    const oldest = this.calls.keys().next().value;
    if (typeof oldest === "string") this.calls.delete(oldest);
  }

  result(activityId: string, failed: boolean, output: unknown): void {
    const call = this.calls.get(activityId);
    if (!call) return;
    this.calls.delete(activityId);
    const record = objectValue(output);
    if (failed || !record) return;
    if (call.name === "TodoWrite") {
      this.todoWrite(record.newTodos);
      return;
    }
    const tasks = this.tasks();
    if (call.name === "TaskCreate") {
      const task = objectValue(record.task);
      const id = boundedIdentifier(task?.id);
      const step = checklistText(task?.subject) ?? checklistText(call.input.subject);
      if (!id || !step) return;
      if (!tasks.has(id) && tasks.size >= MAX_AGENT_PLAN_STEPS) return;
      tasks.set(id, { step, status: "pending" });
    } else if (call.name === "TaskUpdate") {
      const id = boundedIdentifier(call.input.taskId);
      const task = id ? tasks.get(id) : undefined;
      if (record.success !== true || !id || !task) return;
      if (call.input.status === "deleted") {
        tasks.delete(id);
      } else {
        const status = checklistStatus(call.input.status);
        const step = checklistText(call.input.subject);
        if (!status && !step) return;
        tasks.set(id, { step: step ?? task.step, status: status ?? task.status });
      }
    } else {
      if (!Array.isArray(record.tasks)) return;
      const listed = record.tasks.slice(0, MAX_AGENT_PLAN_STEPS).flatMap((value) => {
        const task = checklistTask(value);
        return task ? [task] : [];
      });
      if (record.tasks.length > 0 && listed.length === 0) return;
      tasks.clear();
      for (const { id, step } of listed) tasks.set(id, step);
    }
    this.emitter.rich({ type: "plan", explanation: null, steps: [...tasks.values()] });
  }

  private todoWrite(todos: unknown): void {
    if (!Array.isArray(todos)) return;
    const steps = todos.slice(0, MAX_AGENT_PLAN_STEPS).flatMap((value) => {
      const step = checklistTodo(value);
      return step ? [step] : [];
    });
    if (todos.length > 0 && steps.length === 0) return;
    this.emitter.rich({ type: "plan", explanation: null, steps });
  }
}
