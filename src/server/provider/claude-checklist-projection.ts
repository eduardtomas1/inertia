import type { AgentHarnessEmitter } from "./agent-harness";
import {
  boundedClaudeIdentifier as boundedIdentifier,
  BoundedStringSet,
  claudeObjectValue as objectValue,
  MAX_CLAUDE_TRACKED_MESSAGE_IDS as MAX_TRACKED_MESSAGE_IDS,
} from "./claude-message-projector-support";
import type { AgentPlanStep } from "./interactions";

const MAX_CLAUDE_CHECKLIST_STEPS = 100;
const MAX_CLAUDE_CHECKLIST_STEP_CHARS = 1_000;
const CLAUDE_TASK_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);

type ClaudeChecklistStatus = Exclude<AgentPlanStep["status"], "cancelled">;

interface ClaudeTaskCall {
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

export class ClaudeChecklistProjection {
  private readonly projectedTodos = new BoundedStringSet(MAX_TRACKED_MESSAGE_IDS);
  private readonly calls = new Map<string, ClaudeTaskCall>();
  private readonly tasks = new Map<string, AgentPlanStep>();

  constructor(private readonly emitter: AgentHarnessEmitter) {}

  start(
    name: string,
    activityId: string | undefined,
    input: Record<string, unknown> | undefined,
  ): void {
    if (name === "TodoWrite") {
      this.todoWrite(activityId, input);
      return;
    }
    if (!activityId || !input || !CLAUDE_TASK_TOOLS.has(name)) return;
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
    if (call.name === "TaskCreate") {
      const task = objectValue(record.task);
      const id = boundedIdentifier(task?.id);
      const step = checklistText(task?.subject) ?? checklistText(call.input.subject);
      if (!id || !step) return;
      if (!this.tasks.has(id) && this.tasks.size >= MAX_CLAUDE_CHECKLIST_STEPS) return;
      this.tasks.set(id, { step, status: "pending" });
    } else if (call.name === "TaskUpdate") {
      const id = boundedIdentifier(call.input.taskId);
      const task = id ? this.tasks.get(id) : undefined;
      if (record.success !== true || !id || !task) return;
      if (call.input.status === "deleted") {
        this.tasks.delete(id);
      } else {
        const status = checklistStatus(call.input.status);
        const step = checklistText(call.input.subject);
        if (!status && !step) return;
        this.tasks.set(id, { step: step ?? task.step, status: status ?? task.status });
      }
    } else {
      if (!Array.isArray(record.tasks)) return;
      this.tasks.clear();
      for (const value of record.tasks) {
        if (this.tasks.size >= MAX_CLAUDE_CHECKLIST_STEPS) break;
        const task = checklistTask(value);
        if (task) this.tasks.set(task.id, task.step);
      }
    }
    this.emitter.rich({ type: "plan", explanation: null, steps: [...this.tasks.values()] });
  }

  private todoWrite(
    activityId: string | undefined,
    input: Record<string, unknown> | undefined,
  ): void {
    if (activityId && this.projectedTodos.has(activityId)) return;
    const todos = input?.todos;
    if (!Array.isArray(todos)) return;
    const steps: AgentPlanStep[] = [];
    for (const value of todos) {
      if (steps.length >= MAX_CLAUDE_CHECKLIST_STEPS) break;
      const todo = objectValue(value);
      const step = checklistText(todo?.content);
      const status = checklistStatus(todo?.status);
      if (step && status) steps.push({ step, status });
    }
    if (todos.length > 0 && steps.length === 0) return;
    if (activityId) this.projectedTodos.add(activityId);
    this.emitter.rich({ type: "plan", explanation: null, steps });
  }
}
